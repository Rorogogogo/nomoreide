//! Moving the index and local refs: staging, committing, branch bookkeeping.
//!
//! These mutate the repository but stay local and reversible, which is why they
//! sit on the read-safe side of the split — the same place
//! `src/core/git-manager.ts` keeps them. `fetch` is here for the same reason:
//! it touches the network but only ever adds remote-tracking refs.
//!
//! Every one returns what git said. An agent that stages a file gets git's own
//! (usually empty) output, and one that commits gets the summary line, which is
//! the only report either of them has that the thing happened.

use super::exec;
use super::GitManager;
use crate::config::GithubIdentityDef;
use crate::git_identity::identity_env;
use anyhow::Result;

impl GitManager {
    pub async fn stage(cwd: &str, paths: &[String]) -> Result<String> {
        require_paths(paths)?;
        let mut args = vec!["add", "--"];
        args.extend(paths.iter().map(String::as_str));
        exec::checked(cwd, &args).await
    }

    pub async fn unstage(cwd: &str, paths: &[String]) -> Result<String> {
        require_paths(paths)?;
        let mut args = vec!["restore", "--staged", "--"];
        args.extend(paths.iter().map(String::as_str));
        exec::checked(cwd, &args).await
    }

    /// Commit staged changes. Pass `identity` to stamp a specific author and
    /// committer — callers use this to honour the GitHub account selected for
    /// the repository instead of falling back to the machine's `user.email`.
    pub async fn commit(
        cwd: &str,
        message: &str,
        identity: Option<&GithubIdentityDef>,
    ) -> Result<String> {
        if message.trim().is_empty() {
            anyhow::bail!("commit message is required");
        }
        let env = identity.map(identity_env).unwrap_or_default();
        exec::checked_with_env(cwd, &["commit", "-m", message], &env).await
    }

    pub async fn create_branch(cwd: &str, name: &str, start_point: Option<&str>) -> Result<String> {
        let name = exec::validate_branch_ref(cwd, name, "branch").await?;
        let mut args = vec!["switch", "-c", &name];
        let start;
        if let Some(value) = start_point {
            start = exec::validate_branch_ref(cwd, value, "start point").await?;
            args.push(&start);
        }
        exec::checked(cwd, &args).await
    }

    /// `branch -d`, never `-D`: a branch whose commits are not merged anywhere
    /// stays put. Discarding it needs a surface of its own.
    pub async fn delete_branch(cwd: &str, name: &str) -> Result<String> {
        let name = exec::validate_branch_ref(cwd, name, "branch").await?;
        exec::checked(cwd, &["branch", "-d", &name]).await
    }

    /// Switch to a local branch, or start tracking a remote one.
    ///
    /// The name is only required to be non-blank here, not to be a valid ref:
    /// git decides that, and its refusal says more than a pre-check would.
    pub async fn switch_branch(cwd: &str, name: &str) -> Result<String> {
        let name = exec::require_name(name, "branch")?;
        let is_remote = Self::branches(cwd)
            .await?
            .iter()
            .any(|branch| branch.remote && branch.name == name);
        if is_remote {
            exec::checked(cwd, &["switch", "--track", &name]).await
        } else {
            exec::checked(cwd, &["switch", &name]).await
        }
    }

    pub async fn fetch(cwd: &str) -> Result<String> {
        exec::checked(cwd, &["fetch", "--prune"]).await
    }
}

/// Staging needs something to stage. A path that is only whitespace is not one,
/// and it would otherwise reach git as an argument meaning the current
/// directory — staging everything instead of the nothing that was named.
fn require_paths(paths: &[String]) -> Result<()> {
    if paths.is_empty() || paths.iter().any(|path| path.trim().is_empty()) {
        anyhow::bail!("at least one file path is required");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staging_needs_at_least_one_real_path() {
        assert!(require_paths(&[]).is_err());
        assert!(require_paths(&["   ".to_string()]).is_err());
        // One blank among good ones still fails: the caller meant to name it.
        assert!(require_paths(&["a.txt".to_string(), "".to_string()]).is_err());
        assert!(require_paths(&["a.txt".to_string()]).is_ok());
    }

    #[test]
    fn a_required_name_is_reported_by_its_own_label() {
        assert_eq!(
            exec::require_name("  ", "branch").unwrap_err().to_string(),
            "branch is required"
        );
        assert_eq!(
            exec::require_name("", "start point")
                .unwrap_err()
                .to_string(),
            "start point is required"
        );
        assert_eq!(exec::require_name("  main ", "branch").unwrap(), "main");
    }
}
