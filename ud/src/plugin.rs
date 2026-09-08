use std::collections::BTreeSet;
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs::{self, DirBuilder, File, Permissions};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;

pub const BUILT_INS: &[&str] = &[
    "go", "rs", "md", "nibi", "docker", "health", "quick", "plugin",
];

const RESERVED_NAMES: &[&str] = &[
    "go", "rs", "md", "nibi", "docker", "health", "quick", "q", "cfg", "plugin",
    "help", "h",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMetadata {
    pub api_version: u32,
    pub name: String,
    pub description: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginCache {
    plugin_path: String,
    plugin_modified_nanos: u64,
    plugin_length: u64,
    metadata: PluginMetadata,
}

#[derive(Clone, Copy)]
struct Fingerprint {
    modified_nanos: u64,
    length: u64,
}

pub fn help_text() -> String {
    let names = plugin_names();
    if names.is_empty() {
        return String::new();
    }

    let mut lines = vec!["Installed plugins:".to_owned()];
    for name in names {
        match load_metadata(&name, false) {
            Ok((_, metadata)) => {
                lines.push(format!("  {name:<14} {}", metadata.description));
            }
            Err(_) => lines.push(format!("  {name}")),
        }
    }
    lines.join("\n")
}

pub fn list() -> Result<()> {
    println!("BUILT-IN");
    for name in BUILT_INS {
        println!("{name}");
    }
    println!("\nPLUGIN");
    for name in plugin_names() {
        let path = find_plugin(&name)?.ok_or_else(|| {
            anyhow!("ud plugin disappeared during discovery: {name}")
        })?;
        println!("{}\t{}", name, path.display());
    }
    Ok(())
}

pub fn info(name: &str) -> Result<()> {
    let (_, metadata) = load_metadata(name, false)?;
    println!("{}", serde_json::to_string_pretty(&metadata)?);
    Ok(())
}

pub fn doctor() -> Result<()> {
    for name in plugin_names() {
        if is_reserved(&name) {
            bail!("Plugin command collides with built-in: {name}");
        }
        load_metadata(&name, true)?;
    }
    println!("ud plugins are healthy.");
    Ok(())
}

pub fn dispatch(name: &OsStr, args: &[OsString]) -> Result<i32> {
    let name_text = name.to_string_lossy();
    let plugin = find_plugin(&name_text)?
        .ok_or_else(|| anyhow!("Unknown command: {name_text}"))?;
    let error = Command::new(&plugin)
        .args(args)
        .env("UD_PLUGIN_API_VERSION", "1")
        .env("UD_PLUGIN_NAME", name)
        .exec();
    Err(error).with_context(|| {
        format!("failed to run ud plugin: {}", plugin.display())
    })
}

fn load_metadata(
    name: &str,
    refresh: bool,
) -> Result<(PathBuf, PluginMetadata)> {
    validate_name(name)?;
    let plugin = find_plugin(name)?
        .ok_or_else(|| anyhow!("ud plugin is not installed: {name}"))?;
    let plugin_path = fs::canonicalize(&plugin).unwrap_or(plugin.clone());
    let fingerprint = fingerprint(&plugin_path)?;

    if !refresh && let Ok(metadata) = read_cache(name, &plugin_path, fingerprint)
    {
        return Ok((plugin, metadata));
    }

    let output = Command::new(&plugin)
        .arg("--plugin-info")
        .output()
        .with_context(|| format!("failed to inspect ud plugin: {name}"))?;
    if !output.status.success() {
        bail!("ud plugin metadata command failed: {name}");
    }
    let metadata: PluginMetadata = serde_json::from_slice(&output.stdout)
        .with_context(|| format!("Invalid metadata from ud plugin: {name}"))?;
    validate_metadata(name, &metadata)?;
    let _ = write_cache(name, &plugin_path, fingerprint, &metadata);
    Ok((plugin, metadata))
}

fn validate_metadata(name: &str, metadata: &PluginMetadata) -> Result<()> {
    if metadata.api_version != 1
        || metadata.name != name
        || metadata.description.is_empty()
    {
        bail!("Invalid metadata from ud plugin: {name}");
    }
    Ok(())
}

fn plugin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(data_home) = env::var_os("XDG_DATA_HOME") {
        dirs.push(PathBuf::from(data_home).join("ud/plugins"));
    } else if let Some(home) = env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join(".local/share/ud/plugins"));
    }
    if let Some(paths) = env::var_os("UD_PLUGIN_PATH") {
        dirs.extend(
            env::split_paths(&paths).filter(|path| !path.as_os_str().is_empty()),
        );
    }
    dirs
}

fn plugin_names() -> Vec<String> {
    let mut names = BTreeSet::new();
    for dir in plugin_dirs() {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !is_executable(&path) {
                continue;
            }
            let Some(file_name) = path.file_name().and_then(OsStr::to_str)
            else {
                continue;
            };
            if let Some(name) = file_name.strip_prefix("ud-")
                && !name.is_empty()
            {
                names.insert(name.to_owned());
            }
        }
    }
    names.into_iter().collect()
}

fn find_plugin(name: &str) -> Result<Option<PathBuf>> {
    validate_name(name)?;
    let mut matches = Vec::new();
    for dir in plugin_dirs() {
        let candidate = dir.join(format!("ud-{name}"));
        if is_executable(&candidate) {
            matches.push(candidate);
        }
    }
    match matches.len() {
        0 => Ok(None),
        1 => Ok(matches.pop()),
        _ => bail!("Duplicate ud plugin: {name}"),
    }
}

fn validate_name(name: &str) -> Result<()> {
    let valid = !name.is_empty()
        && name.bytes().enumerate().all(|(index, byte)| match byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' => true,
            b'.' | b'_' | b'-' => index > 0,
            _ => false,
        });
    if !valid {
        bail!("invalid ud plugin name: {name}");
    }
    Ok(())
}

fn is_reserved(name: &str) -> bool {
    RESERVED_NAMES.contains(&name)
}

fn is_executable(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|metadata| {
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    })
}

fn cache_file(name: &str) -> Result<PathBuf> {
    validate_name(name)?;
    let cache_home = if let Some(path) = env::var_os("XDG_CACHE_HOME") {
        PathBuf::from(path)
    } else {
        let home = env::var_os("HOME").context("HOME is not set")?;
        PathBuf::from(home).join(".cache")
    };
    Ok(cache_home
        .join("ud/plugin-metadata")
        .join(format!("{name}.json")))
}

fn fingerprint(path: &Path) -> Result<Fingerprint> {
    let metadata = fs::metadata(path).with_context(|| {
        format!("failed to inspect plugin: {}", path.display())
    })?;
    let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
    let nanos = modified
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .min(u128::from(u64::MAX)) as u64;
    Ok(Fingerprint {
        modified_nanos: nanos,
        length: metadata.len(),
    })
}

fn read_cache(
    name: &str,
    plugin_path: &Path,
    fingerprint: Fingerprint,
) -> Result<PluginMetadata> {
    let cache: PluginCache =
        serde_json::from_reader(File::open(cache_file(name)?)?)?;
    if cache.plugin_path != plugin_path.to_string_lossy()
        || cache.plugin_modified_nanos != fingerprint.modified_nanos
        || cache.plugin_length != fingerprint.length
    {
        bail!("plugin metadata cache is stale");
    }
    validate_metadata(name, &cache.metadata)?;
    Ok(cache.metadata)
}

fn write_cache(
    name: &str,
    plugin_path: &Path,
    fingerprint: Fingerprint,
    metadata: &PluginMetadata,
) -> Result<()> {
    let cache_path = cache_file(name)?;
    let cache_dir = cache_path
        .parent()
        .context("plugin metadata cache path has no parent")?;
    if !cache_dir.exists() {
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(cache_dir)?;
    }
    fs::set_permissions(cache_dir, Permissions::from_mode(0o700))?;

    let cache = PluginCache {
        plugin_path: plugin_path.to_string_lossy().into_owned(),
        plugin_modified_nanos: fingerprint.modified_nanos,
        plugin_length: fingerprint.length,
        metadata: metadata.clone(),
    };
    let mut temp = NamedTempFile::new_in(cache_dir)?;
    temp.as_file_mut()
        .set_permissions(Permissions::from_mode(0o600))?;
    serde_json::to_writer_pretty(temp.as_file_mut(), &cache)?;
    temp.persist(cache_path)?;
    Ok(())
}
