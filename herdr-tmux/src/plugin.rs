//! Herdr registration and popup launchers; the picker stays a standalone CLI.
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use clap::{Subcommand, ValueEnum};
use serde_json::Value;

use crate::app::CliTarget;

pub const PLUGIN_ID: &str = "unique-divine.herdr-tmux";
const MANIFEST: &str = include_str!("../herdr-plugin.toml");
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Debug, Subcommand)]
pub enum PluginCommand {
    /// Link the installed binary into Herdr. Does not change key bindings.
    Register,
    /// Open a registered plugin picker over the active pane.
    Open { picker: Picker },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum Picker {
    Pane,
    Agent,
}

impl Picker {
    fn entrypoint(self) -> &'static str {
        match self {
            Self::Pane => "pane-picker",
            Self::Agent => "agent-picker",
        }
    }
}

pub fn run(command: &PluginCommand, target: CliTarget) -> Result<()> {
    let herdr = env::var_os("HERDR_BIN_PATH").unwrap_or_else(|| "herdr".into());
    match command {
        PluginCommand::Register => {
            let root = registration_root()?;
            register(Path::new(&herdr), &env::current_exe()?, &root)
        }
        PluginCommand::Open { picker } => {
            let mut process = Command::new(herdr);
            if let Some(socket) = target.socket_path {
                process.env("HERDR_SOCKET_PATH", socket);
            }
            process.args(open_args(*picker));
            if !process.status()?.success() {
                return Err("Herdr could not open the plugin picker".into());
            }
            Ok(())
        }
    }
}

fn open_args(picker: Picker) -> Vec<String> {
    [
        "plugin",
        "pane",
        "open",
        "--plugin",
        PLUGIN_ID,
        "--entrypoint",
        picker.entrypoint(),
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

fn registration_root() -> Result<PathBuf> {
    let data =
        match env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty()) {
            Some(path) => PathBuf::from(path),
            None => PathBuf::from(env::var_os("HOME").ok_or("HOME is unset")?)
                .join(".local/share"),
        };
    if !data.is_absolute() {
        return Err("plugin data directory must be absolute".into());
    }
    Ok(data.join("herdr-tmux/plugin"))
}

fn installed_manifest(executable: &Path) -> Result<String> {
    let mut manifest: toml::Value = toml::from_str(MANIFEST)?;
    manifest
        .as_table_mut()
        .ok_or("invalid embedded manifest")?
        .remove("build");
    let executable =
        executable.to_str().ok_or("executable path is not UTF-8")?;
    for section in ["actions", "panes"] {
        for item in manifest[section]
            .as_array_mut()
            .ok_or("invalid entrypoints")?
        {
            item["command"].as_array_mut().ok_or("invalid command")?[0] =
                executable.into();
        }
    }
    Ok(toml::to_string_pretty(&manifest)?)
}

fn check_registration(response: &Value, root: &Path) -> Result<()> {
    let plugins = response
        .get("result")
        .and_then(|r| r.get("plugins"))
        .and_then(Value::as_array)
        .ok_or("invalid Herdr plugin list response")?;
    for plugin in plugins {
        if plugin["plugin_id"].as_str() != Some(PLUGIN_ID) {
            continue;
        }
        let same_root =
            plugin["plugin_root"].as_str().map(Path::new) == Some(root);
        let local = plugin["source"]["kind"].as_str() == Some("local");
        if !same_root || !local {
            return Err(format!("{PLUGIN_ID} is already installed elsewhere; unlink or uninstall it explicitly before registering this binary").into());
        }
    }
    Ok(())
}

fn register(herdr: &Path, executable: &Path, root: &Path) -> Result<()> {
    let listing = Command::new(herdr)
        .args(["plugin", "list", "--json"])
        .output()?;
    if !listing.status.success() {
        return Err(format!(
            "could not list Herdr plugins: {}",
            String::from_utf8_lossy(&listing.stderr)
        )
        .into());
    }
    check_registration(&serde_json::from_slice(&listing.stdout)?, root)?;
    fs::create_dir_all(root)?;
    let manifest_path = root.join("herdr-plugin.toml");
    let previous = match fs::read(&manifest_path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    fs::write(&manifest_path, installed_manifest(executable)?)?;
    let linked = Command::new(herdr)
        .args(["plugin", "link"])
        .arg(root)
        .status();
    match linked {
        Ok(status) if status.success() => {
            println!("Registered {PLUGIN_ID}. Add the plugin action bindings from the README.");
            Ok(())
        }
        result => {
            if let Some(previous) = previous {
                fs::write(&manifest_path, previous)?;
            } else {
                fs::remove_file(&manifest_path)?;
            }
            match result {
                Err(error) => Err(error.into()),
                _ => Err("Herdr plugin registration failed".into()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn manifest_versions_and_paths_match() {
        let source: toml::Value = toml::from_str(MANIFEST).unwrap();
        assert_eq!(source["version"].as_str(), Some(env!("CARGO_PKG_VERSION")));
        assert_eq!(source["id"].as_str(), Some(PLUGIN_ID));
        let executable = Path::new("/tmp/path with spaces/herdr-tmux");
        let installed: toml::Value =
            toml::from_str(&installed_manifest(executable).unwrap()).unwrap();
        assert!(installed.get("build").is_none());
        for section in ["actions", "panes"] {
            for item in installed[section].as_array().unwrap() {
                assert_eq!(item["command"][0].as_str(), executable.to_str());
            }
        }
    }

    #[test]
    fn registration_rejects_conflicts_and_accepts_own_root() {
        let root = Path::new("/tmp/own-plugin");
        let mut response = json!({"result": {"plugins": [{"plugin_id": PLUGIN_ID,
            "plugin_root": root, "source": {"kind": "local"}}]}});
        assert!(check_registration(&response, root).is_ok());
        response["result"]["plugins"][0]["source"]["kind"] = json!("github");
        assert!(check_registration(&response, root).is_err());
        response["result"]["plugins"][0]["source"]["kind"] = json!("local");
        response["result"]["plugins"][0]["plugin_root"] = json!("/tmp/another");
        assert!(check_registration(&response, root).is_err());
        assert!(check_registration(&json!({}), root).is_err());
    }

    #[test]
    fn popup_arguments_use_registered_entrypoints() {
        for picker in [Picker::Pane, Picker::Agent] {
            let args = open_args(picker);
            assert_eq!(args[4], PLUGIN_ID);
            assert_eq!(args[6], picker.entrypoint());
            assert_eq!(args.len(), 7);
        }
    }

    #[test]
    fn failed_registration_restores_manifest() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("plugin with spaces");
        let runner = directory.path().join("herdr test fixture");
        fs::write(&runner, "#!/bin/sh\nif [ \"$2\" = list ]; then\n  printf '%s\\n' '{\"result\":{\"plugins\":[]}}'\nelse\n  exit 1\nfi\n").unwrap();
        fs::set_permissions(&runner, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            register(&runner, Path::new("/tmp/bin/herdr-tmux"), &root).is_err()
        );
        let manifest = root.join("herdr-plugin.toml");
        assert!(!manifest.exists());
        fs::write(&manifest, "previous manifest").unwrap();
        assert!(
            register(&runner, Path::new("/tmp/bin/herdr-tmux"), &root).is_err()
        );
        assert_eq!(fs::read_to_string(manifest).unwrap(), "previous manifest");
    }
}
