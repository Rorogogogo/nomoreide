//! Worktree listing and management.
//!
//! Removal refuses on the primary worktree, a locked one, or one with
//! uncommitted work, so nothing here can lose changes.

use super::exec;
use super::types::GitWorktree;
use super::GitManager;
use anyhow::{Context, Result};
use tokio::process::Command;

impl GitManager {
    pub async fn worktrees(cwd: &str) -> Result<Vec<GitWorktree>> {
        let raw = exec::output(cwd, &["worktree", "list", "--porcelain"]).await?;
        let mut worktrees = Vec::new();
        for (index, record) in raw
            .split("\n\n")
            .filter(|record| !record.trim().is_empty())
            .enumerate()
        {
            let lines: Vec<&str> = record.lines().collect();
            let value = |key: &str| -> Option<String> {
                lines
                    .iter()
                    .find_map(|line| line.strip_prefix(&format!("{key} ")))
                    .map(str::to_string)
            };
            let Some(path) = value("worktree") else {
                continue;
            };
            let branch = value("branch").map(|name| {
                name.strip_prefix("refs/heads/")
                    .unwrap_or(&name)
                    .to_string()
            });
            let dirty = if lines.contains(&"bare") {
                false
            } else {
                !exec::output(
                    &path,
                    &["status", "--porcelain=v1", "--untracked-files=all"],
                )
                .await
                .unwrap_or_default()
                .is_empty()
            };
            let created_at = tokio::fs::metadata(&path)
                .await
                .ok()
                .and_then(|metadata| metadata.created().ok())
                .and_then(|created| created.duration_since(std::time::UNIX_EPOCH).ok())
                .and_then(|duration| u64::try_from(duration.as_millis()).ok());
            worktrees.push(GitWorktree {
                path,
                head: value("HEAD").unwrap_or_default(),
                created_at,
                branch,
                bare: lines.contains(&"bare"),
                detached: lines.contains(&"detached"),
                locked: lines
                    .iter()
                    .any(|line| *line == "locked" || line.starts_with("locked ")),
                locked_reason: value("locked"),
                prunable: lines
                    .iter()
                    .any(|line| *line == "prunable" || line.starts_with("prunable ")),
                prunable_reason: value("prunable"),
                primary: index == 0,
                dirty,
            });
        }
        Ok(worktrees)
    }

    pub async fn create_worktree(
        cwd: &str,
        project_name: &str,
        branch: &str,
        create_branch: bool,
        base_ref: Option<&str>,
    ) -> Result<GitWorktree> {
        let branch = branch.trim();
        if branch.is_empty() || branch.starts_with('-') || branch.contains('\0') {
            anyhow::bail!("A valid branch name is required.");
        }
        let managed_root = std::env::var("NOMOREIDE_WORKTREES_DIR")
            .ok()
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::var("HOME")
                    .ok()
                    .map(|home| std::path::PathBuf::from(home).join(".nomoreide/worktrees"))
            })
            .context("Could not resolve the managed worktrees directory")?;
        let destination = managed_root
            .join(safe_segment(project_name)?)
            .join(safe_segment(branch)?);
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let destination_string = destination.to_string_lossy().into_owned();
        let mut command = Command::new("git");
        command.arg("worktree").arg("add");
        if create_branch {
            command.arg("-b").arg(branch).arg(&destination_string).arg(
                base_ref
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or("HEAD"),
            );
        } else {
            command.arg(&destination_string).arg(branch);
        }
        let output = command.current_dir(cwd).output().await?;
        if !output.status.success() {
            anyhow::bail!("{}", String::from_utf8_lossy(&output.stderr).trim());
        }
        Self::worktrees(cwd)
            .await?
            .into_iter()
            .find(|worktree| worktree.path == destination_string)
            .context("Git created the worktree but it could not be found")
    }

    pub async fn remove_worktree(cwd: &str, path: &str) -> Result<()> {
        let worktree = Self::worktrees(cwd)
            .await?
            .into_iter()
            .find(|worktree| worktree.path == path)
            .context("Unknown worktree")?;
        if worktree.primary {
            anyhow::bail!("The primary worktree cannot be removed.");
        }
        if worktree.locked {
            anyhow::bail!("Unlock this worktree before removing it.");
        }
        if worktree.dirty {
            anyhow::bail!("Commit, stash, or discard this worktree's changes before removing it.");
        }
        let output = Command::new("git")
            .args(["worktree", "remove", path])
            .current_dir(cwd)
            .output()
            .await?;
        if !output.status.success() {
            anyhow::bail!("{}", String::from_utf8_lossy(&output.stderr).trim());
        }
        Ok(())
    }

    pub async fn prune_worktrees(cwd: &str) -> Result<()> {
        let output = Command::new("git")
            .args(["worktree", "prune"])
            .current_dir(cwd)
            .output()
            .await?;
        if !output.status.success() {
            anyhow::bail!("{}", String::from_utf8_lossy(&output.stderr).trim());
        }
        Ok(())
    }
}

/// Fold a project or branch name down to one safe path segment. Rejects the
/// results that would escape the managed root rather than sanitizing them into
/// something surprising.
fn safe_segment(value: &str) -> Result<String> {
    let normalized: String = value
        .trim()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '-'
            }
        })
        .collect();
    let normalized = normalized.trim_matches('-').to_string();
    if normalized.is_empty() || normalized == "." || normalized == ".." {
        anyhow::bail!("Could not derive a safe worktree folder name.");
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::safe_segment;

    #[test]
    fn folds_everything_into_a_single_path_segment() {
        assert_eq!(safe_segment("feature/login").unwrap(), "feature-login");
        assert_eq!(safe_segment("  spaced name ").unwrap(), "spaced-name");
    }

    #[test]
    fn traversal_cannot_survive_as_a_separator_or_as_a_bare_dot_dot() {
        // Dots are legal in a folder name, so they are kept — what makes this
        // safe is that no separator can, leaving one segment that is not "..".
        assert_eq!(safe_segment("../../etc").unwrap(), "..-..-etc");
        assert!(!safe_segment("../../etc").unwrap().contains('/'));
        assert!(safe_segment("..").is_err());
    }

    #[test]
    fn refuses_names_that_leave_nothing_safe() {
        for value in ["", "   ", "/", "..", "."] {
            assert!(
                safe_segment(value).is_err(),
                "expected {value:?} to be refused"
            );
        }
    }
}
