//! `ud lint`: file linters that report `path:line` findings.
//!
//! Each linter turns file text into [`Finding`]s through pure functions, and
//! shares the output format and exit codes defined here: 0 when clean or
//! info only, 1 on any error, 2 on bad input.

mod just;
#[cfg(test)]
mod just_test;

use std::io::{self, IsTerminal};
use std::path::PathBuf;

use anyhow::Result;

use crate::cli::LintCommand;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Severity {
    Error,
    Info,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Finding {
    pub path: PathBuf,
    /// 1-based line number.
    pub line: usize,
    pub severity: Severity,
    pub code: &'static str,
    pub message: String,
}

/// Named ANSI colors, enabled only for a terminal.
pub(crate) struct Palette {
    pub color: bool,
}

impl Palette {
    fn paint(&self, ansi: &str, text: &str) -> String {
        if self.color {
            format!("\x1b[{ansi}m{text}\x1b[0m")
        } else {
            text.to_owned()
        }
    }

    fn severity(&self, severity: Severity) -> String {
        match severity {
            Severity::Error => self.paint("31", "error"),
            Severity::Info => self.paint("34", "info"),
        }
    }
}

/// Display a path without a leading `./`.
pub(crate) fn display_path(path: &std::path::Path) -> String {
    let text = path.to_string_lossy();
    text.strip_prefix("./").unwrap_or(&text).to_owned()
}

/// `path:line: severity[code]: message`, one finding per line.
pub(crate) fn format_finding(finding: &Finding, palette: &Palette) -> String {
    format!(
        "{}:{}: {}[{}]: {}",
        display_path(&finding.path),
        finding.line,
        palette.severity(finding.severity),
        finding.code,
        finding.message
    )
}

/// Counts of files, errors, and info, colored to match the findings.
pub(crate) fn summary(
    files: usize,
    findings: &[Finding],
    noun: &str,
    palette: &Palette,
) -> String {
    let errors = findings
        .iter()
        .filter(|f| f.severity == Severity::Error)
        .count();
    let info = findings.len() - errors;
    let files = format!("{files} {noun}{}", if files == 1 { "" } else { "s" });
    if findings.is_empty() {
        return format!("💚 {} {files}", palette.paint("32", "clean"));
    }
    let errors = format!("{errors} error{}", if errors == 1 { "" } else { "s" });
    format!(
        "{files}, {}, {}",
        palette.paint("31", &errors),
        palette.paint("34", &format!("{info} info"))
    )
}

pub fn run(command: LintCommand) -> Result<i32> {
    match command {
        LintCommand::Just { paths, hide_info } => {
            let palette = Palette {
                color: io::stdout().is_terminal(),
            };
            Ok(just::run(&paths, hide_info, &palette))
        }
    }
}
