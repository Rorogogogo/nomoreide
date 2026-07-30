use tauri::State;
use tokio::process::Command;
use std::path::Path;
use crate::AppState;
use crate::core::git_manager::{GitManager, GitStatus, GitCommit, GitBranch, GitFileStatus, FileSizeRank, GitWorktree};
use crate::core::process_manager::ServiceState;

async fn resolve_cwd(state: &AppState, repo: Option<String>) -> Result<String, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;

    if let Some(name) = repo {
        return config.git_repositories.iter()
            .find(|r| r.name == name)
            .map(repository_worktree_path)
            .ok_or_else(|| format!("Repository '{name}' not found"));
    }

    if let Some(sel) = &config.selected_git_repository {
        if let Some(r) = config.git_repositories.iter().find(|r| &r.name == sel) {
            return Ok(repository_worktree_path(r));
        }
    }

    if let Some(r) = config.git_repositories.first() {
        return Ok(repository_worktree_path(r));
    }

    // Fallback: current working directory
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

fn repository_worktree_path(repository: &crate::core::config::GitRepoDef) -> String {
    repository
        .active_worktree_path
        .as_ref()
        .filter(|path| Path::new(path).exists())
        .cloned()
        .unwrap_or_else(|| repository.path.clone())
}

fn selected_repository<'a>(
    config: &'a crate::core::config::Config,
) -> Option<&'a crate::core::config::GitRepoDef> {
    config.selected_git_repository.as_ref()
        .and_then(|name| config.git_repositories.iter().find(|repo| &repo.name == name))
        .or_else(|| config.git_repositories.first())
}

#[tauri::command]
pub async fn git_worktrees(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let config = state.config_store.load().await.map_err(|error| error.to_string())?;
    let repository = selected_repository(&config)
        .ok_or_else(|| "No Git project is selected.".to_string())?;
    let worktrees = GitManager::worktrees(&repository.path)
        .await
        .map_err(|error| error.to_string())?;
    let configured_active = repository_worktree_path(repository);
    let active_path = worktrees.iter()
        .find(|worktree| worktree.path == configured_active)
        .map(|worktree| worktree.path.clone())
        .unwrap_or_else(|| repository.path.clone());
    Ok(serde_json::json!({
        "activePath": active_path,
        "worktrees": worktrees,
    }))
}

#[tauri::command]
pub async fn git_create_worktree(
    state: State<'_, AppState>,
    branch: String,
    create_branch: bool,
    base_ref: Option<String>,
) -> Result<GitWorktree, String> {
    let config = state.config_store.load().await.map_err(|error| error.to_string())?;
    let repository = selected_repository(&config)
        .ok_or_else(|| "No Git project is selected.".to_string())?;
    let worktree = GitManager::create_worktree(
        &repository.path,
        &repository.name,
        &branch,
        create_branch,
        base_ref.as_deref(),
    )
    .await
    .map_err(|error| error.to_string())?;
    state.config_store
        .select_git_worktree(&repository.name, worktree.path.clone())
        .await
        .map_err(|error| error.to_string())?;
    Ok(worktree)
}

#[tauri::command]
pub async fn git_select_worktree(
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let config = state.config_store.load().await.map_err(|error| error.to_string())?;
    let repository = selected_repository(&config)
        .ok_or_else(|| "No Git project is selected.".to_string())?;
    let worktrees = GitManager::worktrees(&repository.path)
        .await
        .map_err(|error| error.to_string())?;
    if !worktrees.iter().any(|worktree| worktree.path == path) {
        return Err("The selected folder is not a worktree of this project.".to_string());
    }
    state.config_store
        .select_git_worktree(&repository.name, path)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn git_remove_worktree(
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let config = state.config_store.load().await.map_err(|error| error.to_string())?;
    let repository = selected_repository(&config)
        .ok_or_else(|| "No Git project is selected.".to_string())?;
    let active = repository.active_worktree_path.as_ref().unwrap_or(&repository.path);
    if active == &path {
        return Err("Switch to another worktree before removing this one.".to_string());
    }
    if state.terminal_manager
        .list_sessions()
        .iter()
        .any(|session| Path::new(&session.cwd).starts_with(Path::new(&path)))
    {
        return Err("Close terminals using this worktree before removing it.".to_string());
    }
    let running = state.process_manager.status();
    if let Some(service) = config.services.iter().find(|service| {
        service.cwd.as_ref().is_some_and(|cwd| Path::new(cwd).starts_with(Path::new(&path)))
            && running.iter().any(|status| {
                status.name == service.name && status.state == ServiceState::Running
            })
    }) {
        return Err(format!(
            "Stop service \"{}\" before removing this worktree.",
            service.name
        ));
    }
    GitManager::remove_worktree(&repository.path, &path)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn git_prune_worktrees(
    state: State<'_, AppState>,
) -> Result<(), String> {
    let config = state.config_store.load().await.map_err(|error| error.to_string())?;
    let repository = selected_repository(&config)
        .ok_or_else(|| "No Git project is selected.".to_string())?;
    GitManager::prune_worktrees(&repository.path)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn git_status(
    state: State<'_, AppState>,
    repo: Option<String>,
) -> Result<GitStatus, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::status(&cwd).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_diff(
    state: State<'_, AppState>,
    file: Option<String>,
    repo: Option<String>,
) -> Result<String, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    match file {
        Some(f) => GitManager::file_diff(&cwd, &f).await.map_err(|e| e.to_string()),
        None => GitManager::diff(&cwd, None).await.map_err(|e| e.to_string()),
    }
}

#[tauri::command]
pub async fn git_graph(
    state: State<'_, AppState>,
    repo: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<GitCommit>, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::graph(&cwd, limit.unwrap_or(200)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_commit_diff(
    state: State<'_, AppState>,
    hash: String,
    file: Option<String>,
    repo: Option<String>,
) -> Result<String, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::commit_diff(&cwd, &hash, file.as_deref()).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_commit_files(
    state: State<'_, AppState>,
    hash: String,
    repo: Option<String>,
) -> Result<Vec<GitFileStatus>, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::commit_files(&cwd, &hash).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_stage(
    state: State<'_, AppState>,
    paths: Vec<String>,
    repo: Option<String>,
) -> Result<(), String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::stage(&cwd, &paths).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_unstage(
    state: State<'_, AppState>,
    paths: Vec<String>,
    repo: Option<String>,
) -> Result<(), String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::unstage(&cwd, &paths).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_commit(
    state: State<'_, AppState>,
    message: String,
    repo: Option<String>,
) -> Result<String, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::commit(&cwd, &message).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_push(
    state: State<'_, AppState>,
    remote: Option<String>,
    repo: Option<String>,
) -> Result<String, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::push(&cwd, remote.as_deref()).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_fetch(
    state: State<'_, AppState>,
    repo: Option<String>,
) -> Result<String, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::fetch(&cwd).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_create_branch(
    state: State<'_, AppState>,
    name: String,
    repo: Option<String>,
) -> Result<(), String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::create_branch(&cwd, &name).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_switch_branch(
    state: State<'_, AppState>,
    name: String,
    repo: Option<String>,
) -> Result<(), String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::switch_branch(&cwd, &name).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_branches(
    state: State<'_, AppState>,
    repo: Option<String>,
) -> Result<Vec<GitBranch>, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::branches(&cwd).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_pull_default(
    state: State<'_, AppState>,
    repo: Option<String>,
) -> Result<String, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::pull_default(&cwd).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_list_files(
    state: State<'_, AppState>,
    repo: Option<String>,
) -> Result<Vec<String>, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::list_tracked_files(&cwd).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_file_sizes(
    state: State<'_, AppState>,
    repo: Option<String>,
) -> Result<Vec<FileSizeRank>, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::rank_files_by_size(&cwd).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_read_file(
    state: State<'_, AppState>,
    path: String,
    repo: Option<String>,
) -> Result<String, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::read_file(&cwd, &path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_write_file(
    state: State<'_, AppState>,
    path: String,
    content: String,
    repo: Option<String>,
) -> Result<(), String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::write_file(&cwd, &path, &content).await.map_err(|e| e.to_string())
}

/// Parse `owner` and `repo` from the git remote URL of the selected repository.
/// Handles HTTPS (`https://github.com/owner/repo.git`) and SSH (`git@github.com:owner/repo.git`).
#[tauri::command]
pub async fn get_github_repo(
    state: State<'_, AppState>,
    repo: Option<String>,
) -> Result<(String, String), String> {
    let cwd = resolve_cwd(&state, repo).await?;
    let out = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    parse_github_owner_repo(&raw)
        .ok_or_else(|| format!("Cannot parse GitHub owner/repo from remote URL: {raw}"))
}

fn parse_github_owner_repo(url: &str) -> Option<(String, String)> {
    let trimmed = url.trim().trim_end_matches(".git");
    // SSH: git@github.com:owner/repo
    if let Some(rest) = trimmed.strip_prefix("git@github.com:") {
        let mut parts = rest.splitn(2, '/');
        return Some((parts.next()?.to_string(), parts.next()?.to_string()));
    }
    // HTTPS: https://github.com/owner/repo  (also handles enterprise hosts)
    if let Some(after_host) = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
    {
        // after_host = "github.com/owner/repo" or "ghe.company.com/owner/repo"
        let mut segments = after_host.splitn(3, '/');
        segments.next(); // host
        let owner = segments.next()?.to_string();
        let repo  = segments.next()?.to_string();
        if !owner.is_empty() && !repo.is_empty() {
            return Some((owner, repo));
        }
    }
    None
}
