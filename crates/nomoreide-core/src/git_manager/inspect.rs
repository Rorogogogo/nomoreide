//! Reading the repository: working-tree status, diffs, history, branches.

use super::exec;
use super::types::{GitBranch, GitCommit, GitFileStatus, GitStatus};
use super::GitManager;
use anyhow::Result;

impl GitManager {
    pub async fn status(cwd: &str) -> Result<GitStatus> {
        // Branch name
        let branch = exec::output(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await?
            .trim()
            .to_string();

        // Upstream tracking
        let upstream_raw = exec::output(
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
            let ab = exec::output(cwd, &["rev-list", "--left-right", "--count", "HEAD...@{u}"])
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
        let status_out = exec::output(cwd, &["status", "--porcelain", "-u"]).await?;
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
        let staged = exec::output(cwd, &["diff", "--cached", "--"]).await?;
        let unstaged = exec::output(cwd, &args).await?;
        if !staged.is_empty() {
            Ok(staged)
        } else {
            Ok(unstaged)
        }
    }

    pub async fn file_diff(cwd: &str, file: &str) -> Result<String> {
        // Try staged diff first, fall back to unstaged
        let staged = exec::output(cwd, &["diff", "--cached", "--", file]).await?;
        if !staged.trim().is_empty() {
            return Ok(staged);
        }
        exec::output(cwd, &["diff", "--", file]).await
    }

    pub async fn graph(cwd: &str, limit: usize) -> Result<Vec<GitCommit>> {
        let fmt = "%H\x1f%h\x1f%s\x1f%an\x1f%ae\x1f%aI\x1f%D\x1f%P";
        let limit_str = limit.to_string();
        let raw = exec::output(
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
        exec::output(cwd, &args).await
    }

    pub async fn commit_files(cwd: &str, hash: &str) -> Result<Vec<GitFileStatus>> {
        // NUL-separated name-status, matching the Node GitManager. The UI needs
        // the change letter (A/M/D/R/C) per file, not just paths — without it
        // `file.index` is undefined client-side and the commit file list crashes.
        let raw = exec::output(cwd, &["show", "--name-status", "--format=", "-z", hash]).await?;
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

    pub async fn branches(cwd: &str) -> Result<Vec<GitBranch>> {
        let current = exec::output(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await?
            .trim()
            .to_string();
        let locals = exec::lines(cwd, &["branch", "--format=%(refname:short)"]).await?;
        let remotes = exec::lines(cwd, &["branch", "-r", "--format=%(refname:short)"]).await?;

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

    pub async fn remote_url(cwd: &str, remote: &str) -> Result<Option<String>> {
        let url = exec::checked(cwd, &["remote", "get-url", remote])
            .await
            .unwrap_or_default();
        let trimmed = url.trim();
        Ok(if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        })
    }
}
