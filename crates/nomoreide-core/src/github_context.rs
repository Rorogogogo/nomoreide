//! Which GitHub repository a directory is, and which account speaks for it.
//!
//! Every GitHub tool starts here: the remote names the repository, the
//! registered project (when the directory belongs to one) names the account,
//! and neither is guessed at when the answer is not clear.

use anyhow::{anyhow, Result};

use crate::config::{ConfigStore, GithubCredentialSelection};
use crate::git_manager::GitManager;
use crate::github_auth;
use crate::github_manager::GithubManager;
use crate::repo_match::match_registered_repository;

pub struct GithubContext {
    pub manager: GithubManager,
    pub owner: String,
    pub repo: String,
    /// Which account answered, with the secret left behind — this is the shape
    /// the dashboard shows and the config stores, not the resolved token.
    pub credential: GithubCredentialSelection,
}

/// The credential lookup asks about github.com rather than about the remote's
/// own host, the way the reference does — these tools speak to GitHub itself,
/// and an enterprise host would need its own API base as well as its own token.
const CREDENTIAL_HOST: &str = "github.com";

pub async fn require_github_context(store: &ConfigStore, git_cwd: &str) -> Result<GithubContext> {
    let config = store.load().await?;
    let remote_url = GitManager::remote_url(git_cwd, "origin").await?;
    // The top level is read second but reported first: a directory that is not
    // a repository has no remote either, and "not a git repository" is the
    // more useful of the two complaints.
    let top_level = GitManager::root(git_cwd).await?;
    let Some(remote_url) = remote_url else {
        return Err(anyhow!("No git remote 'origin' found."));
    };
    let Some((owner, repo)) = GithubManager::parse_remote_url(&remote_url) else {
        return Err(anyhow!("Could not parse GitHub remote URL: {remote_url}"));
    };

    let repository = match_registered_repository(&config, &top_level)
        .await?
        .map(|repository| repository.name.clone());
    let (token, _, credential) =
        github_auth::resolve(&config, repository.as_deref(), CREDENTIAL_HOST)
            .await
            .map_err(|error| anyhow!("{error}"))?;

    Ok(GithubContext {
        manager: GithubManager::new(token, owner.clone(), repo.clone()),
        owner,
        repo,
        credential,
    })
}

/// The same context, or nothing at all.
///
/// Every failure collapses to `None` on purpose: a route that falls back to an
/// unauthenticated answer does not care *why* it has no account, and the
/// reference reaches this through a bare `catch` that keeps no reason either.
pub async fn optional_github_context(store: &ConfigStore, git_cwd: &str) -> Option<GithubContext> {
    require_github_context(store, git_cwd).await.ok()
}

/// Where a GitHub tool runs when the caller named no directory: the selected
/// repository's active worktree, then its own folder, then this process's
/// working directory.
///
/// Async because the active worktree is verified before it is used — see
/// [`crate::config::selected_git_cwd`], which every surface shares so that the
/// dashboard, the agent, and the desktop app all answer for the same directory.
pub async fn selected_github_cwd(config: &crate::config::Config, fallback: &str) -> String {
    crate::config::selected_git_cwd(config, fallback).await
}
