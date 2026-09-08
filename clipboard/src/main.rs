use std::{
    env,
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use fs2::FileExt;

/// Caps a frame before allocating its payload, so a malformed local client
/// cannot make the daemon reserve unbounded memory.
const MAX_PAYLOAD_BYTES: u64 = 64 * 1024 * 1024;

/// Bounds client startup waits when PowerShell cannot initialize, while still
/// accommodating the one-time Windows process startup cost.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(2);
const WINDOWS_TASK_NAME: &str = "wsl-clipboard-interactive-daemon";
const WINDOWS_POWERSHELL_PATH: &str =
    "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const WINDOWS_WSL_PATH: &str = "/mnt/c/Windows/System32/wsl.exe";

// One-byte operation and status codes for the Unix-socket protocol. The
// payload framing below carries all arbitrary text, not these control values.
const REQUEST_COPY: u8 = 1;
const REQUEST_PASTE: u8 = 2;
const REQUEST_STATUS: u8 = 3;
const REQUEST_STOP: u8 = 4;
const REQUEST_STATUS_VERBOSE: u8 = 5;
const REQUEST_HEALTH: u8 = 6;
const RESPONSE_OK: u8 = 0;
const RESPONSE_ERROR: u8 = 1;

/// A complete, intentionally small request vocabulary for the local bridge.
///
/// Keeping this protocol declarative prevents socket clients from supplying
/// arbitrary PowerShell source code.
enum Request {
    Copy(Vec<u8>),
    Paste,
    Status { verbose: bool },
    Health,
    Stop,
}

/// Runtime-owned paths used to discover, serialize startup of, and diagnose
/// the per-user daemon. These files are never part of the repository state.
struct Paths {
    socket: PathBuf,
    startup_lock: PathBuf,
    log: PathBuf,
}

/// The one long-lived Windows process that accesses the interactive clipboard.
///
/// The daemon serializes access to this object because its stdin/stdout are a
/// single request-response stream. Reusing it avoids the expensive PowerShell
/// process startup on every `copy` or `paste` command.
struct PowerShell {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

/// Owns a PowerShell child and recreates it after a WSL-side process failure.
///
/// A Unix socket daemon can survive after its Windows child exits. Keeping the
/// restart policy here makes copy, paste, and health reporting agree on what
/// constitutes a usable clipboard backend.
struct ClipboardBackend {
    power_shell: PowerShell,
    log: File,
    socket_path: PathBuf,
    log_path: PathBuf,
}

impl PowerShell {
    /// Starts a constrained PowerShell loop and waits for its explicit ready
    /// line before accepting socket requests.
    fn start(log: &File) -> io::Result<Self> {
        let script = build_power_shell_script();
        let mut child = Command::new(power_shell_executable())
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-STA",
                "-Command",
                &script,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(log.try_clone()?))
            .spawn()?;
        let stdin = child.stdin.take().ok_or_else(missing_pipe)?;
        let stdout = child.stdout.take().ok_or_else(missing_pipe)?;
        let mut power_shell = Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        };
        let ready = power_shell.read_line()?;
        if ready != "READY" {
            return Err(other(format!(
                "unexpected PowerShell greeting: {ready}"
            )));
        }
        power_shell.wait_until_healthy()?;
        Ok(power_shell)
    }

    /// Base64-frames arbitrary UTF-8 bytes so newlines never interfere with
    /// the line-oriented PowerShell control channel.
    fn copy(&mut self, bytes: &[u8]) -> io::Result<()> {
        let request = format!("COPY {}\n", STANDARD.encode(bytes));
        self.stdin.write_all(request.as_bytes())?;
        self.stdin.flush()?;
        self.expect_ok().map(|_| ())
    }

    /// Reads clipboard text through the already-running PowerShell process.
    fn paste(&mut self) -> io::Result<Vec<u8>> {
        self.stdin.write_all(b"PASTE\n")?;
        self.stdin.flush()?;
        self.expect_ok()
    }

    /// Verifies clipboard access without returning or modifying its contents.
    fn health(&mut self) -> io::Result<()> {
        self.stdin.write_all(b"HEALTH\n")?;
        self.stdin.flush()?;
        self.expect_ok().map(|_| ())
    }

    /// Tolerates brief clipboard contention, but requires an actual API call
    /// before the daemon claims that its Windows backend is ready.
    fn wait_until_healthy(&mut self) -> io::Result<()> {
        let started_at = Instant::now();
        loop {
            match self.health() {
                Ok(()) => return Ok(()),
                Err(error) if started_at.elapsed() < STARTUP_TIMEOUT => {
                    thread::sleep(Duration::from_millis(50));
                    let _ = error;
                }
                Err(error) => return Err(clipboard_access_error(error)),
            }
        }
    }

    fn expect_ok(&mut self) -> io::Result<Vec<u8>> {
        let line = self.read_line()?;
        let (kind, encoded) = line
            .split_once(' ')
            .map_or((line.as_str(), ""), |(kind, encoded)| (kind, encoded));
        let bytes = STANDARD.decode(encoded).map_err(|error| {
            other(format!("invalid PowerShell response: {error}"))
        })?;
        match kind {
            "OK" => Ok(bytes),
            "ERR" => Err(other(String::from_utf8_lossy(&bytes))),
            _ => Err(other(format!("unexpected PowerShell response: {line}"))),
        }
    }

    fn read_line(&mut self) -> io::Result<String> {
        let mut line = String::new();
        let read = self.stdout.read_line(&mut line)?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "PowerShell closed its output stream",
            ));
        }
        Ok(line.trim_end_matches(['\r', '\n']).to_owned())
    }

    /// Lets the child exit cleanly when the daemon stops, rather than leaving
    /// a Windows process alive after its Unix-socket owner has gone away.
    fn shutdown(&mut self) {
        let _ = self.stdin.write_all(b"QUIT\n");
        let _ = self.stdin.flush();
        let _ = self.child.wait();
    }
}

impl ClipboardBackend {
    fn start(paths: &Paths) -> io::Result<Self> {
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&paths.log)?;
        let power_shell = PowerShell::start(&log)?;
        Ok(Self {
            power_shell,
            log,
            socket_path: paths.socket.clone(),
            log_path: paths.log.clone(),
        })
    }

    fn copy(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.run_with_recovery("copy", |power_shell| power_shell.copy(bytes))
    }

    fn paste(&mut self) -> io::Result<Vec<u8>> {
        self.run_with_recovery("paste", PowerShell::paste)
    }

    fn status(&mut self, verbose: bool) -> io::Result<Vec<u8>> {
        self.ensure_healthy()?;
        let mut report = String::from("running\n");
        if verbose {
            report.push_str(&format!(
                "daemon_pid={}\npowershell_pid={}\nsocket={}\nlog={}\n",
                std::process::id(),
                self.power_shell.child.id(),
                self.socket_path.display(),
                self.log_path.display(),
            ));
        }
        Ok(report.into_bytes())
    }

    fn health(&mut self) -> io::Result<()> {
        self.run_with_recovery("health check", PowerShell::health)
    }

    fn run_with_recovery<T>(
        &mut self,
        operation: &str,
        request: impl Fn(&mut PowerShell) -> io::Result<T>,
    ) -> io::Result<T> {
        if let Err(reason) = self.ensure_healthy() {
            return self.restart_and_retry(operation, reason, request);
        }

        match request(&mut self.power_shell) {
            Ok(value) => Ok(value),
            Err(error) if is_backend_transport_error(&error) => {
                self.restart_and_retry(operation, error, request)
            }
            Err(error) => Err(error),
        }
    }

    fn ensure_healthy(&mut self) -> io::Result<()> {
        match self.power_shell.child.try_wait()? {
            Some(status) => Err(other(format!(
                "Windows clipboard backend exited with status {status}"
            ))),
            None => Ok(()),
        }
    }

    fn restart_and_retry<T>(
        &mut self,
        operation: &str,
        reason: io::Error,
        request: impl Fn(&mut PowerShell) -> io::Result<T>,
    ) -> io::Result<T> {
        self.power_shell = PowerShell::start(&self.log).map_err(|error| {
            recovery_error(
                operation,
                &reason,
                "could not restart it",
                &error,
                self,
            )
        })?;
        request(&mut self.power_shell).map_err(|error| {
            recovery_error(
                operation,
                &reason,
                "restarted the backend, but the request still failed",
                &error,
                self,
            )
        })
    }
}

impl Drop for PowerShell {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("wsl-clipboard: {error}");
        std::process::exit(1);
    }
}

fn run() -> io::Result<()> {
    let mut args = env::args();
    let executable = args.next().unwrap_or_else(|| "wsl-clipboard".to_owned());
    let command =
        command_from_invocation(Path::new(&executable), args.collect())?;
    let paths = socket_paths()?;
    match command {
        CliCommand::Copy => {
            let mut bytes = Vec::new();
            io::stdin().read_to_end(&mut bytes)?;
            validate_utf8_input(&bytes)?;
            send_client_request(&paths, Request::Copy(bytes), true).map(|_| ())
        }
        CliCommand::Paste => {
            let bytes = send_client_request(&paths, Request::Paste, true)?;
            io::stdout().write_all(&bytes)
        }
        CliCommand::Status { verbose } => {
            let bytes =
                send_client_request(&paths, Request::Status { verbose }, false)?;
            io::stdout().write_all(&bytes)
        }
        CliCommand::Health { quiet } => health(&paths, quiet),
        CliCommand::WindowsTask { command } => windows_task(command),
        CliCommand::Stop => {
            send_client_request(&paths, Request::Stop, false)?;
            println!("stopped");
            Ok(())
        }
        CliCommand::Daemon => run_daemon(paths),
        CliCommand::Help => {
            print_usage();
            Ok(())
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
enum CliCommand {
    Copy,
    Paste,
    Status { verbose: bool },
    Health { quiet: bool },
    WindowsTask { command: WindowsTaskCommand },
    Stop,
    Daemon,
    Help,
}

#[derive(Debug, Eq, PartialEq)]
enum WindowsTaskCommand {
    Install,
    Status,
    Remove,
}

/// Maps installed command aliases to operations without requiring duplicate
/// binaries. Cargo installs one `wsl-clipboard` executable; the installer then
/// creates same-directory symlinks named like the familiar clipboard tools.
/// The kernel preserves that invoked name in `argv[0]`, so the client can
/// select copy or paste before it contacts the daemon.
fn command_from_invocation(
    executable: &Path,
    requested: Vec<String>,
) -> io::Result<CliCommand> {
    match executable.file_name().and_then(|name| name.to_str()) {
        Some("pbcopy" | "wsl-pbcopy") if requested.is_empty() => {
            Ok(CliCommand::Copy)
        }
        Some("pbpaste" | "wsl-pbpaste") if requested.is_empty() => {
            Ok(CliCommand::Paste)
        }
        Some("pbcopy" | "wsl-pbcopy" | "pbpaste" | "wsl-pbpaste") => {
            Err(other("clipboard aliases do not accept arguments"))
        }
        _ => match requested.as_slice() {
            [] => Ok(CliCommand::Help),
            [command]
                if matches!(command.as_str(), "help" | "--help" | "-h") =>
            {
                Ok(CliCommand::Help)
            }
            [command] if command == "copy" => Ok(CliCommand::Copy),
            [command] if command == "paste" => Ok(CliCommand::Paste),
            [command] if command == "status" => {
                Ok(CliCommand::Status { verbose: false })
            }
            [command, flag] if command == "status" && flag == "--verbose" => {
                Ok(CliCommand::Status { verbose: true })
            }
            [command] if command == "health" => {
                Ok(CliCommand::Health { quiet: false })
            }
            [command, flag] if command == "health" && flag == "--quiet" => {
                Ok(CliCommand::Health { quiet: true })
            }
            [command, action] if command == "windows-task" => {
                match action.as_str() {
                    "install" => Ok(CliCommand::WindowsTask {
                        command: WindowsTaskCommand::Install,
                    }),
                    "status" => Ok(CliCommand::WindowsTask {
                        command: WindowsTaskCommand::Status,
                    }),
                    "remove" => Ok(CliCommand::WindowsTask {
                        command: WindowsTaskCommand::Remove,
                    }),
                    _ => Err(other(format!(
                        "unknown windows-task command: {action}"
                    ))),
                }
            }
            [command] if command == "stop" => Ok(CliCommand::Stop),
            [command] if command == "daemon" => Ok(CliCommand::Daemon),
            _ => Err(other(format!("unknown command: {}", requested.join(" ")))),
        },
    }
}

/// Reports whether a running daemon can access the Windows clipboard. Unlike
/// copy and paste, this diagnostic never starts a daemon as a side effect.
fn health(paths: &Paths, quiet: bool) -> io::Result<()> {
    let status =
        send_client_request(paths, Request::Status { verbose: true }, false);
    let result = send_client_request(paths, Request::Health, false);
    let task = windows_task_status()
        .unwrap_or_else(|error| format!("task=unknown\ntask_error={error}\n"));
    match (status, result) {
        (Ok(status), Ok(_)) => {
            if !quiet {
                print!(
                    "clipboard=ready\n{}{}",
                    String::from_utf8_lossy(&status),
                    task
                );
            }
            Ok(())
        }
        (Err(_), Ok(_)) => {
            if !quiet {
                print!("clipboard=ready\ndaemon=running\n{task}");
            }
            Ok(())
        }
        (status, Err(error)) => {
            let daemon = if status.is_ok() { "running" } else { "stopped" };
            let message = format!(
                "clipboard health check failed: {error}. If this is an SSH-hosted WSL session, \
run `wsl-clipboard windows-task install` from a logged-in Windows session"
            );
            if quiet {
                Err(other(message))
            } else {
                Err(other(format!(
                    "daemon={daemon}\nclipboard=unavailable\n{task}error={message}"
                )))
            }
        }
    }
}

/// Describes the Windows Task Scheduler entry needed when an SSH-owned WSL
/// process cannot access the logged-in desktop clipboard.
struct WindowsTaskConfig {
    distro: String,
    executable: String,
    runtime_dir: Option<String>,
}

fn windows_task(command: WindowsTaskCommand) -> io::Result<()> {
    let output = match command {
        WindowsTaskCommand::Install => {
            let config = windows_task_config()?;
            run_windows_powershell(&windows_task_install_script(&config))?
        }
        WindowsTaskCommand::Status => windows_task_status()?,
        WindowsTaskCommand::Remove => {
            run_windows_powershell(&windows_task_remove_script())?
        }
    };
    print!("{output}");
    Ok(())
}

fn windows_task_config() -> io::Result<WindowsTaskConfig> {
    let distro = wsl_distro_name()?;
    let executable = env::current_exe()?.to_string_lossy().into_owned();
    let runtime_dir = env::var("XDG_RUNTIME_DIR").ok();
    Ok(WindowsTaskConfig {
        distro,
        executable,
        runtime_dir,
    })
}

fn wsl_distro_name() -> io::Result<String> {
    if let Ok(distro) = env::var("WSL_DISTRO_NAME")
        && !distro.is_empty()
    {
        return Ok(distro);
    }

    let output = Command::new(wsl_executable())
        .args(["--list", "--quiet", "--running"])
        .output()?;
    if !output.status.success() {
        return Err(other(
            "could not identify the running WSL distro; set WSL_DISTRO_NAME and retry",
        ));
    }
    let output = decode_windows_text(&output.stdout);
    let distros = output
        .lines()
        .map(str::trim)
        .filter(|distro| !distro.is_empty())
        .collect::<Vec<_>>();
    match distros.as_slice() {
        [distro] => Ok((*distro).to_owned()),
        [] => Err(other(
            "could not identify a running WSL distro; set WSL_DISTRO_NAME and retry",
        )),
        _ => Err(other(
            "more than one WSL distro is running; set WSL_DISTRO_NAME and retry",
        )),
    }
}

fn windows_task_status() -> io::Result<String> {
    run_windows_powershell(&windows_task_status_script())
}

fn windows_task_install_script(config: &WindowsTaskConfig) -> String {
    let mut arguments = vec![
        "-d".to_owned(),
        config.distro.clone(),
        "--".to_owned(),
        "/usr/bin/env".to_owned(),
    ];
    if let Some(runtime_dir) = &config.runtime_dir {
        arguments.push(format!("XDG_RUNTIME_DIR={runtime_dir}"));
    }
    arguments.extend([config.executable.clone(), "daemon".to_owned()]);
    let arguments = arguments
        .iter()
        .map(|argument| quote_windows_argument(argument))
        .collect::<Vec<_>>()
        .join(" ");
    [
        "$ErrorActionPreference = 'Stop'".to_owned(),
        format!("$taskName = {}", powershell_literal(WINDOWS_TASK_NAME)),
        "$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name".to_owned(),
        format!(
            "$action = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument {}",
            powershell_literal(&arguments)
        ),
        "$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited".to_owned(),
        "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user".to_owned(),
        "Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Trigger $trigger -Force | Out-Null".to_owned(),
        "Start-ScheduledTask -TaskName $taskName".to_owned(),
        "Write-Output 'task=installed'".to_owned(),
        "Write-Output ('task_name=' + $taskName)".to_owned(),
        "Write-Output ('task_user=' + $user)".to_owned(),
    ]
    .join("; ")
}

fn windows_task_status_script() -> String {
    [
        "$ErrorActionPreference = 'Stop'".to_owned(),
        format!(
            "$task = Get-ScheduledTask -TaskName {} -ErrorAction SilentlyContinue",
            powershell_literal(WINDOWS_TASK_NAME)
        ),
        "if ($null -eq $task) { Write-Output 'task=absent'; exit 0 }".to_owned(),
        "$info = Get-ScheduledTaskInfo -TaskName $task.TaskName".to_owned(),
        "Write-Output 'task=present'".to_owned(),
        "Write-Output ('task_name=' + $task.TaskName)".to_owned(),
        "Write-Output ('task_state=' + $task.State)".to_owned(),
        "Write-Output ('task_user=' + $task.Principal.UserId)".to_owned(),
        "Write-Output ('task_last_result=' + $info.LastTaskResult)".to_owned(),
    ]
    .join("; ")
}

fn windows_task_remove_script() -> String {
    [
        "$ErrorActionPreference = 'Stop'".to_owned(),
        format!(
            "$task = Get-ScheduledTask -TaskName {} -ErrorAction SilentlyContinue",
            powershell_literal(WINDOWS_TASK_NAME)
        ),
        "if ($null -eq $task) { Write-Output 'task=absent'; exit 0 }".to_owned(),
        "Stop-ScheduledTask -TaskName $task.TaskName -ErrorAction SilentlyContinue".to_owned(),
        "Unregister-ScheduledTask -TaskName $task.TaskName -Confirm:$false".to_owned(),
        "Write-Output 'task=removed'".to_owned(),
    ]
    .join("; ")
}

fn run_windows_powershell(script: &str) -> io::Result<String> {
    let encoded = STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let output = Command::new(power_shell_executable())
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &encoded,
        ])
        .output()?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(other(format!(
            "Windows Task Scheduler command failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}

fn power_shell_executable() -> PathBuf {
    let mounted = Path::new(WINDOWS_POWERSHELL_PATH);
    if mounted.is_file() {
        mounted.to_path_buf()
    } else {
        PathBuf::from("powershell.exe")
    }
}

fn wsl_executable() -> PathBuf {
    let mounted = Path::new(WINDOWS_WSL_PATH);
    if mounted.is_file() {
        mounted.to_path_buf()
    } else {
        PathBuf::from("wsl.exe")
    }
}

fn decode_windows_text(bytes: &[u8]) -> String {
    if bytes.len() % 2 == 0
        && bytes.iter().skip(1).step_by(2).any(|byte| *byte == 0)
    {
        String::from_utf16_lossy(
            &bytes
                .chunks_exact(2)
                .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
                .collect::<Vec<_>>(),
        )
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

fn powershell_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Quotes one Windows command-line argument for the task's `wsl.exe` action.
fn quote_windows_argument(value: &str) -> String {
    if !value.contains([' ', '\t', '"']) {
        return value.to_owned();
    }
    let mut quoted = String::from('"');
    let mut backslashes = 0;
    for character in value.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.push_str(&"\\".repeat(backslashes));
                quoted.push(character);
                backslashes = 0;
            }
        }
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

/// Sends one request to the daemon. Copy and paste commands may launch it on
/// demand; status and stop stay side-effect free when it is absent.
fn send_client_request(
    paths: &Paths,
    request: Request,
    auto_start: bool,
) -> io::Result<Vec<u8>> {
    let mut stream = match UnixStream::connect(&paths.socket) {
        Ok(stream) => stream,
        Err(error) if auto_start => {
            ensure_daemon(paths, error)?;
            UnixStream::connect(&paths.socket)?
        }
        Err(error) => return Err(error),
    };
    write_request(&mut stream, request)?;
    read_response(&mut stream)
}

/// Starts at most one daemon for a burst of clients that all observe a missing
/// socket. The lock holder rechecks the socket after acquiring the lock, so a
/// previously successful starter wins without spawning a duplicate process.
fn ensure_daemon(paths: &Paths, first_error: io::Error) -> io::Result<()> {
    prepare_runtime_dir(paths)?;
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(&paths.startup_lock)?;
    lock.lock_exclusive()?;

    if UnixStream::connect(&paths.socket).is_ok() {
        return Ok(());
    }
    if paths.socket.exists() {
        fs::remove_file(&paths.socket)?;
    }
    spawn_daemon(paths)?;

    let started_at = Instant::now();
    loop {
        match UnixStream::connect(&paths.socket) {
            Ok(_) => return Ok(()),
            Err(error) if started_at.elapsed() < STARTUP_TIMEOUT => {
                let _ = error;
                thread::sleep(Duration::from_millis(20));
            }
            Err(error) => {
                let diagnostic = recent_daemon_log(paths);
                return Err(other(format!(
                    "clipboard daemon did not start after {first_error}: {error}. \
                     Log: {}{diagnostic}",
                    paths.log.display(),
                )));
            }
        }
    }
}

/// Detaches the daemon from the short-lived client and records diagnostics in
/// a runtime log instead of corrupting command stdout.
fn spawn_daemon(paths: &Paths) -> io::Result<()> {
    let executable = env::current_exe()?;
    let log = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&paths.log)?;
    Command::new(executable)
        .arg("daemon")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log))
        .spawn()?;
    Ok(())
}

/// Owns the Unix socket and the persistent PowerShell child for one WSL user.
///
/// Client handlers may run concurrently, but the `PowerShell` mutex preserves
/// a single ordered request-response conversation with the child process.
fn run_daemon(paths: Paths) -> io::Result<()> {
    prepare_runtime_dir(&paths)?;
    if UnixStream::connect(&paths.socket).is_ok() {
        return Err(other("clipboard daemon is already running"));
    }
    if paths.socket.exists() {
        fs::remove_file(&paths.socket)?;
    }

    // Do not publish a socket until the Windows clipboard backend is ready.
    // Otherwise a failed PowerShell launch leaves a socket path that clients
    // can only report as `Connection refused`.
    let power_shell = Arc::new(Mutex::new(ClipboardBackend::start(&paths)?));
    let listener = UnixListener::bind(&paths.socket)?;
    fs::set_permissions(&paths.socket, fs::Permissions::from_mode(0o600))?;
    listener.set_nonblocking(true)?;

    let running = Arc::new(AtomicBool::new(true));
    while running.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                let power_shell = Arc::clone(&power_shell);
                let running = Arc::clone(&running);
                thread::spawn(move || {
                    handle_client(stream, power_shell, running)
                });
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(error),
        }
    }
    drop(listener);
    fs::remove_file(&paths.socket).or_else(ignore_missing_file)?;
    Ok(())
}

/// Executes one socket request and always returns either a framed result or a
/// framed error, so client command output remains separate from diagnostics.
fn handle_client(
    mut stream: UnixStream,
    power_shell: Arc<Mutex<ClipboardBackend>>,
    running: Arc<AtomicBool>,
) {
    let result = read_request(&mut stream).and_then(|request| match request {
        Request::Copy(bytes) => power_shell
            .lock()
            .map_err(poisoned)?
            .copy(&bytes)
            .map(|_| Vec::new()),
        Request::Paste => power_shell.lock().map_err(poisoned)?.paste(),
        Request::Status { verbose } => {
            power_shell.lock().map_err(poisoned)?.status(verbose)
        }
        Request::Health => power_shell
            .lock()
            .map_err(poisoned)?
            .health()
            .map(|_| b"ready\n".to_vec()),
        Request::Stop => {
            running.store(false, Ordering::SeqCst);
            Ok(b"stopped".to_vec())
        }
    });
    let _ = match result {
        Ok(bytes) => write_response(&mut stream, RESPONSE_OK, &bytes),
        Err(error) => write_response(
            &mut stream,
            RESPONSE_ERROR,
            error.to_string().as_bytes(),
        ),
    };
}

/// Selects an application-owned runtime directory. An `XDG_RUNTIME_DIR`
/// child is preferred; the UID-specific `/tmp` fallback also avoids sharing a
/// socket namespace across local users when no user runtime directory exists.
fn socket_paths() -> io::Result<Paths> {
    let runtime_dir = env::var_os("XDG_RUNTIME_DIR")
        .map(|directory| PathBuf::from(directory).join("wsl-clipboard"))
        .unwrap_or_else(|| {
            let uid = unsafe { libc::geteuid() };
            PathBuf::from(format!("/tmp/wsl-clipboard-{uid}"))
        });
    Ok(Paths {
        socket: runtime_dir.join("wsl-clipboard.sock"),
        startup_lock: runtime_dir.join("wsl-clipboard.startup.lock"),
        log: runtime_dir.join("wsl-clipboard.log"),
    })
}

/// Creates the application directory with owner-only access before placing a
/// socket, lock, or log inside it.
fn prepare_runtime_dir(paths: &Paths) -> io::Result<()> {
    let runtime_dir = paths.socket.parent().expect("socket has parent");
    fs::create_dir_all(runtime_dir)?;
    fs::set_permissions(runtime_dir, fs::Permissions::from_mode(0o700))
}

/// Recovers the daemon's most useful startup context for the waiting client.
///
/// The daemon is detached so a short-lived `pbcopy` or `pbpaste` process does
/// not own it, and its stderr is redirected to the runtime log to keep client
/// stdout clean. That separation has a subtle failure mode: when the daemon
/// exits before publishing its socket, `status` cannot connect to explain why
/// startup failed. The original client therefore reads the log directly and
/// includes its last three lines in the timeout error. The small bound keeps a
/// long-running backend's history from overwhelming a one-line CLI failure.
///
/// Reading is deliberately best-effort. A missing, unreadable, or empty log
/// contributes no suffix because the connection failure remains the primary
/// error. `spawn_daemon` truncates the log before each launch, so any returned
/// lines describe the current startup attempt rather than an older daemon.
fn recent_daemon_log(paths: &Paths) -> String {
    let Ok(log) = fs::read_to_string(&paths.log) else {
        return String::new();
    };
    let lines: Vec<_> = log.lines().rev().take(3).collect();
    if lines.is_empty() {
        String::new()
    } else {
        format!(
            "; last error: {}",
            lines.into_iter().rev().collect::<Vec<_>>().join(" | ")
        )
    }
}

fn write_request<W: Write>(writer: &mut W, request: Request) -> io::Result<()> {
    let (kind, payload): (u8, &[u8]) = match &request {
        Request::Copy(bytes) => (REQUEST_COPY, bytes),
        Request::Paste => (REQUEST_PASTE, &[]),
        Request::Status { verbose: false } => (REQUEST_STATUS, &[]),
        Request::Status { verbose: true } => (REQUEST_STATUS_VERBOSE, &[]),
        Request::Health => (REQUEST_HEALTH, &[]),
        Request::Stop => (REQUEST_STOP, &[]),
    };
    write_frame(writer, kind, payload)
}

fn read_request<R: Read>(reader: &mut R) -> io::Result<Request> {
    let (kind, payload) = read_frame(reader)?;
    match kind {
        REQUEST_COPY => Ok(Request::Copy(payload)),
        REQUEST_PASTE if payload.is_empty() => Ok(Request::Paste),
        REQUEST_STATUS if payload.is_empty() => {
            Ok(Request::Status { verbose: false })
        }
        REQUEST_STATUS_VERBOSE if payload.is_empty() => {
            Ok(Request::Status { verbose: true })
        }
        REQUEST_HEALTH if payload.is_empty() => Ok(Request::Health),
        REQUEST_STOP if payload.is_empty() => Ok(Request::Stop),
        _ => Err(other("invalid clipboard request")),
    }
}

fn write_response<W: Write>(
    writer: &mut W,
    status: u8,
    payload: &[u8],
) -> io::Result<()> {
    write_frame(writer, status, payload)
}

fn read_response<R: Read>(reader: &mut R) -> io::Result<Vec<u8>> {
    let (status, payload) = read_frame(reader)?;
    match status {
        RESPONSE_OK => Ok(payload),
        RESPONSE_ERROR => Err(other(String::from_utf8_lossy(&payload))),
        _ => Err(other("invalid clipboard response")),
    }
}

/// Writes the binary wire format: one operation/status byte, an unsigned
/// 64-bit big-endian length, then the exact payload bytes. Length framing keeps
/// embedded newlines and trailing whitespace lossless across the socket.
fn write_frame<W: Write>(
    writer: &mut W,
    kind: u8,
    payload: &[u8],
) -> io::Result<()> {
    if payload.len() as u64 > MAX_PAYLOAD_BYTES {
        return Err(other("clipboard payload exceeds 64 MiB"));
    }
    writer.write_all(&[kind])?;
    writer.write_all(&(payload.len() as u64).to_be_bytes())?;
    writer.write_all(payload)?;
    writer.flush()
}

/// Reads one complete frame and validates its allocation size before creating
/// the payload buffer.
fn read_frame<R: Read>(reader: &mut R) -> io::Result<(u8, Vec<u8>)> {
    let mut kind = [0_u8; 1];
    reader.read_exact(&mut kind)?;
    let mut length = [0_u8; 8];
    reader.read_exact(&mut length)?;
    let length = u64::from_be_bytes(length);
    if length > MAX_PAYLOAD_BYTES {
        return Err(other("clipboard payload exceeds 64 MiB"));
    }
    let mut payload = vec![0; length as usize];
    reader.read_exact(&mut payload)?;
    Ok((kind[0], payload))
}

/// Builds the child script rather than accepting a caller-provided command.
///
/// The script recognizes only `COPY`, `PASTE`, `HEALTH`, and `QUIT`; base64 carries the
/// actual text and response bytes without invoking PowerShell expression
/// evaluation on client input.
fn build_power_shell_script() -> String {
    [
        "$ErrorActionPreference = 'Stop'",
        "$utf8 = [Text.UTF8Encoding]::new($false, $true)",
        "[Console]::OutputEncoding = $utf8",
        "[Console]::Out.WriteLine('READY')",
        "[Console]::Out.Flush()",
        "while (($line = [Console]::In.ReadLine()) -ne $null) {",
        "try {",
        "if ($line -eq 'PASTE') {",
        "$text = Get-Clipboard -Raw",
        "if ($null -eq $text) { $text = '' }",
        "$bytes = $utf8.GetBytes([string]$text)",
        "[Console]::Out.WriteLine('OK ' + [Convert]::ToBase64String($bytes))",
        "} elseif ($line -eq 'HEALTH') {",
        "$null = Get-Clipboard -Raw",
        "[Console]::Out.WriteLine('OK ')",
        "} elseif ($line.StartsWith('COPY ')) {",
        "$bytes = [Convert]::FromBase64String($line.Substring(5))",
        "$text = $utf8.GetString($bytes)",
        "Set-Clipboard -Value $text",
        "[Console]::Out.WriteLine('OK ')",
        "} elseif ($line -eq 'QUIT') { break } else {",
        "throw 'invalid clipboard command'",
        "}",
        "} catch {",
        "$bytes = $utf8.GetBytes($_.Exception.Message)",
        "[Console]::Out.WriteLine('ERR ' + [Convert]::ToBase64String($bytes))",
        "}",
        "[Console]::Out.Flush()",
        "}",
    ]
    .join("; ")
}

fn is_backend_transport_error(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::BrokenPipe
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::UnexpectedEof
    )
}

fn recovery_error(
    operation: &str,
    reason: &io::Error,
    recovery: &str,
    error: &io::Error,
    backend: &ClipboardBackend,
) -> io::Error {
    other(format!(
        "Windows clipboard backend exited unexpectedly during {operation} ({reason}). \
{recovery}: {error}. Run `wsl-clipboard status --verbose`; log: {}",
        backend.log_path.display(),
    ))
}

fn clipboard_access_error(error: io::Error) -> io::Error {
    other(format!(
        "Windows clipboard access failed: {error}. If this is an SSH-hosted WSL session, \
run `wsl-clipboard windows-task install` from a logged-in Windows session"
    ))
}

fn missing_pipe() -> io::Error {
    other("PowerShell pipe was unavailable")
}

fn poisoned<T>(_: std::sync::PoisonError<T>) -> io::Error {
    other("clipboard PowerShell lock was poisoned")
}

fn ignore_missing_file(error: io::Error) -> io::Result<()> {
    if error.kind() == io::ErrorKind::NotFound {
        Ok(())
    } else {
        Err(error)
    }
}

fn other(message: impl Into<String>) -> io::Error {
    io::Error::other(message.into())
}

/// Rejects byte streams that PowerShell could only decode by replacing data.
///
/// The public commands are text tools, like macOS `pbcopy` and `pbpaste`.
/// Windows stores that text as UTF-16 internally, but every Unicode scalar has
/// a lossless UTF-8 representation at this Unix boundary. Failing here keeps
/// invalid byte streams visible instead of silently producing U+FFFD.
fn validate_utf8_input(bytes: &[u8]) -> io::Result<()> {
    std::str::from_utf8(bytes).map(|_| ()).map_err(|error| {
        other(format!("clipboard copy expects UTF-8 input: {error}"))
    })
}

fn print_usage() {
    println!(
        "Usage: wsl-clipboard <copy|paste|status|health|windows-task|stop|daemon>"
    );
    println!("  health [--quiet]  Verify clipboard access without copying data");
    println!(
        "  windows-task <install|status|remove>  Manage remote WSL clipboard access"
    );
    println!("Aliases: pbcopy, pbpaste, wsl-pbcopy, wsl-pbpaste");
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn copy_request_round_trips_unicode_and_newlines() {
        let expected = "line one\n日本語\n\n".as_bytes().to_vec();
        let mut bytes = Vec::new();
        write_request(&mut bytes, Request::Copy(expected.clone())).unwrap();
        let actual = read_request(&mut Cursor::new(bytes)).unwrap();
        assert!(matches!(actual, Request::Copy(bytes) if bytes == expected));
    }

    #[test]
    fn response_round_trips_binary_data() {
        let expected = vec![0, b'a', b'\n', 255];
        let mut bytes = Vec::new();
        write_response(&mut bytes, RESPONSE_OK, &expected).unwrap();
        assert_eq!(read_response(&mut Cursor::new(bytes)).unwrap(), expected);
    }

    #[test]
    fn rejects_payload_larger_than_limit() {
        let length = (MAX_PAYLOAD_BYTES + 1).to_be_bytes();
        let bytes = [vec![REQUEST_COPY], length.to_vec()].concat();
        assert!(read_request(&mut Cursor::new(bytes)).is_err());
    }

    #[test]
    fn power_shell_protocol_has_no_command_evaluation() {
        let script = build_power_shell_script();
        assert!(script.contains("Get-Clipboard -Raw"));
        assert!(script.contains("Set-Clipboard -Value $text"));
        assert!(script.contains("UTF8Encoding]::new($false, $true)"));
        assert!(!script.contains("Invoke-Expression"));
    }

    #[test]
    fn rejects_invalid_utf8_copy_input() {
        assert!(validate_utf8_input(&[0xff]).is_err());
    }

    #[test]
    fn installed_aliases_select_clipboard_operations() {
        assert_eq!(
            command_from_invocation(
                Path::new("/home/user/.local/bin/pbcopy"),
                vec![]
            )
            .unwrap(),
            CliCommand::Copy
        );
        assert_eq!(
            command_from_invocation(Path::new("wsl-pbpaste"), vec![]).unwrap(),
            CliCommand::Paste
        );
        assert_eq!(
            command_from_invocation(
                Path::new("wsl-clipboard"),
                vec!["status".to_owned()]
            )
            .unwrap(),
            CliCommand::Status { verbose: false }
        );
    }

    #[test]
    fn status_verbose_is_an_explicit_command() {
        assert_eq!(
            command_from_invocation(
                Path::new("wsl-clipboard"),
                vec!["status".to_owned(), "--verbose".to_owned()]
            )
            .unwrap(),
            CliCommand::Status { verbose: true }
        );
    }

    #[test]
    fn health_is_an_explicit_command() {
        assert_eq!(
            command_from_invocation(
                Path::new("wsl-clipboard"),
                vec!["health".to_owned(), "--quiet".to_owned()]
            )
            .unwrap(),
            CliCommand::Health { quiet: true }
        );
    }

    #[test]
    fn windows_task_commands_are_explicit() {
        assert_eq!(
            command_from_invocation(
                Path::new("wsl-clipboard"),
                vec!["windows-task".to_owned(), "install".to_owned()]
            )
            .unwrap(),
            CliCommand::WindowsTask {
                command: WindowsTaskCommand::Install,
            }
        );
    }

    #[test]
    fn task_install_script_uses_the_interactive_user_and_wsl_context() {
        let script = windows_task_install_script(&WindowsTaskConfig {
            distro: "Ubuntu-24.04".to_owned(),
            executable: "/home/realu/.local/bin/wsl-clipboard".to_owned(),
            runtime_dir: Some("/run/user/1000".to_owned()),
        });
        assert!(script.contains("-LogonType Interactive"));
        assert!(script.contains("-AtLogOn -User $user"));
        assert!(script.contains("-Execute 'wsl.exe'"));
        assert!(script.contains("XDG_RUNTIME_DIR=/run/user/1000"));
        assert!(script.contains("/home/realu/.local/bin/wsl-clipboard daemon"));
    }

    #[test]
    fn windows_argument_quoting_preserves_spaces_and_quotes() {
        assert_eq!(quote_windows_argument("plain"), "plain");
        assert_eq!(quote_windows_argument("with space"), "\"with space\"");
        assert_eq!(quote_windows_argument("say \"hi\""), "\"say \\\"hi\\\"\"");
    }

    #[test]
    fn windows_text_decoder_handles_wsl_utf16_output() {
        let bytes = "Ubuntu-24.04\r\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        assert_eq!(decode_windows_text(&bytes), "Ubuntu-24.04\r\n");
    }

    #[test]
    fn health_request_round_trips_without_payload() {
        let mut bytes = Vec::new();
        write_request(&mut bytes, Request::Health).unwrap();
        assert!(matches!(
            read_request(&mut Cursor::new(bytes)).unwrap(),
            Request::Health
        ));
    }

    #[test]
    fn power_shell_protocol_probes_without_copying() {
        let script = build_power_shell_script();
        assert!(script.contains("$line -eq 'HEALTH'"));
        assert!(script.contains("$null = Get-Clipboard -Raw"));
    }

    #[test]
    fn transport_errors_are_eligible_for_backend_recovery() {
        assert!(is_backend_transport_error(&io::Error::from(
            io::ErrorKind::BrokenPipe
        )));
        assert!(is_backend_transport_error(&io::Error::from(
            io::ErrorKind::UnexpectedEof
        )));
        assert!(!is_backend_transport_error(&io::Error::from(
            io::ErrorKind::InvalidInput
        )));
    }
}
