//! Write-capable Git operations, kept deliberately separate from the read-safe
//! `nomoreide_core::git_manager`. These reach outward (push, pull) or move refs
//! (merge, rebase).
//!
//! See the crate docs for which of these an agent may reach and why — the short
//! version is that `push` is on the MCP tool surface and the other four are not.
//!
//! Still intentionally excludes the irreversible footguns (`reset --hard`,
//! `clean -f`, `push --force`, `branch -D`) — those would need their own
//! explicit, separately-guarded surface.
//!
//! The runner and the ref/clean-tree checks below are private to this module
//! rather than borrowed from core. Keeping them here avoids exporting a general
//! "run any git command" helper from `nomoreide-core`, which every surface
//! links; `git-actions.ts` keeps its own private runner for the same reason.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushResult {
    /// Combined stdout/stderr from `git push` — what a terminal would show.
    pub output: String,
    /// The branch that was pushed.
    pub branch: String,
    /// True when an upstream had to be set (first push of a new branch).
    pub set_upstream: bool,
}

/// Credential for a single push. The token travels through the environment into
/// a throwaway credential helper, so it never appears in `argv` (visible to any
/// process listing) and never gets written to the repository's config.
#[derive(Clone)]
pub struct PushCredential<'a> {
    pub token: &'a str,
    /// GitHub ignores the username for token auth; a conventional value is used
    /// when none is given.
    pub username: Option<&'a str>,
}

/// Hand-written rather than derived: a derived `Debug` would print the token
/// into whatever log or panic message formatted it, undoing the point of
/// keeping it out of `argv`.
impl std::fmt::Debug for PushCredential<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PushCredential")
            .field("token", &"***")
            .field("username", &self.username)
            .finish()
    }
}

/// A credential helper that echoes the two values git asks for and nothing else.
/// The empty `credential.helper=` that precedes it resets the inherited helper
/// chain, so the machine's keychain cannot answer first and quietly push as the
/// account the user did not select. The `$NAME` reads are expanded by the
/// helper's own shell — interpolating them here would put the token in `argv`.
const CREDENTIAL_HELPER: &str = r#"!f() { echo "username=$NOMOREIDE_GIT_USERNAME"; echo "password=$NOMOREIDE_GIT_PASSWORD"; }; f"#;

const USERNAME_VAR: &str = "NOMOREIDE_GIT_USERNAME";
const PASSWORD_VAR: &str = "NOMOREIDE_GIT_PASSWORD";

/// The `-c` pair that installs [`CREDENTIAL_HELPER`], reset first.
pub fn credential_config_args() -> Vec<String> {
    vec![
        "-c".to_string(),
        "credential.helper=".to_string(),
        "-c".to_string(),
        format!("credential.helper={CREDENTIAL_HELPER}"),
    ]
}

/// Push output and git's error text are surfaced in the UI, so scrub the token
/// on the way out even though the helper keeps it off the command line.
pub fn redact(text: &str, secret: Option<&str>) -> String {
    match secret {
        Some(secret) if !secret.is_empty() => text.replace(secret, "***"),
        _ => text.to_string(),
    }
}

/// Write-capable Git operations against one working directory.
pub struct GitActions {
    cwd: String,
}

impl GitActions {
    pub fn new(cwd: impl Into<String>) -> Self {
        Self { cwd: cwd.into() }
    }

    /// Push the current branch to its remote. When the branch has no upstream
    /// yet (a freshly created local branch), this sets one with
    /// `-u <remote> <branch>` so later pushes and ahead/behind tracking work.
    pub async fn push(
        &self,
        remote: Option<&str>,
        credential: Option<PushCredential<'_>>,
    ) -> Result<GitPushResult> {
        let remote = remote.unwrap_or("origin");
        let branch = self.git(&["branch", "--show-current"], None).await?;
        let branch = branch.trim().to_string();
        if branch.is_empty() {
            anyhow::bail!("cannot push in a detached HEAD state");
        }

        let upstream = self
            .git(
                &[
                    "rev-parse",
                    "--abbrev-ref",
                    "--symbolic-full-name",
                    "@{upstream}",
                ],
                None,
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
            Some(credential) => {
                let mut args = credential_config_args();
                args.extend(push_args.iter().map(|arg| (*arg).to_string()));
                let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
                let env = HashMap::from([
                    (
                        USERNAME_VAR.to_string(),
                        credential.username.unwrap_or("x-access-token").to_string(),
                    ),
                    (PASSWORD_VAR.to_string(), credential.token.to_string()),
                ]);
                self.git(&arg_refs, Some(&env)).await?
            }
            None => self.git(&push_args, None).await?,
        };

        Ok(GitPushResult {
            output,
            branch,
            set_upstream,
        })
    }

    /// Fast-forward only: a pull that cannot silently create a merge commit.
    pub async fn pull(&self) -> Result<String> {
        self.git(&["pull", "--ff-only"], None).await
    }

    pub async fn merge(&self, branch: &str) -> Result<String> {
        let branch = self.valid_branch_ref(branch).await?;
        self.assert_clean_working_tree("merge").await?;
        match self.git(&["merge", "--no-edit", &branch], None).await {
            Ok(output) => Ok(output),
            Err(error) => {
                let _ = self.git(&["merge", "--abort"], None).await;
                anyhow::bail!("Merge failed and was aborted.\n{error}")
            }
        }
    }

    pub async fn rebase(&self, branch: &str) -> Result<String> {
        let branch = self.valid_branch_ref(branch).await?;
        self.assert_clean_working_tree("rebase").await?;
        match self.git(&["rebase", &branch], None).await {
            Ok(output) => Ok(output),
            Err(error) => {
                let _ = self.git(&["rebase", "--abort"], None).await;
                anyhow::bail!("Rebase failed and was aborted.\n{error}")
            }
        }
    }

    /// Check out the remote's default branch and fast-forward it — the "get me
    /// back to a clean main" move, without the destructive parts.
    ///
    /// Carried over verbatim from the pre-split `GitManager::pull_default`, so
    /// it still diverges from the TypeScript `checkoutDefaultAndPull`: that one
    /// uses `switch`, surfaces the switch output, and errors when the default
    /// branch cannot be determined. Reconciling the two belongs to the Phase 3
    /// git parity pass, not to this move.
    pub async fn pull_default(&self) -> Result<String> {
        let default = self.default_branch().await;
        let _ = Command::new("git")
            .args(["checkout", &default])
            .current_dir(&self.cwd)
            .output()
            .await?;
        let out = Command::new("git")
            .args(["pull", "--ff-only"])
            .current_dir(&self.cwd)
            .output()
            .await?;
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    async fn default_branch(&self) -> String {
        self.git(&["symbolic-ref", "refs/remotes/origin/HEAD"], None)
            .await
            .unwrap_or_default()
            .trim()
            .rsplit('/')
            .next()
            .filter(|name| !name.is_empty())
            .unwrap_or("main")
            .to_string()
    }

    /// Reject anything git itself would not accept as a branch name, and
    /// anything that could be read as an option instead of a ref.
    async fn valid_branch_ref(&self, branch: &str) -> Result<String> {
        let branch = branch.trim();
        if branch.is_empty() || branch.starts_with('-') {
            anyhow::bail!("branch is required");
        }
        self.git(&["check-ref-format", "--branch", branch], None)
            .await?;
        Ok(branch.to_string())
    }

    /// Merge and rebase leave a dirty tree in a state that is hard to recover
    /// from, so refuse before starting rather than aborting halfway.
    async fn assert_clean_working_tree(&self, operation: &str) -> Result<()> {
        let status = self
            .git(&["status", "--porcelain=v1", "--untracked-files=all"], None)
            .await?;
        if !status.trim().is_empty() {
            anyhow::bail!("Commit or stash local changes before {operation}.");
        }
        Ok(())
    }

    async fn git(&self, args: &[&str], env: Option<&HashMap<String, String>>) -> Result<String> {
        let mut command = Command::new("git");
        command.args(args).current_dir(&self.cwd);
        if let Some(env) = env {
            command.envs(env);
        }
        // Redact here rather than at each call site: every string that leaves
        // this runner, success or failure, has passed through it.
        let secret = env
            .and_then(|env| env.get(PASSWORD_VAR))
            .map(String::as_str);
        let out = command
            .output()
            .await
            .map_err(|error| anyhow::anyhow!("git {} failed to start: {error}", args.join(" ")))?;
        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        if !out.status.success() {
            let message = if stderr.trim().is_empty() {
                stdout
            } else {
                stderr
            };
            anyhow::bail!("{}", redact(message.trim(), secret));
        }
        Ok(redact(
            &if stdout.is_empty() { stderr } else { stdout },
            secret,
        ))
    }
}
