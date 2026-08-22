//! The git runner shared by the read-safe modules.
//!
//! Deliberately `pub(super)`: exporting a general "run any git command" helper
//! from the crate `nomoreide-mcp` links would hand back exactly the reach that
//! `nomoreide-actions` exists to withhold. That crate carries its own runner.

use anyhow::{Context, Result};
use tokio::process::Command;

/// Run git and return stdout, ignoring a non-zero exit. Used where an absent
/// answer (no upstream, no remote HEAD) is a normal outcome rather than a fault.
pub(super) async fn output(cwd: &str, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .context("git command failed")?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Run git and surface a non-zero exit as an error carrying git's own message.
pub(super) async fn checked(cwd: &str, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .context("git command failed")?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    if !out.status.success() {
        anyhow::bail!(
            "{}",
            if stderr.trim().is_empty() {
                stdout
            } else {
                stderr
            }
        );
    }
    Ok(if stdout.is_empty() { stderr } else { stdout })
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
