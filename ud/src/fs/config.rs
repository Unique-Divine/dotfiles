//! Credential-free settings, with compatibility for the retired `pub` tool.
use std::{env, fs, path::Path};

use anyhow::{Context, Result, bail};
use serde_json::{Map, Value};

/// Non-secret configuration used by both Google subprocesses and public URLs.
#[derive(Debug)]
pub(super) struct Settings {
    /// HTTPS serving origin, never a URL containing a path or credentials.
    pub base_url: String,
    /// Private GCS bucket whose objects are served by that origin.
    pub bucket: String,
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
            project: "exalted-justice-359714".into(),
            account: "realuniquedivine@gmail.com".into(),
        })
    }
}
