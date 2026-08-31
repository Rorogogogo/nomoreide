//! The Git surface: registering a repository, and reading one.
//!
//! Nothing here needs the daemon. Registration and selection write config,
//! and the reads run git in a directory the caller names — neither is a
//! question about a running service.
//!
//! Like service registration, these write config and never touch the runtime,
//! so they run locally without a daemon: the daemon re-reads the file per
//! operation and picks up what they wrote without being told.
//!

use super::render;
use nomoreide_actions::git::{GitActions, PushCredential};
use nomoreide_core::config::{ConfigStore, GitRepoDef};
use nomoreide_core::git_identity::{
    repository_for_cwd, resolve_identity_for_cwd, resolve_push_credential,
};
use nomoreide_core::git_manager::GitManager;
use nomoreide_core::repo_onboard::clone_repository;

pub(super) async fn status(cwd: Option<&str>) -> Result<String, String> {
    let status = GitManager::status(&working_directory(cwd)?)
        .await
        .map_err(|error| error.to_string())?;
    render(&status)
}

pub(super) async fn branches(cwd: Option<&str>) -> Result<String, String> {
    let branches = GitManager::branches(&working_directory(cwd)?)
        .await
        .map_err(|error| error.to_string())?;
    render(&branches)
}

/// Diffs are returned as git wrote them, not as JSON: an agent reads a patch,
/// and quoting one into a JSON string would only make it harder to read.
pub(super) async fn diff(cwd: Option<&str>, path: Option<&str>) -> Result<String, String> {
    GitManager::diff(&working_directory(cwd)?, path)
        .await
        .map_err(|error| error.to_string())
}

pub(super) async fn staged_diff(cwd: Option<&str>, path: Option<&str>) -> Result<String, String> {
    GitManager::staged_diff(&working_directory(cwd)?, path)
        .await
        .map_err(|error| error.to_string())
}

pub(super) async fn log(cwd: Option<&str>, limit: u32) -> Result<String, String> {
    let entries = GitManager::log(&working_directory(cwd)?, limit)
        .await
        .map_err(|error| error.to_string())?;
    render(&entries)
}

/// Where a read runs. An absent `cwd` means this process's own directory, the
/// way it does in the reference — which is rarely what an agent wants, but is
/// what it gets if it names nothing.
fn working_directory(cwd: Option<&str>) -> Result<String, String> {
    match cwd {
        Some(cwd) => Ok(cwd.to_string()),
        None => std::env::current_dir()
            .map(|path| path.to_string_lossy().into_owned())
            .map_err(|error| error.to_string()),
    }
}

pub(super) async fn register_repository(
    store: &ConfigStore,
    name: &str,
    path: &str,
) -> Result<String, String> {
    let config = store
        .register_git_repository(GitRepoDef {
            name: name.to_string(),
            path: path.to_string(),
            active_worktree_path: None,
            github_credential: None,
            provider_projects: None,
            legacy_vercel_project_id: None,
        })
        .await
        .map_err(|error| error.to_string())?;
    let view = config.public_view();
    render(&view)
}

pub(super) async fn select_repository(store: &ConfigStore, name: &str) -> Result<String, String> {
    let config = store
        .select_git_repository(Some(name.to_string()))
        .await
        .map_err(|error| error.to_string())?;
    let view = config.public_view();
    render(&view)
}

pub(super) async fn worktrees(cwd: Option<&str>) -> Result<String, String> {
    let worktrees = GitManager::worktrees(&working_directory(cwd)?)
        .await
        .map_err(|error| error.to_string())?;
    render(&worktrees)
}

pub(super) async fn create_worktree(
    cwd: Option<&str>,
    branch: &str,
    create_branch: bool,
    base_ref: Option<&str>,
    project_name: Option<&str>,
) -> Result<String, String> {
    let worktree = GitManager::create_worktree(
        &working_directory(cwd)?,
        project_name,
        branch,
        create_branch,
        base_ref,
    )
    .await
    .map_err(|error| error.to_string())?;
    render(&worktree)
}

pub(super) async fn select_worktree(
    store: &ConfigStore,
    repository: &str,
    path: &str,
) -> Result<String, String> {
    let config = store
        .select_git_worktree(repository, path)
        .await
        .map_err(|error| error.to_string())?;
    let view = config.public_view();
    render(&view)
}

/// Pruning reports that it happened rather than what git said, because git says
/// nothing when there was nothing stale to drop.
pub(super) async fn prune_worktrees(cwd: Option<&str>) -> Result<String, String> {
    GitManager::prune_worktrees(&working_directory(cwd)?)
        .await
        .map_err(|error| error.to_string())?;
    render(&serde_json::json!({ "pruned": true }))
}

/// Staging and unstaging report git's own output — usually nothing — as a JSON
/// string rather than as bare text, which is what the reference does and what
/// tells the two apart from the tools that return a patch.
pub(super) async fn stage(cwd: Option<&str>, paths: &[String]) -> Result<String, String> {
    let output = GitManager::stage(&working_directory(cwd)?, paths)
        .await
        .map_err(|error| error.to_string())?;
    render(&output)
}

pub(super) async fn unstage(cwd: Option<&str>, paths: &[String]) -> Result<String, String> {
    let output = GitManager::unstage(&working_directory(cwd)?, paths)
        .await
        .map_err(|error| error.to_string())?;
    render(&output)
}

/// Commit as the GitHub account selected for this repository, so an agent's
/// commits and a human's carry one author. Without a selected account this
/// falls back to the machine's `user.email`, which is what git would do anyway.
pub(super) async fn commit(
    store: &ConfigStore,
    cwd: Option<&str>,
    message: &str,
) -> Result<String, String> {
    let directory = working_directory(cwd)?;
    let identity = resolve_identity_for_cwd(store, &directory)
        .await
        .map_err(|error| error.to_string())?;
    GitManager::commit(&directory, message, identity.selected.as_ref())
        .await
        .map_err(|error| error.to_string())
}

pub(super) async fn create_branch(cwd: Option<&str>, name: &str) -> Result<String, String> {
    GitManager::create_branch(&working_directory(cwd)?, name, None)
        .await
        .map_err(|error| error.to_string())
}

pub(super) async fn switch_branch(cwd: Option<&str>, name: &str) -> Result<String, String> {
    GitManager::switch_branch(&working_directory(cwd)?, name)
        .await
        .map_err(|error| error.to_string())
}

pub(super) async fn fetch(cwd: Option<&str>) -> Result<String, String> {
    GitManager::fetch(&working_directory(cwd)?)
        .await
        .map_err(|error| error.to_string())
}

/// Push the current branch, as the GitHub account selected for this repository
/// when one is selected and the remote is an HTTPS one on that account's host.
///
/// The token never reaches `argv`: it travels through the environment into a
/// throwaway credential helper, installed after an empty `credential.helper=`
/// that resets the inherited chain — otherwise the machine's keychain could
/// answer first and push as an account the user did not choose.
pub(super) async fn push(
    store: &ConfigStore,
    cwd: Option<&str>,
    remote: Option<&str>,
) -> Result<String, String> {
    let directory = working_directory(cwd)?;
    let config = store.load().await.map_err(|error| error.to_string())?;
    let repository = repository_for_cwd(&config, &directory).await;
    let remote_url = GitManager::remote_url(&directory, remote.unwrap_or("origin"))
        .await
        .map_err(|error| error.to_string())?;
    let credential = resolve_push_credential(&config, repository, remote_url.as_deref()).await;
    let result = GitActions::new(directory)
        .push(
            remote,
            credential.as_ref().map(|(token, login)| PushCredential {
                token,
                username: login.as_deref(),
            }),
        )
        .await
        .map_err(|error| error.to_string())?;
    render(&result)
}

/// Clone into the managed repositories directory and register what landed.
///
/// The token handed to the clone is the legacy github.com one rather than the
/// repository's selected account: there is no repository yet to have selected
/// an account for.
pub(super) async fn clone(store: &ConfigStore, url: &str) -> Result<String, String> {
    let config = store.load().await.map_err(|error| error.to_string())?;
    let token = store.get_github_token(&config, "github.com");
    let cloned = clone_repository(url, None, token)
        .await
        .map_err(|error| error.to_string())?;
    store
        .register_git_repository(GitRepoDef {
            name: cloned.name.clone(),
            path: cloned.clone_path.clone(),
            active_worktree_path: None,
            github_credential: None,
            provider_projects: None,
            legacy_vercel_project_id: None,
        })
        .await
        .map_err(|error| error.to_string())?;
    render(&serde_json::json!({ "name": cloned.name, "path": cloned.clone_path }))
}
