use std::{
    env,
    fs::{self, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
    },
    path::PathBuf,
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

const MAX_PAYLOAD_BYTES: u64 = 64 * 1024 * 1024;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(2);
const REQUEST_COPY: u8 = 1;
const REQUEST_PASTE: u8 = 2;
const REQUEST_STATUS: u8 = 3;
const REQUEST_STOP: u8 = 4;
const RESPONSE_OK: u8 = 0;
const RESPONSE_ERROR: u8 = 1;

enum Request {
    Copy(Vec<u8>),
    Paste,
    Status,
    Stop,
}

struct Paths {
    socket: PathBuf,
    startup_lock: PathBuf,
    log: PathBuf,
}

struct PowerShell {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl PowerShell {
    fn start() -> io::Result<Self> {
        let script = build_power_shell_script();
        let mut child = Command::new("powershell.exe")
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
            .stderr(Stdio::null())
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
        Ok(power_shell)
    }

    fn copy(&mut self, bytes: &[u8]) -> io::Result<()> {
        let request = format!("COPY {}\n", STANDARD.encode(bytes));
        self.stdin.write_all(request.as_bytes())?;
        self.stdin.flush()?;
        self.expect_ok().map(|_| ())
    }

    fn paste(&mut self) -> io::Result<Vec<u8>> {
        self.stdin.write_all(b"PASTE\n")?;
        self.stdin.flush()?;
        self.expect_ok()
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
            return Err(other("PowerShell closed its output stream"));
        }
        Ok(line.trim_end_matches(['\r', '\n']).to_owned())
    }

    fn shutdown(&mut self) {
        let _ = self.stdin.write_all(b"QUIT\n");
        let _ = self.stdin.flush();
        let _ = self.child.wait();
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
    let command = env::args().nth(1).unwrap_or_else(|| "help".to_owned());
    let paths = socket_paths()?;
    match command.as_str() {
        "copy" => {
            let mut bytes = Vec::new();
            io::stdin().read_to_end(&mut bytes)?;
            send_client_request(&paths, Request::Copy(bytes), true).map(|_| ())
        }
        "paste" => {
            let bytes = send_client_request(&paths, Request::Paste, true)?;
            io::stdout().write_all(&bytes)
        }
        "status" => {
            send_client_request(&paths, Request::Status, false)?;
            println!("running");
            Ok(())
        }
        "stop" => {
            send_client_request(&paths, Request::Stop, false)?;
            println!("stopped");
            Ok(())
        }
        "daemon" => run_daemon(paths),
        "help" | "--help" | "-h" => {
            print_usage();
            Ok(())
        }
        _ => Err(other(format!("unknown command: {command}"))),
    }
}

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
                return Err(other(format!(
                    "clipboard daemon did not start after {first_error}: {error}",
                )));
            }
        }
    }
}

fn spawn_daemon(paths: &Paths) -> io::Result<()> {
    let executable = env::current_exe()?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.log)?;
    Command::new(executable)
        .arg("daemon")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log))
        .spawn()?;
    Ok(())
}

fn run_daemon(paths: Paths) -> io::Result<()> {
    prepare_runtime_dir(&paths)?;
    if UnixStream::connect(&paths.socket).is_ok() {
        return Err(other("clipboard daemon is already running"));
    }
    if paths.socket.exists() {
        fs::remove_file(&paths.socket)?;
    }
    let listener = UnixListener::bind(&paths.socket)?;
    fs::set_permissions(&paths.socket, fs::Permissions::from_mode(0o600))?;
    listener.set_nonblocking(true)?;

    let power_shell = Arc::new(Mutex::new(PowerShell::start()?));
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

fn handle_client(
    mut stream: UnixStream,
    power_shell: Arc<Mutex<PowerShell>>,
    running: Arc<AtomicBool>,
) {
    let result = read_request(&mut stream).and_then(|request| match request {
        Request::Copy(bytes) => power_shell
            .lock()
            .map_err(poisoned)?
            .copy(&bytes)
            .map(|_| Vec::new()),
        Request::Paste => power_shell.lock().map_err(poisoned)?.paste(),
        Request::Status => Ok(b"running".to_vec()),
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

fn prepare_runtime_dir(paths: &Paths) -> io::Result<()> {
    let runtime_dir = paths.socket.parent().expect("socket has parent");
    fs::create_dir_all(runtime_dir)?;
    fs::set_permissions(runtime_dir, fs::Permissions::from_mode(0o700))
}

fn write_request<W: Write>(writer: &mut W, request: Request) -> io::Result<()> {
    let (kind, payload): (u8, &[u8]) = match &request {
        Request::Copy(bytes) => (REQUEST_COPY, bytes),
        Request::Paste => (REQUEST_PASTE, &[]),
        Request::Status => (REQUEST_STATUS, &[]),
        Request::Stop => (REQUEST_STOP, &[]),
    };
    write_frame(writer, kind, payload)
}

fn read_request<R: Read>(reader: &mut R) -> io::Result<Request> {
    let (kind, payload) = read_frame(reader)?;
    match kind {
        REQUEST_COPY => Ok(Request::Copy(payload)),
        REQUEST_PASTE if payload.is_empty() => Ok(Request::Paste),
        REQUEST_STATUS if payload.is_empty() => Ok(Request::Status),
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

fn build_power_shell_script() -> String {
    [
        "$ErrorActionPreference = 'Stop'",
        "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
        "[Console]::Out.WriteLine('READY')",
        "[Console]::Out.Flush()",
        "while (($line = [Console]::In.ReadLine()) -ne $null) {",
        "try {",
        "if ($line -eq 'PASTE') {",
        "$text = Get-Clipboard -Raw",
        "if ($null -eq $text) { $text = '' }",
        "$bytes = [Text.Encoding]::UTF8.GetBytes([string]$text)",
        "[Console]::Out.WriteLine('OK ' + [Convert]::ToBase64String($bytes))",
        "} elseif ($line.StartsWith('COPY ')) {",
        "$bytes = [Convert]::FromBase64String($line.Substring(5))",
        "$text = [Text.Encoding]::UTF8.GetString($bytes)",
        "Set-Clipboard -Value $text",
        "[Console]::Out.WriteLine('OK ')",
        "} elseif ($line -eq 'QUIT') { break } else {",
        "throw 'invalid clipboard command'",
        "}",
        "} catch {",
        "$bytes = [Text.Encoding]::UTF8.GetBytes($_.Exception.Message)",
        "[Console]::Out.WriteLine('ERR ' + [Convert]::ToBase64String($bytes))",
        "}",
        "[Console]::Out.Flush()",
        "}",
    ]
    .join("; ")
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

fn print_usage() {
    println!("Usage: wsl-clipboard <copy|paste|status|stop|daemon>");
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
        assert!(!script.contains("Invoke-Expression"));
    }
}
