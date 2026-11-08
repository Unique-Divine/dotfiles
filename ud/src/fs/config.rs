//! Credential-free settings, with compatibility for the retired `pub` tool.
use std::{
    env, fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use serde_json::{Map, Value};

/// Non-secret configuration used by both Google subprocesses and public URLs.
#[derive(Debug)]
pub(super) struct Settings {
    /// HTTPS serving origin, never a URL containing a path or credentials.
    pub base_url: String,
    /// Private GCS bucket whose objects are served by that origin.
    pub bucket: String,
    /// Firebase Hosting site whose CDN caches `/f/` responses.
    pub hosting_site: String,
    /// Private bucket holding the index database; never served publicly.
    pub meta_bucket: String,
    /// Local directory standing in for the meta bucket, for tests and
    /// offline use. Unset in normal operation.
    pub index_dir: Option<String>,
    /// Directories `refs` and `rm` search for backlinks to published URLs.
    pub ref_roots: Vec<PathBuf>,
    /// Google project passed explicitly to avoid changing CLI defaults.
    pub project: String,
    /// Owner login passed explicitly so another active account is not used.
    pub account: String,
}

impl Settings {
    /// Load legacy then current JSON; environment variables have final
    /// priority.
    pub fn load() -> Result<Self> {
        let root = env::var_os("XDG_CONFIG_HOME")
            .map(Into::into)
            .or_else(|| {
                env::var_os("HOME").map(|p| Path::new(&p).join(".config"))
            })
            .context("HOME or XDG_CONFIG_HOME must be set")?;
        Self::from_sources(&root, |key| env::var(key).ok())
    }

    /// Accept an environment reader so precedence tests never mutate
    /// global state.
    pub fn from_sources(
        root: &Path,
        lookup: impl Fn(&str) -> Option<String>,
    ) -> Result<Self> {
        let mut values = Map::new();
        for relative in ["pub/config.json", "ud/fs/config.json"] {
            let path = root.join(relative);
            match fs::read(&path) {
                Ok(bytes) => {
                    let value: Value = serde_json::from_slice(&bytes)
                        .with_context(|| {
                            format!("Invalid config: {}", path.display())
                        })?;
                    let Some(object) = value.as_object() else {
                        bail!(
                            "Configuration must be a JSON object: {}",
                            path.display()
                        );
                    };
                    values.extend(object.clone());
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => return Err(error.into()),
            }
        }
        let setting = |key: &str, current: &str, legacy: &str, default: &str| {
            if let Some(value) = lookup(current).or_else(|| lookup(legacy)) {
                return Ok(value);
            }
            match values.get(key) {
                Some(Value::String(value)) => Ok(value.clone()),
                Some(_) => bail!("Configuration {key} must be a string"),
                None => Ok(default.to_owned()),
            }
        };
        Ok(Self {
            base_url: setting(
                "base_url",
                "UD_FS_BASE_URL",
                "PUB_BASE_URL",
                "https://uniquedivine.com",
            )?,
            bucket: setting(
                "bucket",
                "UD_FS_BUCKET",
                "PUB_BUCKET",
                "uniquedivine-public-files-876932632137",
            )?,
            hosting_site: setting(
                "hosting_site",
                "UD_FS_HOSTING_SITE",
                "UD_FS_HOSTING_SITE",
                "uniquedivine-site",
            )?,
            meta_bucket: setting(
                "meta_bucket",
                "UD_FS_META_BUCKET",
                "UD_FS_META_BUCKET",
                "ud-fs-meta-876932632137",
            )?,
            index_dir: lookup("UD_FS_INDEX_DIR").or_else(|| {
                match values.get("index_dir") {
                    Some(Value::String(value)) => Some(value.clone()),
                    _ => None,
                }
            }),
            ref_roots: ref_roots(&values, &lookup),
            project: "exalted-justice-359714".into(),
            account: "realuniquedivine@gmail.com".into(),
        })
    }
}

/// Backlink roots from `UD_FS_REF_ROOTS` (colon-separated), then the
/// `ref_roots` config array, then `~/ki`. A leading `~/` expands to HOME.
fn ref_roots(
    values: &Map<String, Value>,
    lookup: &impl Fn(&str) -> Option<String>,
) -> Vec<PathBuf> {
    let home = lookup("HOME").map(PathBuf::from);
    let expand = |value: &str| match (value.strip_prefix("~/"), &home) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(value),
    };
    if let Some(value) = lookup("UD_FS_REF_ROOTS") {
        return value
            .split(':')
            .filter(|v| !v.is_empty())
            .map(expand)
            .collect();
    }
    if let Some(Value::Array(items)) = values.get("ref_roots") {
        return items.iter().filter_map(Value::as_str).map(expand).collect();
    }
    home.map(|h| vec![h.join("ki")]).unwrap_or_default()
}
