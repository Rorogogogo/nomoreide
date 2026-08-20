use crate::config::GithubIdentityDef;
use crate::git_identity::identity_env;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use tokio::process::Command;

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    pub index: String,
    pub working_tree: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: String,
    pub upstream: Option<String>,
    pub ahead: i32,
    pub behind: i32,
    pub files: Vec<GitFileStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub refs: Vec<String>,
    pub parents: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushResult {
    pub output: String,
    pub branch: String,
    pub set_upstream: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSizeRank {
    pub path: String,
    /// Line count; a lower bound (`truncated: true`) for files past the read cap.
    pub lines: usize,
    pub bytes: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree {
    pub path: String,
    pub head: String,
    pub created_at: Option<u64>,
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
    pub locked: bool,
    pub locked_reason: Option<String>,
    pub prunable: bool,
    pub prunable_reason: Option<String>,
    pub primary: bool,
    pub dirty: bool,
}

// ---------------------------------------------------------------------------
// Runner helpers
// ---------------------------------------------------------------------------

async fn git(cwd: &str, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .context("git command failed")?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// A credential helper that echoes the two values git asks for and nothing else.
/// The empty `credential.helper=` that precedes it resets the inherited helper
/// chain, so the machine's keychain cannot answer first and quietly push as the
/// account the user did not select. The `$NAME` reads are expanded by the
/// helper's own shell — interpolating them here would put the token in `argv`.
const CREDENTIAL_HELPER_CONFIG: &str = concat!(
    "credential.helper=",
    r#"!f() { echo "username=$NOMOREIDE_GIT_USERNAME"; echo "password=$NOMOREIDE_GIT_PASSWORD"; }; f"#
);

fn credential_config_args() -> Vec<&'static str> {
    vec!["-c", "credential.helper=", "-c", CREDENTIAL_HELPER_CONFIG]
}

/// Push output and git's error text are surfaced in the UI, so scrub the token
/// on the way out even though the helper keeps it off the command line.
fn redact(text: &str, secret: Option<&str>) -> String {
    match secret {
        Some(secret) if !secret.is_empty() => text.replace(secret, "***"),
        _ => text.to_string(),
    }
}

async fn git_checked_env(
    cwd: &str,
    args: &[&str],
    env: &HashMap<String, String>,
) -> Result<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .envs(env)
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

async fn git_checked(cwd: &str, args: &[&str]) -> Result<String> {
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

async fn git_lines(cwd: &str, args: &[&str]) -> Result<Vec<String>> {
    let raw = git(cwd, args).await?;
    Ok(raw
        .lines()
        .map(str::to_string)
        .filter(|l| !l.is_empty())
        .collect())
}

// ---------------------------------------------------------------------------
// GitManager
// ---------------------------------------------------------------------------

pub struct GitManager;

impl GitManager {
    pub async fn worktrees(cwd: &str) -> Result<Vec<GitWorktree>> {
        let raw = git(cwd, &["worktree", "list", "--porcelain"]).await?;
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
                !git(
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

    pub async fn status(cwd: &str) -> Result<GitStatus> {
        // Branch name
        let branch = git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await?
            .trim()
            .to_string();

        // Upstream tracking
        let upstream_raw = git(
            cwd,
            &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        )
        .await
        .unwrap_or_default();
        let upstream = upstream_raw.trim().to_string();
        let upstream = if upstream.is_empty() || upstream.starts_with("fatal") {
            None
        } else {
            Some(upstream)
        };

        // Ahead/behind
        let (ahead, behind) = if upstream.is_some() {
            let ab = git(cwd, &["rev-list", "--left-right", "--count", "HEAD...@{u}"])
                .await
                .unwrap_or_default();
            let parts: Vec<i32> = ab
                .split_whitespace()
                .filter_map(|s| s.parse().ok())
                .collect();
            (
                parts.first().copied().unwrap_or(0),
                parts.get(1).copied().unwrap_or(0),
            )
        } else {
            (0, 0)
        };

        // File statuses (porcelain v1)
        let status_out = git(cwd, &["status", "--porcelain", "-u"]).await?;
        let files = status_out
            .lines()
            .filter(|l| l.len() >= 3)
            .map(|l| {
                let index = l.chars().next().map(|c| c.to_string()).unwrap_or_default();
                let wt = l.chars().nth(1).map(|c| c.to_string()).unwrap_or_default();
                let path = l[3..].trim().to_string();
                GitFileStatus {
                    path,
                    index,
                    working_tree: wt,
                }
            })
            .collect();

        Ok(GitStatus {
            branch,
            upstream,
            ahead,
            behind,
            files,
        })
    }

    pub async fn diff(cwd: &str, file: Option<&str>) -> Result<String> {
        let mut args = vec!["diff", "--"];
        if let Some(f) = file {
            args.push(f);
        }
        let staged = git(cwd, &["diff", "--cached", "--"]).await?;
        let unstaged = git(cwd, &args).await?;
        if !staged.is_empty() {
            Ok(staged)
        } else {
            Ok(unstaged)
        }
    }

    pub async fn file_diff(cwd: &str, file: &str) -> Result<String> {
        // Try staged diff first, fall back to unstaged
        let staged = git(cwd, &["diff", "--cached", "--", file]).await?;
        if !staged.trim().is_empty() {
            return Ok(staged);
        }
        git(cwd, &["diff", "--", file]).await
    }

    pub async fn list_tracked_files(cwd: &str) -> Result<Vec<String>> {
        git_lines(cwd, &["ls-files"]).await
    }

    pub async fn read_file(cwd: &str, path: &str) -> Result<String> {
        tokio::fs::read_to_string(Path::new(cwd).join(path))
            .await
            .context("Failed to read tracked file")
    }

    pub async fn write_file(cwd: &str, path: &str, content: &str) -> Result<()> {
        let full = Path::new(cwd).join(path);
        tokio::fs::write(full, content)
            .await
            .context("Failed to write file")
    }

    pub async fn graph(cwd: &str, limit: usize) -> Result<Vec<GitCommit>> {
        let fmt = "%H\x1f%h\x1f%s\x1f%an\x1f%ae\x1f%aI\x1f%D\x1f%P";
        let limit_str = limit.to_string();
        let raw = git(
            cwd,
            &["log", &format!("-{limit_str}"), &format!("--format={fmt}")],
        )
        .await?;

        let commits = raw
            .lines()
            .filter(|l| !l.is_empty())
            .map(|line| {
                let parts: Vec<&str> = line.split('\x1f').collect();
                GitCommit {
                    hash: parts.first().copied().unwrap_or("").to_string(),
                    short_hash: parts.get(1).copied().unwrap_or("").to_string(),
                    subject: parts.get(2).copied().unwrap_or("").to_string(),
                    author: parts.get(3).copied().unwrap_or("").to_string(),
                    email: parts.get(4).copied().unwrap_or("").to_string(),
                    date: parts.get(5).copied().unwrap_or("").to_string(),
                    refs: parts
                        .get(6)
                        .copied()
                        .unwrap_or("")
                        .split(", ")
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .collect(),
                    parents: parts
                        .get(7)
                        .copied()
                        .unwrap_or("")
                        .split_whitespace()
                        .map(str::to_string)
                        .collect(),
                }
            })
            .collect();

        Ok(commits)
    }

    pub async fn commit_diff(cwd: &str, hash: &str, file: Option<&str>) -> Result<String> {
        let mut args = vec!["show", hash, "--"];
        if let Some(f) = file {
            args.push(f);
        }
        git(cwd, &args).await
    }

    pub async fn commit_files(cwd: &str, hash: &str) -> Result<Vec<GitFileStatus>> {
        // NUL-separated name-status, matching the Node GitManager. The UI needs
        // the change letter (A/M/D/R/C) per file, not just paths — without it
        // `file.index` is undefined client-side and the commit file list crashes.
        let raw = git(cwd, &["show", "--name-status", "--format=", "-z", hash]).await?;
        let tokens: Vec<&str> = raw.split('\0').filter(|t| !t.is_empty()).collect();

        let mut files = Vec::new();
        let mut i = 0;
        while i < tokens.len() {
            let letter = tokens[i].chars().next().unwrap_or(' ').to_ascii_uppercase();
            if letter == 'R' || letter == 'C' {
                // rename/copy: STATUS \0 OLD \0 NEW
                if let Some(new_path) = tokens.get(i + 2) {
                    files.push(GitFileStatus {
                        path: new_path.to_string(),
                        index: letter.to_string(),
                        working_tree: " ".to_string(),
                    });
                }
                i += 3;
            } else {
                // regular: STATUS \0 PATH
                if let Some(path) = tokens.get(i + 1) {
                    files.push(GitFileStatus {
                        path: path.to_string(),
                        index: letter.to_string(),
                        working_tree: " ".to_string(),
                    });
                }
                i += 2;
            }
        }
        Ok(files)
    }

    pub async fn stage(cwd: &str, paths: &[String]) -> Result<()> {
        let mut args = vec!["add", "--"];
        let path_refs: Vec<&str> = paths.iter().map(String::as_str).collect();
        args.extend(path_refs);
        let out = Command::new("git")
            .args(&args)
            .current_dir(cwd)
            .output()
            .await?;
        if !out.status.success() {
            anyhow::bail!("{}", String::from_utf8_lossy(&out.stderr));
        }
        Ok(())
    }

    pub async fn unstage(cwd: &str, paths: &[String]) -> Result<()> {
        let mut args = vec!["restore", "--staged", "--"];
        let path_refs: Vec<&str> = paths.iter().map(String::as_str).collect();
        args.extend(path_refs);
        Command::new("git")
            .args(&args)
            .current_dir(cwd)
            .output()
            .await?;
        Ok(())
    }

    /// Commit staged changes. Pass `identity` to stamp a specific author and
    /// committer — callers use this to honour the GitHub account selected for
    /// the repository instead of falling back to the machine's `user.email`.
    pub async fn commit(
        cwd: &str,
        message: &str,
        identity: Option<&GithubIdentityDef>,
    ) -> Result<String> {
        let mut command = Command::new("git");
        command.args(["commit", "-m", message]).current_dir(cwd);
        if let Some(identity) = identity {
            command.envs(identity_env(identity));
        }
        let out = command.output().await?;
        if !out.status.success() {
            anyhow::bail!("{}", String::from_utf8_lossy(&out.stderr));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    pub async fn remote_url(cwd: &str, remote: &str) -> Result<Option<String>> {
        let url = git_checked(cwd, &["remote", "get-url", remote])
            .await
            .unwrap_or_default();
        let trimmed = url.trim();
        Ok(if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        })
    }

    /// Push, optionally authenticating as a specific account. The token travels
    /// through the environment into a throwaway credential helper, so it never
    /// appears in `argv` and is never written to the repository's config.
    pub async fn push_with_credential(
        cwd: &str,
        remote: Option<&str>,
        credential: Option<(&str, Option<&str>)>,
    ) -> Result<GitPushResult> {
        let remote = remote.unwrap_or("origin");
        let branch = git_checked(cwd, &["branch", "--show-current"])
            .await?
            .trim()
            .to_string();
        if branch.is_empty() {
            anyhow::bail!("cannot push in a detached HEAD state");
        }
        let upstream = git_checked(
            cwd,
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ],
        )
        .await
        .unwrap_or_default();
        let set_upstream = upstream.trim().is_empty();
        let push_args: Vec<&str> = if set_upstream {
            vec!["push", "--set-upstream", remote, &branch]
        } else {
            vec!["push"]
        };

        let output = match credential {
            Some((token, username)) => {
                let mut args = credential_config_args();
                args.extend(push_args);
                let env = HashMap::from([
                    (
                        "NOMOREIDE_GIT_USERNAME".to_string(),
                        username.unwrap_or("x-access-token").to_string(),
                    ),
                    ("NOMOREIDE_GIT_PASSWORD".to_string(), token.to_string()),
                ]);
                match git_checked_env(cwd, &args, &env).await {
                    Ok(out) => redact(&out, Some(token)),
                    Err(error) => anyhow::bail!("{}", redact(&error.to_string(), Some(token))),
                }
            }
            None => git_checked(cwd, &push_args).await?,
        };

        Ok(GitPushResult {
            output,
            branch,
            set_upstream,
        })
    }

    pub async fn fetch(cwd: &str) -> Result<String> {
        git_checked(cwd, &["fetch", "--prune"]).await
    }

    pub async fn pull(cwd: &str) -> Result<String> {
        git_checked(cwd, &["pull", "--ff-only"]).await
    }

    pub async fn merge(cwd: &str, branch: &str) -> Result<String> {
        Self::validate_branch_ref(cwd, branch).await?;
        Self::ensure_clean(cwd, "merge").await?;
        match git_checked(cwd, &["merge", "--no-edit", branch]).await {
            Ok(output) => Ok(output),
            Err(error) => {
                let _ = git_checked(cwd, &["merge", "--abort"]).await;
                anyhow::bail!("Merge failed and was aborted.\n{error}")
            }
        }
    }

    pub async fn rebase(cwd: &str, branch: &str) -> Result<String> {
        Self::validate_branch_ref(cwd, branch).await?;
        Self::ensure_clean(cwd, "rebase").await?;
        match git_checked(cwd, &["rebase", branch]).await {
            Ok(output) => Ok(output),
            Err(error) => {
                let _ = git_checked(cwd, &["rebase", "--abort"]).await;
                anyhow::bail!("Rebase failed and was aborted.\n{error}")
            }
        }
    }

    async fn validate_branch_ref(cwd: &str, branch: &str) -> Result<()> {
        if branch.trim().is_empty() || branch.starts_with('-') {
            anyhow::bail!("branch is required");
        }
        git_checked(cwd, &["check-ref-format", "--branch", branch]).await?;
        Ok(())
    }

    async fn ensure_clean(cwd: &str, operation: &str) -> Result<()> {
        let status =
            git_checked(cwd, &["status", "--porcelain=v1", "--untracked-files=all"]).await?;
        if !status.trim().is_empty() {
            anyhow::bail!("Commit or stash local changes before {operation}.");
        }
        Ok(())
    }

    pub async fn create_branch(cwd: &str, name: &str, start_point: Option<&str>) -> Result<()> {
        Self::validate_branch_ref(cwd, name).await?;
        let mut args = vec!["switch", "-c", name];
        if let Some(start) = start_point {
            Self::validate_branch_ref(cwd, start).await?;
            args.push(start);
        }
        git_checked(cwd, &args).await?;
        Ok(())
    }

    pub async fn delete_branch(cwd: &str, name: &str) -> Result<String> {
        Self::validate_branch_ref(cwd, name).await?;
        git_checked(cwd, &["branch", "-d", name]).await
    }

    pub async fn switch_branch(cwd: &str, name: &str) -> Result<()> {
        let is_remote = Self::branches(cwd)
            .await?
            .iter()
            .any(|branch| branch.is_remote && branch.name == name);
        if is_remote {
            git_checked(cwd, &["switch", "--track", name]).await?;
        } else {
            git_checked(cwd, &["switch", name]).await?;
        }
        Ok(())
    }

    pub async fn branches(cwd: &str) -> Result<Vec<GitBranch>> {
        let current = git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await?
            .trim()
            .to_string();
        let locals = git_lines(cwd, &["branch", "--format=%(refname:short)"]).await?;
        let remotes = git_lines(cwd, &["branch", "-r", "--format=%(refname:short)"]).await?;

        let mut branches: Vec<GitBranch> = locals
            .into_iter()
            .map(|name| GitBranch {
                is_current: name == current,
                is_remote: false,
                name,
            })
            .collect();

        branches.extend(remotes.into_iter().map(|name| GitBranch {
            is_current: false,
            is_remote: true,
            name,
        }));

        Ok(branches)
    }

    pub async fn pull_default(cwd: &str) -> Result<String> {
        // Checkout default branch (main or master) and pull --ff-only
        let default = detect_default_branch(cwd).await;
        Command::new("git")
            .args(["checkout", &default])
            .current_dir(cwd)
            .output()
            .await?;
        let out = Command::new("git")
            .args(["pull", "--ff-only"])
            .current_dir(cwd)
            .output()
            .await?;
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// Rank tracked files by line count (then bytes), skipping binaries. Mirrors
    /// the Node `rankFilesBySize`: files past `MAX_BYTES` are measured from a
    /// capped read and flagged `truncated`.
    pub async fn rank_files_by_size(cwd: &str) -> Result<Vec<FileSizeRank>> {
        const MAX_BYTES: u64 = 2_000_000;
        let files = Self::list_tracked_files(cwd).await?;
        let mut ranks: Vec<FileSizeRank> = Vec::new();

        for path in files {
            let full = Path::new(cwd).join(&path);
            let Ok(meta) = tokio::fs::metadata(&full).await else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }

            let bytes = meta.len();
            let truncated = bytes > MAX_BYTES;
            let read_len = if truncated {
                MAX_BYTES as usize
            } else {
                bytes as usize
            };

            let Ok(buf) = read_capped(&full, read_len).await else {
                continue;
            };
            if buf.contains(&0) {
                continue;
            } // binary

            let mut lines = buf.iter().filter(|&&b| b == b'\n').count();
            // Count a final line that has no trailing newline.
            if !buf.is_empty() && *buf.last().unwrap() != b'\n' {
                lines += 1;
            }

            ranks.push(FileSizeRank {
                path,
                lines,
                bytes,
                truncated,
            });
        }

        ranks.sort_by(|a, b| b.lines.cmp(&a.lines).then(b.bytes.cmp(&a.bytes)));
        Ok(ranks)
    }
}

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

/// Read at most `len` bytes from the start of a file (reads fully up to the cap;
/// a single `read` can return short).
async fn read_capped(path: &Path, len: usize) -> Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let file = tokio::fs::File::open(path).await?;
    let mut buf = Vec::new();
    file.take(len as u64).read_to_end(&mut buf).await?;
    Ok(buf)
}

async fn detect_default_branch(cwd: &str) -> String {
    git(cwd, &["symbolic-ref", "refs/remotes/origin/HEAD"])
        .await
        .unwrap_or_default()
        .trim()
        .split('/')
        .next_back()
        .unwrap_or("main")
        .to_string()
}
