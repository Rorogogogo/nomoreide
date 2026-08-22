//! The git runner shared by the read-safe modules.
//!
//! Deliberately `pub(super)`: exporting a general "run any git command" helper
//! from the crate `nomoreide-mcp` links would hand back exactly the reach that
//! `nomoreide-actions` exists to withhold. That crate carries its own runner.

use anyhow::Result;
use std::io::ErrorKind;
use tokio::process::Command;

/// Run git and return stdout, ignoring a non-zero exit. Used where an absent
/// answer (no upstream, no remote HEAD) is a normal outcome rather than a fault.
pub(super) async fn output(cwd: &str, args: &[&str]) -> Result<String> {
    let out = match Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
    {
        Ok(out) => out,
        Err(error) => anyhow::bail!("{}", spawn_failure(&error)),
    };
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Run git and surface a non-zero exit as an error carrying git's own message.
///
/// What is returned, and what a failure says, is the reference runner's rule:
/// stdout, or stderr when stdout is empty; and on failure stderr, else stdout,
/// else the reason the process never started — trimmed either way.
pub(super) async fn checked(cwd: &str, args: &[&str]) -> Result<String> {
    let out = match Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
    {
        Ok(out) => out,
        Err(error) => anyhow::bail!("{}", spawn_failure(&error)),
    };
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    if !out.status.success() {
        let message = if stderr.is_empty() { &stdout } else { &stderr };
        anyhow::bail!("{}", message.trim());
    }
    Ok(if stdout.is_empty() { stderr } else { stdout })
}

/// How the reference names a spawn that never happened.
///
/// A `cwd` that does not exist and a missing `git` are the same failure to the
/// kernel, and Node reports both as `spawn git ENOENT` — the errno, not prose.
/// An agent that points a tool at the wrong directory therefore reads the same
/// two words from either runtime. Codes a git spawn cannot realistically
/// produce are left as the OS text rather than invented.
fn spawn_failure(error: &std::io::Error) -> String {
    let code = match error.kind() {
        ErrorKind::NotFound => "ENOENT",
        ErrorKind::PermissionDenied => "EACCES",
        ErrorKind::OutOfMemory => "ENOMEM",
        _ => return format!("spawn git failed: {error}"),
    };
    format!("spawn git {code}")
}

/// [`output`] split into non-empty lines.
pub(super) async fn lines(cwd: &str, args: &[&str]) -> Result<Vec<String>> {
    let raw = output(cwd, args).await?;
    Ok(raw
        .lines()
        .map(str::to_string)
        .filter(|line| !line.is_empty())
        .collect())
}

/// Reject anything git would not accept as a branch name, and anything that
/// could be read as an option instead of a ref.
pub(super) async fn validate_branch_ref(cwd: &str, branch: &str) -> Result<()> {
    if branch.trim().is_empty() || branch.starts_with('-') {
        anyhow::bail!("branch is required");
    }
    checked(cwd, &["check-ref-format", "--branch", branch]).await?;
    Ok(())
}
