//! Build identity helpers.

use serde::Serialize;

pub const BASE_VERSION: &str = env!("CARGO_PKG_VERSION");
pub(crate) const SOURCE: &str = "Unique-Divine/dotfiles";
const UPSTREAM_BASELINE: &str = "v0.9.3";
const UPSTREAM_COMMIT: &str = "7b116c05bfda646af39d2524c54e70c751f57ee8";

#[derive(Serialize)]
pub(crate) struct BuildInfo {
    pub version: String,
    pub channel: &'static str,
    pub source: &'static str,
    pub commit: Option<&'static str>,
    pub upstream_baseline: &'static str,
    pub upstream_commit: &'static str,
    pub update_provider: &'static str,
    pub update_command: Option<&'static str>,
}

pub(crate) fn current() -> BuildInfo {
    BuildInfo {
        version: version(),
        channel: channel(),
        source: SOURCE,
        commit: non_empty(option_env!("HERDR_SOURCE_COMMIT")),
        upstream_baseline: UPSTREAM_BASELINE,
        upstream_commit: UPSTREAM_COMMIT,
        update_provider: "dotfiles",
        update_command: if cfg!(windows) {
            None
        } else {
            Some("just herdr-install")
        },
    }
}

pub fn channel() -> &'static str {
    non_empty(option_env!("HERDR_BUILD_CHANNEL")).unwrap_or("stable")
}

pub fn build_id() -> Option<&'static str> {
    non_empty(option_env!("HERDR_BUILD_ID"))
}

pub fn version() -> String {
    match channel() {
        "stable" => BASE_VERSION.to_string(),
        channel => match build_id() {
            Some(build_id) => format!("{BASE_VERSION}-{channel}.{build_id}"),
            None => format!("{BASE_VERSION}-{channel}"),
        },
    }
}

pub fn is_preview() -> bool {
    channel() == "preview"
}

fn non_empty(value: Option<&'static str>) -> Option<&'static str> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn stable_version_defaults_to_cargo_version() {
        assert!(!super::version().is_empty());
    }
}
