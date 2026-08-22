//! Moving the index and local refs: staging, committing, branch bookkeeping.
//!
//! These mutate the repository but stay local and reversible, which is why they
//! sit on the read-safe side of the split — the same place
//! `src/core/git-manager.ts` keeps them. `fetch` is here for the same reason:
//! it touches the network but only ever adds remote-tracking refs.

use super::exec;
use super::GitManager;
use crate::config::GithubIdentityDef;
use crate::git_identity::identity_env;
use anyhow::Result;
use tokio::process::Command;

impl GitManager {
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

    pub async fn create_branch(cwd: &str, name: &str, start_point: Option<&str>) -> Result<()> {
        exec::validate_branch_ref(cwd, name).await?;
        let mut args = vec!["switch", "-c", name];
        if let Some(start) = start_point {
            exec::validate_branch_ref(cwd, start).await?;
            args.push(start);
        }
        exec::checked(cwd, &args).await?;
        Ok(())
    }

    /// `branch -d`, never `-D`: a branch whose commits are not merged anywhere
    /// stays put. Discarding it needs a surface of its own.
    pub async fn delete_branch(cwd: &str, name: &str) -> Result<String> {
        exec::validate_branch_ref(cwd, name).await?;
        exec::checked(cwd, &["branch", "-d", name]).await
    }

    pub async fn switch_branch(cwd: &str, name: &str) -> Result<()> {
        let is_remote = Self::branches(cwd)
            .await?
            .iter()
            .any(|branch| branch.is_remote && branch.name == name);
        if is_remote {
            exec::checked(cwd, &["switch", "--track", name]).await?;
        } else {
            exec::checked(cwd, &["switch", name]).await?;
        }
        Ok(())
    }

    pub async fn fetch(cwd: &str) -> Result<String> {
        exec::checked(cwd, &["fetch", "--prune"]).await
    }
}
