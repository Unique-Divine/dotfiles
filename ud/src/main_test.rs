//! End-to-end router checks; isolated homes prevent user plugin discovery.

use std::env;
use std::fs;
use std::io::{BufRead, BufReader};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Output, Stdio};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::thread;
use std::time::Duration;

use assert_cmd::Command;
use tempfile::TempDir;

/// Locate the compiled executable through Cargo, independent of the
/// installed ud.
fn ud() -> Command {
    assert_cmd::cargo::cargo_bin_cmd!("ud")
}

/// Run a command without routing through a login shell.
fn run(args: &[&str]) -> Output {
    ud().args(args).output().unwrap()
}

/// Normalize trailing whitespace for assertions about user-facing stdout.
fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

/// Keep diagnostics separate from data intended for pipes.
fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_owned()
}

/// Include both output streams when a child command fails.
fn assert_success(output: &Output) {
    assert!(
        output.status.success(),
        "command failed\nstdout:\n{}\nstderr:\n{}",
        stdout(output),
        stderr(output),
    );
}

/// Use a disposable home and plugin search path rather than workstation state.
fn isolated_ud(temp: &TempDir) -> Command {
    let mut command = ud();
    command
        .env("HOME", temp.path())
        .env("XDG_DATA_HOME", temp.path().join("data"))
        .env("XDG_CACHE_HOME", temp.path().join("cache"))
        .env_remove("UD_PLUGIN_PATH");
    command
}

/// Create an actual child executable for controlled process-boundary fixtures.
fn write_executable(path: &Path, contents: &str) {
    fs::write(path, contents).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

/// Prepend a fixture command directory while retaining required system tools.
fn path_with(directory: &Path) -> String {
    let current = env::var_os("PATH").unwrap_or_default();
    env::join_paths(
        std::iter::once(directory.to_path_buf())
            .chain(env::split_paths(&current)),
    )
    .unwrap()
    .to_string_lossy()
    .into_owned()
}

/// An empty invocation and legacy help aliases must show help without side
/// effects.
#[test]
fn root_help_works_for_empty_help_and_aliases() {
    let temp = TempDir::new().unwrap();
    for args in [vec![], vec!["help"], vec!["h"], vec!["-h"], vec!["--help"]] {
        let output = isolated_ud(&temp).args(args).output().unwrap();
        assert_success(&output);
        assert!(stdout(&output).contains("Usage: ud [COMMAND]"));
        assert!(stdout(&output).contains("plugin"));
    }
}

/// Completions must follow Clap so aliases and nested flags stay discoverable.
#[test]
fn zsh_completions_cover_the_clap_command_tree() {
    let output = run(&["completions", "zsh"]);
    assert_success(&output);

    let completion = stdout(&output);
    assert!(completion.starts_with("#compdef ud\n"));
    assert!(completion.contains("(nibi)"));
    assert!(completion.contains("(completions)"));
    assert!(completion.contains("--archive["));
}

/// Every command branch must expose help without invoking workstation tools.
#[test]
fn every_command_has_clap_help() {
    for args in [
        vec!["go", "--help"],
        vec!["fs", "--help"],
        vec!["fs", "publish", "--help"],
        vec!["fs", "ls", "--help"],
        vec!["fs", "search", "--help"],
        vec!["fs", "tag", "--help"],
        vec!["fs", "desc", "--help"],
        vec!["fs", "tags", "--help"],
        vec!["fs", "log", "--help"],
        vec!["fs", "index", "sync", "--help"],
        vec!["fs", "refs", "--help"],
        vec!["fs", "rm", "--help"],
        vec!["rs", "--help"],
        vec!["md", "--help"],
        vec!["nibi", "--help"],
        vec!["nibi", "cfg", "--help"],
        vec!["nibi", "keys", "--help"],
        vec!["docker", "--help"],
        vec!["health", "--help"],
        vec!["plugin", "--help"],
        vec!["quick", "--help"],
        vec!["q", "--help"],
        vec!["cfg", "--help"],
    ] {
        let output = run(&args);
        assert_success(&output);
        assert!(stdout(&output).contains("Usage: ud"), "args: {args:?}");
    }
}

/// Legacy trailing help words must remain usable after the Rust migration.
#[test]
fn legacy_help_words_still_work_below_the_root() {
    for args in [
        vec!["go", "help"],
        vec!["health", "help"],
        vec!["health", "gpg", "help"],
        vec!["nibi", "keys", "add-mnem", "help"],
    ] {
        let output = run(&args);
        assert_success(&output);
        assert!(stdout(&output).contains("Usage: ud"), "args: {args:?}");
    }
}

/// Root help must resolve a nested command without executing that operation.
#[test]
fn help_command_accepts_a_nested_path() {
    let temp = TempDir::new().unwrap();
    let output = isolated_ud(&temp)
        .args(["help", "nibi", "keys", "add-mnem"])
        .output()
        .unwrap();
    assert_success(&output);
    assert!(stdout(&output).contains("--stdin"));
    assert!(!stdout(&output).contains("--mnem"));
    assert!(stdout(&output).contains(
        "pass show path/to/mnemonic | ud nibi keys add-mnem --name alice --stdin"
    ));
}

/// Preview mode must expose commands without running Cargo or Go.
#[test]
fn command_previews_do_not_execute() {
    let output = run(&["rs", "test", "--cmd"]);
    assert_success(&output);
    assert_eq!(stdout(&output), "cargo test");

    let output = run(&["go", "test-short", "--cmd"]);
    assert_success(&output);
    assert!(stdout(&output).contains("go test ./... -short"));
}

/// Package-scoped tests must use the invoked checkout, not the ud crate.
#[test]
fn rust_short_test_detects_the_current_package() {
    let temp = TempDir::new().unwrap();
    fs::write(
        temp.path().join("Cargo.toml"),
        "[package]\nname = \"sample-crate\"\nversion = \"0.1.0\"\n",
    )
    .unwrap();
    let output = ud()
        .current_dir(temp.path())
        .args(["rs", "test-short", "--cmd"])
        .output()
        .unwrap();
    assert_success(&output);
    assert_eq!(
        stdout(&output),
        "RUST_BACKTRACE=1 cargo test --package \"sample-crate\""
    );
}

/// Explicit repair intent must reach the doctor without being silently dropped.
#[test]
fn health_gpg_forwards_fix_to_the_doctor() {
    let temp = TempDir::new().unwrap();
    let doctor = temp.path().join("bin/gpg-agent-doctor");
    fs::create_dir_all(doctor.parent().unwrap()).unwrap();
    write_executable(&doctor, "#!/usr/bin/env bash\nprintf '<%s>\\n' \"$@\"\n");

    let output = ud()
        .env("DOTFILES", temp.path())
        .args(["health", "gpg", "--fix"])
        .output()
        .unwrap();
    assert_success(&output);
    assert_eq!(stdout(&output), "<--fix>");
}

/// Relative symlink targets must retain destination-relative semantics.
#[test]
fn quick_symlink_creates_a_missing_parent() {
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("ai-skills");
    let destination = temp.path().join(".agents/skills");
    fs::create_dir(&source).unwrap();

    let output = ud()
        .current_dir(temp.path())
        .args(["q", "symlink", "../ai-skills", ".agents/skills"])
        .output()
        .unwrap();
    assert_success(&output);
    assert_eq!(
        fs::read_link(&destination).unwrap(),
        PathBuf::from("../ai-skills")
    );
    assert_eq!(fs::canonicalize(destination).unwrap(), source);
}

/// Shell delegation must receive only the parsed operation and its arguments.
#[test]
fn shell_backed_commands_receive_only_the_selected_operation() {
    let temp = TempDir::new().unwrap();
    let helper = temp.path().join("helper.sh");
    write_executable(&helper, "#!/usr/bin/env bash\nprintf '<%s>\\n' \"$@\"\n");

    let output = ud()
        .env("UD_SHELL_HELPER", helper)
        .args(["docker", "start"])
        .output()
        .unwrap();
    assert_success(&output);
    assert_eq!(stdout(&output), "<docker>\n<start>");
}

/// Run `ud docker kill-all` through the real helper with a fake docker that
/// lists `compose` projects and container `ids`, and record each docker call
/// with every argument in angle brackets.
fn docker_kill_all(compose: &str, ids: &str) -> (Output, Vec<String>) {
    docker_kill_all_failing(compose, ids, "")
}

/// Like `docker_kill_all`, but the fake docker exits 1 for the subcommand
/// named in `fail` (`ps-ids` for the ID listing, or `stop`).
fn docker_kill_all_failing(
    compose: &str,
    ids: &str,
    fail: &str,
) -> (Output, Vec<String>) {
    let temp = TempDir::new().unwrap();
    let compose_file = temp.path().join("compose");
    let ids_file = temp.path().join("ids");
    let calls_file = temp.path().join("calls");
    fs::write(&compose_file, compose).unwrap();
    fs::write(&ids_file, ids).unwrap();
    write_executable(
        &temp.path().join("docker"),
        "#!/usr/bin/env bash\n\
         printf '<%s>' \"$@\" >> \"$DOCKER_CALLS_FILE\"\n\
         printf '\\n' >> \"$DOCKER_CALLS_FILE\"\n\
         case \"$1\" in\n\
         \x20 ps)\n\
         \x20   if [[ \"$*\" == *com.docker.compose.project* ]]; then\n\
         \x20     cat \"$DOCKER_COMPOSE_FILE\"\n\
         \x20   elif [[ \"$DOCKER_FAIL\" == ps-ids ]]; then\n\
         \x20     exit 1\n\
         \x20   else\n\
         \x20     cat \"$DOCKER_IDS_FILE\"\n\
         \x20   fi\n\
         \x20   ;;\n\
         \x20 stop)\n\
         \x20   [[ \"$DOCKER_FAIL\" != stop ]]\n\
         \x20   ;;\n\
         esac\n",
    );
    let helper =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../zsh/ud/shell.sh");
    let output = ud()
        .env("UD_SHELL_HELPER", helper)
        .env("PATH", path_with(temp.path()))
        .env("DOCKER_CALLS_FILE", &calls_file)
        .env("DOCKER_COMPOSE_FILE", &compose_file)
        .env("DOCKER_IDS_FILE", &ids_file)
        .env("DOCKER_FAIL", fail)
        .args(["docker", "kill-all"])
        .output()
        .unwrap();
    let calls = fs::read_to_string(calls_file)
        .unwrap()
        .lines()
        .filter(|call| !call.starts_with("<info>") && !call.starts_with("<ps>"))
        .map(str::to_owned)
        .collect();
    (output, calls)
}

/// With no running containers, kill-all must not call docker stop.
#[test]
fn docker_kill_all_skips_stop_without_containers() {
    let (output, calls) = docker_kill_all("", "");
    assert_success(&output);
    assert!(calls.is_empty(), "calls: {calls:?}");
    assert!(stdout(&output).contains("No remaining running containers found."));
}

/// One container ID is passed as one docker stop argument.
#[test]
fn docker_kill_all_stops_one_container() {
    let (output, calls) = docker_kill_all("", "abc123\n");
    assert_success(&output);
    assert_eq!(calls, ["<stop><abc123>"]);
}

/// Each container ID is its own argument, and Compose projects still get
/// `docker compose down -v` with their directory and config files.
#[test]
fn docker_kill_all_tears_down_compose_and_stops_many_containers() {
    let (output, calls) = docker_kill_all(
        "app|/work dir|/work dir/compose.yml,/work dir/override.yml\n",
        "abc123\ndef456\n789abc\n",
    );
    assert_success(&output);
    assert_eq!(
        calls,
        [
            "<compose><--project-directory></work dir>\
             <-f></work dir/compose.yml><-f></work dir/override.yml>\
             <down><-v>",
            "<stop><abc123><def456><789abc>",
        ]
    );
    assert!(stdout(&output).contains("Docker compose app: app"));
}

/// A failed container listing ends the command without calling docker stop.
#[test]
fn docker_kill_all_fails_when_listing_containers_fails() {
    let (output, calls) = docker_kill_all_failing("", "abc123\n", "ps-ids");
    assert!(!output.status.success());
    assert!(stdout(&output).contains("Failed to list running containers."));
    assert!(calls.is_empty(), "calls: {calls:?}");
}

/// A failed docker stop fails the command instead of reporting success.
#[test]
fn docker_kill_all_fails_when_docker_stop_fails() {
    let (output, calls) = docker_kill_all_failing("", "abc123\n", "stop");
    assert!(!output.status.success());
    assert_eq!(calls, ["<stop><abc123>"]);
    assert!(stdout(&output).contains("Failed to stop running containers."));
    assert!(!stdout(&output).contains("Done."));
}

/// Notes must resolve the configured repository before launching the editor.
#[test]
fn quick_shell_helper_runs_the_existing_notes_function() {
    let temp = TempDir::new().unwrap();
    let repository_root = temp.path().join("ki");
    let boku = repository_root.join("boku");
    fs::create_dir_all(&boku).unwrap();
    let nvim = temp.path().join("nvim");
    let call_file = temp.path().join("nvim-call");
    write_executable(
        &nvim,
        "#!/usr/bin/env bash\nprintf 'cwd=%s\\narg=%s\\n' \"$PWD\" \"$1\" > \"$NVIM_CALL_FILE\"\n",
    );
    let dotfiles = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let helper = dotfiles.join("zsh/ud/shell.sh");

    let output = ud()
        .env("DOTFILES", dotfiles)
        .env("REPO", &repository_root)
        .env("UD_SHELL_HELPER", helper)
        .env("PATH", path_with(temp.path()))
        .env("NVIM_CALL_FILE", &call_file)
        .args(["q", "notes"])
        .output()
        .unwrap();
    assert_success(&output);
    assert_eq!(
        fs::read_to_string(call_file).unwrap(),
        format!(
            "cwd={}\narg={}\n",
            boku.display(),
            boku.join("free/the-log.md").display()
        )
    );
}

/// Network presets must configure the expected endpoint and
/// machine-readable output.
#[test]
fn nibi_cfg_sets_the_expected_network_and_json_output() {
    for (args, rpc_url, chain_id) in [
        (
            &["local"][..],
            "http://localhost:26657",
            "nibiru-localnet-0",
        ),
        (
            &["local", "--archive"][..],
            "http://localhost:26657",
            "nibiru-localnet-0",
        ),
        (&["prod"][..], "https://rpc.nibiru.fi:443", "cataclysm-1"),
        (
            &["prod", "--archive"][..],
            "https://rpc.archive.nibiru.fi:443",
            "cataclysm-1",
        ),
        (
            &["test"][..],
            "https://rpc.testnet-2.nibiru.fi:443",
            "nibiru-testnet-2",
        ),
        (
            &["test", "--archive"][..],
            "https://rpc.archive.testnet-2.nibiru.fi:443",
            "nibiru-testnet-2",
        ),
    ] {
        let temp = TempDir::new().unwrap();
        let nibiru = temp.path().join("nibiru");
        let args_file = temp.path().join("args");
        write_executable(
            &nibiru,
            "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$NIBIRU_ARGS_FILE\"\n",
        );

        let output = ud()
            .env("PATH", path_with(temp.path()))
            .env("NIBIRU_ARGS_FILE", &args_file)
            .args(["nibi", "cfg"])
            .args(args)
            .output()
            .unwrap();
        assert_success(&output);
        assert_eq!(
            fs::read_to_string(args_file).unwrap(),
            format!(
                "config node {rpc_url}\n\
                 config chain-id {chain_id}\n\
                 config broadcast-mode sync\n\
                 config output json\n\
                 config\n"
            ),
            "args: {args:?}",
        );
    }
}

/// Help must describe supported network presets and the archive switch.
#[test]
fn nibi_cfg_help_excludes_dev_and_documents_archive() {
    let output = run(&["nibi", "cfg", "--help"]);
    assert_success(&output);
    assert!(!stdout(&output).contains("dev"));

    let output = run(&["nibi", "cfg", "prod", "--help"]);
    assert_success(&output);
    assert!(stdout(&output).contains("--archive"));

    let output = run(&["nibi", "cfg", "dev"]);
    assert!(!output.status.success());
    assert!(stderr(&output).contains("unrecognized subcommand 'dev'"));
}

/// A disposable child process that stands in for a running nibid node.
struct FakeNode {
    pid: u32,
    exit: Receiver<ExitStatus>,
}

impl FakeNode {
    /// Start `sleep`; `ignore_term` makes it survive SIGTERM.
    fn spawn(ignore_term: bool) -> Self {
        let trap = if ignore_term { "trap '' TERM; " } else { "" };
        let mut child = std::process::Command::new("bash")
            .args(["-c", &format!("{trap}echo ready; exec sleep 60")])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut ready = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        assert_eq!(ready, "ready\n");
        let pid = child.id();
        let (sender, exit) = mpsc::channel();
        // Reap promptly so an exited node does not linger as a zombie.
        thread::spawn(move || {
            let _ = sender.send(child.wait().unwrap());
        });
        Self { pid, exit }
    }

    fn is_running(&self) -> bool {
        matches!(self.exit.try_recv(), Err(TryRecvError::Empty))
    }
}

impl Drop for FakeNode {
    fn drop(&mut self) {
        if self.is_running() {
            let _ = std::process::Command::new("kill")
                .args(["-KILL", &self.pid.to_string()])
                .status();
        }
    }
}

/// Fake pgrep that reports only the fixture PIDs that are still alive, so
/// tests never see or signal a real nibid on the machine.
fn fake_pgrep(temp: &TempDir, nodes: &[&FakeNode]) -> Command {
    let pids = nodes
        .iter()
        .map(|node| node.pid.to_string())
        .collect::<Vec<_>>()
        .join(" ");
    write_executable(
        &temp.path().join("pgrep"),
        &format!(
            "#!/usr/bin/env bash\n\
             printf '%s\\n' \"$*\" >> \"$PGREP_CALLS_FILE\"\n\
             status=1\n\
             for pid in {pids}; do\n\
             \x20 if kill -0 \"$pid\" 2>/dev/null; then\n\
             \x20   printf '%s\\n' \"$pid\"\n\
             \x20   status=0\n\
             \x20 fi\n\
             done\n\
             exit \"$status\"\n"
        ),
    );
    let mut command = ud();
    command
        .env("PATH", path_with(temp.path()))
        .env("PGREP_CALLS_FILE", temp.path().join("pgrep-calls"));
    command
}

/// A bare stop must not inspect or signal any process.
#[test]
fn nibi_stop_without_all_sends_no_signal() {
    let temp = TempDir::new().unwrap();
    let node = FakeNode::spawn(false);

    let output = fake_pgrep(&temp, &[&node])
        .args(["nibi", "stop"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(stderr(&output).contains("ud nibi stop --all"));
    assert!(!temp.path().join("pgrep-calls").exists());
    thread::sleep(Duration::from_millis(300));
    assert!(node.is_running());
}

/// The broad stop lists each matched PID before sending SIGTERM to it.
#[test]
fn nibi_stop_all_lists_and_terminates_every_match() {
    let temp = TempDir::new().unwrap();
    let first = FakeNode::spawn(false);
    let second = FakeNode::spawn(false);

    let output = fake_pgrep(&temp, &[&first, &second])
        .args(["nibi", "stop", "--all"])
        .output()
        .unwrap();
    assert_success(&output);
    let text = stdout(&output);
    let lines = text.lines().collect::<Vec<_>>();
    assert_eq!(
        lines[..4],
        [
            format!("Found nibiru process {}", first.pid),
            format!("Found nibiru process {}", second.pid),
            format!("Sent SIGTERM to process {}", first.pid),
            format!("Sent SIGTERM to process {}", second.pid),
        ]
    );
    assert_eq!(lines.last(), Some(&"Done stopping nibiru processes."));
    for node in [&first, &second] {
        let status = node.exit.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(status.signal(), Some(15));
    }
    let calls = fs::read_to_string(temp.path().join("pgrep-calls")).unwrap();
    let uid = std::process::Command::new("id").arg("-u").output().unwrap();
    let expected = format!(
        "-u {} -x nibid|nibiru",
        String::from_utf8_lossy(&uid.stdout).trim()
    );
    assert!(calls.lines().all(|line| line == expected), "calls: {calls}");
}

/// Fake kill(1) whose SIGTERM fails. With `kill_first`, it SIGKILLs the
/// target before failing, as if the process exited on its own. Other signals,
/// including the `-0` liveness check, use Bash's builtin kill.
fn write_failing_kill(temp: &TempDir, kill_first: bool) {
    let exit_first = if kill_first {
        "  builtin kill -KILL \"$3\"\n\
         \x20 while builtin kill -0 \"$3\" 2>/dev/null; do sleep 0.05; done\n"
    } else {
        ""
    };
    write_executable(
        &temp.path().join("kill"),
        &format!(
            "#!/usr/bin/env bash\n\
             if [[ \"$1\" == -TERM ]]; then\n\
             {exit_first}\
             \x20 echo 'kill: Operation not permitted' >&2\n\
             \x20 exit 1\n\
             fi\n\
             builtin kill \"$@\"\n"
        ),
    );
}

/// A live process that cannot be signaled fails at once instead of waiting
/// for the timeout.
#[test]
fn nibi_stop_all_fails_fast_when_sigterm_is_refused() {
    let temp = TempDir::new().unwrap();
    let node = FakeNode::spawn(false);
    write_failing_kill(&temp, false);

    let started = std::time::Instant::now();
    let output = fake_pgrep(&temp, &[&node])
        .args(["nibi", "stop", "--all"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(stderr(&output).contains(&format!(
        "could not send SIGTERM to nibiru processes: {}",
        node.pid
    )));
    assert!(!stdout(&output).contains("Sent SIGTERM"));
    assert!(node.is_running());
}

/// A process that is gone by the time kill runs is dropped from the wait.
#[test]
fn nibi_stop_all_drops_a_process_that_already_exited() {
    let temp = TempDir::new().unwrap();
    let node = FakeNode::spawn(false);
    write_failing_kill(&temp, true);

    let output = fake_pgrep(&temp, &[&node])
        .args(["nibi", "stop", "--all"])
        .output()
        .unwrap();
    assert_success(&output);
    assert!(
        stdout(&output)
            .contains(&format!("Process {} exited before SIGTERM", node.pid))
    );
    assert!(stdout(&output).ends_with("Done stopping nibiru processes."));
}

/// Finding nothing to stop is a success, not an error.
#[test]
fn nibi_stop_all_succeeds_when_nothing_matches() {
    let temp = TempDir::new().unwrap();

    let output = fake_pgrep(&temp, &[])
        .args(["nibi", "stop", "--all"])
        .output()
        .unwrap();
    assert_success(&output);
    assert_eq!(
        stdout(&output),
        "No nibiru processes you own are running.\nDone stopping nibiru processes."
    );
}

/// A process that ignores SIGTERM must fail the command after the timeout.
#[test]
fn nibi_stop_all_fails_when_a_process_outlives_the_timeout() {
    let temp = TempDir::new().unwrap();
    let node = FakeNode::spawn(true);

    let output = fake_pgrep(&temp, &[&node])
        .args(["nibi", "stop", "--all"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        stdout(&output).contains(&format!("Found nibiru process {}", node.pid))
    );
    assert!(stderr(&output).contains(&format!(
        "nibiru processes still running after 10 seconds: {}",
        node.pid
    )));
    assert!(node.is_running());
}

/// Help must say that a broad stop needs --all.
#[test]
fn nibi_stop_help_documents_all() {
    let output = run(&["nibi", "stop", "--help"]);
    assert_success(&output);
    assert!(stdout(&output).contains("--all"));
    assert!(stdout(&output).contains("Without --all"));
}

/// The helper receives the key name as an argument and the mnemonic only on
/// stdin.
#[test]
fn mnemonic_import_forwards_to_the_shell_helper() {
    let temp = TempDir::new().unwrap();
    let helper = temp.path().join("helper.sh");
    write_executable(
        &helper,
        "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > \"$HELPER_ARGS_FILE\"\ncat > \"$HELPER_STDIN_FILE\"\n",
    );
    let args_file = temp.path().join("args");
    let stdin_file = temp.path().join("stdin");
    let mnemonic = "word1 word2 word3";

    let output = ud()
        .env("UD_SHELL_HELPER", helper)
        .env("HELPER_ARGS_FILE", &args_file)
        .env("HELPER_STDIN_FILE", &stdin_file)
        .args(["nibi", "keys", "add-mnem", "--name", "alice", "--stdin"])
        .write_stdin(format!("{mnemonic}\n"))
        .output()
        .unwrap();
    assert_success(&output);
    assert_eq!(
        fs::read_to_string(args_file).unwrap(),
        "nibi-keys-add-mnem\n--name\nalice\n"
    );
    assert_eq!(
        fs::read_to_string(stdin_file).unwrap(),
        format!("{mnemonic}\n")
    );
}

/// Invalid arguments, a missing input mode, and empty stdin must fail before
/// launching an importing process.
#[test]
fn mnemonic_import_rejects_invalid_arguments() {
    let temp = TempDir::new().unwrap();
    let helper = temp.path().join("helper.sh");
    let called = temp.path().join("called");
    write_executable(
        &helper,
        "#!/usr/bin/env bash\ntouch \"$HELPER_CALLED_FILE\"\n",
    );
    for (args, input) in [
        (
            vec!["nibi", "keys", "add-mnem", "--name", "alice"],
            "words\n",
        ),
        (vec!["nibi", "keys", "add-mnem", "--stdin"], "words\n"),
        (
            vec![
                "nibi", "keys", "add-mnem", "--name", "alice", "--mnem", "words",
            ],
            "",
        ),
        (
            vec![
                "nibi", "keys", "add-mnem", "--name", "alice", "--stdin",
                "--mnem", "words",
            ],
            "",
        ),
        (
            vec![
                "nibi", "keys", "add-mnem", "--name", "alice", "--name", "bob",
                "--stdin",
            ],
            "words\n",
        ),
        (
            vec![
                "nibi", "keys", "add-mnem", "--name", "alice", "--stdin",
                "extra",
            ],
            "words\n",
        ),
        (
            vec!["nibi", "keys", "add-mnem", "--name", "alice", "--stdin"],
            " \n\n",
        ),
    ] {
        let output = ud()
            .env("UD_SHELL_HELPER", &helper)
            .env("HELPER_CALLED_FILE", &called)
            .args(&args)
            .write_stdin(input)
            .output()
            .unwrap();
        assert!(!output.status.success(), "args: {args:?}");
        assert!(!called.exists(), "args: {args:?}");
    }
}

/// Mnemonic material reaches nibiru on stdin and never appears in the
/// argument list of ud, the Bash helper, or nibiru.
#[test]
fn mnemonic_shell_helper_pipes_the_secret_to_nibiru() {
    let temp = TempDir::new().unwrap();
    let nibiru = temp.path().join("nibiru");
    let args_file = temp.path().join("args");
    let parent_args_file = temp.path().join("parent-args");
    let stdin_file = temp.path().join("stdin");
    // The fake also records its parent's argv, which is the Bash helper.
    write_executable(
        &nibiru,
        "#!/usr/bin/env bash\n\
         printf '%s\\n' \"$@\" > \"$NIBIRU_ARGS_FILE\"\n\
         tr '\\0' '\\n' < \"/proc/$PPID/cmdline\" > \"$NIBIRU_PARENT_ARGS_FILE\"\n\
         cat > \"$NIBIRU_STDIN_FILE\"\n",
    );
    let helper =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../zsh/ud/shell.sh");
    let mnemonic = "word1 word2 word3";
    let ud_args = ["nibi", "keys", "add-mnem", "--name", "alice", "--stdin"];

    let output = ud()
        .env("UD_SHELL_HELPER", &helper)
        .env("PATH", path_with(temp.path()))
        .env("NIBIRU_ARGS_FILE", &args_file)
        .env("NIBIRU_PARENT_ARGS_FILE", &parent_args_file)
        .env("NIBIRU_STDIN_FILE", &stdin_file)
        .args(ud_args)
        .write_stdin(format!("{mnemonic}\n"))
        .output()
        .unwrap();
    assert_success(&output);
    assert!(!ud_args.join(" ").contains("word1"));
    assert_eq!(
        fs::read_to_string(args_file).unwrap(),
        "keys\nadd\nalice\n--recover\n--keyring-backend=test\n"
    );
    assert_eq!(
        fs::read_to_string(parent_args_file).unwrap(),
        format!(
            "bash\n{}\nnibi-keys-add-mnem\n--name\nalice\n",
            helper.display()
        )
    );
    assert_eq!(
        fs::read_to_string(stdin_file).unwrap(),
        format!("{mnemonic}\n")
    );
}

/// Create a discoverable executable plugin inside the fixture directory.
fn write_plugin(directory: &Path, name: &str, body: &str) -> PathBuf {
    fs::create_dir_all(directory).unwrap();
    let path = directory.join(format!("ud-{name}"));
    write_executable(&path, body);
    path
}

/// External plugins must receive literal argv and the dispatcher API context.
#[test]
fn executable_plugin_dispatches_arguments_and_environment() {
    let temp = TempDir::new().unwrap();
    let plugins = temp.path().join("plugins");
    write_plugin(
        &plugins,
        "example",
        r#"#!/usr/bin/env bash
if [[ "${1:-}" == --plugin-info ]]; then
  printf '%s\n' '{"apiVersion":1,"name":"example","description":"Test plugin"}'
  exit 0
fi
printf '%s|%s|%s\n' "$UD_PLUGIN_API_VERSION" "$UD_PLUGIN_NAME" "$*"
"#,
    );

    let output = isolated_ud(&temp)
        .env("UD_PLUGIN_PATH", &plugins)
        .args(["example", "alpha", "beta"])
        .output()
        .unwrap();
    assert_success(&output);
    assert_eq!(stdout(&output), "1|example|alpha beta");
}

/// Discovery and help must use the same validated plugin metadata contract.
#[test]
fn plugin_info_list_and_help_use_validated_metadata() {
    let temp = TempDir::new().unwrap();
    let plugins = temp.path().join("plugins");
    let plugin = write_plugin(
        &plugins,
        "example",
        "#!/usr/bin/env bash\nprintf '%s\\n' '{\"apiVersion\":1,\"name\":\"example\",\"description\":\"Test plugin\"}'\n",
    );

    let info = isolated_ud(&temp)
        .env("UD_PLUGIN_PATH", &plugins)
        .args(["plugin", "info", "example"])
        .output()
        .unwrap();
    assert_success(&info);
    assert!(stdout(&info).contains("\"name\": \"example\""));

    let list = isolated_ud(&temp)
        .env("UD_PLUGIN_PATH", &plugins)
        .args(["plugin", "list"])
        .output()
        .unwrap();
    assert_success(&list);
    assert!(stdout(&list).contains(&format!("example\t{}", plugin.display())));

    let help = isolated_ud(&temp)
        .env("UD_PLUGIN_PATH", &plugins)
        .arg("--help")
        .output()
        .unwrap();
    assert_success(&help);
    assert!(stdout(&help).contains("example        Test plugin"));
}

/// Replacing a plugin must invalidate metadata cached for the old executable.
#[test]
fn plugin_metadata_cache_refreshes_after_the_plugin_changes() {
    let temp = TempDir::new().unwrap();
    let plugins = temp.path().join("plugins");
    let counter = temp.path().join("count");
    let plugin = write_plugin(
        &plugins,
        "example",
        r#"#!/usr/bin/env bash
count=0
[[ -f "$PLUGIN_COUNTER" ]] && count=$(<"$PLUGIN_COUNTER")
printf '%s\n' "$((count + 1))" > "$PLUGIN_COUNTER"
printf '%s\n' '{"apiVersion":1,"name":"example","description":"Cached plugin"}'
"#,
    );

    for _ in 0..2 {
        let output = isolated_ud(&temp)
            .env("UD_PLUGIN_PATH", &plugins)
            .env("PLUGIN_COUNTER", &counter)
            .arg("--help")
            .output()
            .unwrap();
        assert_success(&output);
    }
    assert_eq!(fs::read_to_string(&counter).unwrap(), "1\n");
    assert!(
        temp.path()
            .join("cache/ud/plugin-metadata/example.json")
            .is_file()
    );

    let mut changed = fs::read_to_string(&plugin).unwrap();
    changed.push_str("# changed\n");
    write_executable(&plugin, &changed);
    let output = isolated_ud(&temp)
        .env("UD_PLUGIN_PATH", &plugins)
        .env("PLUGIN_COUNTER", &counter)
        .arg("--help")
        .output()
        .unwrap();
    assert_success(&output);
    assert_eq!(fs::read_to_string(counter).unwrap(), "2\n");
}

/// Plugins must not claim command names already owned by the built-in router.
#[test]
fn plugin_doctor_rejects_built_in_collisions() {
    let temp = TempDir::new().unwrap();
    let plugins = temp.path().join("plugins");
    write_plugin(
        &plugins,
        "health",
        "#!/usr/bin/env bash\nprintf '%s\\n' '{\"apiVersion\":1,\"name\":\"health\",\"description\":\"collision\"}'\n",
    );
    let output = isolated_ud(&temp)
        .env("UD_PLUGIN_PATH", plugins)
        .args(["plugin", "doctor"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(stderr(&output).contains("collides with built-in: health"));
}

/// Ambiguous plugin paths must fail instead of silently choosing an executable.
#[test]
fn duplicate_plugins_are_rejected() {
    let temp = TempDir::new().unwrap();
    let first = temp.path().join("first");
    let second = temp.path().join("second");
    let body = "#!/usr/bin/env bash\nprintf '%s\\n' '{\"apiVersion\":1,\"name\":\"example\",\"description\":\"duplicate\"}'\n";
    write_plugin(&first, "example", body);
    write_plugin(&second, "example", body);
    let paths = env::join_paths([first, second]).unwrap();

    let output = isolated_ud(&temp)
        .env("UD_PLUGIN_PATH", paths)
        .args(["plugin", "info", "example"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(stderr(&output).contains("Duplicate ud plugin: example"));
}

/// Entering an untrusted checkout must never enable a local executable plugin.
#[test]
fn a_plugin_in_the_current_directory_is_ignored() {
    let temp = TempDir::new().unwrap();
    write_plugin(
        temp.path(),
        "not-discovered",
        "#!/usr/bin/env bash\nexit 0\n",
    );

    let output = isolated_ud(&temp)
        .current_dir(temp.path())
        .arg("not-discovered")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(stderr(&output).contains("Unknown command: not-discovered"));
}

/// Help and completions must expose fs without requiring an installed plugin.
#[test]
fn fs_builtin_help_and_completion() {
    let temp = TempDir::new().unwrap();
    for args in [
        vec!["fs"],
        vec!["fs", "--help"],
        vec!["help", "fs"],
        vec!["fs", "help"],
    ] {
        let output = isolated_ud(&temp).args(args).output().unwrap();
        assert_success(&output);
        assert!(stdout(&output).contains("publish"));
        assert!(stdout(&output).contains("ls"));
    }
    let output = isolated_ud(&temp)
        .args(["completions", "zsh"])
        .output()
        .unwrap();
    assert_success(&output);
    assert!(stdout(&output).contains("--no-clipboard"));
    let output = isolated_ud(&temp)
        .args(["plugin", "list"])
        .output()
        .unwrap();
    assert_success(&output);
    assert!(stdout(&output).lines().any(|line| line == "fs"));
}

/// Dry runs traverse the compiled router but cannot authenticate or upload.
#[test]
fn fs_outputs_and_date_override_through_ud() {
    let temp = TempDir::new().unwrap();
    let file = temp.path().join("20261012-104530.png");
    fs::write(&file, b"image").unwrap();
    let output = isolated_ud(&temp)
        .env("XDG_CONFIG_HOME", temp.path().join("config"))
        .env("UD_FS_BASE_URL", "https://uniquedivine.com")
        .args([
            "fs",
            "publish",
            file.to_str().unwrap(),
            "trade-modal",
            "--dry-run",
        ])
        .output()
        .unwrap();
    assert_success(&output);
    assert_eq!(
        stdout(&output),
        "https://uniquedivine.com/f/26-10/261012-trade-modal.png"
    );
    let output = isolated_ud(&temp)
        .env("XDG_CONFIG_HOME", temp.path().join("config"))
        .env("UD_FS_BASE_URL", "https://uniquedivine.com")
        .args([
            "fs",
            "publish",
            file.to_str().unwrap(),
            "trade-modal.webp",
            "--dry-run",
            "--md",
            "--date",
            "2026-09-01",
        ])
        .output()
        .unwrap();
    assert_success(&output);
    assert_eq!(
        stdout(&output),
        "<img src=\"https://uniquedivine.com/f/26-09/260901-trade-modal.webp\" alt=\"trade modal\" />"
    );
}

/// Invalid input must fail before cloud invocation and emit no data on stdout.
#[test]
fn fs_command_errors_do_not_authenticate_or_print_data() {
    let temp = TempDir::new().unwrap();
    let bin = temp.path().join("bin");
    fs::create_dir(&bin).unwrap();
    let marker = temp.path().join("gcloud-called");
    write_executable(
        &bin.join("gcloud"),
        "#!/bin/sh\ntouch \"$GCLOUD_MARKER\"\nexit 99\n",
    );
    let file = temp.path().join("file.png");
    fs::write(&file, b"image").unwrap();
    for args in [
        vec!["fs", "ls", "--json", "--urls"],
        vec!["fs", "ls", "../26"],
        vec!["fs", "publish"],
        vec!["fs", "unknown"],
        vec!["fs", "ls", "--time", "261332"],
        vec!["fs", "ls", "--time", "26", "--all"],
        vec!["fs", "ls", "--al"],
        vec!["fs", file.to_str().unwrap(), "name", "--dry-run"],
        vec![
            "fs",
            "publish",
            file.to_str().unwrap(),
            "../bad",
            "--dry-run",
        ],
        vec![
            "fs",
            "publish",
            file.to_str().unwrap(),
            "ui/icon",
            "--dry-run",
        ],
    ] {
        let output = isolated_ud(&temp)
            .env("XDG_CONFIG_HOME", temp.path().join("config"))
            .env("UD_FS_BASE_URL", "https://example.com")
            .env("PATH", path_with(&bin))
            .env("GCLOUD_MARKER", &marker)
            .args(&args)
            .output()
            .unwrap();
        assert!(!output.status.success(), "{args:?}");
        assert_eq!(stdout(&output), "");
        assert!(
            !marker.exists(),
            "Invalid input invoked cloud login: {args:?}"
        );
    }
}

/// A failed upload cannot produce a success URL and must retain integrity
/// flags.
#[test]
fn fs_upload_refusal_has_no_success_output() {
    let temp = TempDir::new().unwrap();
    let bin = temp.path().join("bin");
    fs::create_dir(&bin).unwrap();
    let arguments = temp.path().join("args");
    write_executable(
        &bin.join("gcloud"),
        "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$GCLOUD_ARGS\"\nexit 1\n",
    );
    let file = temp.path().join("data.png");
    fs::write(&file, b"image").unwrap();
    let output = isolated_ud(&temp)
        .env("XDG_CONFIG_HOME", temp.path().join("config"))
        .env("UD_FS_BASE_URL", "https://example.com")
        .env("PATH", path_with(&bin))
        .env("GCLOUD_ARGS", &arguments)
        .args([
            "fs",
            "publish",
            file.to_str().unwrap(),
            "image",
            "--date",
            "2026-10-12",
            "--no-clipboard",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(stdout(&output), "");
    assert!(stderr(&output).contains("not overwritten without --replace"));
    let args = fs::read_to_string(arguments).unwrap();
    assert!(args.contains("--if-generation-match=0"));
    assert!(args.contains("--content-md5="));
}

/// A replace dry run must sign in to check the target, and a failed login
/// must not print the URL as if the check succeeded.
#[test]
fn fs_replace_dry_run_checks_target_through_login() {
    let temp = TempDir::new().unwrap();
    let bin = temp.path().join("bin");
    fs::create_dir(&bin).unwrap();
    let marker = temp.path().join("gcloud-called");
    write_executable(
        &bin.join("gcloud"),
        "#!/bin/sh\ntouch \"$GCLOUD_MARKER\"\nexit 1\n",
    );
    let file = temp.path().join("data.png");
    fs::write(&file, b"image").unwrap();
    let publish = |extra: &[&str]| {
        let mut args = vec![
            "fs",
            "publish",
            file.to_str().unwrap(),
            "image",
            "--date",
            "2026-10-12",
            "--dry-run",
        ];
        args.extend_from_slice(extra);
        isolated_ud(&temp)
            .env("XDG_CONFIG_HOME", temp.path().join("config"))
            .env("UD_FS_BASE_URL", "https://example.com")
            .env("PATH", path_with(&bin))
            .env("GCLOUD_MARKER", &marker)
            .args(&args)
            .output()
            .unwrap()
    };
    let plain = publish(&[]);
    assert_success(&plain);
    assert_eq!(
        stdout(&plain),
        "https://example.com/f/26-10/261012-image.png"
    );
    assert!(!marker.exists(), "plain dry run must stay local");
    let replace = publish(&["--replace"]);
    assert!(!replace.status.success());
    assert_eq!(stdout(&replace), "");
    assert!(stderr(&replace).contains("Google authentication failed"));
    assert!(marker.exists(), "replace dry run must check the target");
}

/// Installing the built-in removes only this checkout's retired symlinks.
#[test]
fn fs_migration_preserves_unrelated_files_and_links() {
    let temp = TempDir::new().unwrap();
    let dotfiles = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let plugin = temp.path().join("data/ud/plugins/ud-fs");
    let legacy = temp.path().join(".local/bin/pub");
    fs::create_dir_all(plugin.parent().unwrap()).unwrap();
    fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    let migrate = |mode: &str| {
        std::process::Command::new("bash")
            .arg(dotfiles.join("ud/migrate-fs.sh"))
            .arg(mode)
            .env("HOME", temp.path())
            .env("XDG_DATA_HOME", temp.path().join("data"))
            .output()
            .unwrap()
    };
    std::os::unix::fs::symlink(dotfiles.join("bin/ud-fs"), &plugin).unwrap();
    std::os::unix::fs::symlink(dotfiles.join("bin/pub"), &legacy).unwrap();
    assert_success(&migrate("--check"));
    assert!(plugin.is_symlink());
    assert_success(&migrate("--apply"));
    assert!(!plugin.is_symlink());
    assert!(!legacy.is_symlink());
    assert_success(&migrate("--apply"));
    fs::write(&plugin, b"unrelated executable").unwrap();
    assert!(!migrate("--apply").status.success());
    assert_eq!(fs::read(&plugin).unwrap(), b"unrelated executable");
    fs::remove_file(&plugin).unwrap();
    std::os::unix::fs::symlink("/unrelated/plugin", &plugin).unwrap();
    std::os::unix::fs::symlink("/unrelated/pub", &legacy).unwrap();
    assert!(!migrate("--apply").status.success());
    assert_eq!(
        fs::read_link(&plugin).unwrap(),
        Path::new("/unrelated/plugin")
    );
    fs::remove_file(&plugin).unwrap();
    assert_success(&migrate("--apply"));
    assert!(legacy.is_symlink());
}

/// Index commands run against a directory store without any Google login.
#[test]
fn fs_index_commands_use_a_directory_store() {
    let temp = TempDir::new().unwrap();
    let bin = temp.path().join("bin");
    fs::create_dir(&bin).unwrap();
    let marker = temp.path().join("gcloud-called");
    write_executable(
        &bin.join("gcloud"),
        "#!/bin/sh\ntouch \"$GCLOUD_MARKER\"\nexit 99\n",
    );
    let file = temp.path().join("file.png");
    fs::write(&file, b"image").unwrap();
    let ud_fs = |args: &[&str]| {
        let mut full = vec!["fs"];
        full.extend_from_slice(args);
        isolated_ud(&temp)
            .env("XDG_CONFIG_HOME", temp.path().join("config"))
            .env("UD_FS_INDEX_DIR", temp.path().join("index"))
            .env("UD_FS_BASE_URL", "https://example.com")
            .env("PATH", path_with(&bin))
            .env("GCLOUD_MARKER", &marker)
            .args(&full)
            .output()
            .unwrap()
    };
    let empty = ud_fs(&["tags"]);
    assert_success(&empty);
    assert_eq!(stdout(&empty), "tags: []");
    let empty = ud_fs(&["search", "chart", "--tag", "sai"]);
    assert_success(&empty);
    assert_eq!(stdout(&empty), "files: []");
    let unknown = ud_fs(&["tag", "26-11/261108-a.png", "--add", "sai"]);
    assert!(!unknown.status.success());
    assert!(stderr(&unknown).contains("--new-tag"));
    let missing = ud_fs(&[
        "tag",
        "https://example.com/f/26-11/261108-a.png",
        "--add",
        "sai",
        "--new-tag",
    ]);
    assert!(!missing.status.success());
    assert!(stderr(&missing).contains("index sync"));
    for args in [
        vec!["search", "--tag", "Bad Tag"],
        vec!["tag", "../x", "--add", "a"],
        vec!["tag", "26/a.png"],
        vec![
            "publish",
            file.to_str().unwrap(),
            "a",
            "--tag",
            "Bad",
            "--dry-run",
        ],
    ] {
        let output = ud_fs(&args);
        assert!(!output.status.success(), "{args:?}");
        assert_eq!(stdout(&output), "");
    }
    let log = ud_fs(&["log"]);
    assert_success(&log);
    assert_eq!(stdout(&log), "changes: []");
    assert!(!marker.exists(), "directory index must not call gcloud");
}

/// Deletion previews tags and backlinks and never calls gcloud without --yes.
#[test]
fn fs_rm_previews_backlinks_without_deleting() {
    let temp = TempDir::new().unwrap();
    let bin = temp.path().join("bin");
    fs::create_dir(&bin).unwrap();
    let marker = temp.path().join("gcloud-called");
    write_executable(
        &bin.join("gcloud"),
        "#!/bin/sh\ntouch \"$GCLOUD_MARKER\"\nexit 99\n",
    );
    let docs = temp.path().join("docs");
    fs::create_dir(&docs).unwrap();
    fs::write(
        docs.join("post.md"),
        "![x](https://example.com/f/26-11/261108-a.png)\n",
    )
    .unwrap();
    let ud_fs = |args: &[&str]| {
        let mut full = vec!["fs"];
        full.extend_from_slice(args);
        isolated_ud(&temp)
            .env("XDG_CONFIG_HOME", temp.path().join("config"))
            .env("UD_FS_INDEX_DIR", temp.path().join("index"))
            .env("UD_FS_REF_ROOTS", &docs)
            .env("UD_FS_BASE_URL", "https://example.com")
            .env("PATH", path_with(&bin))
            .env("GCLOUD_MARKER", &marker)
            .args(&full)
            .output()
            .unwrap()
    };
    // Unindexed keys are refused rather than previewed as deletable.
    let unknown = ud_fs(&["rm", "https://example.com/f/26-11/261108-a.png"]);
    assert!(!unknown.status.success());
    assert!(stderr(&unknown).contains("Not live in the index"));
    // Create the index through the CLI, then add one file row directly.
    assert_success(&ud_fs(&["tags", "--prune"]));
    let remote = temp.path().join("index");
    let db = rusqlite::Connection::open(remote.join("fs.db")).unwrap();
    db.execute(
        "INSERT INTO files (key, slug, size, content_type, created_at)
         VALUES ('26-11/261108-a.png', 'a', 1, 'image/png', 'now')",
        [],
    )
    .unwrap();
    drop(db);
    fs::write(remote.join("fs.db.generation"), "2").unwrap();
    let preview = ud_fs(&["rm", "https://example.com/f/26-11/261108-a.png"]);
    assert_success(&preview);
    assert_eq!(stdout(&preview), "");
    let notes = stderr(&preview);
    assert!(notes.contains("Would delete 1 file(s); 1 with backlinks"));
    assert!(notes.contains("post.md"), "{notes}");
    assert!(notes.contains("Pass --yes"));
    let refs = ud_fs(&["refs", "26-11/261108-a.png"]);
    assert_success(&refs);
    assert!(stdout(&refs).starts_with("refs[1]{key,file}:"));
    let none = ud_fs(&["rm", "--tag", "unused-group"]);
    assert!(!none.status.success());
    assert!(stderr(&none).contains("No live files match"));
    assert!(!marker.exists(), "preview must not call gcloud");
}
