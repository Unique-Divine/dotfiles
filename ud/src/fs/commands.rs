//! Index-backed commands: tagging, descriptions, search, change log, sync.
use anyhow::{Context, Result, bail, ensure};
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
};

use super::{
    backend::Gcs,
    cli::{DescArgs, LogArgs, RefsArgs, RmArgs, SearchArgs, TagArgs, TagsArgs},
    config::Settings,
    index::{
        self, Cache, Query,
        store::{DirStore, GcsStore, Store},
    },
    listing,
    naming::resolve_key,
};

/// The local cache directory; a test or offline index keeps its own cache.
fn cache(config: &Settings) -> Result<Cache> {
    if let Some(dir) = &config.index_dir {
        return Ok(Cache {
            dir: Path::new(dir).join(".cache"),
        });
    }
    let root = env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|h| Path::new(&h).join(".cache")))
        .context("HOME or XDG_CACHE_HOME must be set")?;
    Ok(Cache {
        dir: root.join("ud/fs"),
    })
}

/// Run `body` with the configured store and cache.
pub(super) fn with_index<T>(
    config: &Settings,
    body: impl FnOnce(&dyn Store, &Cache) -> Result<T>,
) -> Result<T> {
    let cache = cache(config)?;
    if let Some(dir) = &config.index_dir {
        let store = DirStore {
            root: PathBuf::from(dir),
        };
        return body(&store, &cache);
    }
    let gcs = Gcs::new(config)?;
    let store = GcsStore {
        gcs: &gcs,
        bucket: config.meta_bucket.clone(),
    };
    body(&store, &cache)
}

/// Split repeated and comma-separated tag flags into one list.
pub(super) fn tag_list(values: &[String]) -> Vec<String> {
    values
        .iter()
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Where `publish` ran, relative to `~/ki` when possible, so search can
/// find files by the repo or epic they came from.
pub(super) fn source_label(cwd: &Path, home: Option<&Path>) -> String {
    if let Some(home) = home {
        if let Ok(rest) = cwd.strip_prefix(home.join("ki")) {
            return rest.to_string_lossy().into_owned();
        }
        if let Ok(rest) = cwd.strip_prefix(home) {
            return format!("~/{}", rest.to_string_lossy());
        }
    }
    cwd.to_string_lossy().into_owned()
}

/// `ud fs tag`: add and remove tags on one or more files.
pub(super) fn tag(args: &TagArgs, config: &Settings) -> Result<()> {
    let add = tag_list(&args.add);
    let remove = tag_list(&args.rm);
    anyhow::ensure!(!add.is_empty() || !remove.is_empty(), "Pass --add or --rm");
    let keys = args
        .targets
        .iter()
        .map(|t| resolve_key(t, &config.base_url))
        .collect::<Result<Vec<_>>>()?;
    index::validate_tags(&remove)?;
    with_index(config, |store, cache| {
        index::check_known(&cache.read(store)?, &add, args.new_tag)?;
        cache.write(store, |tx| {
            for key in &keys {
                index::retag(tx, key, &add, &remove)?;
            }
            Ok(())
        })
    })?;
    eprintln!("Updated tags on {} file(s).", keys.len());
    Ok(())
}

/// `ud fs desc`: set a Markdown description, from stdin when TEXT is `-`.
pub(super) fn desc(args: &DescArgs, config: &Settings) -> Result<()> {
    let key = resolve_key(&args.target, &config.base_url)?;
    let markdown = if args.text == "-" {
        let mut text = String::new();
        std::io::stdin().read_to_string(&mut text)?;
        // Drop the final newline a heredoc or echo adds; keep the rest.
        text.strip_suffix('\n').unwrap_or(&text).to_owned()
    } else {
        args.text.clone()
    };
    with_index(config, |store, cache| {
        cache.write(store, |tx| index::describe(tx, &key, &markdown))
    })
}

/// `ud fs tags`: every tag with its live file count.
pub(super) fn tags(args: &TagsArgs, config: &Settings) -> Result<()> {
    if args.prune {
        let removed = with_index(config, |store, cache| {
            cache.write(store, index::prune_tags)
        })?;
        eprintln!("Removed {} unused tag(s).", removed.len());
        for name in removed {
            println!("{name}");
        }
        return Ok(());
    }
    let counts = with_index(config, |store, cache| {
        index::tag_counts(&cache.read(store)?)
    })?;
    if args.json {
        let tags = counts
            .iter()
            .map(
                |(name, files)| serde_json::json!({"tag": name, "files": files}),
            )
            .collect::<Vec<_>>();
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({"tags": tags}))?
        );
    } else if counts.is_empty() {
        println!("tags: []");
    } else {
        println!("tags[{}]{{tag,files}}:", counts.len());
        for (name, files) in counts {
            println!("  {},{files}", listing::toon_string(&name));
        }
    }
    Ok(())
}

/// `ud fs search`: full-text search with tag and date filters.
pub(super) fn search(args: &SearchArgs, config: &Settings) -> Result<()> {
    let query = Query {
        text: args.query.join(" "),
        tags: tag_list(&args.tag),
        date: args.time.as_deref().map(listing::time_filter).transpose()?,
        deleted: args.deleted,
    };
    index::validate_tags(&query.tags)?;
    let entries = with_index(config, |store, cache| {
        index::search(&cache.read(store)?, &query)
    })?;
    let format = if args.json {
        "json"
    } else if args.urls {
        "urls"
    } else if args.paths {
        "paths"
    } else {
        "toon"
    };
    let output = index::output(&entries, format, &config.base_url)?;
    if !output.is_empty() {
        println!("{output}");
    }
    Ok(())
}

/// `ud fs log`: recent index changes, newest first.
pub(super) fn log(args: &LogArgs, config: &Settings) -> Result<()> {
    let changes = with_index(config, |store, cache| {
        index::log(&cache.read(store)?, args.limit)
    })?;
    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(
                &serde_json::json!({"changes": changes})
            )?
        );
    } else if changes.is_empty() {
        println!("changes: []");
    } else {
        println!("changes[{}]{{at,action,key,detail}}:", changes.len());
        for change in changes {
            println!(
                "  {},{},{},{}",
                listing::toon_string(&change.at),
                change.action,
                listing::toon_string(&change.key),
                listing::toon_string(change.detail.as_deref().unwrap_or(""))
            );
        }
    }
    Ok(())
}

/// `ud fs index sync`: reconcile the index with the public bucket.
pub(super) fn sync(config: &Settings) -> Result<()> {
    // Two minutes of slack covers clock skew between machines.
    let listed_at = (chrono::Utc::now() - chrono::Duration::minutes(2))
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string();
    let records = Gcs::new(config)?.list("")?;
    let report = with_index(config, |store, cache| {
        cache.write(store, |tx| index::reconcile(tx, &records, Some(&listed_at)))
    })?;
    eprintln!(
        "Index sync: {} added, {} marked deleted, {} restored; {} live files.",
        report.added,
        report.deleted,
        report.restored,
        records.len()
    );
    Ok(())
}

/// File types searched for backlinks.
const BACKLINK_GLOB: &str = "*.{md,mdx,markdown,html,htm,astro,svelte,vue,ts,\
tsx,js,jsx,mjs,json,jsonl,yaml,yml,toml,txt,rs,go,py,sh,css,typ,tex,org,rst,\
csv,toon}";

/// Files under `roots` that mention each key's `/f/KEY` path, found with one
/// fixed-string `rg` run. Keys without backlinks map to an empty list.
pub(super) fn backlinks(
    keys: &[String],
    roots: &[PathBuf],
) -> Result<BTreeMap<String, Vec<String>>> {
    let mut found = keys
        .iter()
        .map(|k| (k.clone(), Vec::new()))
        .collect::<BTreeMap<_, _>>();
    let roots = roots.iter().filter(|r| r.is_dir()).collect::<Vec<_>>();
    if keys.is_empty() || roots.is_empty() {
        return Ok(found);
    }
    let mut command = Command::new("rg");
    command.args(["--fixed-strings", "--only-matching", "--with-filename"]);
    command.args(["--no-heading", "--no-line-number", "--color", "never"]);
    // Only text formats can embed a URL; skipping binaries and build output
    // cuts a full ~/ki scan from about 19 s to about 3 s.
    command.args(["--glob", BACKLINK_GLOB]);
    // Agent notes live in hidden folders such as .claude/ and .cursor/.
    command.args(["--hidden", "--glob", "!.git"]);
    for key in keys {
        command.arg("-e").arg(format!("/f/{key}"));
    }
    command.arg("--").args(&roots);
    let output = command.output().context("rg is required for backlinks")?;
    // Exit 1 means no matches; 2 means an error such as an unreadable file,
    // which still reports the matches it found.
    ensure!(
        output.status.code().is_some_and(|c| c <= 2),
        "rg failed while searching for backlinks"
    );
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Some((file, matched)) = line.rsplit_once(":/f/") else {
            continue;
        };
        if let Some(files) = found.get_mut(matched)
            && !files.iter().any(|f| f == file)
        {
            files.push(file.to_owned());
        }
    }
    Ok(found)
}

/// `ud fs refs`: documents that embed or link each file.
pub(super) fn refs(args: &RefsArgs, config: &Settings) -> Result<()> {
    let keys = args
        .targets
        .iter()
        .map(|t| resolve_key(t, &config.base_url))
        .collect::<Result<Vec<_>>>()?;
    let found = backlinks(&keys, &config.ref_roots)?;
    let rows = found
        .iter()
        .flat_map(|(key, files)| files.iter().map(move |f| (key, f)))
        .collect::<Vec<_>>();
    if args.json {
        let refs = found
            .iter()
            .map(|(key, files)| serde_json::json!({"key": key, "files": files}))
            .collect::<Vec<_>>();
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({"refs": refs}))?
        );
    } else if rows.is_empty() {
        println!("refs: []");
    } else {
        println!("refs[{}]{{key,file}}:", rows.len());
        for (key, file) in rows {
            println!(
                "  {},{}",
                listing::toon_string(key),
                listing::toon_string(file)
            );
        }
    }
    Ok(())
}

/// `ud fs rm`: preview by default; `--yes` deletes objects and marks them
/// deleted in the index.
pub(super) fn rm(args: &RmArgs, config: &Settings) -> Result<()> {
    let mut keys = args
        .targets
        .iter()
        .map(|t| resolve_key(t, &config.base_url))
        .collect::<Result<Vec<_>>>()?;
    let group = tag_list(&args.tag);
    index::validate_tags(&group)?;
    let (keys, tags) = with_index(config, |store, cache| {
        let read = cache.read(store)?;
        let live = index::search(&read, &Query::default())?
            .into_iter()
            .map(|e| e.key)
            .collect::<BTreeSet<_>>();
        let unknown = keys
            .iter()
            .filter(|k| !live.contains(*k))
            .cloned()
            .collect::<Vec<_>>();
        ensure!(
            unknown.is_empty(),
            "Not live in the index: {}. Run ud fs index sync if they were \
             uploaded another way",
            unknown.join(", ")
        );
        if !group.is_empty() {
            let query = Query {
                tags: group.clone(),
                ..Query::default()
            };
            keys.extend(
                index::search(&read, &query)?.into_iter().map(|e| e.key),
            );
        }
        keys.sort();
        keys.dedup();
        let tags = keys
            .iter()
            .map(|k| index::tags_of(&read, k))
            .collect::<Result<Vec<_>>>()?;
        Ok((keys, tags))
    })?;
    if keys.is_empty() {
        bail!("No live files match");
    }
    let links = backlinks(&keys, &config.ref_roots)?;
    let linked = links.values().filter(|f| !f.is_empty()).count();
    eprintln!(
        "{} {} file(s); {linked} with backlinks:",
        if args.yes { "Deleting" } else { "Would delete" },
        keys.len()
    );
    for (key, tags) in keys.iter().zip(&tags) {
        let tags = if tags.is_empty() {
            "untagged".to_owned()
        } else {
            tags.join(" ")
        };
        eprintln!("  {key}  [{tags}]");
        for file in &links[key] {
            eprintln!("    linked from {file}");
        }
    }
    if !args.yes {
        eprintln!("Nothing deleted. Pass --yes to delete these files.");
        return Ok(());
    }
    let gcs = Gcs::new(config)?;
    let mut deleted = Vec::new();
    let mut failure = None;
    for key in &keys {
        match gcs.delete(key) {
            Ok(()) => deleted.push(key.clone()),
            Err(error) => {
                failure = Some(error);
                break;
            }
        }
    }
    // Report deletions first: they happened even if the index write fails.
    for key in &deleted {
        println!("{key}");
    }
    with_index(config, |store, cache| {
        cache.write(store, |tx| {
            for key in &deleted {
                index::mark_deleted(tx, key)?;
            }
            Ok(())
        })
    })
    .with_context(|| {
        format!(
            "Deleted {} file(s), but the index was not updated; \
             run ud fs index sync",
            deleted.len()
        )
    })?;
    eprintln!(
        "Deleted {} file(s). CDN copies can be served for up to five \
         minutes; restore within seven days with gcloud storage restore.",
        deleted.len()
    );
    if let Some(error) = failure {
        return Err(error);
    }
    Ok(())
}
