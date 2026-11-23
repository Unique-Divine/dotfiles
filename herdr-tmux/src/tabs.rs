use std::collections::HashSet;
use std::env;
use std::io;
use std::os::unix::process::CommandExt;
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::app::{Client, HerdrError, Target};

#[derive(Serialize, Deserialize)]
struct Tab {
    tab_id: String,
    label: String,
    focused: bool,
}

#[derive(Deserialize)]
struct TabList {
    tabs: Vec<Tab>,
}

#[derive(Deserialize)]
struct TabLocation {
    tab: Workspace,
}

#[derive(Deserialize)]
struct Workspace {
    workspace_id: String,
}

#[derive(Deserialize)]
struct Edit {
    original: Vec<String>,
    desired: Vec<String>,
}

pub(crate) fn edit(target: &Target) -> Result<(), HerdrError> {
    let mut editor = Command::new("nvim");
    editor
        .args(["-u", "NONE", "-i", "NONE", "-n"])
        .arg("-c")
        .arg(concat!("lua ", include_str!("tab_editor.lua")))
        .env("HERDR_TMUX_BIN", env::current_exe()?)
        .env("HERDR_TMUX_SOCKET", &target.socket_path)
        .env("HERDR_TMUX_TAB", &target.tab_id)
        .env("HERDR_TMUX_PANE", &target.pane_id);
    Err(HerdrError::Target(format!(
        "could not start nvim for the tab editor: {}",
        editor.exec()
    )))
}

pub(crate) fn tab_order(target: &Target, apply: bool) -> Result<(), HerdrError> {
    let client = Client::new(target.socket_path.clone());
    let location: TabLocation =
        client.request("tab.get", json!({"tab_id": target.tab_id}))?;
    let current: TabList = client.request(
        "tab.list",
        json!({"workspace_id": location.tab.workspace_id}),
    )?;
    if !apply {
        serde_json::to_writer(io::stdout().lock(), &current.tabs)?;
        return Ok(());
    }
    let edit: Edit = serde_json::from_reader(io::stdin().lock())?;
    apply_order(
        current.tabs.into_iter().map(|tab| tab.tab_id).collect(),
        edit,
        |id, index| {
            let response: TabList = client.request(
                "tab.move",
                json!({"tab_id": id, "insert_index": index}),
            )?;
            Ok(response.tabs.into_iter().map(|tab| tab.tab_id).collect())
        },
    )
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

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|id| (*id).to_owned()).collect()
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
