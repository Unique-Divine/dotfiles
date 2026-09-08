use std::env;
use std::ffi::OsStr;
use std::fs;
use std::os::unix::fs as unix_fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};

use crate::cli::{
    CommandPreview, DockerCommand, GoCommand, HealthCommand, MarkdownCommand,
    NibiCommand, NibiKeysCommand, NibiNetwork, QuickCommand, RustCommand,
};
use crate::process;

pub fn run_go(command: GoCommand) -> Result<i32> {
    match command {
        GoCommand::TestShort(preview) => run_go_script(
            "go test ./... -short 2>&1 | grep -Ev 'no test|no statement'",
            preview,
        ),
        GoCommand::TestIntegration(preview) => run_go_script(
            "go test ./... -run Integration 2>&1 | grep -Ev 'no test|no statement'",
            preview,
        ),
        GoCommand::Test(preview) => run_go_script(
            "go test ./... 2>&1 | grep -Ev 'no test|no statement'",
            preview,
        ),
        GoCommand::Lint(preview) => run_go_script(
            "golangci-lint run --allow-parallel-runners --fix",
            preview,
        ),
        GoCommand::CoverShort(preview) => run_go_coverage(
            "go test ./... -short -cover -coverprofile='/tmp/temp.out' 2>&1 | grep -Ev 'no test|no statement'",
            preview,
        ),
        GoCommand::Cover(preview) => run_go_coverage(
            "go test ./... -cover -coverprofile='/tmp/temp.out' 2>&1 | grep -Ev 'no test|no statement'",
            preview,
        ),
    }
}

fn run_go_script(script: &str, preview: CommandPreview) -> Result<i32> {
    process::run_shell(script, script, preview.cmd)
}

fn run_go_coverage(script: &str, preview: CommandPreview) -> Result<i32> {
    let code = process::run_shell(script, script, preview.cmd)?;
    if preview.cmd || code != 0 {
        return Ok(code);
    }

    let mut coverage = Command::new("go");
    coverage.args([
        "tool",
        "cover",
        "-html=/tmp/temp.out",
        "-o",
        "/tmp/coverage.html",
    ]);
    let code = process::run_quiet(coverage)?;
    if code != 0 {
        return Ok(code);
    }

    for (program, args) in [
        ("wslview", vec!["/tmp/coverage.html"]),
        ("open", vec!["/tmp/coverage.html"]),
        ("explorer.exe", vec!["/tmp/coverage.html"]),
    ] {
        let status = Command::new(program)
            .args(args)
            .stderr(Stdio::null())
            .status();
        if status.is_ok_and(|status| status.success()) {
            return Ok(0);
        }
    }
    println!("Coverage report generated:\n/tmp/coverage.html");
    Ok(0)
}

pub fn run_rust(command: RustCommand) -> Result<i32> {
    match command {
        RustCommand::TestShort(preview) => rust_test_short(preview),
        RustCommand::Test(preview) => {
            let mut command = Command::new("cargo");
            command.arg("test");
            process::run(command, "cargo test", preview.cmd)
        }
        RustCommand::Fmt(preview) => rust_fmt(preview),
        RustCommand::Tidy(preview) => rust_tidy(preview),
        RustCommand::Lint(preview) => {
            let mut command = Command::new("cargo");
            command.args(["clippy", "--fix", "--allow-dirty", "--allow-staged"]);
            process::run(
                command,
                "cargo clippy --fix --allow-dirty --allow-staged",
                preview.cmd,
            )
        }
        RustCommand::ClippyCheck(preview) => {
            let mut command = Command::new("cargo");
            command.arg("clippy");
            process::run(command, "cargo clippy", preview.cmd)
        }
    }
}

fn rust_test_short(preview: CommandPreview) -> Result<i32> {
    let package = current_package_name();
    let mut command = Command::new("cargo");
    command.arg("test").env("RUST_BACKTRACE", "1");
    let display = if let Some(package) = package {
        command.args(["--package", &package]);
        format!("RUST_BACKTRACE=1 cargo test --package \"{package}\"")
    } else {
        "RUST_BACKTRACE=1 cargo test".to_owned()
    };
    process::run(command, &display, preview.cmd)
}

fn current_package_name() -> Option<String> {
    let manifest = fs::read_to_string("Cargo.toml").ok()?;
    manifest.lines().find_map(|line| {
        let value = line.trim().strip_prefix("name")?.trim_start();
        let value = value.strip_prefix('=')?.trim();
        value
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .map(str::to_owned)
    })
}

fn rust_fmt(preview: CommandPreview) -> Result<i32> {
    let display = "cp \"$DOTFILES/rustfmt.toml\" . && cargo fmt --all";
    println!("{display}");
    if preview.cmd {
        return Ok(0);
    }
    let dotfiles = dotfiles_path()?;
    fs::copy(dotfiles.join("rustfmt.toml"), "rustfmt.toml")
        .context("failed to copy the shared rustfmt.toml")?;
    let mut command = Command::new("cargo");
    command.args(["fmt", "--all"]);
    process::run_quiet(command)
}

fn rust_tidy(preview: CommandPreview) -> Result<i32> {
    if preview.cmd {
        println!("cargo build && ud rs lint && ud rs fmt");
        return Ok(0);
    }

    let mut build = Command::new("cargo");
    build.arg("build");
    let code = process::run(build, "cargo build", false)?;
    if code != 0 {
        return Ok(code);
    }
    let code = run_rust(RustCommand::Lint(CommandPreview { cmd: false }))?;
    if code != 0 {
        return Ok(code);
    }
    run_rust(RustCommand::Fmt(CommandPreview { cmd: false }))
}

pub fn run_markdown(command: MarkdownCommand) -> i32 {
    match command {
        MarkdownCommand::Show => {
            println!("Use command: markdown-preview");
            println!("Install with: bun install -g @mryhryki/markdown-preview");
            0
        }
    }
}

pub fn run_health(command: HealthCommand) -> Result<i32> {
    match command {
        HealthCommand::Gpg { fix } => {
            let doctor = dotfiles_path()?.join("bin/gpg-agent-doctor");
            let executable = fs::metadata(&doctor).is_ok_and(|metadata| {
                use std::os::unix::fs::PermissionsExt;
                metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
            });
            if !executable {
                bail!(
                    "GPG agent doctor is not executable: {}",
                    doctor.display()
                );
            }
            let mut command = Command::new("bash");
            command.arg(&doctor);
            if fix {
                command.arg("--fix");
            }
            process::run_quiet(command)
        }
    }
}

pub fn run_quick(command: QuickCommand) -> Result<i32> {
    match command {
        QuickCommand::Dotf(preview) => quick_helper("dotf", "dotf", preview),
        QuickCommand::Ip => quick_ip(),
        QuickCommand::Music(preview) => quick_helper("music", "music", preview),
        QuickCommand::Notes(preview) => quick_helper("notes", "notes", preview),
        QuickCommand::Out(preview) => {
            let home = env::var("HOME").context("HOME is not set")?;
            quick_helper("out", &format!("nvim {home}/ki/out.txt"), preview)
        }
        QuickCommand::Symlink { src, dst } => quick_symlink(&src, &dst),
        QuickCommand::Skills(preview) => {
            quick_helper("skills", "skills", preview)
        }
        QuickCommand::Todos(preview) => quick_helper("todos", "todos", preview),
    }
}

fn quick_helper(
    name: &str,
    display: &str,
    preview: CommandPreview,
) -> Result<i32> {
    println!("{display}");
    if preview.cmd {
        return Ok(0);
    }
    run_shell_helper([OsStr::new("quick"), OsStr::new(name)])
}

fn quick_symlink(src: &Path, dst: &Path) -> Result<i32> {
    let parent = dst
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)
        .with_context(|| format!("failed to create {}", parent.display()))?;
    if dst.is_symlink() {
        fs::remove_file(dst)
            .with_context(|| format!("failed to replace {}", dst.display()))?;
    }
    unix_fs::symlink(src, dst).with_context(|| {
        format!(
            "failed to create symbolic link {} -> {}",
            dst.display(),
            src.display()
        )
    })?;
    Ok(0)
}

fn quick_ip() -> Result<i32> {
    let output = Command::new("curl")
        .args(["-s", "--max-time", "12", "https://api.ipify.org"])
        .output()
        .context("failed to query the public IP")?;
    let ip = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if !output.status.success() || ip.is_empty() {
        bail!("Unable to fetch public IP from https://api.ipify.org");
    }
    println!("{ip}");

    let url = format!(
        "http://ip-api.com/line/{ip}?fields=status,country,regionName,city"
    );
    let Ok(output) = Command::new("curl")
        .args(["-s", "--max-time", "12", &url])
        .output()
    else {
        return Ok(0);
    };
    let geo = String::from_utf8_lossy(&output.stdout);
    let mut lines = geo.lines();
    if lines.next() != Some("success") {
        return Ok(0);
    }
    let country = lines.next().unwrap_or_default();
    let region = lines.next().unwrap_or_default();
    let city = lines.next().unwrap_or_default();
    let location = [city, region, country]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    if !location.is_empty() {
        println!("Region: {location}");
    }
    Ok(0)
}

pub fn run_nibi(command: NibiCommand) -> Result<i32> {
    match command {
        NibiCommand::Cfg(network) => match network.command {
            Some(network) => configure_nibi(network),
            None => bail!("missing Nibiru network"),
        },
        NibiCommand::Addrs => {
            for name in [
                "ADDR_VAL",
                "ADDR_UD",
                "ADDR_DELPHI",
                "FAUCET_WEB",
                "FAUCET_DISCORD",
            ] {
                println!("{} {name}", env::var(name).unwrap_or_default());
            }
            Ok(0)
        }
        NibiCommand::GetNibid => {
            run_shell_helper([OsStr::new("nibi-get-nibid")])
        }
        NibiCommand::Stop => stop_nibid(),
        NibiCommand::Keys(keys) => match keys.command {
            Some(command) => run_nibi_keys(command),
            None => bail!("missing Nibiru keys command"),
        },
    }
}

fn configure_nibi(network: NibiNetwork) -> Result<i32> {
    let (rpc_url, chain_id) = match network {
        NibiNetwork::Local => ("http://localhost:26657", "nibiru-localnet-0"),
        NibiNetwork::Prod => {
            ("https://rpc.archive.nibiru.fi:443", "cataclysm-1")
        }
        NibiNetwork::Test => (
            "https://rpc.archive.testnet-2.nibiru.fi:443",
            "nibiru-testnet-2",
        ),
        NibiNetwork::Dev => {
            ("https://rpc.devnet-3.nibiru.fi:443", "nibiru-devnet-3")
        }
    };
    for args in [
        vec!["config", "node", rpc_url],
        vec!["config", "chain-id", chain_id],
        vec!["config", "broadcast-mode", "sync"],
        vec!["config"],
    ] {
        let mut command = Command::new("nibid");
        command.args(args);
        let code = process::run_quiet(command)?;
        if code != 0 {
            return Ok(code);
        }
    }
    Ok(0)
}

fn run_nibi_keys(command: NibiKeysCommand) -> Result<i32> {
    let (name, mnemonic) = command.into_parts();
    run_shell_helper([
        OsStr::new("nibi-keys-add-mnem"),
        OsStr::new("--name"),
        OsStr::new(&name),
        OsStr::new("--mnem"),
        OsStr::new(&mnemonic),
    ])
}

fn stop_nibid() -> Result<i32> {
    let output = Command::new("pgrep")
        .args(["-x", "nibid"])
        .output()
        .context("failed to inspect nibid processes")?;
    if !output.status.success() {
        println!("No nibid processes are running.");
        println!("Done stopping nibid processes.");
        return Ok(0);
    }

    for pid in String::from_utf8_lossy(&output.stdout).split_whitespace() {
        let status = Command::new("kill").arg(pid).status()?;
        if status.success() {
            println!("Killed process {pid} (nibid)");
        }
    }
    for _ in 0..50 {
        let running = Command::new("pgrep")
            .args(["-x", "nibid"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        if !running {
            println!("Done stopping nibid processes.");
            return Ok(0);
        }
        thread::sleep(Duration::from_millis(200));
    }
    bail!("nibid processes did not stop within 10 seconds")
}

pub fn run_docker(command: DockerCommand) -> Result<i32> {
    let operation = match command {
        DockerCommand::KillAll => "kill-all",
        DockerCommand::Start => "start",
        DockerCommand::Stop => "stop",
    };
    run_shell_helper([OsStr::new("docker"), OsStr::new(operation)])
}

fn dotfiles_path() -> Result<PathBuf> {
    env::var_os("DOTFILES")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("DOTFILES is not set; source zsh/zshenv"))
}

fn shell_helper_path() -> Result<PathBuf> {
    if let Some(path) = env::var_os("UD_SHELL_HELPER") {
        return Ok(PathBuf::from(path));
    }
    Ok(dotfiles_path()?.join("zsh/ud/shell.sh"))
}

fn run_shell_helper<I, S>(args: I) -> Result<i32>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let helper = shell_helper_path()?;
    if !helper.is_file() {
        bail!("ud shell helper is missing: {}", helper.display());
    }
    let mut command = Command::new("bash");
    command.arg(&helper).args(args);
    process::run_quiet(command)
}
