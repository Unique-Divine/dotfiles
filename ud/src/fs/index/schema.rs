//! SQLite schema for the file index. Triggers own the change log and the
//! full-text table, so command code only writes `files` and `file_tags`.
use anyhow::{Result, ensure};
use rusqlite::Connection;

/// Bump when the schema changes; `open` refuses newer databases.
pub(super) const VERSION: i64 = 1;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per object ever indexed. `description` holds Markdown verbatim.
-- Deleted objects keep their row so dead URLs stay discoverable.
CREATE TABLE IF NOT EXISTS files (
  key TEXT PRIMARY KEY,
  date TEXT,
  slug TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS tags (
  name TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS file_tags (
  key TEXT NOT NULL REFERENCES files(key),
  tag TEXT NOT NULL REFERENCES tags(name),
  PRIMARY KEY (key, tag)
);
CREATE INDEX IF NOT EXISTS file_tags_by_tag ON file_tags(tag);

CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  key TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);

-- Trigram tokens give substring matches like rg; triggers keep rows current.
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
  key UNINDEXED, slug, description, source, tags, tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS files_add AFTER INSERT ON files BEGIN
  INSERT INTO changes (key, action) VALUES (new.key, 'add');
  INSERT INTO search (key, slug, description, source, tags)
    VALUES (new.key, new.slug, new.description, new.source, '');
END;

CREATE TRIGGER IF NOT EXISTS files_describe
AFTER UPDATE OF description ON files
WHEN new.description IS NOT old.description BEGIN
  INSERT INTO changes (key, action, detail)
    VALUES (new.key, 'describe', new.description);
  UPDATE search SET description = new.description WHERE key = new.key;
END;

CREATE TRIGGER IF NOT EXISTS files_delete
AFTER UPDATE OF deleted_at ON files
WHEN new.deleted_at IS NOT NULL AND old.deleted_at IS NULL BEGIN
  INSERT INTO changes (key, action) VALUES (new.key, 'delete');
END;

CREATE TRIGGER IF NOT EXISTS files_restore
AFTER UPDATE OF deleted_at ON files
WHEN new.deleted_at IS NULL AND old.deleted_at IS NOT NULL BEGIN
  INSERT INTO changes (key, action) VALUES (new.key, 'restore');
END;

CREATE TRIGGER IF NOT EXISTS file_tags_add AFTER INSERT ON file_tags BEGIN
  INSERT INTO changes (key, action, detail) VALUES (new.key, 'tag', new.tag);
  UPDATE search SET tags = (
    SELECT group_concat(tag, ' ') FROM
      (SELECT tag FROM file_tags WHERE key = new.key ORDER BY tag)
  ) WHERE key = new.key;
END;

CREATE TRIGGER IF NOT EXISTS file_tags_remove AFTER DELETE ON file_tags BEGIN
  INSERT INTO changes (key, action, detail)
    VALUES (old.key, 'untag', old.tag);
  UPDATE search SET tags = coalesce((
    SELECT group_concat(tag, ' ') FROM
      (SELECT tag FROM file_tags WHERE key = old.key ORDER BY tag)
  ), '') WHERE key = old.key;
END;
"#;

/// Create or validate the schema. Older databases are migrated in place;
/// newer ones are refused so an old binary cannot corrupt them.
pub(super) fn ensure(connection: &Connection) -> Result<()> {
    connection.execute_batch("PRAGMA foreign_keys = ON;")?;
    connection.execute_batch(SCHEMA)?;
    let stored: Option<i64> = connection
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'version'",
            [],
            |row| row.get(0),
        )
        .ok();
    match stored {
        None => {
            connection.execute(
                "INSERT INTO meta (key, value) VALUES ('version', ?1)",
                [VERSION.to_string()],
            )?;
        }
        Some(version) => ensure!(
            version <= VERSION,
            "Index schema {version} is newer than this ud ({VERSION}); \
             update ud with just fs-install"
        ),
    }
    Ok(())
}
