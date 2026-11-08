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

    /// The bounded HTTP client shared with the index store.
    pub fn client(&self) -> &Client {
        &self.client
    }

    /// Authenticate only after validating bucket/origin; never print
    /// token output.
    pub fn token(&self) -> Result<String> {
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
        Ok(token.trim().to_owned())
    }

    /// Fetch fresh metadata for every page under a prefix.
    pub fn list(&self, prefix: &str) -> Result<Vec<Record>> {
        let token = self.token()?;
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
                .bearer_auth(&token)
                .send()?
                .error_for_status()?
                .json()?)
        })
    }

    /// Return the stored size of one object, or `None` when it is absent.
    pub fn existing_size(&self, key: &str) -> Result<Option<u64>> {
        self.metadata(key, "size")?
            .map(|value| object_size(&value))
            .transpose()
    }

    /// Return the stored base64 MD5 of one object, or `None` when absent.
    pub fn existing_md5(&self, key: &str) -> Result<Option<String>> {
        self.metadata(key, "md5Hash")?
            .map(|value| {
                value
                    .get("md5Hash")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .context("Storage returned no MD5 for the object")
            })
            .transpose()
    }

    /// Selected metadata fields of one object, or `None` when it is absent.
    fn metadata(
        &self,
        key: &str,
        fields: &str,
    ) -> Result<Option<serde_json::Value>> {
        let token = self.token()?;
        let mut url = Url::parse(&format!(
            "https://storage.googleapis.com/storage/v1/b/{}/o/",
            self.config.bucket
        ))?;
        // One encoded segment keeps directory separators inside the name.
        url.path_segments_mut()
            .map_err(|()| anyhow::anyhow!("Invalid storage URL"))?
            .pop_if_empty()
            .push(key);
        url.query_pairs_mut().append_pair("fields", fields);
        let response = self.client.get(url).bearer_auth(&token).send()?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        Ok(Some(response.error_for_status()?.json()?))
    }

    /// Refuse existing names unless `replace` is set; MD5 also detects file
    /// changes mid-upload.
    pub fn upload(
        &self,
        file: &Path,
        key: &str,
        digest: &str,
        replace: bool,
    ) -> Result<()> {
        let status =
            upload_command("gcloud", self.config, file, key, digest, replace)
                .stdout(Stdio::from(std::io::stderr()))
                .status()
                .context("gcloud is required")?;
        if replace {
            ensure!(status.success(), "Upload failed");
        } else {
            ensure!(
                status.success(),
                "Upload failed. Existing names are not overwritten without --replace; use --replace or a different slug"
            );
        }
        Ok(())
    }

    /// Delete one object. The public bucket keeps it for seven days under
    /// soft delete, so `gcloud storage restore` can undo this.
    pub fn delete(&self, key: &str) -> Result<()> {
        ensure!(
            super::naming::safe_key(key),
            "Refusing to delete an unsafe key: {key}"
        );
        let status = Command::new("gcloud")
            .args(["storage", "rm"])
            .arg(format!("gs://{}/{key}", self.config.bucket))
            .args([
                "--project",
                &self.config.project,
                "--account",
                &self.config.account,
            ])
            .stdout(Stdio::from(std::io::stderr()))
            .status()
            .context("gcloud is required")?;
        ensure!(status.success(), "Deleting {key} failed");
        Ok(())
    }

    /// Purge the Hosting CDN with a new release of identical content.
    /// Firebase refuses to re-release the active version, so this clones it
    /// first; every release clears cached responses, including `/f/`.
    pub fn purge_cdn(&self, key: &str) -> Result<()> {
        let token = self.token()?;
        ensure!(
            matches(r"^[a-z0-9][a-z0-9-]*$", &self.config.hosting_site),
            "Hosting site must be a Firebase site ID"
        );
        let api = "https://firebasehosting.googleapis.com/v1beta1";
        let site = format!("{api}/sites/{}", self.config.hosting_site);
        let call =
            |request: reqwest::blocking::RequestBuilder| -> Result<Value> {
                Ok(request
                    .bearer_auth(&token)
                    .header("x-goog-user-project", &self.config.project)
                    .send()?
                    .error_for_status()?
                    .json()?)
            };
        let live = call(self.client.get(format!("{site}/channels/live")))?;
        let source = live_version(&live, &self.config.hosting_site)?;
        let mut operation =
            call(self.client.post(format!("{site}/versions:clone")).json(
                &serde_json::json!({
                    "sourceVersion": source,
                    "finalize": true,
                }),
            ))?;
        let name = operation
            .get("name")
            .and_then(Value::as_str)
            .context("Hosting clone returned no operation")?
            .to_owned();
        ensure!(
            matches(r"^projects/[0-9]+/operations/[A-Za-z0-9_-]+$", &name),
            "Hosting clone returned an invalid operation"
        );
        for attempt in 0..30 {
            if operation.get("done").and_then(Value::as_bool) == Some(true) {
                break;
            }
            thread::sleep(Duration::from_secs(1 + attempt.min(4)));
            operation = call(self.client.get(format!("{api}/{name}")))?;
        }
        let version = cloned_version(&operation, &self.config.hosting_site)?;
        let mut url = Url::parse(&format!("{site}/channels/live/releases"))?;
        url.query_pairs_mut().append_pair("versionName", &version);
        call(self.client.post(url).json(&serde_json::json!({
            "message": format!("ud fs publish --replace {key}: purge CDN")
        })))?;
        Ok(())
    }

    /// Retry until the public body has the uploaded MD5, so stale CDN bytes
    /// fail verification even when the size is unchanged.
    pub fn verify_digest(&self, url: &str, digest: &str) -> Result<()> {
        verify_digest(&self.client, url, digest, 8, |attempt| {
            thread::sleep(Duration::from_secs(2 + attempt as u64));
        })
    }

    /// Retry public visibility before reporting successful publication.
    pub fn verify(&self, url: &str, expected_size: u64) -> Result<()> {
        verify(&self.client, url, expected_size, 5, |attempt| {
            thread::sleep(Duration::from_secs(1 + attempt as u64));
        })
    }
}

/// Read the decimal size string from GCS object metadata.
pub(super) fn object_size(metadata: &Value) -> Result<u64> {
    metadata
        .get("size")
        .and_then(Value::as_str)
        .and_then(|size| size.parse().ok())
        .context("Storage returned invalid object metadata")
}

/// Extract the live version name, refusing versions from another site.
pub(super) fn live_version(channel: &Value, site: &str) -> Result<String> {
    let version = channel
        .pointer("/release/version/name")
        .and_then(Value::as_str)
        .context("Hosting live channel has no released version")?;
    ensure!(
        version.starts_with(&format!("sites/{site}/versions/")),
        "Hosting returned a version from another site"
    );
    Ok(version.to_owned())
}

/// Extract the finalized version from a completed clone operation.
pub(super) fn cloned_version(operation: &Value, site: &str) -> Result<String> {
    ensure!(
        operation.get("done").and_then(Value::as_bool) == Some(true),
        "Hosting clone did not finish in time"
    );
    if let Some(error) = operation.get("error") {
        bail!("Hosting clone failed: {error}");
    }
    let response = operation
        .get("response")
        .context("Hosting clone returned no version")?;
    ensure!(
        response.get("status").and_then(Value::as_str) == Some("FINALIZED"),
        "Hosting clone did not finalize the version"
    );
    live_version(&serde_json::json!({"release":{"version":response}}), site)
}

/// Assemble literal argv, keeping user paths out of shell interpolation.
pub(super) fn upload_command(
    program: &str,
    config: &Settings,
    file: &Path,
    key: &str,
    digest: &str,
    replace: bool,
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
        .args(["--project", &config.project, "--account", &config.account]);
    if !replace {
        // Generation 0 matches only an absent object, so creation is atomic.
        command.arg("--if-generation-match=0");
    }
    command
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

/// Compare the full public body with the base64 MD5 sent to storage.
pub(super) fn verify_digest(
    client: &Client,
    url: &str,
    expected: &str,
    attempts: usize,
    mut pause: impl FnMut(usize),
) -> Result<()> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use md5::{Digest, Md5};
    for attempt in 0..attempts {
        let result = (|| {
            let response = client.get(url).send()?;
            ensure!(
                response.status() == 200,
                "Public response has unexpected status"
            );
            let actual = STANDARD.encode(Md5::digest(response.bytes()?));
            ensure!(
                actual == expected,
                "Public response still serves different bytes"
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
