use std::{
    env,
    io::Write,
    process::{Command, Output, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

const LEGACY_PBCOPY: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../bin/legacy-pbcopy");
const LEGACY_PBPASTE: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../bin/legacy-pbpaste");
static CLIPBOARD_TEST_LOCK: Mutex<()> = Mutex::new(());
struct ClipboardCli {
    name: &'static str,
    copy_executable: &'static str,
    copy_args: &'static [&'static str],
    paste_executable: &'static str,
    paste_args: &'static [&'static str],
}

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_wsl-clipboard")
}

fn legacy_clipboard() -> ClipboardCli {
    ClipboardCli {
        name: "legacy one-shot clipboard",
        copy_executable: LEGACY_PBCOPY,
        copy_args: &[],
        paste_executable: LEGACY_PBPASTE,
        paste_args: &[],
    }
}

fn rust_clipboard() -> ClipboardCli {
    ClipboardCli {
        name: "wsl-clipboard",
        copy_executable: binary(),
        copy_args: &["copy"],
        paste_executable: binary(),
        paste_args: &["paste"],
    }
}

fn command_available(executable: &str) -> bool {
    Command::new(executable)
        .arg("-NoProfile")
        .arg("-Command")
        .arg("exit 0")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn run_command(executable: &str, args: &[&str], input: Option<&[u8]>) -> Output {
    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    if let Some(input) = input {
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(input).unwrap();
    }
    child.wait_with_output().unwrap()
}

fn copy(cli: &ClipboardCli, input: &[u8]) {
    let output = run_command(cli.copy_executable, cli.copy_args, Some(input));
    assert!(
        output.status.success(),
        "{} copy failed: {}",
        cli.name,
        String::from_utf8_lossy(&output.stderr),
    );
    assert!(output.stdout.is_empty(), "{} copy wrote stdout", cli.name);
    assert!(output.stderr.is_empty(), "{} copy wrote stderr", cli.name);
}

fn paste(cli: &ClipboardCli) -> Vec<u8> {
    let output = run_command(cli.paste_executable, cli.paste_args, None);
    assert!(
        output.status.success(),
        "{} paste failed: {}",
        cli.name,
        String::from_utf8_lossy(&output.stderr),
    );
    assert!(output.stderr.is_empty(), "{} paste wrote stderr", cli.name);
    output.stdout
}

fn run_rust_command(args: &[&str]) -> Output {
    run_command(binary(), args, None)
}

fn verbose_status() -> String {
    let output = run_rust_command(&["status", "--verbose"]);
    assert!(
        output.status.success(),
        "verbose status failed: {}",
        String::from_utf8_lossy(&output.stderr),
    );
    String::from_utf8(output.stdout).unwrap()
}

fn status_field(status: &str, name: &str) -> String {
    status
        .lines()
        .find_map(|line| line.strip_prefix(&format!("{name}=")))
        .unwrap_or_else(|| panic!("{name} was missing from status: {status}"))
        .to_owned()
}

fn stop_daemon() {
    let _ = run_rust_command(&["stop"]);
}

fn wait_for_daemon_stop() {
    let started_at = Instant::now();
    while started_at.elapsed() < Duration::from_secs(1) {
        if !run_rust_command(&["status"]).status.success() {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("clipboard daemon did not stop");
}

fn wait_for_backend_exit() {
    let started_at = Instant::now();
    while started_at.elapsed() < Duration::from_secs(2) {
        let output = run_rust_command(&["status"]);
        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr);
            assert!(
                error.contains("Windows clipboard backend"),
                "status did not describe the dead backend: {error}",
            );
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("clipboard backend did not exit");
}

fn terminate_process(pid: &str) {
    let status = Command::new("kill").args(["-TERM", pid]).status().unwrap();
    assert!(status.success(), "failed to terminate PowerShell PID {pid}");
}

fn require_clipboard_prerequisites() -> bool {
    if !command_available("powershell.exe") {
        eprintln!(
            "skipping Windows clipboard integration test: powershell.exe is unavailable"
        );
        return false;
    }
    true
}

fn assert_clipboard_case(input: &str) {
    let expected = input.as_bytes();
    let legacy = legacy_clipboard();
    let rust = rust_clipboard();

    copy(&legacy, expected);
    let legacy_output = paste(&legacy);
    assert_eq!(
        legacy_output, expected,
        "legacy output differed from expectation"
    );

    copy(&rust, expected);
    let rust_output = paste(&rust);
    assert_eq!(
        rust_output, expected,
        "Rust output differed from expectation"
    );

    assert_eq!(
        rust_output, legacy_output,
        "Rust output differed from legacy"
    );
}

/// The Windows clipboard is global to the interactive desktop. The shared
/// lock prevents this scenario from racing the recovery integration test.
#[test]
fn preserves_legacy_cases_and_unicode() {
    if !require_clipboard_prerequisites() {
        return;
    }
    let _clipboard_lock = CLIPBOARD_TEST_LOCK.lock().unwrap();

    let cases = [
        "one line output\n",
        "line0\nline1\n\n\n",
        "line0\nline1",
        "sanity check",
        "HJK 日本語",
        "この職場は、経験よりも腕を優先する考え方だ。\n職場 (しょくば)\n",
        "’—“” → ← ↔ ✓",
        "ΓÇÖ ╬ô├ç├û ΓÇô ΓÇ£ ΓÇ¥",
        "e\u{301} café 東京語 𐐷",
        "😀 👍 ❤️ 👩‍👩‍👧‍👧 🏳️‍🌈 🇺🇸 🐈",
    ];

    stop_daemon();
    for input in cases {
        assert_clipboard_case(input);
    }

    let expected = "line one\n日本語\n\n";
    let rust = rust_clipboard();
    copy(&rust, expected.as_bytes());
    assert_eq!(paste(&rust), expected.as_bytes());

    stop_daemon();
    wait_for_daemon_stop();
    assert_eq!(paste(&rust), expected.as_bytes());
    stop_daemon();
}

#[test]
fn recovers_after_the_powershell_backend_exits() {
    if !require_clipboard_prerequisites() {
        return;
    }
    let _clipboard_lock = CLIPBOARD_TEST_LOCK.lock().unwrap();
    stop_daemon();

    let rust = rust_clipboard();
    copy(&rust, b"recovery test before\n");
    let original_status = verbose_status();
    let original_pid = status_field(&original_status, "powershell_pid");
    terminate_process(&original_pid);
    wait_for_backend_exit();

    let recovered = "recovered after backend exit 日本語\n";
    copy(&rust, recovered.as_bytes());
    assert_eq!(paste(&rust), recovered.as_bytes());
    let recovered_status = verbose_status();
    assert_ne!(
        status_field(&recovered_status, "powershell_pid"),
        original_pid,
        "recovery should create a replacement PowerShell process",
    );

    stop_daemon();
    wait_for_daemon_stop();
}

#[test]
fn utf16le_to_utf8_preserves_unicode_scalars() {
    let expected = "😀 👩‍👩‍👧‍👧 𐐷 ’—→ 日本語";
    let utf16: Vec<u16> = expected.encode_utf16().collect();
    assert_eq!(String::from_utf16(&utf16).unwrap(), expected);
}

#[test]
fn copy_rejects_invalid_utf8_before_starting_daemon() {
    let output = run_command(binary(), &["copy"], Some(&[0xff]));
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("expects UTF-8"));
}
