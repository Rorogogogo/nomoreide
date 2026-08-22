//! Snapshots, and onboarding a repository from nothing but a URL.
//!
//! Two groups that read as one: both hand an agent a starting point. A
//! snapshot is a way back to where the working tree was before the agent
//! touched it; onboarding is how a repository the agent has never seen becomes
//! something it can propose running.
//!
//! Neither restores nor registers anything. Restoring a snapshot overwrites
//! work and stays human-confirmed in the dashboard; onboarding stops at the
//! profile, and the agent finishes with the registration tools it already has.

use nomoreide_core::repo_onboard::{
    clone_repository, default_repos_dir, propose_databases, propose_services, scan_repo,
};
use nomoreide_core::snapshot_manager::{SnapshotManager, DEFAULT_KEEP};

use super::render;

/// Where a tool works when it was not told. The process's own directory, which
/// for a stdio MCP server is wherever the agent started it.
fn working_directory(cwd: Option<&str>) -> Result<String, String> {
    match cwd {
        Some(cwd) => Ok(cwd.to_string()),
        None => std::env::current_dir()
            .map(|path| path.to_string_lossy().into_owned())
            .map_err(|error| error.to_string()),
    }
}

pub(super) async fn snapshots_list(cwd: Option<&str>) -> Result<String, String> {
    let manager = SnapshotManager::new(working_directory(cwd)?);
    let snapshots = manager.list().await.map_err(|error| error.to_string())?;
    render(&snapshots)
}

pub(super) async fn snapshot_create(cwd: Option<&str>, label: &str) -> Result<String, String> {
    let manager = SnapshotManager::new(working_directory(cwd)?);
    let snapshot = manager
        .snapshot(label)
        .await
        .map_err(|error| error.to_string())?;
    // Pruning is housekeeping, not part of the answer: the snapshot the caller
    // just took is reported whether or not old ones could be cleared.
    let _ = manager.prune(DEFAULT_KEEP).await;
    render(&snapshot)
}

pub(super) async fn onboard_repo(url: &str) -> Result<String, String> {
    // The destination is named rather than defaulted, matching the reference —
    // though `clone_repository` would reach the same directory on its own, so
    // no fixture can tell the two spellings apart.
    //
    // No token is passed. Onboarding is for a repository the agent has not
    // seen, and a stored GitHub credential is not something to spend on an
    // arbitrary URL; `nomoreide_git_clone` is the tool that authenticates.
    let cloned = clone_repository(url, Some(&default_repos_dir()), None)
        .await
        .map_err(|error| error.to_string())?;
    let profile = scan_repo(&cloned.clone_path)
        .await
        .map_err(|error| error.to_string())?;
    let proposals = propose_services(&profile);
    let databases = propose_databases(&profile);
    render(&serde_json::json!({
        "profile": profile,
        "proposals": proposals,
        "databases": databases,
    }))
}
