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
const WRITE_ATTEMPTS: usize = 3;

/// The local cache directory holding `fs.db` and its generation.
pub(super) struct Cache {
    pub dir: PathBuf,
}

impl Cache {
    fn db(&self) -> PathBuf {
        self.dir.join(store::OBJECT)
    }

    fn generation_file(&self) -> PathBuf {
        self.dir.join(format!("{}.generation", store::OBJECT))
    }

    fn generation(&self) -> Option<i64> {
        fs::read_to_string(self.generation_file())
            .ok()
            .and_then(|v| v.trim().parse().ok())
    }

    /// Copy the remote database into `to` unless the cached copy already
    /// matches `remote`; an absent remote leaves `to` absent, which SQLite
    /// opens as a new empty database.
    fn materialize(
        &self,
        store: &dyn Store,
        remote: Option<i64>,
        to: &Path,
    ) -> Result<()> {
        fs::create_dir_all(&self.dir)?;
        let fresh = remote.is_some()
            && self.generation() == remote
            && self.db().is_file();
        if fresh && to == self.db() {
            return Ok(());
        }
        let _ = fs::remove_file(to);
        if fresh {
            fs::copy(self.db(), to)?;
        } else if remote.is_some() {
            let generation = store.download(to)?;
            if to == self.db() {
                fs::write(self.generation_file(), generation.to_string())?;
            }
        } else if to == self.db() {
            let _ = fs::remove_file(self.generation_file());
        }
        Ok(())
    }

    /// Open a fresh read view of the index.
    pub fn read(&self, store: &dyn Store) -> Result<Connection> {
        let remote = store.generation()?;
        self.materialize(store, remote, &self.db())?;
        let connection = Connection::open(self.db())?;
        schema::ensure(&connection)?;
        Ok(connection)
    }

    /// Apply `change` in one transaction and publish the result. On a
    /// conflicting remote write, rebuild from the new remote and retry.
    pub fn write<T>(
        &self,
        store: &dyn Store,
        mut change: impl FnMut(&Transaction) -> Result<T>,
    ) -> Result<T> {
        let working = self.dir.join(format!("{}.work", store::OBJECT));
        for _ in 0..WRITE_ATTEMPTS {
            let remote = store.generation()?;
            self.materialize(store, remote, &working)?;
            let value = {
                let mut connection = Connection::open(&working)?;
                schema::ensure(&connection)?;
                let transaction = connection.transaction()?;
                let value = change(&transaction)?;
                transaction.commit()?;
                value
            };
            if let Some(generation) = store.upload(&working, remote)? {
                fs::rename(&working, self.db())?;
                fs::write(self.generation_file(), generation.to_string())?;
                return Ok(value);
            }
            eprintln!("Index changed on another machine; retrying.");
        }
        let _ = fs::remove_file(&working);
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

/// Insert a newly published file. Re-publishing a key with `--replace`
/// updates its size and type and keeps tags and description.
pub(super) fn add_file(
    transaction: &Transaction,
    key: &str,
    size: u64,
    content_type: &str,
    source: &str,
) -> Result<()> {
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
    let found = transaction
        .query_row(
            "SELECT 1 FROM files WHERE key = ?1 AND deleted_at IS NULL",
            [key],
            |_| Ok(()),
        )
        .optional()?;
    ensure!(
        found.is_some(),
        "{key} is not in the index; run ud fs index sync if it was uploaded \
         another way"
    );
    Ok(())
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
pub(super) fn reconcile(
    transaction: &Transaction,
    records: &[Record],
) -> Result<SyncReport> {
    let mut known = BTreeMap::new();
    {
        let mut statement =
            transaction.prepare("SELECT key, deleted_at FROM files")?;
        for row in statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })? {
            let (key, deleted) = row?;
            known.insert(key, deleted.is_some());
        }
    }
    let mut report = SyncReport::default();
    let live = records
        .iter()
        .map(|r| r.key.as_str())
        .collect::<BTreeSet<_>>();
    for record in records {
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
                     WHERE key = ?1",
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
            let mut lines = vec![format!(
                "files[{}]{{url,size,contentType,tags,description}}:",
                entries.len()
            )];
            for e in entries {
                lines.push(format!(
                    "  {},{},{},{},{}",
                    toon_string(&public_url(&e.key, origin)?),
                    e.size,
                    toon_string(&e.content_type),
                    toon_string(&e.tags.join(" ")),
                    toon_string(&e.description)
                ));
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
