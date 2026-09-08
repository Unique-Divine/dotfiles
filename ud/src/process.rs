use std::process::{Command, ExitStatus};

use anyhow::{Context, Result};

pub fn run(mut command: Command, display: &str, preview: bool) -> Result<i32> {
    println!("{display}");
    if preview {
        return Ok(0);
    }

    let program = command.get_program().to_string_lossy().into_owned();
    let status = command
        .status()
        .with_context(|| format!("failed to run {program}"))?;
    Ok(exit_code(status))
}

pub fn run_quiet(mut command: Command) -> Result<i32> {
    let program = command.get_program().to_string_lossy().into_owned();
    let status = command
        .status()
        .with_context(|| format!("failed to run {program}"))?;
    Ok(exit_code(status))
}

pub fn run_shell(script: &str, display: &str, preview: bool) -> Result<i32> {
    let mut command = Command::new("bash");
    command.args(["-o", "pipefail", "-c", script]);
    run(command, display, preview)
}

pub fn exit_code(status: ExitStatus) -> i32 {
    status.code().unwrap_or(1)
}
