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
use nomoreide_core::config::{ConfigStore, GitRepoDef};
use nomoreide_core::git_manager::GitManager;

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
