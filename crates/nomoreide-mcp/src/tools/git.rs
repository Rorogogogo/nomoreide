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
//! Both validations below are the reference's and belong here rather than in
//! `nomoreide_core::config`, which registers whatever it is handed. The Rust
//! `ConfigStore` predates this tool and had neither.

use super::render;
use nomoreide_core::config::{ConfigStore, GitRepoDef};
use nomoreide_core::git_manager::GitManager;
use std::path::Path;
use tokio::process::Command;

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
    require_absolute_path(path)?;
    require_git_worktree(path).await?;
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

/// `~` is not expanded here, so a path that starts with it would be registered
/// literally and resolve to nothing. Say so rather than storing it.
fn require_absolute_path(path: &str) -> Result<(), String> {
    if Path::new(path).is_absolute() {
        return Ok(());
    }
    Err("Please add an absolute path. Paths beginning with ~ are not expanded here.".to_string())
}

async fn require_git_worktree(path: &str) -> Result<(), String> {
    if is_git_worktree(path).await {
        return Ok(());
    }
    Err("Not a Git repository. Choose a folder inside a Git worktree.".to_string())
}

/// A missing directory, a missing `git`, and a directory outside any repository
/// are all the same answer here: not a worktree.
async fn is_git_worktree(path: &str) -> bool {
    Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(path)
        .output()
        .await
        .ok()
        .filter(|output| output.status.success())
        .is_some_and(|output| String::from_utf8_lossy(&output.stdout).trim() == "true")
}
