use std::{
    io::Write,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_wsl-clipboard")
}

fn has_power_shell() -> bool {
    Command::new("powershell.exe")
        .arg("-Version")
        .output()
        .is_ok()
}

fn run_copy(input: &[u8]) {
    let mut child = Command::new(binary())
        .arg("copy")
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.as_mut().unwrap().write_all(input).unwrap();
    let status = child.wait().unwrap();
    assert!(status.success());
}

fn run_paste() -> Vec<u8> {
    let output = Command::new(binary()).arg("paste").output().unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    output.stdout
}

fn stop_daemon() {
    let _ = Command::new(binary()).arg("stop").output();
}

fn wait_for_daemon_stop() {
    let started_at = Instant::now();
    while started_at.elapsed() < Duration::from_secs(1) {
        let status = Command::new(binary()).arg("status").output().unwrap();
        if !status.status.success() {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("clipboard daemon did not stop");
}

fn require_power_shell() -> bool {
    if !has_power_shell() {
        eprintln!(
            "skipping Windows clipboard integration test: powershell.exe is unavailable"
        );
        return false;
    }
    true
}

#[test]
fn copies_and_pastes_existing_text_formats_and_restarts_exactly() {
    if !require_power_shell() {
        return;
    }

    let cases = [
        "one line output",
        "line0\nline1\n\n\n",
        "line0\nline1",
        "sanity check",
        "HJK 日本語",
        "この職場は、経験よりも腕を優先する考え方だ。\n職場 (しょくば)\n",
    ];

    stop_daemon();
    for expected in cases {
        run_copy(expected.as_bytes());
        assert_eq!(run_paste(), expected.as_bytes());
    }

    let expected = "line one\n日本語\n\n".as_bytes();
    run_copy(expected);
    assert_eq!(run_paste(), expected);

    stop_daemon();
    wait_for_daemon_stop();
    assert_eq!(run_paste(), expected);
    stop_daemon();
}
