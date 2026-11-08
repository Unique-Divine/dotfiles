//! Searchable index of published files: tags, Markdown descriptions, and a
//! change log in one SQLite database kept in a private bucket.
//!
//! Reads refresh a local cached copy when the remote generation changes.
//! Writes apply to a working copy and upload with a generation precondition,
//! retrying from fresh state when another machine wrote first.
mod schema;
pub(super) mod store;

use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use super::{
    listing::{self, Record, toon_string},
    naming::{matches, public_url},
};
use store::Store;

/// Attempts at a compare-and-swap upload before giving up.
const WRITE_ATTEMPTS: u32 = 6;

/// Largest description accepted, in bytes. Longer notes belong in a
/// document that the description links to.
pub(super) const MAX_DESCRIPTION: usize = 16 * 1024;

/// SQLite file header; anything else in the cache is discarded.
const SQLITE_HEADER: &[u8] = b"SQLite format 3\0";

/// Whether `path` starts like a SQLite database. A zero-byte or truncated
/// file would otherwise open as an empty index.
fn looks_like_sqlite(path: &Path) -> bool {
    let mut header = [0; 16];
    fs::File::open(path)
        .and_then(|mut file| std::io::Read::read_exact(&mut file, &mut header))
        .is_ok_and(|()| header == SQLITE_HEADER)
}

/// Wait a little longer on each retry, with jitter so racing writers
/// spread out instead of colliding again.
fn backoff(attempt: u32) {
    let jitter = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::from(d.subsec_nanos()) % 150);
    std::thread::sleep(std::time::Duration::from_millis(
        100 * u64::from(attempt) + jitter,
    ));
}

/// The local cache directory. Each cached copy is named after its remote
/// generation (`fs-<generation>.db`), so a file's name always matches its
/// content even when several `ud` processes update the cache at once.
/// Working copies are unique temp files, so a journal left by a killed
/// process can never roll back a later download.
pub(super) struct Cache {
    pub dir: PathBuf,
}

impl Cache {
    fn copy_of(&self, generation: i64) -> PathBuf {
        self.dir.join(format!("fs-{generation}.db"))
    }

    /// A new empty temp file in the cache directory, deleted on drop.
    fn scratch(&self) -> Result<tempfile::TempPath> {
        fs::create_dir_all(&self.dir)?;
        Ok(tempfile::Builder::new()
            .prefix(".work-")
            .suffix(".db")
            .tempfile_in(&self.dir)?
            .into_temp_path())
    }

    /// Make the cached copy of `generation` present and return its path.
    /// Downloads land in a temp file and are renamed into place.
    fn cached(&self, store: &dyn Store, generation: i64) -> Result<PathBuf> {
        let path = self.copy_of(generation);
        if looks_like_sqlite(&path) {
            return Ok(path);
        }
        let _ = fs::remove_file(&path);
        let download = self.scratch()?;
        let got = store.download(&download)?;
        ensure!(
            looks_like_sqlite(&download),
            "The stored index (generation {got}) is not a SQLite database; \
             restore an earlier version from the meta bucket's history"
        );
        let path = self.copy_of(got);
        download.persist(&path)?;
        self.prune(got);
        Ok(path)
    }

    /// Best-effort removal of cached copies older than `current`. Open
    /// handles on Linux keep removed files readable.
    fn prune(&self, current: i64) {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let older = name
                .to_str()
                .and_then(|n| n.strip_prefix("fs-")?.strip_suffix(".db"))
                .and_then(|g| g.parse::<i64>().ok())
                .is_some_and(|g| g < current);
            // Files from the single-copy layout used before generations
            // were part of the name.
            let legacy = name
                .to_str()
                .is_some_and(|n| n == "fs.db" || n.starts_with("fs.db."));
            if older || legacy {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    /// Open a read-only view of the current index. With nothing stored
    /// yet, the view is an empty in-memory database.
    pub fn read(&self, store: &dyn Store) -> Result<Connection> {
        let Some(generation) = store.generation()? else {
            let connection = Connection::open_in_memory()?;
            schema::ensure(&connection)?;
            return Ok(connection);
        };
        let connection = Connection::open_with_flags(
            self.cached(store, generation)?,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        schema::check_version(&connection)?;
        Ok(connection)
    }

    /// Apply `change` in one transaction and publish the result. On a
    /// conflicting remote write, rebuild from the new remote and retry.
    /// `change` may run more than once, so it must only use the transaction.
    pub fn write<T>(
        &self,
        store: &dyn Store,
        mut change: impl FnMut(&Transaction) -> Result<T>,
    ) -> Result<T> {
        for attempt in 1..=WRITE_ATTEMPTS {
            let remote = store.generation()?;
            let working = self.scratch()?;
            if let Some(generation) = remote {
                let cached = self.cached(store, generation)?;
                fs::copy(&cached, &working)?;
            }
            let (value, changed) = {
                let mut connection = Connection::open(&working)?;
                // A stored index always has a version; without one the copy
                // is damaged, and rebuilding it would erase the remote index.
                let version = schema::check_version(&connection)?;
                ensure!(
                    remote.is_none() || version.is_some(),
                    "The cached index copy is not a ud index; delete {} \
                     and run the command again",
                    self.dir.display()
                );
                schema::ensure(&connection)?;
                let before = connection.total_changes();
                let transaction = connection.transaction()?;
                let value = change(&transaction)?;
                transaction.commit()?;
                (value, connection.total_changes() != before)
            };
            if !changed && remote.is_some() {
                return Ok(value);
            }
            if let Some(generation) = store.upload(&working, remote)? {
                working.persist(self.copy_of(generation))?;
                self.prune(generation);
                return Ok(value);
            }
            eprintln!("Index changed on another machine; retrying.");
            backoff(attempt);
        }
        bail!("Index kept changing during the write; run the command again")
    }
}

/// Current UTC time in the format the change log uses.
pub(super) fn timestamp() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// Strip the date prefix and extension from a key's filename.
pub(super) fn slug_of(key: &str) -> String {
    let leaf = key.rsplit('/').next().unwrap_or(key);
    let mut name = leaf;
    for pattern in [
        r"^[0-9]{6}-",
        r"^[0-9]{2}-[0-9]{2}-[0-9]{2}-",
        r"^[0-9]{2}-[0-9]{2}-",
    ] {
        if let Some(found) = regex::Regex::new(pattern)
            .expect("static pattern")
            .find(name)
        {
            name = &name[found.end()..];
            break;
        }
    }
    name.split('.').next().unwrap_or(name).to_owned()
}

/// Tags follow the slug rules so they stay typeable and greppable.
pub(super) fn validate_tags(tags: &[String]) -> Result<()> {
    for tag in tags {
        ensure!(
            tag.len() <= 40 && matches(r"^[a-z0-9]+(?:-[a-z0-9]+)*$", tag),
            "Tag {tag:?} must use lowercase letters, digits, and single \
             hyphens, up to 40 characters"
        );
    }
    Ok(())
}

/// Levenshtein distance for short tag names.
fn distance(a: &str, b: &str) -> usize {
    let b = b.chars().collect::<Vec<_>>();
    let mut row = (0..=b.len()).collect::<Vec<_>>();
    for (i, x) in a.chars().enumerate() {
        let mut previous = row[0];
        row[0] = i + 1;
        for (j, y) in b.iter().enumerate() {
            let current = row[j + 1];
            row[j + 1] = (current + 1)
                .min(row[j] + 1)
                .min(previous + usize::from(x != *y));
            previous = current;
        }
    }
    row[b.len()]
}

/// Existing tags that look like `tag`, closest first, at most five.
pub(super) fn similar_tags(tag: &str, existing: &[String]) -> Vec<String> {
    let mut scored = existing
        .iter()
        .filter_map(|name| {
            let score = distance(tag, name);
            let related = name.contains(tag) || tag.contains(name.as_str());
            (score <= 3 || related).then(|| (score, name.clone()))
        })
        .collect::<Vec<_>>();
    scored.sort();
    scored.into_iter().take(5).map(|(_, name)| name).collect()
}

/// All tag names in the index.
fn tag_names(connection: &Connection) -> Result<Vec<String>> {
    let mut statement =
        connection.prepare("SELECT name FROM tags ORDER BY name")?;
    let names = statement
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(names)
}

/// Fail on tags the index has never seen unless `allow_new` is set, listing
/// lookalikes so agents reuse tags instead of inventing near-duplicates.
pub(super) fn check_known(
    connection: &Connection,
    tags: &[String],
    allow_new: bool,
) -> Result<()> {
    validate_tags(tags)?;
    if allow_new {
        return Ok(());
    }
    let existing = tag_names(connection)?;
    let unknown = tags
        .iter()
        .filter(|tag| !existing.contains(tag))
        .collect::<Vec<_>>();
    if unknown.is_empty() {
        return Ok(());
    }
    let mut message =
        String::from("Unknown tags; pass --new-tag to create them:");
    for tag in unknown {
        let similar = similar_tags(tag, &existing);
        if similar.is_empty() {
            message.push_str(&format!("\n  {tag}"));
        } else {
            message.push_str(&format!(
                "\n  {tag} (existing: {})",
                similar.join(", ")
            ));
        }
    }
    bail!(message)
}

/// Insert a newly published file. Re-publishing a live key with `--replace`
/// updates its size and type and keeps tags and description; publishing
/// over a deleted key starts fresh, since the old notes described other
/// bytes.
pub(super) fn add_file(
    transaction: &Transaction,
    key: &str,
    size: u64,
    content_type: &str,
    source: &str,
) -> Result<()> {
    let was_deleted = transaction
        .query_row(
            "SELECT deleted_at IS NOT NULL FROM files WHERE key = ?1",
            [key],
            |row| row.get::<_, bool>(0),
        )
        .optional()?
        .unwrap_or(false);
    if was_deleted {
        transaction.execute("DELETE FROM file_tags WHERE key = ?1", [key])?;
        transaction.execute(
            "UPDATE files SET description = '', source = ?2 WHERE key = ?1",
            params![key, source],
        )?;
    }
    transaction.execute(
        "INSERT INTO files (key, date, slug, size, content_type, source,
                            created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (key) DO UPDATE SET
           size = excluded.size,
           content_type = excluded.content_type,
           deleted_at = NULL",
        params![
            key,
            listing::publication_date(key),
            slug_of(key),
            size as i64,
            content_type,
            source,
            timestamp()
        ],
    )?;
    Ok(())
}

/// Require that `key` is indexed and live.
fn require_file(transaction: &Transaction, key: &str) -> Result<()> {
    let deleted = transaction
        .query_row(
            "SELECT deleted_at FROM files WHERE key = ?1",
            [key],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?;
    match deleted {
        None => bail!(
            "{key} is not in the index; run ud fs index sync if it was \
             uploaded another way"
        ),
        Some(Some(at)) => bail!("{key} was deleted at {at}"),
        Some(None) => Ok(()),
    }
}

/// Add and remove tags on one file, creating new tag names on the way.
pub(super) fn retag(
    transaction: &Transaction,
    key: &str,
    add: &[String],
    remove: &[String],
) -> Result<()> {
    require_file(transaction, key)?;
    for tag in add {
        transaction.execute(
            "INSERT OR IGNORE INTO tags (name, created_at) VALUES (?1, ?2)",
            params![tag, timestamp()],
        )?;
        transaction.execute(
            "INSERT OR IGNORE INTO file_tags (key, tag) VALUES (?1, ?2)",
            params![key, tag],
        )?;
    }
    for tag in remove {
        transaction.execute(
            "DELETE FROM file_tags WHERE key = ?1 AND tag = ?2",
            params![key, tag],
        )?;
    }
    Ok(())
}

/// Replace a file's Markdown description verbatim.
pub(super) fn describe(
    transaction: &Transaction,
    key: &str,
    markdown: &str,
) -> Result<()> {
    ensure!(
        markdown.len() <= MAX_DESCRIPTION,
        "Description is {} bytes; the limit is {MAX_DESCRIPTION}. Put longer \
         notes in a document and link to it",
        markdown.len()
    );
    require_file(transaction, key)?;
    transaction.execute(
        "UPDATE files SET description = ?2 WHERE key = ?1",
        params![key, markdown],
    )?;
    Ok(())
}

/// Record that an object was deleted from the bucket.
pub(super) fn mark_deleted(transaction: &Transaction, key: &str) -> Result<()> {
    transaction.execute(
        "UPDATE files SET deleted_at = ?2 WHERE key = ?1 AND deleted_at IS NULL",
        params![key, timestamp()],
    )?;
    Ok(())
}

/// Counts from reconciling the index with a bucket listing.
#[derive(Debug, Default, PartialEq, Serialize)]
pub(super) struct SyncReport {
    pub added: usize,
    pub deleted: usize,
    pub restored: usize,
}

/// Make the index match a full bucket listing: add unknown objects, mark
/// vanished ones deleted, and restore ones that reappeared.
///
/// The listing is older than the index it is applied to, so keys with a
/// change logged at or after `listed_at` are left alone: a publish or
/// `rm` that finished after the listing knows better than the listing.
pub(super) fn reconcile(
    transaction: &Transaction,
    records: &[Record],
    listed_at: Option<&str>,
) -> Result<SyncReport> {
    let mut known = BTreeMap::new();
    {
        let mut statement = transaction.prepare(
            "SELECT key, deleted_at FROM files f WHERE ?1 IS NULL
               OR NOT EXISTS (SELECT 1 FROM changes c
                              WHERE c.key = f.key AND c.at >= ?1)",
        )?;
        for row in statement.query_map([listed_at], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })? {
            let (key, deleted) = row?;
            known.insert(key, deleted.is_some());
        }
    }
    let changed_since: BTreeSet<String> = match listed_at {
        None => BTreeSet::new(),
        Some(at) => {
            let mut statement = transaction
                .prepare("SELECT DISTINCT key FROM changes WHERE at >= ?1")?;
            statement
                .query_map([at], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?
        }
    };
    let mut report = SyncReport::default();
    let live = records
        .iter()
        .map(|r| r.key.as_str())
        .collect::<BTreeSet<_>>();
    for record in records {
        if changed_since.contains(&record.key) {
            continue;
        }
        match known.get(&record.key) {
            None => {
                add_file(
                    transaction,
                    &record.key,
                    record.size,
                    &record.content_type,
                    "",
                )?;
                report.added += 1;
            }
            Some(true) => {
                transaction.execute(
                    "UPDATE files SET deleted_at = NULL, size = ?2,
                       content_type = ?3 WHERE key = ?1",
                    params![record.key, record.size as i64, record.content_type],
                )?;
                report.restored += 1;
            }
            Some(false) => {
                transaction.execute(
                    "UPDATE files SET size = ?2, content_type = ?3
                     WHERE key = ?1
                       AND (size IS NOT ?2 OR content_type IS NOT ?3)",
                    params![record.key, record.size as i64, record.content_type],
                )?;
            }
        }
    }
    for (key, deleted) in &known {
        if !deleted && !live.contains(key.as_str()) {
            mark_deleted(transaction, key)?;
            report.deleted += 1;
        }
    }
    Ok(report)
}

/// One indexed file as search returns it.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Entry {
    pub key: String,
    pub size: u64,
    pub content_type: String,
    pub tags: Vec<String>,
    /// Markdown, stored and returned verbatim.
    pub description: String,
    pub source: String,
    pub deleted_at: Option<String>,
}

/// Search filters; every field narrows the result.
#[derive(Debug, Default)]
pub(super) struct Query {
    /// Free text; each word must appear in the slug, description, source,
    /// or tags.
    pub text: String,
    /// Every listed tag must be present.
    pub tags: Vec<String>,
    /// Publication date prefix from `listing::time_filter`.
    pub date: Option<String>,
    /// Include deleted files.
    pub deleted: bool,
}

/// Quote one word as an FTS5 phrase.
fn phrase(word: &str) -> String {
    format!("\"{}\"", word.replace('"', "\"\""))
}

/// Run a search. Words of three or more characters use the trigram index
/// and rank by BM25; shorter words fall back to substring checks.
pub(super) fn search(
    connection: &Connection,
    query: &Query,
) -> Result<Vec<Entry>> {
    let words = query.text.split_whitespace().collect::<Vec<_>>();
    let (long, short): (Vec<&str>, Vec<&str>) =
        words.iter().partition(|word| word.chars().count() >= 3);
    let mut sql = String::from(
        "SELECT f.key, f.size, f.content_type, f.description, f.source,
                f.deleted_at, s.tags
         FROM files f JOIN search s ON s.key = f.key WHERE 1",
    );
    let mut values: Vec<String> = Vec::new();
    if !long.is_empty() {
        values.push(
            long.iter()
                .map(|w| phrase(w))
                .collect::<Vec<_>>()
                .join(" AND "),
        );
        sql.push_str(&format!(" AND search MATCH ?{}", values.len()));
    }
    for word in &short {
        values.push(word.to_lowercase());
        sql.push_str(&format!(
            " AND instr(lower(s.slug || ' ' || s.description || ' ' ||
                              s.source || ' ' || s.tags), ?{}) > 0",
            values.len()
        ));
    }
    for tag in &query.tags {
        values.push(tag.clone());
        sql.push_str(&format!(
            " AND EXISTS (SELECT 1 FROM file_tags t
                          WHERE t.key = f.key AND t.tag = ?{})",
            values.len()
        ));
    }
    if let Some(date) = &query.date {
        values.push(format!("{date}%"));
        sql.push_str(&format!(" AND f.date LIKE ?{}", values.len()));
    }
    if !query.deleted {
        sql.push_str(" AND f.deleted_at IS NULL");
    }
    sql.push_str(if long.is_empty() {
        " ORDER BY f.date DESC, f.key"
    } else {
        " ORDER BY bm25(search), f.date DESC, f.key"
    });
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map(
        rusqlite::params_from_iter(values.iter()),
        |row| {
            let tags: String = row.get(6)?;
            Ok(Entry {
                key: row.get(0)?,
                size: row.get::<_, i64>(1)? as u64,
                content_type: row.get(2)?,
                description: row.get(3)?,
                source: row.get(4)?,
                deleted_at: row.get(5)?,
                tags: tags.split_whitespace().map(str::to_owned).collect(),
            })
        },
    )?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Tags with their live file counts, most used first.
pub(super) fn tag_counts(connection: &Connection) -> Result<Vec<(String, u64)>> {
    let mut statement = connection.prepare(
        "SELECT t.name, count(f.key) AS n
         FROM tags t
         LEFT JOIN file_tags ft ON ft.tag = t.name
         LEFT JOIN files f ON f.key = ft.key AND f.deleted_at IS NULL
         GROUP BY t.name ORDER BY n DESC, t.name",
    )?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get::<_, i64>(1)? as u64)))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Remove tags that no live file carries, with their links to deleted
/// files. Returns the removed names.
pub(super) fn prune_tags(transaction: &Transaction) -> Result<Vec<String>> {
    let unused = {
        let mut statement = transaction.prepare(
            "SELECT name FROM tags t WHERE NOT EXISTS (
               SELECT 1 FROM file_tags ft JOIN files f ON f.key = ft.key
               WHERE ft.tag = t.name AND f.deleted_at IS NULL)
             ORDER BY name",
        )?;
        statement
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?
    };
    for name in &unused {
        transaction.execute("DELETE FROM file_tags WHERE tag = ?1", [name])?;
        transaction.execute("DELETE FROM tags WHERE name = ?1", [name])?;
    }
    Ok(unused)
}

/// One change-log row.
#[derive(Debug, Serialize)]
pub(super) struct Change {
    pub at: String,
    pub key: String,
    pub action: String,
    pub detail: Option<String>,
}

/// The most recent changes, newest first.
pub(super) fn log(connection: &Connection, limit: usize) -> Result<Vec<Change>> {
    let mut statement = connection.prepare(
        "SELECT at, key, action, detail FROM changes
         ORDER BY id DESC LIMIT ?1",
    )?;
    let rows = statement.query_map([limit as i64], |row| {
        Ok(Change {
            at: row.get(0)?,
            key: row.get(1)?,
            action: row.get(2)?,
            detail: row.get(3)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Render search results in the listing formats, adding tags and the
/// Markdown description. JSON keeps the description verbatim.
pub(super) fn output(
    entries: &[Entry],
    format: &str,
    origin: &str,
) -> Result<String> {
    #[derive(Serialize)]
    struct Json<'a> {
        url: String,
        size: u64,
        #[serde(rename = "contentType")]
        content_type: &'a str,
        tags: &'a [String],
        description: &'a str,
        source: &'a str,
        #[serde(rename = "deletedAt", skip_serializing_if = "Option::is_none")]
        deleted_at: &'a Option<String>,
    }
    Ok(match format {
        "json" => {
            let files = entries
                .iter()
                .map(|e| {
                    Ok(Json {
                        url: public_url(&e.key, origin)?,
                        size: e.size,
                        content_type: &e.content_type,
                        tags: &e.tags,
                        description: &e.description,
                        source: &e.source,
                        deleted_at: &e.deleted_at,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            serde_json::to_string_pretty(&serde_json::json!({ "files": files }))?
        }
        "urls" => entries
            .iter()
            .map(|e| public_url(&e.key, origin))
            .collect::<Result<Vec<_>>>()?
            .join("\n"),
        "paths" => entries
            .iter()
            .map(|e| e.key.clone())
            .collect::<Vec<_>>()
            .join("\n"),
        _ if entries.is_empty() => "files: []".into(),
        _ => {
            // The deletedAt column appears only when a row needs it.
            let deleted = entries.iter().any(|e| e.deleted_at.is_some());
            let mut lines = vec![format!(
                "files[{}]{{url,size,contentType,tags,description{}}}:",
                entries.len(),
                if deleted { ",deletedAt" } else { "" }
            )];
            for e in entries {
                let mut line = format!(
                    "  {},{},{},{},{}",
                    toon_string(&public_url(&e.key, origin)?),
                    e.size,
                    toon_string(&e.content_type),
                    toon_string(&e.tags.join(" ")),
                    toon_string(&e.description)
                );
                if deleted {
                    line.push(',');
                    line.push_str(
                        &e.deleted_at
                            .as_deref()
                            .map_or_else(|| "null".to_owned(), toon_string),
                    );
                }
                lines.push(line);
            }
            lines.join("\n")
        }
    })
}

/// Tags of one file, for delete previews.
pub(super) fn tags_of(
    connection: &Connection,
    key: &str,
) -> Result<Vec<String>> {
    let mut statement = connection
        .prepare("SELECT tag FROM file_tags WHERE key = ?1 ORDER BY tag")?;
    let rows = statement.query_map([key], |row| row.get(0))?;
    rows.collect::<rusqlite::Result<Vec<String>>>()
        .context("Could not read tags")
}

#[cfg(test)]
mod index_test;
