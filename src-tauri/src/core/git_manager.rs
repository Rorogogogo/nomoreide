use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
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

async fn git_lines(cwd: &str, args: &[&str]) -> Result<Vec<String>> {
    let raw = git(cwd, args).await?;
    Ok(raw.lines().map(str::to_string).filter(|l| !l.is_empty()).collect())
}

// ---------------------------------------------------------------------------
// GitManager
// ---------------------------------------------------------------------------

pub struct GitManager;

impl GitManager {
    pub async fn status(cwd: &str) -> Result<GitStatus> {
        // Branch name
        let branch = git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).await?.trim().to_string();

        // Upstream tracking
        let upstream_raw = git(cwd, &[
            "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}",
        ]).await.unwrap_or_default();
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
            let parts: Vec<i32> = ab.trim().split_whitespace()
                .filter_map(|s| s.parse().ok())
                .collect();
            (parts.first().copied().unwrap_or(0), parts.get(1).copied().unwrap_or(0))
        } else {
            (0, 0)
        };

        // File statuses (porcelain v1)
        let status_out = git(cwd, &["status", "--porcelain", "-u"]).await?;
        let files = status_out.lines()
            .filter(|l| l.len() >= 3)
            .map(|l| {
                let index = l.chars().next().map(|c| c.to_string()).unwrap_or_default();
                let wt = l.chars().nth(1).map(|c| c.to_string()).unwrap_or_default();
                let path = l[3..].trim().to_string();
                GitFileStatus { path, index, working_tree: wt }
            })
            .collect();

        Ok(GitStatus { branch, upstream, ahead, behind, files })
    }

    pub async fn diff(cwd: &str, file: Option<&str>) -> Result<String> {
        let mut args = vec!["diff", "--"];
        if let Some(f) = file {
            args.push(f);
        }
        let staged = git(cwd, &["diff", "--cached", "--"]).await?;
        let unstaged = git(cwd, &args).await?;
        if !staged.is_empty() { Ok(staged) } else { Ok(unstaged) }
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
        tokio::fs::write(full, content).await.context("Failed to write file")
    }

    pub async fn graph(cwd: &str, limit: usize) -> Result<Vec<GitCommit>> {
        let fmt = "%H\x1f%h\x1f%s\x1f%an\x1f%ae\x1f%aI\x1f%D\x1f%P";
        let limit_str = limit.to_string();
        let raw = git(cwd, &["log", &format!("-{limit_str}"), &format!("--format={fmt}")]).await?;

        let commits = raw.lines().filter(|l| !l.is_empty()).map(|line| {
            let parts: Vec<&str> = line.split('\x1f').collect();
            GitCommit {
                hash: parts.first().copied().unwrap_or("").to_string(),
                short_hash: parts.get(1).copied().unwrap_or("").to_string(),
                subject: parts.get(2).copied().unwrap_or("").to_string(),
                author: parts.get(3).copied().unwrap_or("").to_string(),
                email: parts.get(4).copied().unwrap_or("").to_string(),
                date: parts.get(5).copied().unwrap_or("").to_string(),
                refs: parts.get(6).copied().unwrap_or("").split(", ")
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect(),
                parents: parts.get(7).copied().unwrap_or("").split_whitespace()
                    .map(str::to_string)
                    .collect(),
            }
        }).collect();

        Ok(commits)
    }

    pub async fn commit_diff(cwd: &str, hash: &str, file: Option<&str>) -> Result<String> {
        let mut args = vec!["show", hash, "--"];
        if let Some(f) = file { args.push(f); }
        git(cwd, &args).await
    }

    pub async fn commit_files(cwd: &str, hash: &str) -> Result<Vec<String>> {
        git_lines(cwd, &["diff-tree", "--no-commit-id", "-r", "--name-only", hash]).await
    }

    pub async fn stage(cwd: &str, paths: &[String]) -> Result<()> {
        let mut args = vec!["add", "--"];
        let path_refs: Vec<&str> = paths.iter().map(String::as_str).collect();
        args.extend(path_refs);
        let out = Command::new("git").args(&args).current_dir(cwd).output().await?;
        if !out.status.success() {
            anyhow::bail!("{}", String::from_utf8_lossy(&out.stderr));
        }
        Ok(())
    }

    pub async fn unstage(cwd: &str, paths: &[String]) -> Result<()> {
        let mut args = vec!["restore", "--staged", "--"];
        let path_refs: Vec<&str> = paths.iter().map(String::as_str).collect();
        args.extend(path_refs);
        Command::new("git").args(&args).current_dir(cwd).output().await?;
        Ok(())
    }

    pub async fn commit(cwd: &str, message: &str) -> Result<String> {
        let out = Command::new("git")
            .args(["commit", "-m", message])
            .current_dir(cwd)
            .output()
            .await?;
        if !out.status.success() {
            anyhow::bail!("{}", String::from_utf8_lossy(&out.stderr));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    pub async fn push(cwd: &str, remote: Option<&str>) -> Result<String> {
        let remote = remote.unwrap_or("origin");
        let out = Command::new("git")
            .args(["push", remote])
            .current_dir(cwd)
            .output()
            .await?;
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    pub async fn fetch(cwd: &str) -> Result<String> {
        let out = Command::new("git").args(["fetch"]).current_dir(cwd).output().await?;
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    pub async fn create_branch(cwd: &str, name: &str) -> Result<()> {
        let out = Command::new("git")
            .args(["checkout", "-b", name])
            .current_dir(cwd)
            .output()
            .await?;
        if !out.status.success() {
            anyhow::bail!("{}", String::from_utf8_lossy(&out.stderr));
        }
        Ok(())
    }

    pub async fn switch_branch(cwd: &str, name: &str) -> Result<()> {
        let out = Command::new("git")
            .args(["checkout", name])
            .current_dir(cwd)
            .output()
            .await?;
        if !out.status.success() {
            anyhow::bail!("{}", String::from_utf8_lossy(&out.stderr));
        }
        Ok(())
    }

    pub async fn branches(cwd: &str) -> Result<Vec<GitBranch>> {
        let current = git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await?.trim().to_string();
        let locals = git_lines(cwd, &["branch", "--format=%(refname:short)"]).await?;
        let remotes = git_lines(cwd, &["branch", "-r", "--format=%(refname:short)"]).await?;

        let mut branches: Vec<GitBranch> = locals.into_iter().map(|name| GitBranch {
            is_current: name == current,
            is_remote: false,
            name,
        }).collect();

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
        Command::new("git").args(["checkout", &default]).current_dir(cwd).output().await?;
        let out = Command::new("git").args(["pull", "--ff-only"]).current_dir(cwd).output().await?;
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }
}

async fn detect_default_branch(cwd: &str) -> String {
    let out = Command::new("git")
        .args(["symbolic-ref", "refs/remotes/origin/HEAD"])
        .current_dir(cwd)
        .output()
        .await
        .unwrap_or_default();
    let raw = String::from_utf8_lossy(&out.stdout);
    raw.trim().split('/').last().unwrap_or("main").to_string()
}
