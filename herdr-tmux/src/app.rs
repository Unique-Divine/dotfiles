//! Internal implementation for the `herdr-tmux` command-line application.

use std::env;
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use crossterm::terminal::{disable_raw_mode, enable_raw_mode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const TIMEOUT: Duration = Duration::from_secs(5);
const PICKER_TIMEOUT: Duration = Duration::from_millis(1_500);
const MAX_PICKER_PANES: usize = 10;

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
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
struct PaneInfo {
    pane_id: String,
    tab_id: String,
    focused: bool,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    terminal_title_stripped: Option<String>,
    #[serde(default)]
    display_agent: Option<String>,
    #[serde(default)]
    foreground_cwd: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
}
#[derive(Debug, Deserialize)]
struct PaneLayoutResponse {
    layout: PaneLayout,
}
#[derive(Debug, Deserialize)]
struct PaneLayout {
    tab_id: String,
    focused_pane_id: String,
    panes: Vec<PaneLayoutPane>,
}
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
struct PaneLayoutPane {
    pane_id: String,
    rect: PaneRect,
}
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
struct PaneRect {
    x: u16,
    y: u16,
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
        Ok(self.pane_get(pane_id)?.tab_id)
    }
    fn pane_layout(&self, pane_id: &str) -> Result<PaneLayout, HerdrError> {
        Ok(self
            .request::<PaneLayoutResponse>(
                "pane.layout",
                json!({"pane_id": pane_id}),
            )?
            .layout)
    }
    fn pane_get(&self, pane_id: &str) -> Result<PaneInfo, HerdrError> {
        Ok(self
            .request::<PaneGetResponse>("pane.get", json!({"pane_id": pane_id}))?
            .pane)
    }
    fn pane_focus(&self, pane_id: &str) -> Result<PaneInfo, HerdrError> {
        Ok(self
            .request::<PaneGetResponse>(
                "pane.focus",
                json!({"pane_id": pane_id}),
            )?
            .pane)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PickerChoice {
    Select(usize),
    Cancel,
}

trait RawModeControl {
    fn enable(&mut self) -> io::Result<()>;
    fn disable(&mut self) -> io::Result<()>;
}

struct CrosstermRawMode;

impl RawModeControl for CrosstermRawMode {
    fn enable(&mut self) -> io::Result<()> {
        enable_raw_mode()
    }

    fn disable(&mut self) -> io::Result<()> {
        disable_raw_mode()
    }
}

struct RawModeGuard<'a, T: RawModeControl> {
    mode: &'a mut T,
}

impl<'a, T: RawModeControl> RawModeGuard<'a, T> {
    fn enter(mode: &'a mut T) -> io::Result<Self> {
        mode.enable()?;
        Ok(Self { mode })
    }
}

impl<T: RawModeControl> Drop for RawModeGuard<'_, T> {
    fn drop(&mut self) {
        let _ = self.mode.disable();
    }
}

fn parse_picker_event(event: Event, pane_count: usize) -> PickerChoice {
    let Event::Key(key) = event else {
        return PickerChoice::Cancel;
    };
    if key.kind != KeyEventKind::Press {
        return PickerChoice::Cancel;
    }
    match key.code {
        KeyCode::Char(digit) if digit.is_ascii_digit() => {
            let index = digit as usize - '0' as usize;
            if index < pane_count {
                PickerChoice::Select(index)
            } else {
                PickerChoice::Cancel
            }
        }
        KeyCode::Esc => PickerChoice::Cancel,
        _ => PickerChoice::Cancel,
    }
}

fn read_picker_choice_with<M, P, R>(
    mode: &mut M,
    pane_count: usize,
    timeout: Duration,
    mut poll: P,
    mut read: R,
) -> Result<PickerChoice, HerdrError>
where
    M: RawModeControl,
    P: FnMut(Duration) -> io::Result<bool>,
    R: FnMut() -> io::Result<Event>,
{
    let _guard = RawModeGuard::enter(mode)?;
    if !poll(timeout)? {
        return Ok(PickerChoice::Cancel);
    }
    Ok(parse_picker_event(read()?, pane_count))
}

fn read_picker_choice(pane_count: usize) -> Result<PickerChoice, HerdrError> {
    read_picker_choice_with(
        &mut CrosstermRawMode,
        pane_count,
        PICKER_TIMEOUT,
        event::poll,
        event::read,
    )
}

fn sort_panes(panes: &mut [PaneLayoutPane]) {
    panes.sort_by(|left, right| {
        (left.rect.y, left.rect.x, &left.pane_id).cmp(&(
            right.rect.y,
            right.rect.x,
            &right.pane_id,
        ))
    });
}

fn nonempty(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|value| !value.trim().is_empty())
}

fn pane_description(pane: &PaneInfo) -> String {
    let description = nonempty(&pane.label)
        .or_else(|| nonempty(&pane.display_agent))
        .or_else(|| nonempty(&pane.agent))
        .or_else(|| nonempty(&pane.title))
        .or_else(|| nonempty(&pane.terminal_title_stripped))
        .map(str::to_owned)
        .or_else(|| {
            nonempty(&pane.foreground_cwd)
                .or_else(|| nonempty(&pane.cwd))
                .and_then(|cwd| Path::new(cwd).file_name())
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| pane.pane_id.clone());
    let mut chars = description.trim().chars().map(|character| {
        if character.is_control() {
            ' '
        } else {
            character
        }
    });
    let prefix = chars.by_ref().take(44).collect::<String>();
    if chars.next().is_some() {
        format!("{prefix}…")
    } else {
        prefix
    }
}

fn write_picker<W: Write>(
    writer: &mut W,
    panes: &[(PaneLayoutPane, PaneInfo)],
    active_pane_id: &str,
) -> Result<(), HerdrError> {
    writeln!(writer, "Select pane (0-9, Esc cancels)\n")?;
    for (index, (layout, pane)) in panes.iter().enumerate() {
        let marker = if layout.pane_id == active_pane_id {
            "*"
        } else {
            " "
        };
        writeln!(writer, " {index} {marker} {}", pane_description(pane))?;
    }
    writer.flush()?;
    Ok(())
}

pub(crate) fn pick_pane(target: &Target) -> Result<(), HerdrError> {
    pick_pane_with(target, &mut io::stdout().lock(), read_picker_choice)
}

fn pick_pane_with<W, C>(
    target: &Target,
    writer: &mut W,
    mut choose: C,
) -> Result<(), HerdrError>
where
    W: Write,
    C: FnMut(usize) -> Result<PickerChoice, HerdrError>,
{
    let client = Client::new(target.socket_path.clone());
    let mut layout = client.pane_layout(&target.pane_id)?;
    if layout.tab_id != target.tab_id
        || layout.focused_pane_id != target.pane_id
        || !layout
            .panes
            .iter()
            .any(|pane| pane.pane_id == target.pane_id)
    {
        return Err(HerdrError::Protocol(
            "the active pane is no longer in the originating tab".into(),
        ));
    }
    if layout.panes.len() > MAX_PICKER_PANES {
        return Err(HerdrError::Protocol(format!(
            "pane picker supports at most {MAX_PICKER_PANES} panes; this tab has {}",
            layout.panes.len()
        )));
    }
    if layout.panes.len() <= 1 {
        return Ok(());
    }

    sort_panes(&mut layout.panes);
    let panes = layout
        .panes
        .into_iter()
        .map(|layout_pane| {
            let pane = client.pane_get(&layout_pane.pane_id)?;
            if pane.tab_id != target.tab_id {
                return Err(HerdrError::Protocol(format!(
                    "pane {} moved outside the originating tab",
                    layout_pane.pane_id
                )));
            }
            Ok((layout_pane, pane))
        })
        .collect::<Result<Vec<_>, HerdrError>>()?;

    write_picker(writer, &panes, &target.pane_id)?;
    let PickerChoice::Select(index) = choose(panes.len())? else {
        return Ok(());
    };
    let selected_id = &panes[index].0.pane_id;
    let selected = client.pane_get(selected_id)?;
    if selected.tab_id != target.tab_id {
        return Err(HerdrError::Protocol(format!(
            "pane {selected_id} moved outside the originating tab"
        )));
    }
    if selected_id == &target.pane_id {
        return Ok(());
    }
    let focused = client.pane_focus(selected_id)?;
    if focused.pane_id != *selected_id
        || focused.tab_id != target.tab_id
        || !focused.focused
    {
        return Err(HerdrError::Protocol(format!(
            "Herdr did not focus pane {selected_id}"
        )));
    }
    Ok(())
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
        json!({"title":"Herdr tmux command failed", "body":error.to_string()}),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyEvent, KeyModifiers};
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
                    "pane.get" => json!({"pane": {
                        "pane_id": request["params"]["pane_id"],
                        "tab_id": "w1:t1",
                        "focused": false
                    }}),
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

    fn scripted_server(
        results: Vec<Value>,
        pane_id: &str,
    ) -> (tempfile::TempDir, Target, mpsc::Receiver<Value>) {
        let directory = tempfile::tempdir().unwrap();
        let socket_path = directory.path().join("herdr.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            for result in results {
                let (stream, _) = listener.accept().unwrap();
                let mut line = String::new();
                BufReader::new(stream.try_clone().unwrap())
                    .read_line(&mut line)
                    .unwrap();
                let request: Value = serde_json::from_str(&line).unwrap();
                let response = if let Some(error) = result.get("__error") {
                    json!({"id": request["id"], "error": error})
                } else {
                    json!({"id": request["id"], "result": result})
                };
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
                pane_id: pane_id.into(),
            },
            receiver,
        )
    }

    fn picker_layout(panes: &[(&str, u16, u16)], focused: &str) -> Value {
        json!({"layout": {
            "tab_id": "w1:t1",
            "focused_pane_id": focused,
            "panes": panes.iter().map(|(pane_id, x, y)| json!({
                "pane_id": pane_id,
                "rect": {"x": x, "y": y}
            })).collect::<Vec<_>>()
        }})
    }

    fn picker_pane(pane_id: &str, tab_id: &str, focused: bool) -> Value {
        json!({"pane": {
            "pane_id": pane_id,
            "tab_id": tab_id,
            "focused": focused,
            "cwd": format!("/work/{pane_id}")
        }})
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
    fn picker_orders_panes_by_y_then_x() {
        let mut panes = vec![
            PaneLayoutPane {
                pane_id: "p3".into(),
                rect: PaneRect { x: 10, y: 10 },
            },
            PaneLayoutPane {
                pane_id: "p2".into(),
                rect: PaneRect { x: 20, y: 0 },
            },
            PaneLayoutPane {
                pane_id: "p1".into(),
                rect: PaneRect { x: 0, y: 0 },
            },
        ];
        sort_panes(&mut panes);
        assert_eq!(
            panes
                .iter()
                .map(|pane| pane.pane_id.as_str())
                .collect::<Vec<_>>(),
            ["p1", "p2", "p3"]
        );
    }

    #[test]
    fn pane_description_uses_metadata_precedence_and_id_fallback() {
        let mut pane: PaneInfo = serde_json::from_value(json!({
            "pane_id": "w1:p1", "tab_id": "w1:t1", "focused": false,
            "label": "editor", "display_agent": "Codex", "agent": "codex",
            "title": "task", "terminal_title_stripped": "shell",
            "foreground_cwd": "/work/repo", "cwd": "/work"
        }))
        .unwrap();
        assert_eq!(pane_description(&pane), "editor");
        pane.label = None;
        assert_eq!(pane_description(&pane), "Codex");
        pane.display_agent = None;
        pane.agent = None;
        pane.title = None;
        pane.terminal_title_stripped = None;
        assert_eq!(pane_description(&pane), "repo");
        pane.foreground_cwd = None;
        pane.cwd = None;
        assert_eq!(pane_description(&pane), "w1:p1");
    }

    #[test]
    fn pane_description_strips_controls_and_truncates_long_text() {
        let pane: PaneInfo = serde_json::from_value(json!({
            "pane_id": "w1:p1", "tab_id": "w1:t1", "focused": false,
            "label": "line one\nline two with a very long pane description that will not fit"
        }))
        .unwrap();
        let description = pane_description(&pane);
        assert!(!description.contains('\n'));
        assert!(description.ends_with('…'));
        assert_eq!(description.chars().count(), 45);
    }

    #[test]
    fn picker_selection_parses_digits_and_cancels_other_input() {
        let key = |code| Event::Key(KeyEvent::new(code, KeyModifiers::NONE));
        assert_eq!(
            parse_picker_event(key(KeyCode::Char('2')), 3),
            PickerChoice::Select(2)
        );
        assert_eq!(
            parse_picker_event(key(KeyCode::Char('3')), 3),
            PickerChoice::Cancel
        );
        assert_eq!(
            parse_picker_event(key(KeyCode::Esc), 3),
            PickerChoice::Cancel
        );
        assert_eq!(
            parse_picker_event(key(KeyCode::Char('x')), 3),
            PickerChoice::Cancel
        );
    }

    #[derive(Default)]
    struct MockRawMode {
        enabled: usize,
        disabled: usize,
    }

    impl RawModeControl for MockRawMode {
        fn enable(&mut self) -> io::Result<()> {
            self.enabled += 1;
            Ok(())
        }

        fn disable(&mut self) -> io::Result<()> {
            self.disabled += 1;
            Ok(())
        }
    }

    #[test]
    fn picker_timeout_cancels_and_restores_terminal_mode() {
        let mut mode = MockRawMode::default();
        let choice = read_picker_choice_with(
            &mut mode,
            2,
            Duration::from_millis(1),
            |_| Ok(false),
            || panic!("timeout must not read an event"),
        )
        .unwrap();
        assert_eq!(choice, PickerChoice::Cancel);
        assert_eq!((mode.enabled, mode.disabled), (1, 1));
    }

    #[test]
    fn picker_selection_restores_terminal_mode() {
        let mut mode = MockRawMode::default();
        let choice = read_picker_choice_with(
            &mut mode,
            2,
            Duration::from_millis(1),
            |_| Ok(true),
            || {
                Ok(Event::Key(KeyEvent::new(
                    KeyCode::Char('1'),
                    KeyModifiers::NONE,
                )))
            },
        )
        .unwrap();
        assert_eq!(choice, PickerChoice::Select(1));
        assert_eq!((mode.enabled, mode.disabled), (1, 1));
    }

    #[test]
    fn picker_read_error_restores_terminal_mode() {
        let mut mode = MockRawMode::default();
        let result = read_picker_choice_with(
            &mut mode,
            2,
            Duration::from_millis(1),
            |_| Ok(true),
            || Err(io::Error::other("read failed")),
        );
        assert!(matches!(result, Err(HerdrError::Io(_))));
        assert_eq!((mode.enabled, mode.disabled), (1, 1));
    }

    #[test]
    fn picker_rejects_more_than_ten_panes_before_input() {
        let pane_specs = (0..11)
            .map(|index| (format!("w1:p{index}"), index as u16, 0_u16))
            .collect::<Vec<_>>();
        let layout = json!({"layout": {
            "tab_id": "w1:t1", "focused_pane_id": "w1:p0",
            "panes": pane_specs.iter().map(|(pane_id, x, y)| json!({
                "pane_id": pane_id, "rect": {"x": x, "y": y}
            })).collect::<Vec<_>>()
        }});
        let (_directory, target, receiver) =
            scripted_server(vec![layout], "w1:p0");
        let mut input_called = false;
        let error = pick_pane_with(&target, &mut Vec::new(), |_| {
            input_called = true;
            Ok(PickerChoice::Cancel)
        })
        .unwrap_err();
        assert!(error.to_string().contains("at most 10 panes"));
        assert!(!input_called);
        assert_eq!(receiver.iter().count(), 1);
    }

    #[test]
    fn picker_one_pane_tab_is_a_successful_no_op_before_input() {
        let (_directory, target, receiver) = scripted_server(
            vec![picker_layout(&[("w1:p1", 0, 0)], "w1:p1")],
            "w1:p1",
        );
        let mut input_called = false;
        pick_pane_with(&target, &mut Vec::new(), |_| {
            input_called = true;
            Ok(PickerChoice::Cancel)
        })
        .unwrap();
        assert!(!input_called);
        assert_eq!(receiver.iter().count(), 1);
    }

    #[test]
    fn picker_socket_transcript_focuses_selected_id_directly() {
        let results = vec![
            picker_layout(&[("w1:p2", 10, 0), ("w1:p1", 0, 0)], "w1:p1"),
            picker_pane("w1:p1", "w1:t1", true),
            picker_pane("w1:p2", "w1:t1", false),
            picker_pane("w1:p2", "w1:t1", false),
            picker_pane("w1:p2", "w1:t1", true),
        ];
        let (_directory, target, receiver) = scripted_server(results, "w1:p1");
        let mut output = Vec::new();
        pick_pane_with(&target, &mut output, |_| Ok(PickerChoice::Select(1)))
            .unwrap();
        let requests = receiver.iter().collect::<Vec<_>>();
        assert_eq!(
            requests
                .iter()
                .map(|request| request["method"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "pane.layout",
                "pane.get",
                "pane.get",
                "pane.get",
                "pane.focus"
            ]
        );
        assert_eq!(
            requests.last().unwrap()["params"],
            json!({"pane_id": "w1:p2"})
        );
        let output = String::from_utf8(output).unwrap();
        assert!(output.contains("0 * w1:p1"));
        assert!(output.contains("1   w1:p2"));
    }

    #[test]
    fn picker_same_pane_selection_is_a_successful_no_op() {
        let results = vec![
            picker_layout(&[("w1:p1", 0, 0), ("w1:p2", 10, 0)], "w1:p1"),
            picker_pane("w1:p1", "w1:t1", true),
            picker_pane("w1:p2", "w1:t1", false),
            picker_pane("w1:p1", "w1:t1", true),
        ];
        let (_directory, target, receiver) = scripted_server(results, "w1:p1");
        pick_pane_with(&target, &mut Vec::new(), |_| {
            Ok(PickerChoice::Select(0))
        })
        .unwrap();
        assert!(!receiver
            .iter()
            .any(|request| request["method"] == "pane.focus"));
    }

    #[test]
    fn picker_cancellation_leaves_focus_unchanged() {
        let results = vec![
            picker_layout(&[("w1:p1", 0, 0), ("w1:p2", 10, 0)], "w1:p1"),
            picker_pane("w1:p1", "w1:t1", true),
            picker_pane("w1:p2", "w1:t1", false),
        ];
        let (_directory, target, receiver) = scripted_server(results, "w1:p1");
        pick_pane_with(&target, &mut Vec::new(), |_| Ok(PickerChoice::Cancel))
            .unwrap();
        assert!(!receiver
            .iter()
            .any(|request| request["method"] == "pane.focus"));
    }

    #[test]
    fn picker_rejects_stale_or_moved_selected_pane_without_focus() {
        for stale_result in [
            json!({"__error": {"code": "pane_not_found", "message": "pane not found"}}),
            picker_pane("w1:p2", "w1:t2", false),
        ] {
            let results = vec![
                picker_layout(&[("w1:p1", 0, 0), ("w1:p2", 10, 0)], "w1:p1"),
                picker_pane("w1:p1", "w1:t1", true),
                picker_pane("w1:p2", "w1:t1", false),
                stale_result,
            ];
            let (_directory, target, receiver) =
                scripted_server(results, "w1:p1");
            assert!(pick_pane_with(&target, &mut Vec::new(), |_| {
                Ok(PickerChoice::Select(1))
            })
            .is_err());
            assert!(!receiver
                .iter()
                .any(|request| request["method"] == "pane.focus"));
        }
    }

    #[test]
    fn picker_propagates_layout_api_failure() {
        let (_directory, target, receiver) = scripted_server(
            vec![json!({"__error": {
                "code": "pane_layout_unavailable",
                "message": "pane layout unavailable"
            }})],
            "w1:p1",
        );
        let error = pick_pane_with(&target, &mut Vec::new(), |_| {
            Ok(PickerChoice::Cancel)
        })
        .unwrap_err();
        assert!(matches!(error, HerdrError::Api { .. }));
        assert_eq!(receiver.iter().count(), 1);
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
