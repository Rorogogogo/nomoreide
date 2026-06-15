use tauri::State;
use serde::{Deserialize, Serialize};
use tokio::process::Command;
use crate::AppState;
use crate::core::git_manager::GitManager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub sha: String,
    pub label: Option<String>,
    pub created_at: String,
}

/// Create a snapshot (stash-like: git stash with a label)
#[tauri::command]
pub async fn create_snapshot(
    state: State<'_, AppState>,
    label: Option<String>,
    repo: Option<String>,
) -> Result<Snapshot, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let cwd = resolve_cwd(&config, repo.as_deref())?;

    let msg = label.as_deref().unwrap_or("nomoreide snapshot");
    let out = Command::new("git")
        .args(["stash", "push", "-u", "-m", msg])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }

    // Get the stash SHA
    let sha_out = Command::new("git")
        .args(["rev-parse", "stash@{0}"])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    let sha = String::from_utf8_lossy(&sha_out.stdout).trim().to_string();

    Ok(Snapshot {
        sha,
        label: label,
        created_at: chrono::Utc::now().to_rfc3339(),
    })
}

#[tauri::command]
pub async fn list_snapshots(
    state: State<'_, AppState>,
    repo: Option<String>,
) -> Result<Vec<Snapshot>, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let cwd = resolve_cwd(&config, repo.as_deref())?;

    let out = Command::new("git")
        .args(["stash", "list", "--format=%H|%s|%aI"])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    let snapshots = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let parts: Vec<&str> = line.splitn(3, '|').collect();
            Snapshot {
                sha: parts.first().copied().unwrap_or("").to_string(),
                label: parts.get(1).map(|s| s.replace("On stash: ", "").replace("WIP on stash: ", "")),
                created_at: parts.get(2).copied().unwrap_or("").to_string(),
            }
        })
        .collect();

    Ok(snapshots)
}

#[tauri::command]
pub async fn restore_snapshot(
    state: State<'_, AppState>,
    sha: String,
    repo: Option<String>,
) -> Result<(), String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let cwd = resolve_cwd(&config, repo.as_deref())?;

    let out = Command::new("git")
        .args(["stash", "apply", &sha])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_snapshot(
    state: State<'_, AppState>,
    sha: String,
    repo: Option<String>,
) -> Result<(), String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let cwd = resolve_cwd(&config, repo.as_deref())?;

    let out = Command::new("git")
        .args(["stash", "drop", &sha])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(())
}

fn resolve_cwd(config: &crate::core::config::Config, repo: Option<&str>) -> Result<String, String> {
    if let Some(name) = repo {
        return config.git_repositories.iter()
            .find(|r| r.name == name)
            .map(|r| r.path.clone())
            .ok_or_else(|| format!("Repository '{name}' not found"));
    }
    if let Some(sel) = &config.selected_git_repository {
        if let Some(r) = config.git_repositories.iter().find(|r| &r.name == sel) {
            return Ok(r.path.clone());
        }
    }
    config.git_repositories.first()
        .map(|r| r.path.clone())
        .ok_or_else(|| "No git repository configured".to_string())
}

use chrono;
