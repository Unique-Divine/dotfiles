use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::ffi::OsStr;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::app::{
    configured_tab_display_index_base, herdr_config_path, Client, HerdrError,
    Target,
};

#[derive(Serialize, Deserialize)]
struct Tab {
    tab_id: String,
    workspace_id: String,
    label: String,
    focused: bool,
    pane_count: usize,
    agent_status: String,
    #[serde(default)]
    agent_count: usize,
    #[serde(default)]
    status_icon: String,
}

#[derive(Deserialize)]
struct TabList {
    tabs: Vec<Tab>,
}

#[derive(Deserialize)]
struct SnapshotResponse {
    snapshot: Snapshot,
}

#[derive(Deserialize)]
struct Snapshot {
    workspaces: Vec<Workspace>,
    tabs: Vec<Tab>,
    agents: Vec<AgentLocation>,
}

#[derive(Deserialize)]
struct Workspace {
    workspace_id: String,
    label: String,
}

#[derive(Deserialize)]
struct AgentLocation {
    tab_id: String,
}

#[derive(Serialize)]
struct EditorWorkspace {
    workspace_id: String,
    label: String,
    tabs: Vec<Tab>,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
struct WorkspaceOrder {
    workspace_id: String,
    tab_ids: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct WorkspaceEdit {
    original: Vec<WorkspaceOrder>,
    desired: Vec<WorkspaceOrder>,
}

#[derive(Serialize, Deserialize)]
struct SavedOrder {
    order: Vec<WorkspaceOrder>,
    tab_id_changes: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct Edit {
    original: Vec<String>,
    desired: Vec<String>,
}

pub(crate) fn edit(target: &Target) -> Result<(), HerdrError> {
    let executable = env::current_exe()?;
    let base = configured_tab_display_index_base().to_string();
    let nord = editor_uses_nord();
    let launch = |nvim: PathBuf| {
        Command::new(nvim)
            .args(["-u", "NONE", "-i", "NONE", "-n"])
            .arg("-c")
            .arg(concat!("lua ", include_str!("tab_editor.lua")))
            .env("HERDR_TMUX_BIN", &executable)
            .env("HERDR_TMUX_SOCKET", &target.socket_path)
            .env("HERDR_TMUX_TAB", &target.tab_id)
            .env("HERDR_TMUX_PANE", &target.pane_id)
            .env("HERDR_TMUX_TAB_BASE", &base)
            .env("HERDR_TMUX_NORD", if nord { "1" } else { "0" })
            .exec()
    };
    let home = env::var_os("HOME").map(PathBuf::from);
    let path = env::var_os("PATH");
    let shim =
        home.as_deref()
            .zip(path.as_deref())
            .is_some_and(|(home, path)| {
                path_uses_mise(path, &home.join(".local/bin/mise"))
            });
    let launch_mise = || home.as_deref().and_then(mise_nvim).map(&launch);
    let launch_from_path = || launch(PathBuf::from("nvim"));
    let error = if shim {
        // The shim does more startup work than resolving the pinned binary.
        launch_mise().unwrap_or_else(launch_from_path)
    } else {
        let error = launch_from_path();
        if error.kind() == io::ErrorKind::NotFound {
            launch_mise().unwrap_or(error)
        } else {
            error
        }
    };
    Err(HerdrError::Target(format!(
        "could not start nvim for the tab editor: {error}"
    )))
}

fn path_uses_mise(path: &OsStr, mise: &Path) -> bool {
    let Ok(mise) = mise.canonicalize() else {
        return false;
    };
    env::split_paths(path)
        .map(|dir| dir.join("nvim"))
        .find(|candidate| {
            candidate.metadata().is_ok_and(|metadata| {
                metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
            })
        })
        .and_then(|candidate| candidate.canonicalize().ok())
        .is_some_and(|candidate| candidate == mise)
}

fn mise_nvim(home: &Path) -> Option<PathBuf> {
    let result = Command::new(home.join(".local/bin/mise"))
        .arg("--cd")
        .arg(home)
        .args(["which", "nvim"])
        .env("MISE_AUTO_INSTALL", "false")
        .output()
        .ok()?;
    let nvim = PathBuf::from(std::str::from_utf8(&result.stdout).ok()?.trim());
    (result.status.success() && nvim.is_absolute()).then_some(nvim)
}

fn editor_uses_nord() -> bool {
    let Ok(content) = std::fs::read_to_string(herdr_config_path()) else {
        return false;
    };
    let Ok(config) = toml::from_str::<toml::Table>(&content) else {
        return false;
    };
    let Some(theme) = config.get("theme").and_then(toml::Value::as_table) else {
        return false;
    };
    theme.get("name").and_then(toml::Value::as_str) == Some("nord")
        && theme.get("auto_switch").and_then(toml::Value::as_bool) != Some(true)
        && !theme.contains_key("custom")
}

pub(crate) fn tab_order(target: &Target, apply: bool) -> Result<(), HerdrError> {
    let client = Client::new(target.socket_path.clone());
    if !apply {
        let snapshot = read_snapshot(&client)?;
        serde_json::to_writer(
            io::stdout().lock(),
            &editor_workspaces(snapshot),
        )?;
        return Ok(());
    }
    let edit: WorkspaceEdit = serde_json::from_reader(io::stdin().lock())?;
    let saved = match client.request("tab.reorder", serde_json::to_value(&edit)?)
    {
        Err(HerdrError::Api { code, message })
            if code == "invalid_request"
                && message.contains("unknown variant `tab.reorder`") =>
        {
            apply_legacy_order(&client, edit)?
        }
        result => result?,
    };
    serde_json::to_writer(io::stdout().lock(), &saved)?;
    Ok(())
}

fn read_snapshot(client: &Client) -> Result<Snapshot, HerdrError> {
    let response: SnapshotResponse =
        client.request("session.snapshot", json!({}))?;
    Ok(response.snapshot)
}

fn editor_workspaces(snapshot: Snapshot) -> Vec<EditorWorkspace> {
    let mut counts = HashMap::new();
    for agent in snapshot.agents {
        *counts.entry(agent.tab_id).or_insert(0) += 1;
    }
    let mut tabs_by_workspace: HashMap<_, Vec<_>> = HashMap::new();
    for mut tab in snapshot.tabs {
        tab.agent_count = counts.remove(&tab.tab_id).unwrap_or_default();
        if tab.agent_count > 0 {
            tab.status_icon =
                crate::app::agent_status_style(&tab.agent_status).0.into();
        }
        tabs_by_workspace
            .entry(tab.workspace_id.clone())
            .or_default()
            .push(tab);
    }
    snapshot
        .workspaces
        .into_iter()
        .map(|workspace| EditorWorkspace {
            tabs: tabs_by_workspace
                .remove(&workspace.workspace_id)
                .unwrap_or_default(),
            workspace_id: workspace.workspace_id,
            label: workspace.label,
        })
        .collect()
}

fn apply_legacy_order(
    client: &Client,
    edit: WorkspaceEdit,
) -> Result<SavedOrder, HerdrError> {
    let current: Vec<_> = editor_workspaces(read_snapshot(client)?)
        .into_iter()
        .map(|workspace| WorkspaceOrder {
            workspace_id: workspace.workspace_id,
            tab_ids: workspace.tabs.into_iter().map(|tab| tab.tab_id).collect(),
        })
        .collect();
    if current != edit.original {
        return Err(HerdrError::SnapshotChanged(
            "Workspace tabs changed. Reopen the editor to get the current order.".into(),
        ));
    }
    if current.len() != edit.desired.len()
        || !current.iter().zip(&edit.desired).all(|(before, after)| {
            before.workspace_id == after.workspace_id
                && before.tab_ids.len() == after.tab_ids.len()
                && before.tab_ids.iter().collect::<HashSet<_>>()
                    == after.tab_ids.iter().collect()
        })
    {
        return Err(HerdrError::Target(
            "Moving tabs between workspaces requires a Herdr server with tab.reorder. No tabs were moved.".into(),
        ));
    }
    for (before, after) in current.into_iter().zip(&edit.desired) {
        if before == *after {
            continue;
        }
        let original = before.tab_ids;
        let edit = Edit {
            original: original.clone(),
            desired: after.tab_ids.clone(),
        };
        apply_order(original, edit, |tab_id, index| {
            let response: TabList = client.request(
                "tab.move",
                json!({"tab_id": tab_id, "insert_index": index}),
            )?;
            Ok(response.tabs.into_iter().map(|tab| tab.tab_id).collect())
        })?;
    }
    Ok(SavedOrder {
        order: edit.desired,
        tab_id_changes: BTreeMap::new(),
    })
}

fn apply_order(
    mut current: Vec<String>,
    edit: Edit,
    mut move_tab: impl FnMut(&str, usize) -> Result<Vec<String>, HerdrError>,
) -> Result<(), HerdrError> {
    if current != edit.original {
        return Err(HerdrError::SnapshotChanged(
            "The workspace's tabs changed. Reopen the editor to get the current order.".into(),
        ));
    }
    let original: HashSet<_> = edit.original.iter().collect();
    let desired: HashSet<_> = edit.desired.iter().collect();
    if desired != original || edit.desired.len() != current.len() {
        return Err(HerdrError::Target(
            "Keep each original tab row exactly once.".into(),
        ));
    }

    for (index, id) in edit.desired.iter().enumerate() {
        if &current[index] == id {
            continue;
        }
        // Earlier positions already match, so this move always goes left.
        let from = current.iter().position(|tab| tab == id).unwrap();
        let tab = current.remove(from);
        current.insert(index, tab);
        let actual = move_tab(id, index).map_err(|error| {
            HerdrError::SnapshotChanged(format!(
                "Could not finish reordering: {error}. Reopen the editor to check the current order."
            ))
        })?;
        if actual != current {
            return Err(HerdrError::SnapshotChanged(
                "The tabs changed during the save. Reopen the editor to check the current order."
                    .into(),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|id| (*id).to_owned()).collect()
    }

    #[test]
    fn detects_mise_shims_in_path_order() {
        let root = tempfile::tempdir().unwrap();
        let direct = root.path().join("direct");
        let shims = root.path().join("shims");
        let links = root.path().join("links");
        for dir in [&direct, &shims, &links] {
            fs::create_dir(dir).unwrap();
        }
        let mise = root.path().join("mise");
        let direct_nvim = direct.join("nvim");
        for file in [&mise, &direct_nvim] {
            fs::write(file, "").unwrap();
            fs::set_permissions(file, fs::Permissions::from_mode(0o755))
                .unwrap();
        }
        symlink(&mise, shims.join("nvim")).unwrap();
        symlink(shims.join("nvim"), links.join("nvim")).unwrap();

        assert!(path_uses_mise(
            &env::join_paths([&links, &direct]).unwrap(),
            &mise
        ));
        assert!(!path_uses_mise(
            &env::join_paths([&direct, &links]).unwrap(),
            &mise
        ));
    }

    #[test]
    fn invalid_or_stale_edits_do_not_move_tabs() {
        let original = ids(&["a", "b", "c"]);
        for (current, desired) in [
            (&["a", "b", "c"][..], &["a", "a", "c"][..]),
            (&["a", "b", "c"][..], &["a", "b"][..]),
            (&["a", "b", "c"][..], &["a", "b", "x"][..]),
            (&["b", "a", "c"][..], &["c", "a", "b"][..]),
        ] {
            let edit = Edit {
                original: original.clone(),
                desired: ids(desired),
            };
            assert!(apply_order(ids(current), edit, |_, _| {
                panic!("invalid edits must never move a tab")
            })
            .is_err());
        }
    }

    #[test]
    fn applies_rows_in_the_requested_order() {
        let original = ids(&["a", "b", "c", "d"]);
        let edit = Edit {
            original: original.clone(),
            desired: ids(&["c", "d", "a", "b"]),
        };
        let mut moves = vec![];
        apply_order(original, edit, |id, index| {
            moves.push((id.to_owned(), index));
            let order = if id == "c" {
                ids(&["c", "a", "b", "d"])
            } else {
                ids(&["c", "d", "a", "b"])
            };
            Ok(order)
        })
        .unwrap();
        assert_eq!(moves, [("c".into(), 0), ("d".into(), 1)]);
    }

    #[test]
    fn stops_when_a_move_returns_an_unexpected_order() {
        let original = ids(&["a", "b", "c", "d"]);
        let edit = Edit {
            original: original.clone(),
            desired: ids(&["c", "d", "a", "b"]),
        };
        let mut moves = 0;
        let result = apply_order(original, edit, |_, _| {
            moves += 1;
            Ok(ids(&["c", "a", "b", "d", "e"]))
        });
        assert!(result.is_err());
        assert_eq!(moves, 1);
    }
}
