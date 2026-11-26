use std::collections::{BTreeMap, HashMap, HashSet};

use crate::api::schema::{
    EventData, EventEnvelope, EventKind, ResponseResult, TabReorderParams, WorkspaceTabOrder,
};
use crate::app::App;
use crate::layout::PaneId;

use super::responses::{encode_error, encode_success};

impl App {
    pub(super) fn handle_tab_reorder(&mut self, id: String, params: TabReorderParams) -> String {
        let current: Vec<_> = self
            .state
            .workspaces
            .iter()
            .enumerate()
            .map(|(index, ws)| WorkspaceTabOrder {
                workspace_id: ws.id.clone(),
                tab_ids: (0..ws.tabs.len())
                    .filter_map(|tab| self.public_tab_id(index, tab))
                    .collect(),
            })
            .collect();
        if current != params.original {
            return encode_error(
                id,
                "tab_order_changed",
                "Workspace tabs changed. Reopen the editor to get the current order.",
            );
        }
        if !valid_reorder(&current, &params.desired) {
            return encode_error(id, "invalid_tab_order", "Keep every workspace in order, every tab exactly once, and at least one tab per workspace.");
        }
        if current == params.desired {
            return encode_success(
                id,
                ResponseResult::TabReorder {
                    order: current,
                    tab_id_changes: BTreeMap::new(),
                    pane_id_changes: BTreeMap::new(),
                },
            );
        }

        let active = self.state.active;
        let active_roots: Vec<_> = self
            .state
            .workspaces
            .iter()
            .map(|workspace| workspace.active_tab().map(|tab| tab.root_pane))
            .collect();
        let previous_focus = self.state.previous_pane_focus.clone();
        let mut tabs = HashMap::new();
        let mut previous_panes = HashMap::new();
        for (index, workspace) in self.state.workspaces.iter_mut().enumerate() {
            for (tab_index, (tab_id, tab)) in current[index]
                .tab_ids
                .iter()
                .zip(std::mem::take(&mut workspace.tabs))
                .enumerate()
            {
                for &pane in tab.panes.keys() {
                    if let Some(number) = workspace.public_pane_number(pane) {
                        previous_panes.insert(
                            pane,
                            crate::workspace::public_pane_id_for_number(&workspace.id, number),
                        );
                    }
                }
                tabs.insert(tab_id.as_str(), (index, tab_index, tab));
            }
        }

        let mut order = Vec::with_capacity(current.len());
        let mut tab_id_changes = BTreeMap::new();
        let mut pane_id_changes = BTreeMap::new();
        let mut locations = HashMap::new();
        let mut transferred = Vec::new();
        let mut focused_tab = None;

        for (destination, desired) in params.desired.iter().enumerate() {
            let mut tab_ids = Vec::with_capacity(desired.tab_ids.len());
            for (index, tab_id) in desired.tab_ids.iter().enumerate() {
                let Some((source, old_index, mut tab)) = tabs.remove(tab_id.as_str()) else {
                    unreachable!("the complete tab permutation was validated before mutation");
                };
                locations.insert((source, old_index), (destination, index));
                if active == Some(source) && active_roots[source] == Some(tab.root_pane) {
                    focused_tab = Some((destination, index));
                }
                if source != destination {
                    let mut panes: Vec<PaneId> = tab.panes.keys().copied().collect();
                    panes.sort_by_key(|pane| pane.raw());
                    for &pane in &panes {
                        self.state.workspaces[source].unregister_moved_pane(pane);
                        self.state
                            .public_pane_id_aliases
                            .insert(previous_panes[&pane].clone(), pane);
                    }
                    self.state.workspaces[destination].register_transferred_tab(&mut tab, &panes);
                    for &pane in &panes {
                        if let Some(public_id) = self.public_pane_id(destination, pane) {
                            pane_id_changes.insert(previous_panes[&pane].clone(), public_id);
                        }
                    }
                    let new_id = crate::workspace::public_tab_id_for_number(
                        &desired.workspace_id,
                        tab.number,
                    );
                    tab_id_changes.insert(tab_id.clone(), new_id.clone());
                    tab_ids.push(new_id);
                    transferred.push((source, destination, index, tab_id.clone(), panes));
                } else {
                    tab_ids.push(tab_id.clone());
                }
                self.state.workspaces[destination].tabs.push(tab);
            }
            order.push(WorkspaceTabOrder {
                workspace_id: desired.workspace_id.clone(),
                tab_ids,
            });
        }

        for (index, workspace) in self.state.workspaces.iter_mut().enumerate() {
            workspace.active_tab = workspace
                .tabs
                .iter()
                .position(|tab| Some(tab.root_pane) == active_roots[index])
                .unwrap_or(workspace.active_tab.min(workspace.tabs.len() - 1));
        }
        for overlay in self.overlay_panes.values_mut() {
            if let Some(&(workspace, tab)) = locations.get(&(overlay.ws_idx, overlay.tab_idx)) {
                overlay.ws_idx = workspace;
                overlay.tab_idx = tab;
            }
        }
        if let Some((workspace, tab)) = focused_tab {
            self.state.active = Some(workspace);
            if active == Some(self.state.selected) {
                self.state.selected = workspace;
            }
            self.state.workspaces[workspace].active_tab = tab;
        }
        self.state.previous_pane_focus = previous_focus.map(|mut focus| {
            if let Some((index, _)) = self.find_pane(focus.pane_id) {
                focus.workspace_id = self.public_workspace_id(index);
            }
            focus
        });
        self.state.mark_session_dirty();
        self.schedule_session_save();

        for (source, destination, index, old_tab, panes) in transferred {
            let source_workspace = self.public_workspace_id(source);
            self.emit_event(EventEnvelope {
                event: EventKind::TabClosed,
                data: EventData::TabClosed {
                    tab_id: old_tab.clone(),
                    workspace_id: source_workspace.clone(),
                },
            });
            if let Some(tab) = self.tab_info(destination, index) {
                self.emit_event(EventEnvelope {
                    event: EventKind::TabCreated,
                    data: EventData::TabCreated { tab },
                });
            }
            for pane in panes {
                if let Some(info) = self.pane_info(destination, pane) {
                    self.emit_event(EventEnvelope {
                        event: EventKind::PaneMoved,
                        data: EventData::PaneMoved {
                            previous_pane_id: previous_panes[&pane].clone(),
                            previous_workspace_id: source_workspace.clone(),
                            previous_tab_id: old_tab.clone(),
                            pane: Box::new(info),
                            created_workspace: None,
                            created_tab: None,
                            closed_workspace_id: None,
                            closed_tab_id: None,
                        },
                    });
                }
            }
            if let Some(layout) = self.pane_layout_snapshot(destination, index) {
                self.emit_layout_updated_snapshot(layout);
            }
        }
        for (workspace, (before, after)) in current.iter().zip(&order).enumerate() {
            if before != after {
                let tabs = self.tab_list_info(workspace);
                for (index, tab_id) in after.tab_ids.iter().enumerate() {
                    if before.tab_ids.get(index) != Some(tab_id) {
                        self.emit_event(EventEnvelope {
                            event: EventKind::TabMoved,
                            data: EventData::TabMoved {
                                tab_id: tab_id.clone(),
                                workspace_id: after.workspace_id.clone(),
                                insert_index: index,
                                tabs: tabs.clone(),
                            },
                        });
                    }
                }
            }
        }

        encode_success(
            id,
            ResponseResult::TabReorder {
                order,
                tab_id_changes,
                pane_id_changes,
            },
        )
    }
}

fn valid_reorder(original: &[WorkspaceTabOrder], desired: &[WorkspaceTabOrder]) -> bool {
    if original.len() != desired.len()
        || !original
            .iter()
            .zip(desired)
            .all(|(old, new)| old.workspace_id == new.workspace_id && !new.tab_ids.is_empty())
    {
        return false;
    }
    let mut remaining: HashSet<_> = original
        .iter()
        .flat_map(|workspace| &workspace.tab_ids)
        .collect();
    desired
        .iter()
        .flat_map(|workspace| &workspace.tab_ids)
        .all(|tab_id| remaining.remove(tab_id))
        && remaining.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::schema::SuccessResponse;
    use crate::app::{AppPolicy, AppState};
    use crate::config::Config;
    use crate::workspace::Workspace;
    use ratatui::layout::Direction;

    #[test]
    fn tab_reorder_swaps_single_tab_workspaces_without_recreating_panes() {
        let (_, api_rx) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(
            &Config::default(),
            AppPolicy::TEST,
            None,
            api_rx,
            crate::api::EventHub::default(),
        );
        app.state = AppState::test_with_adversarial_identity_state();
        app.state.workspaces.truncate(1);
        let mut source = Workspace::test_new("source");
        let extra_pane = source.test_split(Direction::Horizontal);
        source.tabs[0].custom_name = Some("split".into());
        source.tabs[0].zoomed = true;
        let destination = Workspace::test_new("destination");
        app.state.workspaces = vec![source, destination];
        app.state.terminals.clear();
        app.state.ensure_test_terminals();
        let before = app.session_snapshot();
        let original: Vec<_> = before
            .tabs
            .iter()
            .map(|tab| WorkspaceTabOrder {
                workspace_id: tab.workspace_id.clone(),
                tab_ids: vec![tab.tab_id.clone()],
            })
            .collect();
        let mut desired = original.clone();
        desired[0].tab_ids.clone_from(&original[1].tab_ids);
        desired[1].tab_ids.clone_from(&original[0].tab_ids);
        let terminal = app.state.workspaces[0].tabs[0]
            .terminal_id(extra_pane)
            .cloned();
        let response = app.handle_tab_reorder(
            "req".into(),
            TabReorderParams {
                original: original.clone(),
                desired: desired.clone(),
            },
        );
        let response: SuccessResponse = serde_json::from_str(&response).unwrap();
        let ResponseResult::TabReorder {
            order,
            tab_id_changes,
            pane_id_changes,
        } = response.result
        else {
            panic!("expected tab reorder response");
        };
        assert_eq!(tab_id_changes.len(), 2);
        assert_eq!(pane_id_changes.len(), 3);
        assert_eq!(order[1].tab_ids[0], tab_id_changes[&original[0].tab_ids[0]]);
        assert_eq!(app.state.active, Some(1));
        let transferred = &app.state.workspaces[1].tabs[0];
        assert_eq!(transferred.custom_name.as_deref(), Some("split"));
        assert!(transferred.zoomed);
        assert_eq!(transferred.panes.len(), 2);
        assert_eq!(transferred.terminal_id(extra_pane).cloned(), terminal);
        assert!(pane_id_changes
            .keys()
            .all(|id| app.state.public_pane_id_aliases.contains_key(id)));
        app.state.assert_invariants_for_test();

        let response =
            app.handle_tab_reorder("stale".into(), TabReorderParams { original, desired });
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&response).unwrap()["error"]["code"],
            "tab_order_changed"
        );
        assert_eq!(app.session_snapshot().tabs[1].tab_id, order[1].tab_ids[0]);
    }

    #[test]
    fn tab_reorder_rejects_an_empty_workspace_and_duplicate_tab_ids() {
        let original = vec![
            WorkspaceTabOrder {
                workspace_id: "w1".into(),
                tab_ids: vec!["w1:t1".into()],
            },
            WorkspaceTabOrder {
                workspace_id: "w2".into(),
                tab_ids: vec!["w2:t1".into()],
            },
        ];
        let mut desired = original.clone();
        desired[1].tab_ids.clear();
        desired[0].tab_ids.push("w2:t1".into());
        assert!(!valid_reorder(&original, &desired));
        desired[0].tab_ids.pop();
        desired[1].tab_ids.push("w1:t1".into());
        assert!(!valid_reorder(&original, &desired));
    }
}
