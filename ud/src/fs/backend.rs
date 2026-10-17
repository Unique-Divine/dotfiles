//! Google authentication and transfer boundaries; credentials never reach stdout.
use anyhow::{Context, Result, bail, ensure};
use reqwest::{Url, blocking::Client};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
    process::{Command, Stdio},
    thread,
    time::Duration,
};

use super::{
    config::Settings,
    listing::{self, Record},
    naming::{inline_type, matches, public_url},
};

/// Borrowed settings and a bounded HTTP client for fresh metadata reads.
pub(super) struct Gcs<'a> {
    config: &'a Settings,
    client: Client,
}

impl<'a> Gcs<'a> {
    /// Bound each request to the legacy tool's thirty-second timeout.
    pub fn new(config: &'a Settings) -> Result<Self> {
        Ok(Self {
            config,
            client: Client::builder()
                .timeout(Duration::from_secs(30))
                .build()?,
        })
    }

    /// Authenticate only after validating bucket/origin; never print
    /// token output.
    pub fn list(&self, prefix: &str) -> Result<Vec<Record>> {
        public_url("validation", &self.config.base_url)?;
        ensure!(
            matches(r"^[a-z0-9][a-z0-9._-]*$", &self.config.bucket),
            "Bucket must be a Google Storage bucket name"
        );
        let auth = Command::new("gcloud")
            .args([
                "auth",
                "print-access-token",
                "--account",
                &self.config.account,
                "--project",
                &self.config.project,
            ])
            .output()
            .context("gcloud is required")?;
        let token = String::from_utf8(auth.stdout)?;
        ensure!(
            auth.status.success() && !token.trim().is_empty(),
            "Google authentication failed. Sign in with gcloud auth login {}",
            self.config.account
        );
        collect_pages(&self.config.base_url, |cursor| {
            let mut url = Url::parse(&format!(
                "https://storage.googleapis.com/storage/v1/b/{}/o",
                self.config.bucket
            ))?;
            url.query_pairs_mut()
                .append_pair("prefix", prefix)
                .append_pair("maxResults", "1000")
                .append_pair(
                    "fields",
                    "items(name,size,contentType),nextPageToken",
                );
            if let Some(cursor) = cursor {
                url.query_pairs_mut().append_pair("pageToken", cursor);
            }
            // Errors contain the request URL, never the Authorization header.
            Ok(self
                .client
                .get(url)
                .bearer_auth(token.trim())
                .send()?
                .error_for_status()?
                .json()?)
        })
    }

    /// Never replace an existing object; MD5 also detects file changes
    /// mid-upload.
    pub fn upload(&self, file: &Path, key: &str, digest: &str) -> Result<()> {
        let status = upload_command("gcloud", self.config, file, key, digest)
            .stdout(Stdio::from(std::io::stderr()))
            .status()
            .context("gcloud is required")?;
        ensure!(
            status.success(),
            "Upload failed. Existing names are never overwritten; use a different slug for another version"
        );
        Ok(())
    }

    /// Retry public visibility before reporting successful publication.
    pub fn verify(&self, url: &str, expected_size: u64) -> Result<()> {
        verify(&self.client, url, expected_size, 5, |attempt| {
            thread::sleep(Duration::from_secs(1 + attempt as u64));
        })
    }
}

/// Assemble literal argv, keeping user paths out of shell interpolation.
pub(super) fn upload_command(
    program: &str,
    config: &Settings,
    file: &Path,
    key: &str,
    digest: &str,
) -> Command {
    let mut command = Command::new(program);
    let mime = inline_type(key).unwrap_or("application/octet-stream");
    let disposition = if inline_type(key).is_some() {
        "inline"
    } else {
        "attachment"
    };
    command
        .arg("storage")
        .arg("cp")
        .arg(file)
        .arg(format!("gs://{}/{key}", config.bucket))
        .args(["--project", &config.project, "--account", &config.account])
        .arg("--if-generation-match=0")
        .arg(format!("--content-md5={digest}"))
        .arg("--cache-control=public,max-age=300,no-transform")
        .arg(format!("--content-type={mime}"))
        .arg(format!(
            "--content-disposition={disposition}; filename=\"{}\"",
            Path::new(key)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
        ));
    command
}

/// Aggregate complete pages before output, deduplicate by key and reject loops.
/// The page reader separates authenticated HTTP from deterministic aggregation.
pub(super) fn collect_pages(
    origin: &str,
    mut read: impl FnMut(Option<&str>) -> Result<Value>,
) -> Result<Vec<Record>> {
    let mut records = BTreeMap::new();
    let mut seen = HashSet::new();
    let mut cursor: Option<String> = None;
    let mut skipped = 0;
    loop {
        let page = read(cursor.as_deref())?;
        let object = page
            .as_object()
            .context("Storage returned an invalid listing")?;
        if let Some(items) = object.get("items") {
            for item in items
                .as_array()
                .context("Storage returned an invalid listing")?
            {
                if let Some(record) = listing::normalize(item, origin)? {
                    records.insert(record.key.clone(), record);
                } else {
                    skipped += 1;
                }
            }
        }
        match object.get("nextPageToken") {
            None | Some(Value::Null) => break,
            Some(Value::String(value)) if value.is_empty() => break,
            Some(Value::String(value)) if seen.insert(value.clone()) => {
                cursor = Some(value.clone())
            }
            _ => bail!("Storage returned invalid pagination"),
        }
    }
    if skipped > 0 {
        eprintln!(
            "Skipped {skipped} folder markers or names unsupported by the public file server."
        );
    }
    Ok(records.into_values().collect())
}

/// Verify status and Content-Length together; tests use an actual local server.
pub(super) fn verify(
    client: &Client,
    url: &str,
    expected: u64,
    attempts: usize,
    mut pause: impl FnMut(usize),
) -> Result<()> {
    for attempt in 0..attempts {
        let result = (|| {
            let response = client.head(url).send()?;
            let size = response
                .headers()
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok());
            ensure!(
                response.status() == 200 && size == Some(expected),
                "Public response has unexpected status or size"
            );
            Ok(())
        })();
        match result {
            Ok(()) => return Ok(()),
            Err(error) if attempt + 1 == attempts => return Err(error),
            Err(_) => pause(attempt),
        }
    }
    bail!("No verification attempts configured")
}
