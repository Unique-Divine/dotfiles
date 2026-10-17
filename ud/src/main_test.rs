//! End-to-end router checks; isolated homes prevent user plugin discovery.

use std::env;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Output;

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
    assert!(stdout(&output).contains("--mnem <MNEM>"));
    assert!(stdout(&output).contains("shell history"));
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

/// Mnemonic import must preserve the selected network, wallet name and input.
#[test]
fn mnemonic_import_forwards_to_the_shell_helper() {
    let temp = TempDir::new().unwrap();
    let helper = temp.path().join("helper.sh");
    write_executable(
        &helper,
        "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > \"$HELPER_ARGS_FILE\"\n",
    );
    let args_file = temp.path().join("args");
    let mnemonic = "word1 word2 word3";

    let output = ud()
        .env("UD_SHELL_HELPER", helper)
        .env("HELPER_ARGS_FILE", &args_file)
        .args([
            "nibi", "keys", "add-mnem", "--name", "alice", "--mnem", mnemonic,
        ])
        .output()
        .unwrap();
    assert_success(&output);
    assert_eq!(
        fs::read_to_string(args_file).unwrap(),
        format!("nibi-keys-add-mnem\n--name\nalice\n--mnem\n{mnemonic}\n")
    );
}

/// Invalid mnemonic arguments must fail before launching an importing process.
#[test]
fn mnemonic_import_rejects_invalid_arguments() {
    for args in [
        vec!["nibi", "keys", "add-mnem", "--name", "alice"],
        vec!["nibi", "keys", "add-mnem", "--mnem", "words"],
        vec![
            "nibi", "keys", "add-mnem", "--name", "alice", "--name", "bob",
            "--mnem", "words",
        ],
        vec![
            "nibi", "keys", "add-mnem", "--name", "alice", "--mnem", "words",
            "extra",
        ],
    ] {
        let output = run(&args);
        assert!(!output.status.success(), "args: {args:?}");
    }
}

/// Mnemonic material belongs on stdin rather than the child command line.
#[test]
fn mnemonic_shell_helper_pipes_the_secret_to_nibiru() {
    let temp = TempDir::new().unwrap();
    let nibiru = temp.path().join("nibiru");
    let args_file = temp.path().join("args");
    let stdin_file = temp.path().join("stdin");
    write_executable(
        &nibiru,
        "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > \"$NIBIRU_ARGS_FILE\"\ncat > \"$NIBIRU_STDIN_FILE\"\n",
    );
    let helper =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../zsh/ud/shell.sh");
    let mnemonic = "word1 word2 word3";

    let output = ud()
        .env("UD_SHELL_HELPER", helper)
        .env("PATH", path_with(temp.path()))
        .env("NIBIRU_ARGS_FILE", &args_file)
        .env("NIBIRU_STDIN_FILE", &stdin_file)
        .args([
            "nibi", "keys", "add-mnem", "--name", "alice", "--mnem", mnemonic,
        ])
        .output()
        .unwrap();
    assert_success(&output);
    assert_eq!(
        fs::read_to_string(args_file).unwrap(),
        "keys\nadd\nalice\n--recover\n--keyring-backend=test\n"
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
        "https://uniquedivine.com/f/26/261012-trade-modal.png"
    );
    let output = isolated_ud(&temp)
        .env("XDG_CONFIG_HOME", temp.path().join("config"))
        .env("UD_FS_BASE_URL", "https://uniquedivine.com")
        .args([
            "fs",
            "publish",
            file.to_str().unwrap(),
            "ui/trade-modal.webp",
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
        "<img src=\"https://uniquedivine.com/f/26/ui/260901-trade-modal.webp\" alt=\"trade modal\" />"
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
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$GCLOUD_ARGS\"\nexit 1\n",
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
    assert!(stderr(&output).contains("Existing names are never overwritten"));
    let args = fs::read_to_string(arguments).unwrap();
    assert!(args.contains("--if-generation-match=0"));
    assert!(args.contains("--content-md5="));
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
