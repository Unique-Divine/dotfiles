use std::env;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Output;

use assert_cmd::Command;
use tempfile::TempDir;

fn ud() -> Command {
    assert_cmd::cargo::cargo_bin_cmd!("ud")
}

fn run(args: &[&str]) -> Output {
    ud().args(args).output().unwrap()
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_owned()
}

fn assert_success(output: &Output) {
    assert!(
        output.status.success(),
        "command failed\nstdout:\n{}\nstderr:\n{}",
        stdout(output),
        stderr(output),
    );
}

fn isolated_ud(temp: &TempDir) -> Command {
    let mut command = ud();
    command
        .env("HOME", temp.path())
        .env("XDG_DATA_HOME", temp.path().join("data"))
        .env("XDG_CACHE_HOME", temp.path().join("cache"))
        .env_remove("UD_PLUGIN_PATH");
    command
}

fn write_executable(path: &Path, contents: &str) {
    fs::write(path, contents).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

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

#[test]
fn every_command_has_clap_help() {
    for args in [
        vec!["go", "--help"],
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

#[test]
fn command_previews_do_not_execute() {
    let output = run(&["rs", "test", "--cmd"]);
    assert_success(&output);
    assert_eq!(stdout(&output), "cargo test");

    let output = run(&["go", "test-short", "--cmd"]);
    assert_success(&output);
    assert!(stdout(&output).contains("go test ./... -short"));
}

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

#[test]
fn nibi_cfg_runs_each_expected_nibid_command() {
    let temp = TempDir::new().unwrap();
    let nibid = temp.path().join("nibid");
    let args_file = temp.path().join("args");
    write_executable(
        &nibid,
        "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$NIBID_ARGS_FILE\"\n",
    );

    let output = ud()
        .env("PATH", path_with(temp.path()))
        .env("NIBID_ARGS_FILE", &args_file)
        .args(["nibi", "cfg", "prod"])
        .output()
        .unwrap();
    assert_success(&output);
    assert_eq!(
        fs::read_to_string(args_file).unwrap(),
        "config node https://rpc.archive.nibiru.fi:443\n\
         config chain-id cataclysm-1\n\
         config broadcast-mode sync\n\
         config\n"
    );
}

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

#[test]
fn mnemonic_shell_helper_pipes_the_secret_to_nibid() {
    let temp = TempDir::new().unwrap();
    let nibid = temp.path().join("nibid");
    let args_file = temp.path().join("args");
    let stdin_file = temp.path().join("stdin");
    write_executable(
        &nibid,
        "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > \"$NIBID_ARGS_FILE\"\ncat > \"$NIBID_STDIN_FILE\"\n",
    );
    let helper =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../zsh/ud/shell.sh");
    let mnemonic = "word1 word2 word3";

    let output = ud()
        .env("UD_SHELL_HELPER", helper)
        .env("PATH", path_with(temp.path()))
        .env("NIBID_ARGS_FILE", &args_file)
        .env("NIBID_STDIN_FILE", &stdin_file)
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

fn write_plugin(directory: &Path, name: &str, body: &str) -> PathBuf {
    fs::create_dir_all(directory).unwrap();
    let path = directory.join(format!("ud-{name}"));
    write_executable(&path, body);
    path
}

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
