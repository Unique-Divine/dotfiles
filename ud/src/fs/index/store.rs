//! Where the index database lives, and how machines avoid overwriting each
//! other. Every remote copy has a generation number; a write uploads only if
//! the remote generation is still the one it started from.
use anyhow::{Context, Result, bail, ensure};
use reqwest::{StatusCode, Url};
use serde_json::Value;
use std::{fs, path::Path};

use super::super::backend::Gcs;

/// Object name of the database inside the private meta bucket.
pub(in crate::fs) const OBJECT: &str = "fs.db";

/// A remote copy of the database with compare-and-swap uploads.
pub(in crate::fs) trait Store {
    /// The current remote generation, or `None` when nothing is stored yet.
    fn generation(&self) -> Result<Option<i64>>;
    /// Download the database to `to` and return the generation it came from.
    fn download(&self, to: &Path) -> Result<i64>;
    /// Upload `from` only if the remote generation still equals `expected`
    /// (`None` means the object must be absent). Returns the new generation,
    /// or `None` when another writer changed the remote copy first.
    fn upload(&self, from: &Path, expected: Option<i64>) -> Result<Option<i64>>;
}

/// The production store: one object in the private meta bucket.
pub(in crate::fs) struct GcsStore<'a> {
    pub gcs: &'a Gcs<'a>,
    pub bucket: String,
}

impl GcsStore<'_> {
    /// Object metadata or media URL for the database object.
    fn object_url(&self) -> Result<Url> {
        ensure!(
            super::super::naming::matches(
                r"^[a-z0-9][a-z0-9._-]*$",
                &self.bucket
            ),
            "Meta bucket must be a Google Storage bucket name"
        );
        let mut url = Url::parse(&format!(
            "https://storage.googleapis.com/storage/v1/b/{}/o/",
            self.bucket
        ))?;
        url.path_segments_mut()
            .map_err(|()| anyhow::anyhow!("Invalid storage URL"))?
            .pop_if_empty()
            .push(OBJECT);
        Ok(url)
    }
}

/// Parse GCS's decimal-string generation field.
fn parse_generation(value: &Value) -> Result<i64> {
    value
        .get("generation")
        .and_then(Value::as_str)
        .and_then(|v| v.parse().ok())
        .context("Storage returned no generation for the index")
}

impl Store for GcsStore<'_> {
    fn generation(&self) -> Result<Option<i64>> {
        let token = self.gcs.token()?;
        let mut url = self.object_url()?;
        url.query_pairs_mut().append_pair("fields", "generation");
        let response = self.gcs.client().get(url).bearer_auth(&token).send()?;
        if response.status() == StatusCode::NOT_FOUND {
            // A missing object means a new index; a missing bucket is a
            // configuration error that must not look like an empty index.
            let bucket = Url::parse(&format!(
                "https://storage.googleapis.com/storage/v1/b/{}",
                self.bucket
            ))?;
            let status = self
                .gcs
                .client()
                .get(bucket)
                .bearer_auth(&token)
                .send()?
                .status();
            ensure!(
                status != StatusCode::NOT_FOUND,
                "Meta bucket {} does not exist; check UD_FS_META_BUCKET",
                self.bucket
            );
            return Ok(None);
        }
        parse_generation(&response.error_for_status()?.json()?).map(Some)
    }

    fn download(&self, to: &Path) -> Result<i64> {
        let token = self.gcs.token()?;
        let mut url = self.object_url()?;
        url.query_pairs_mut().append_pair("alt", "media");
        let response = self
            .gcs
            .client()
            .get(url)
            .bearer_auth(&token)
            .send()?
            .error_for_status()?;
        let generation = response
            .headers()
            .get("x-goog-generation")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .context("Storage returned no generation for the index")?;
        fs::write(to, response.bytes()?)?;
        Ok(generation)
    }

    fn upload(&self, from: &Path, expected: Option<i64>) -> Result<Option<i64>> {
        let token = self.gcs.token()?;
        let mut url = Url::parse(&format!(
            "https://storage.googleapis.com/upload/storage/v1/b/{}/o",
            self.bucket
        ))?;
        url.query_pairs_mut()
            .append_pair("uploadType", "media")
            .append_pair("name", OBJECT)
            .append_pair("ifGenerationMatch", &expected.unwrap_or(0).to_string())
            .append_pair("fields", "generation");
        let response = self
            .gcs
            .client()
            .post(url)
            .bearer_auth(&token)
            .header("content-type", "application/vnd.sqlite3")
            .body(fs::read(from)?)
            .send()?;
        if response.status() == StatusCode::PRECONDITION_FAILED {
            return Ok(None);
        }
        parse_generation(&response.error_for_status()?.json()?).map(Some)
    }
}

/// A store in a local directory, emulating generations with a counter file.
/// Tests use it, and it works for an offline or self-hosted index.
pub(in crate::fs) struct DirStore {
    pub root: std::path::PathBuf,
}

impl DirStore {
    fn counter(&self) -> std::path::PathBuf {
        self.root.join(format!("{OBJECT}.generation"))
    }
}

impl Store for DirStore {
    fn generation(&self) -> Result<Option<i64>> {
        match fs::read_to_string(self.counter()) {
            Ok(value) => Ok(Some(value.trim().parse()?)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(None)
            }
            Err(error) => Err(error.into()),
        }
    }

    fn download(&self, to: &Path) -> Result<i64> {
        let Some(generation) = self.generation()? else {
            bail!("No index stored in {}", self.root.display());
        };
        fs::copy(self.root.join(OBJECT), to)?;
        Ok(generation)
    }

    fn upload(&self, from: &Path, expected: Option<i64>) -> Result<Option<i64>> {
        if self.generation()? != expected {
            return Ok(None);
        }
        let next = expected.unwrap_or(0) + 1;
        fs::create_dir_all(&self.root)?;
        fs::copy(from, self.root.join(OBJECT))?;
        fs::write(self.counter(), next.to_string())?;
        Ok(Some(next))
    }
}
