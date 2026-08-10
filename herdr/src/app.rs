//! Internal implementation for the `herdr-tmux` command-line application.

use std::env;
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Direction {
    Down,
    Right,
}

impl Direction {
    fn as_str(self) -> &'static str {
        match self {
            Self::Down => "down",
            Self::Right => "right",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Target {
    pub socket_path: PathBuf,
    pub tab_id: String,
    pub pane_id: String,
}

#[derive(Debug, Default)]
pub(crate) struct CliTarget {
    pub socket_path: Option<PathBuf>,
    pub tab_id: Option<String>,
    pub pane_id: Option<String>,
}

pub(crate) fn resolve_target(cli: CliTarget) -> Result<Target, HerdrError> {
    let socket_path = cli
        .socket_path
        .or_else(|| env_var_path("HERDR_SOCKET_PATH"));
    let tab_id = cli
        .tab_id
        .or_else(|| env_var("HERDR_TAB_ID"))
        .or_else(|| env_var("HERDR_ACTIVE_TAB_ID"));
    let pane_id = cli
        .pane_id
        .or_else(|| env_var("HERDR_PANE_ID"))
        .or_else(|| env_var("HERDR_ACTIVE_PANE_ID"));
    match (socket_path, tab_id, pane_id) {
        (Some(socket_path), Some(tab_id), Some(pane_id)) => Ok(Target { socket_path, tab_id, pane_id }),
        _ => Err(HerdrError::Target("run from a Herdr key binding or pass --socket-path, --tab-id, and --pane-id".into())),
    }
}

fn env_var(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.is_empty())
}
fn env_var_path(name: &str) -> Option<PathBuf> {
    env_var(name).map(PathBuf::from)
}

#[derive(Debug)]
pub(crate) enum HerdrError {
    Target(String),
    Busy,
    Io(std::io::Error),
    Json(serde_json::Error),
    Api { code: String, message: String },
    Protocol(String),
}

impl fmt::Display for HerdrError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Target(message) | Self::Protocol(message) => {
                f.write_str(message)
            }
            Self::Busy => {
                f.write_str("an equal-layout command is already running")
            }
            Self::Io(error) => write!(f, "could not reach Herdr: {error}"),
            Self::Json(error) => {
                write!(f, "Herdr returned invalid JSON: {error}")
            }
            Self::Api { code, message } => write!(f, "{code}: {message}"),
        }
    }
}
impl std::error::Error for HerdrError {}
impl From<std::io::Error> for HerdrError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<serde_json::Error> for HerdrError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

#[derive(Debug, Deserialize)]
struct ApiResponse<T> {
    result: Option<T>,
    error: Option<ApiError>,
}
#[derive(Debug, Deserialize)]
struct ApiError {
    code: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ExportResult {
    layout: LayoutDescription,
}
#[derive(Debug, Deserialize)]
struct LayoutDescription {
    workspace_id: String,
    tab_id: String,
    zoomed: bool,
    focused_pane_id: String,
    root: LayoutNode,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum LayoutNode {
    Pane {
        pane_id: Option<String>,
    },
    Split {
        direction: String,
        ratio: f64,
        first: Box<LayoutNode>,
        second: Box<LayoutNode>,
    },
}
#[derive(Debug, Deserialize)]
struct MoveResponse {
    move_result: MoveResult,
}
#[derive(Debug, Deserialize)]
struct MoveResult {
    changed: bool,
    reason: Option<String>,
    created_tab: Option<TabInfo>,
}
#[derive(Debug, Deserialize)]
struct TabInfo {
    tab_id: String,
}
#[derive(Debug, Deserialize)]
struct PaneGetResponse {
    pane: PaneInfo,
}
#[derive(Debug, Deserialize)]
struct PaneInfo {
    tab_id: String,
}

pub(crate) fn leaves(node: &LayoutNode) -> Result<Vec<String>, HerdrError> {
    match node {
        LayoutNode::Pane {
            pane_id: Some(pane_id),
        } => Ok(vec![pane_id.clone()]),
        LayoutNode::Pane { pane_id: None } => Err(HerdrError::Protocol(
            "layout export omitted a pane ID".into(),
        )),
        LayoutNode::Split { first, second, .. } => {
            let mut result = leaves(first)?;
            result.extend(leaves(second)?);
            Ok(result)
        }
    }
}

pub(crate) fn even_tree(
    pane_ids: &[String],
    direction: Direction,
) -> Result<LayoutNode, HerdrError> {
    match pane_ids {
        [] => Err(HerdrError::Protocol(
            "layout export contains no panes".into(),
        )),
        [pane_id] => Ok(LayoutNode::Pane {
            pane_id: Some(pane_id.clone()),
        }),
        _ => {
            let first_count = pane_ids.len() / 2;
            Ok(LayoutNode::Split {
                direction: direction.as_str().into(),
                ratio: first_count as f64 / pane_ids.len() as f64,
                first: Box::new(even_tree(&pane_ids[..first_count], direction)?),
                second: Box::new(even_tree(
                    &pane_ids[first_count..],
                    direction,
                )?),
            })
        }
    }
}

struct SessionLock(File);
impl SessionLock {
    fn acquire(socket_path: &Path) -> Result<Self, HerdrError> {
        let digest = format!(
            "{:x}",
            Sha256::digest(socket_path.as_os_str().as_encoded_bytes())
        );
        let path =
            env::temp_dir().join(format!("herdr-tmux-{}.lock", &digest[..16]));
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(path)?;
        if unsafe {
            libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB)
        } != 0
        {
            return if std::io::Error::last_os_error().kind()
                == std::io::ErrorKind::WouldBlock
            {
                Err(HerdrError::Busy)
            } else {
                Err(HerdrError::Io(std::io::Error::last_os_error()))
            };
        }
        Ok(Self(file))
    }
}
impl Drop for SessionLock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

struct Client {
    socket_path: PathBuf,
    next_id: AtomicU64,
}
impl Client {
    fn new(socket_path: PathBuf) -> Self {
        Self {
            socket_path,
            next_id: AtomicU64::new(0),
        }
    }
    fn request<T: for<'de> Deserialize<'de>>(
        &self,
        method: &str,
        params: Value,
    ) -> Result<T, HerdrError> {
        let mut stream = UnixStream::connect(&self.socket_path)?;
        stream.set_read_timeout(Some(TIMEOUT))?;
        stream.set_write_timeout(Some(TIMEOUT))?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let request = json!({"id": format!("herdr-tmux-{}-{id}", std::process::id()), "method": method, "params": params});
        serde_json::to_writer(&mut stream, &request)?;
        stream.write_all(b"\n")?;
        stream.flush()?;
        let mut line = String::new();
        let bytes = BufReader::new(stream).read_line(&mut line)?;
        if bytes == 0 {
            return Err(HerdrError::Protocol(
                "Herdr closed the socket without responding".into(),
            ));
        }
        let response: ApiResponse<T> = serde_json::from_str(&line)?;
        if let Some(error) = response.error {
            return Err(HerdrError::Api {
                code: error.code.unwrap_or_else(|| "api_error".into()),
                message: error
                    .message
                    .unwrap_or_else(|| "unknown API error".into()),
            });
        }
        response.result.ok_or_else(|| {
            HerdrError::Protocol("invalid Herdr response: missing result".into())
        })
    }
    fn move_pane(
        &self,
        pane_id: &str,
        destination: Value,
    ) -> Result<MoveResult, HerdrError> {
        let response: MoveResponse = self.request("pane.move", json!({"pane_id": pane_id, "destination": destination, "focus": false}))?;
        if !response.move_result.changed {
            return Err(HerdrError::Protocol(format!(
                "pane move did not complete: {}",
                response
                    .move_result
                    .reason
                    .unwrap_or_else(|| "unknown reason".into())
            )));
        }
        Ok(response.move_result)
    }
    fn pane_tab_id(&self, pane_id: &str) -> Result<String, HerdrError> {
        Ok(self
            .request::<PaneGetResponse>("pane.get", json!({"pane_id": pane_id}))?
            .pane
            .tab_id)
    }
}

pub(crate) fn arrange(
    target: &Target,
    direction: Direction,
) -> Result<(), HerdrError> {
    let _lock = SessionLock::acquire(&target.socket_path)?;
    let client = Client::new(target.socket_path.clone());
    let exported: ExportResult =
        client.request("layout.export", json!({"tab_id": target.tab_id}))?;
    if exported.layout.tab_id != target.tab_id {
        return Err(HerdrError::Protocol(
            "layout export returned a different tab".into(),
        ));
    }
    let pane_ids = leaves(&exported.layout.root)?;
    if !pane_ids.contains(&target.pane_id)
        || exported.layout.focused_pane_id != target.pane_id
    {
        return Err(HerdrError::Protocol(
            "the focused pane is no longer in the active tab".into(),
        ));
    }
    if exported.layout.zoomed {
        let _: Value = client.request(
            "pane.zoom",
            json!({"pane_id": target.pane_id, "mode": "off"}),
        )?;
    }
    if pane_ids.len() == 1 {
        return Ok(());
    }
    let desired = even_tree(&pane_ids, direction)?;
    let anchor = &pane_ids[0];
    let mut stage = None;
    let result = (|| {
        stage_panes(
            &client,
            &pane_ids,
            anchor,
            &exported.layout.workspace_id,
            &mut stage,
        )?;
        rebuild_from_tree(&client, &target.tab_id, &desired, anchor)
    })();
    if let Err(error) = result {
        let recovery: Result<(), HerdrError> = (|| {
            if stage.is_some() {
                stage_panes(
                    &client,
                    &pane_ids,
                    anchor,
                    &exported.layout.workspace_id,
                    &mut stage,
                )?;
                rebuild_from_tree(
                    &client,
                    &target.tab_id,
                    &exported.layout.root,
                    anchor,
                )?;
            }
            Ok(())
        })();
        let body = match recovery {
            Ok(()) if stage.is_some() => {
                format!("Original layout restored: {error}")
            }
            Ok(()) => error.to_string(),
            Err(recovery_error) => {
                format!("{error}; recovery failed: {recovery_error}")
            }
        };
        let _ = client.request::<Value>(
            "notification.show",
            json!({"title":"Herdr pane layout failed", "body":body}),
        );
        return Err(error);
    }
    let _: Value =
        client.request("pane.focus", json!({"pane_id": target.pane_id}))?;
    Ok(())
}

fn stage_panes(
    client: &Client,
    pane_ids: &[String],
    anchor: &str,
    workspace_id: &str,
    stage: &mut Option<(String, String)>,
) -> Result<(), HerdrError> {
    if let Some((tab_id, stage_anchor)) = stage.as_mut() {
        let mut staged = None;
        for pane_id in
            pane_ids.iter().filter(|pane_id| pane_id.as_str() != anchor)
        {
            if client.pane_tab_id(pane_id)? == *tab_id {
                staged = Some(pane_id.clone());
                break;
            }
        }
        if let Some(pane_id) = staged {
            *stage_anchor = pane_id;
        } else {
            *stage = None;
        }
    }
    for pane_id in pane_ids.iter().filter(|pane_id| pane_id.as_str() != anchor) {
        if let Some((tab_id, _)) = stage.as_ref() {
            if client.pane_tab_id(pane_id)? == *tab_id {
                continue;
            }
        }
        match stage {
            None => {
                let result = client.move_pane(pane_id, json!({"type":"new_tab", "workspace_id":workspace_id, "label":"herdr tmux staging"}))?;
                let tab = result.created_tab.ok_or_else(|| {
                    HerdrError::Protocol(
                        "Herdr did not return the staging tab ID".into(),
                    )
                })?;
                *stage = Some((tab.tab_id, pane_id.clone()));
            }
            Some((tab_id, stage_anchor)) => {
                client.move_pane(pane_id, json!({"type":"tab", "tab_id":tab_id, "target_pane_id":stage_anchor, "split":"right", "ratio":0.5}))?;
            }
        }
    }
    Ok(())
}

fn rebuild_from_tree(
    client: &Client,
    tab_id: &str,
    node: &LayoutNode,
    representative: &str,
) -> Result<(), HerdrError> {
    let node_leaves = leaves(node)?;
    if node_leaves.first().map(String::as_str) != Some(representative) {
        return Err(HerdrError::Protocol(
            "layout tree does not start with its representative pane".into(),
        ));
    }
    if let LayoutNode::Split {
        direction,
        ratio,
        first,
        second,
    } = node
    {
        let second_representative = leaves(second)?
            .into_iter()
            .next()
            .expect("split has a leaf");
        client.move_pane(&second_representative, json!({"type":"tab", "tab_id":tab_id, "target_pane_id":representative, "split":direction, "ratio":ratio}))?;
        rebuild_from_tree(client, tab_id, first, representative)?;
        rebuild_from_tree(client, tab_id, second, &second_representative)?;
    }
    Ok(())
}

pub(crate) fn notify_failure(target: &Target, error: &HerdrError) {
    let client = Client::new(target.socket_path.clone());
    let _ = client.request::<Value>(
        "notification.show",
        json!({"title":"Herdr pane layout failed", "body":error.to_string()}),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;
    use std::sync::mpsc;
    use std::thread;

    fn mock_server(
        layout: Value,
        request_count: usize,
    ) -> (tempfile::TempDir, Target, mpsc::Receiver<Value>) {
        let directory = tempfile::tempdir().unwrap();
        let socket_path = directory.path().join("herdr.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        let (sender, receiver) = mpsc::channel();
        let focused_pane_id =
            layout["focused_pane_id"].as_str().unwrap().to_owned();
        thread::spawn(move || {
            for _ in 0..request_count {
                let (stream, _) = listener.accept().unwrap();
                let mut line = String::new();
                BufReader::new(stream.try_clone().unwrap())
                    .read_line(&mut line)
                    .unwrap();
                let request: Value = serde_json::from_str(&line).unwrap();
                let method = request["method"].as_str().unwrap();
                let result = match method {
                    "layout.export" => json!({"layout": layout}),
                    "pane.get" => json!({"pane": {"tab_id": "w1:t1"}}),
                    "pane.move"
                        if request["params"]["destination"]["type"]
                            == "new_tab" =>
                    {
                        json!({"move_result": {"changed": true, "created_tab": {"tab_id": "w1:t-stage"}}})
                    }
                    "pane.move" => json!({"move_result": {"changed": true}}),
                    _ => json!({}),
                };
                let response = json!({"id": request["id"], "result": result});
                let mut writer = stream;
                writeln!(writer, "{response}").unwrap();
                sender.send(request).unwrap();
            }
        });
        (
            directory,
            Target {
                socket_path,
                tab_id: "w1:t1".into(),
                pane_id: focused_pane_id,
            },
            receiver,
        )
    }

    #[test]
    fn even_tree_is_balanced_and_ordered() {
        let ids = ["p1", "p2", "p3", "p4"].map(String::from);
        let tree = even_tree(&ids, Direction::Down).unwrap();
        assert_eq!(leaves(&tree).unwrap(), ids);
        assert_eq!(
            tree,
            LayoutNode::Split {
                direction: "down".into(),
                ratio: 0.5,
                first: Box::new(LayoutNode::Split {
                    direction: "down".into(),
                    ratio: 0.5,
                    first: Box::new(LayoutNode::Pane {
                        pane_id: Some("p1".into())
                    }),
                    second: Box::new(LayoutNode::Pane {
                        pane_id: Some("p2".into())
                    })
                }),
                second: Box::new(LayoutNode::Split {
                    direction: "down".into(),
                    ratio: 0.5,
                    first: Box::new(LayoutNode::Pane {
                        pane_id: Some("p3".into())
                    }),
                    second: Box::new(LayoutNode::Pane {
                        pane_id: Some("p4".into())
                    })
                })
            }
        );
    }
    #[test]
    fn one_pane_tree_is_a_leaf() {
        assert_eq!(
            even_tree(&["p1".into()], Direction::Right).unwrap(),
            LayoutNode::Pane {
                pane_id: Some("p1".into())
            }
        );
    }
    #[test]
    fn layout_rejects_missing_pane_id() {
        assert!(leaves(&LayoutNode::Pane { pane_id: None }).is_err());
    }
    #[test]
    fn explicit_target_overrides_do_not_require_a_herdr_environment() {
        let target = resolve_target(CliTarget {
            socket_path: Some(PathBuf::from("/tmp/herdr.sock")),
            tab_id: Some("w1:t1".into()),
            pane_id: Some("w1:p1".into()),
        })
        .unwrap();
        assert_eq!(target.socket_path, PathBuf::from("/tmp/herdr.sock"));
    }
    #[test]
    fn lock_is_exclusive() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("socket");
        let first = SessionLock::acquire(&path).unwrap();
        assert!(matches!(SessionLock::acquire(&path), Err(HerdrError::Busy)));
        drop(first);
        assert!(SessionLock::acquire(&path).is_ok());
    }

    #[test]
    fn golden_two_pane_transcript_rebuilds_vertical_layout() {
        let layout: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/two-pane.json"
        ))
        .unwrap();
        let (_directory, target, receiver) = mock_server(layout, 4);
        arrange(&target, Direction::Down).unwrap();
        let requests: Vec<Value> = receiver.iter().collect();
        assert_eq!(
            requests
                .iter()
                .map(|request| request["method"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["layout.export", "pane.move", "pane.move", "pane.focus"]
        );
        assert_eq!(
            requests[1]["params"]["destination"],
            json!({"type":"new_tab", "workspace_id":"w1", "label":"herdr tmux staging"})
        );
        assert_eq!(
            requests[2]["params"]["destination"],
            json!({"type":"tab", "tab_id":"w1:t1", "target_pane_id":"w1:p1", "split":"down", "ratio":0.5})
        );
        assert_eq!(requests[3]["params"], json!({"pane_id":"w1:p2"}));
    }

    #[test]
    fn golden_zoomed_four_pane_transcript_unzooms_and_uses_balanced_right_splits(
    ) {
        let layout: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/four-pane-zoomed.json"
        ))
        .unwrap();
        let (_directory, target, receiver) = mock_server(layout, 11);
        arrange(&target, Direction::Right).unwrap();
        let requests: Vec<Value> = receiver.iter().collect();
        assert_eq!(requests[1]["method"], "pane.zoom");
        let rebuilds: Vec<&Value> = requests
            .iter()
            .filter(|request| {
                request["method"] == "pane.move"
                    && request["params"]["destination"]["type"] == "tab"
                    && request["params"]["destination"]["tab_id"] == "w1:t1"
            })
            .collect();
        assert_eq!(rebuilds.len(), 3);
        for request in rebuilds {
            assert_eq!(request["params"]["destination"]["split"], "right");
            assert_eq!(request["params"]["destination"]["ratio"], 0.5);
        }
        assert_eq!(
            requests.last().unwrap()["params"],
            json!({"pane_id":"w1:p4"})
        );
    }

    #[test]
    fn golden_three_pane_transcript_uses_one_third_then_half() {
        let layout: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/three-pane.json"
        ))
        .unwrap();
        let (_directory, target, receiver) = mock_server(layout, 7);
        arrange(&target, Direction::Down).unwrap();
        let requests: Vec<Value> = receiver.iter().collect();
        let rebuilds: Vec<&Value> = requests
            .iter()
            .filter(|request| {
                request["method"] == "pane.move"
                    && request["params"]["destination"]["tab_id"] == "w1:t1"
            })
            .collect();
        assert_eq!(rebuilds.len(), 2);
        assert_eq!(rebuilds[0]["params"]["destination"]["ratio"], 1.0 / 3.0);
        assert_eq!(rebuilds[1]["params"]["destination"]["ratio"], 0.5);
        for request in rebuilds {
            assert_eq!(request["params"]["destination"]["split"], "down");
        }
    }

    #[test]
    fn one_pane_layout_is_a_socket_no_op() {
        let layout = json!({
            "workspace_id": "w1", "tab_id": "w1:t1", "zoomed": false,
            "focused_pane_id": "w1:p1", "root": {"type": "pane", "pane_id": "w1:p1"}
        });
        let (_directory, target, receiver) = mock_server(layout, 1);
        arrange(&target, Direction::Down).unwrap();
        let requests: Vec<Value> = receiver.iter().collect();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["method"], "layout.export");
    }

    #[test]
    fn malformed_api_response_is_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let socket_path = directory.path().join("herdr.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut line)
                .unwrap();
            writeln!(stream, "{{\"id\":\"ignored\"}}").unwrap();
        });
        let client = Client::new(socket_path);
        assert!(matches!(
            client.request::<Value>("pane.focus", json!({"pane_id":"w1:p1"})),
            Err(HerdrError::Protocol(_))
        ));
    }
}
