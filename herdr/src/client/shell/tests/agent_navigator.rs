use super::*;
use crate::client::endpoint::{ClientEndpointId, ClientEndpointStatus, SavedSshEndpoint};

fn projection(statuses: &[Option<AgentStatus>]) -> ClientShellSnapshot {
    let mut projected = snapshot();
    let pane = projected.panes[0].clone();
    projected.panes.clear();
    for (index, status) in statuses.iter().enumerate() {
        let pane_id = format!("pane_{index}");
        projected.panes.push(ClientShellPane {
            pane_id: pane_id.clone(),
            label: Some(format!("task {index}")),
            focused: index == 0,
            ..pane.clone()
        });
        projected.agents.push(ClientShellAgent {
            pane_id,
            workspace_id: "ws_1".into(),
            tab_id: "tab_1".into(),
            name: None,
            display_agent: Some("display metadata".into()),
            agent: status.map(|_| "codex".into()),
            title: Some(format!("Review {index}")),
            terminal_title: None,
            terminal_title_stripped: None,
            agent_status: status.unwrap_or(AgentStatus::Unknown),
            state_change_seq: 1,
            state_labels: Vec::new(),
            tokens: Vec::new(),
            focused: index == 0,
        });
    }
    projected.focused_pane_id = Some("pane_0".into());
    projected
}

fn state_with_agents(statuses: &[Option<AgentStatus>]) -> ClientShellState {
    let mut state = ClientShellState::new(ClientShellConfig::from_config(&Config::default()));
    state.set_snapshot(Box::new(projection(statuses)));
    let mut frame = surface();
    frame.panes[0].pane_id = "pane_0".into();
    state.set_pane_surface(frame);
    state.open_agent_navigator_overlay();
    state
}

fn rows(state: &ClientShellState) -> Vec<ClientNavigatorRow> {
    let Some(ClientShellOverlay::Navigator(navigator)) = state.overlay.as_ref() else {
        panic!("expected navigator");
    };
    render::client_navigator_rows(
        &state.endpoints,
        &state.active_endpoint_id,
        navigator,
        state.config.keybinds.keybinds.tab_display_index_base(),
    )
}

#[test]
fn agent_navigator_filters_shells_and_empty_groups_without_changing_general_navigation() {
    let mut state = state_with_agents(&[None, Some(AgentStatus::Working)]);
    let visible = rows(&state);
    assert_eq!(visible.len(), 2);
    assert!(visible[1].label.contains("task 1"));
    assert!(visible.iter().all(|row| row.quick_digit.is_none()));
    if let Some(ClientShellOverlay::Navigator(navigator)) = state.overlay.as_mut() {
        navigator.query = "missing".into();
    }
    assert!(rows(&state).is_empty());
    state.set_snapshot(Box::new(projection(&[None])));
    state.open_agent_navigator_overlay();
    assert!(rows(&state).is_empty());
    state.open_navigator_overlay();
    let general = rows(&state);
    assert_eq!(general.len(), 2);
    assert!(general.iter().all(|row| row.quick_digit.is_none()));
}

#[test]
fn agent_navigator_numbers_only_ready_noncurrent_rows_without_reordering() {
    let statuses = [
        Some(AgentStatus::Idle),
        Some(AgentStatus::Working),
        Some(AgentStatus::Blocked),
        Some(AgentStatus::Unknown),
        Some(AgentStatus::Done),
        Some(AgentStatus::Idle),
    ];
    let state = state_with_agents(&statuses);
    let visible = rows(&state);
    let panes = visible
        .iter()
        .filter(|row| row.status.is_some())
        .collect::<Vec<_>>();
    assert_eq!(
        panes.iter().map(|row| row.quick_digit).collect::<Vec<_>>(),
        [None, None, Some(0), None, Some(1), Some(2)]
    );
    for (index, row) in panes.iter().enumerate() {
        assert!(row.label.contains(&format!("task {index}")));
    }
    let state = state_with_agents(&[Some(AgentStatus::Idle); 16]);
    let visible = rows(&state);
    assert_eq!(
        visible.iter().filter(|row| row.status.is_some()).count(),
        16
    );
    assert_eq!(
        visible
            .iter()
            .filter_map(|row| row.quick_digit)
            .collect::<Vec<_>>(),
        (0..10).collect::<Vec<_>>()
    );
}

#[test]
fn agent_navigator_shortcuts_follow_filter_and_status_updates_and_search_digits_are_text() {
    let mut state = state_with_agents(&[Some(AgentStatus::Idle); 3]);
    state.handle_input_bytes(b"/");
    let query = state.handle_input_bytes(b"Review 2");
    assert!(query.actions.is_empty());
    let visible = rows(&state);
    let target = visible
        .iter()
        .find(|row| row.quick_digit == Some(0))
        .unwrap();
    assert!(
        matches!(&target.target, ClientNavigatorTarget::Pane { pane_id, .. } if pane_id == "pane_2")
    );
    state.handle_input_bytes(b"\x1b");
    state.compose(106, 30).expect("filtered frame");
    let accept = state.handle_input_bytes(b"0");
    assert!(accept.actions.iter().any(|action| matches!(action,
        ClientShellAction::Endpoint { request, .. }
            if matches!(&request.method, crate::api::schema::Method::PaneFocus(params) if params.pane_id == "pane_2")
    )));

    state.open_agent_navigator_overlay();
    state.set_snapshot(Box::new(projection(&[
        Some(AgentStatus::Idle),
        Some(AgentStatus::Working),
        Some(AgentStatus::Done),
    ])));
    let visible = rows(&state);
    assert_eq!(
        visible
            .iter()
            .filter_map(|row| row.quick_digit)
            .collect::<Vec<_>>(),
        [0]
    );
    state.compose(106, 30).expect("updated shortcut frame");
    let accept = state.handle_input_bytes(b"0");
    assert!(accept.actions.iter().any(|action| matches!(action,
        ClientShellAction::Endpoint { request, .. }
            if matches!(&request.method, crate::api::schema::Method::PaneFocus(params) if params.pane_id == "pane_2")
    )));
}

#[test]
fn agent_navigator_shortcuts_route_colliding_remote_ids_and_skip_disconnected_targets() {
    let mut state = state_with_agents(&[Some(AgentStatus::Idle)]);
    let profile = SavedSshEndpoint::new("Build", "dev@example.invalid", "agents").unwrap();
    let remote_id = ClientEndpointId::Ssh(profile.id.clone());
    state.set_endpoint_catalog(&[profile]);
    state.set_endpoint_status(&remote_id, ClientEndpointStatus::Online);
    state.set_endpoint_snapshot(
        &remote_id,
        Box::new(projection(&[Some(AgentStatus::Blocked)])),
    );
    state.open_agent_navigator_overlay();
    let visible = rows(&state);
    let numbered = visible
        .iter()
        .filter(|row| row.quick_digit.is_some())
        .collect::<Vec<_>>();
    assert_eq!(numbered.len(), 1);
    assert!(
        matches!(&numbered[0].target, ClientNavigatorTarget::Pane { endpoint_id, pane_id }
        if endpoint_id == &remote_id && pane_id == "pane_0")
    );
    state.compose(106, 30).expect("remote shortcut frame");
    let accept = state.handle_input_bytes(b"0");
    assert!(matches!(accept.actions.as_slice(),
        [ClientShellAction::ActivateEndpoint { endpoint_id, target: Some(ClientEndpointFocusTarget::Pane(pane_id)) }]
            if endpoint_id == &remote_id && pane_id == "pane_0"));
    state.open_agent_navigator_overlay();
    state.set_endpoint_status(&remote_id, ClientEndpointStatus::Connecting);
    assert!(rows(&state).iter().all(|row| row.quick_digit.is_none()));
    assert!(state.handle_input_bytes(b"0").actions.is_empty());
}

#[test]
fn agent_navigator_renders_digit_badges_and_survives_narrow_resizes() {
    let mut state = state_with_agents(&[Some(AgentStatus::Idle), Some(AgentStatus::Done)]);
    for (width, height) in [(106, 30), (50, 24), (24, 12)] {
        let frame = state.compose(width, height).expect("agent navigator frame");
        let text = frame
            .cells
            .chunks(frame.width as usize)
            .map(|row| {
                row.iter()
                    .map(|cell| cell.symbol.as_str())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("Go to agent"));
        assert!(text.contains("0 "));
    }
}

#[test]
fn agent_navigator_does_not_redirect_rendered_digits_after_snapshot_changes() {
    let mut state = state_with_agents(&[
        Some(AgentStatus::Idle),
        Some(AgentStatus::Done),
        Some(AgentStatus::Working),
    ]);
    state
        .compose(106, 30)
        .expect("digit zero points to pane one");
    state.set_snapshot(Box::new(projection(&[
        Some(AgentStatus::Idle),
        Some(AgentStatus::Working),
        Some(AgentStatus::Idle),
    ])));
    let stale = state.handle_input_bytes(b"0");
    assert!(stale.actions.is_empty());
    assert!(stale.repaint);
    assert!(state.overlay.is_some());
    state
        .compose(106, 30)
        .expect("digit zero now points to pane two");
    let accept = state.handle_input_bytes(b"0");
    assert!(accept.actions.iter().any(|action| matches!(action,
        ClientShellAction::Endpoint { request, .. }
            if matches!(&request.method, crate::api::schema::Method::PaneFocus(params) if params.pane_id == "pane_2")
    )));
}

#[test]
#[ignore = "manual comparison of general and agent-only navigator composition"]
fn agent_navigator_render_scale_profile() {
    for count in [1, 15, 52, 512] {
        for agents_only in [false, true] {
            for query in ["", "task 1"] {
                let mut state = state_with_agents(&vec![Some(AgentStatus::Idle); count]);
                if let Some(ClientShellOverlay::Navigator(navigator)) = state.overlay.as_mut() {
                    navigator.agents_only = agents_only;
                    navigator.query = query.into();
                }
                for _ in 0..20 {
                    std::hint::black_box(state.compose(106, 30).expect("warm frame"));
                }
                let start = std::time::Instant::now();
                for _ in 0..1000 {
                    std::hint::black_box(state.compose(106, 30).expect("profile frame"));
                }
                eprintln!(
                    "agent navigator: count={count}, agents_only={agents_only}, query={query:?}, {:.1} us/frame",
                    start.elapsed().as_secs_f64() * 1000.0
                );
                let start = std::time::Instant::now();
                for _ in 0..1000 {
                    if agents_only {
                        state.open_agent_navigator_overlay();
                    } else {
                        state.open_navigator_overlay();
                    }
                    std::hint::black_box(state.compose(106, 30).expect("open frame"));
                }
                eprintln!(
                    "agent navigator open: count={count}, agents_only={agents_only}, {:.1} us/open+frame",
                    start.elapsed().as_secs_f64() * 1000.0
                );
            }
        }
    }
}

#[test]
#[ignore = "export a styled rendered fixture for manual UI review"]
fn agent_navigator_capture() {
    let capture_dir = std::path::PathBuf::from(
        std::env::var("HERDR_NAVIGATOR_CAPTURE_DIR").expect("set capture output directory"),
    );
    std::fs::create_dir_all(&capture_dir).unwrap();
    let mut state = state_with_agents(&[
        Some(AgentStatus::Working),
        Some(AgentStatus::Done),
        None,
        Some(AgentStatus::Blocked),
        Some(AgentStatus::Idle),
        Some(AgentStatus::Unknown),
    ]);
    let profile = SavedSshEndpoint::new("Homebox", "dev@example.invalid", "agents").unwrap();
    let remote_id = ClientEndpointId::Ssh(profile.id.clone());
    state.set_endpoint_catalog(&[profile]);
    state.set_endpoint_status(&remote_id, ClientEndpointStatus::Online);
    state.set_endpoint_snapshot(
        &remote_id,
        Box::new(projection(&[
            Some(AgentStatus::Idle),
            Some(AgentStatus::Working),
        ])),
    );
    for agents_only in [false, true] {
        if agents_only {
            state.open_agent_navigator_overlay();
        } else {
            state.open_navigator_overlay();
        }
        let frame = state.compose(106, 30).expect("capture frame");
        let encoded = crate::protocol::render_ansi::BlitEncoder::new().encode(&frame.frame, true);
        let filename = if agents_only {
            "native-agents"
        } else {
            "native-general"
        };
        std::fs::write(capture_dir.join(format!("{filename}.ansi")), encoded.bytes).unwrap();
        std::fs::write(
            capture_dir.join(format!("{filename}.json")),
            serde_json::to_vec(&frame.frame).unwrap(),
        )
        .unwrap();
        let text = frame
            .cells
            .chunks(usize::from(frame.width))
            .map(|row| {
                row.iter()
                    .map(|cell| cell.symbol.as_str())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(capture_dir.join(format!("{filename}.txt")), text).unwrap();
    }
}
