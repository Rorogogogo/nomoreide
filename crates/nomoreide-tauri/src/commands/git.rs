use crate::AppState;
use nomoreide_actions::git::{GitActions, GitPushResult, PushCredential};
use nomoreide_core::config::{Config, GitRepoDef};
use nomoreide_core::git_identity;
use nomoreide_core::git_manager::{
    FileSizeRank, GitBranch, GitCommit, GitFileStatus, GitManager, GitStatus, GitWorktree,
};
use nomoreide_core::process_manager::ServiceState;
use std::path::Path;
use tauri::State;
use tokio::process::Command;

/// Same resolution as {@link resolve_cwd}, but also returns the repository the
/// directory belongs to and the config it came from. Commit and push need those
/// to attribute the operation to the repository's selected GitHub account.
async fn resolve_repo_target(
    state: &AppState,
    repo: Option<String>,
) -> Result<(String, Option<GitRepoDef>, Config), String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;

    let selected = match &repo {
        Some(name) => Some(
            config
                .git_repositories
                .iter()
                .find(|r| &r.name == name)
                .ok_or_else(|| format!("Repository '{name}' not found"))?
                .clone(),
        ),
        None => config
            .selected_git_repository
            .as_ref()
            .and_then(|sel| config.git_repositories.iter().find(|r| &r.name == sel))
            .or_else(|| config.git_repositories.first())
            .cloned(),
    };

    let cwd = match &selected {
        Some(repository) => repository_worktree_path(repository),
        None => std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(|e| e.to_string())?,
    };
    Ok((cwd, selected, config))
}

async fn resolve_cwd(state: &AppState, repo: Option<String>) -> Result<String, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;

    if let Some(name) = repo {
        return config
            .git_repositories
            .iter()
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

fn repository_worktree_path(repository: &nomoreide_core::config::GitRepoDef) -> String {
    repository
        .active_worktree_path
        .as_ref()
        .filter(|path| Path::new(path).exists())
        .cloned()
        .unwrap_or_else(|| repository.path.clone())
}

fn selected_repository(
    config: &nomoreide_core::config::Config,
) -> Option<&nomoreide_core::config::GitRepoDef> {
    config
        .selected_git_repository
        .as_ref()
        .and_then(|name| {
            config
                .git_repositories
                .iter()
                .find(|repo| &repo.name == name)
        })
        .or_else(|| config.git_repositories.first())
}

#[tauri::command]
pub async fn git_worktrees(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let config = state
        .config_store
        .load()
        .await
        .map_err(|error| error.to_string())?;
    let repository =
        selected_repository(&config).ok_or_else(|| "No Git project is selected.".to_string())?;
    let worktrees = GitManager::worktrees(&repository.path)
        .await
        .map_err(|error| error.to_string())?;
    let configured_active = repository_worktree_path(repository);
    let active_path = worktrees
        .iter()
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
    let config = state
        .config_store
        .load()
        .await
        .map_err(|error| error.to_string())?;
    let repository =
        selected_repository(&config).ok_or_else(|| "No Git project is selected.".to_string())?;
    let worktree = GitManager::create_worktree(
        &repository.path,
        // The desktop app groups a repository's worktrees under its registered
        // name, which is not always its folder name.
        Some(&repository.name),
        &branch,
        create_branch,
        base_ref.as_deref(),
    )
    .await
    .map_err(|error| error.to_string())?;
    state
        .config_store
        .select_git_worktree(&repository.name, &worktree.path)
        .await
        .map_err(|error| error.to_string())?;
    Ok(worktree)
}

#[tauri::command]
pub async fn git_select_worktree(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let config = state
        .config_store
        .load()
        .await
        .map_err(|error| error.to_string())?;
    let repository =
        selected_repository(&config).ok_or_else(|| "No Git project is selected.".to_string())?;
    // The store checks membership itself, canonically — comparing the strings
    // here missed a worktree reached through a symlinked path.
    state
        .config_store
        .select_git_worktree(&repository.name, &path)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn git_remove_worktree(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let config = state
        .config_store
        .load()
        .await
        .map_err(|error| error.to_string())?;
    let repository =
        selected_repository(&config).ok_or_else(|| "No Git project is selected.".to_string())?;
    let active = repository
        .active_worktree_path
        .as_ref()
        .unwrap_or(&repository.path);
    if active == &path {
        return Err("Switch to another worktree before removing this one.".to_string());
    }
    if state
        .terminal_manager
        .list_sessions()
        .iter()
        .any(|session| Path::new(&session.cwd).starts_with(Path::new(&path)))
    {
        return Err("Close terminals using this worktree before removing it.".to_string());
    }
    let running = state.process_manager.status();
    if let Some(service) = config.services.iter().find(|service| {
        service
            .cwd
            .as_ref()
            .is_some_and(|cwd| Path::new(cwd).starts_with(Path::new(&path)))
            && running
                .iter()
                .any(|status| status.name == service.name && status.state == ServiceState::Running)
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
pub async fn git_prune_worktrees(state: State<'_, AppState>) -> Result<(), String> {
    let config = state
        .config_store
        .load()
        .await
        .map_err(|error| error.to_string())?;
    let repository =
        selected_repository(&config).ok_or_else(|| "No Git project is selected.".to_string())?;
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
        Some(f) => GitManager::file_diff(&cwd, &f)
            .await
            .map_err(|e| e.to_string()),
        None => GitManager::diff(&cwd, None)
            .await
            .map_err(|e| e.to_string()),
    }
}

#[tauri::command]
pub async fn git_graph(
    state: State<'_, AppState>,
    repo: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<GitCommit>, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::graph(&cwd, limit.unwrap_or(200))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_commit_diff(
    state: State<'_, AppState>,
    hash: String,
    file: Option<String>,
    repo: Option<String>,
) -> Result<String, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::commit_diff(&cwd, &hash, file.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_commit_files(
    state: State<'_, AppState>,
    hash: String,
    repo: Option<String>,
) -> Result<Vec<GitFileStatus>, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::commit_files(&cwd, &hash)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_stage(
    state: State<'_, AppState>,
    paths: Vec<String>,
    repo: Option<String>,
) -> Result<String, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::stage(&cwd, &paths)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_unstage(
    state: State<'_, AppState>,
    paths: Vec<String>,
    repo: Option<String>,
) -> Result<String, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::unstage(&cwd, &paths)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_commit(
    state: State<'_, AppState>,
    message: String,
    repo: Option<String>,
) -> Result<String, String> {
    // Honour the GitHub account selected for this repository, so the commit's
    // author matches the account that will open the pull request. Falls back to
    // the machine's git identity when no account is selected.
    let (cwd, repository, config) = resolve_repo_target(&state, repo).await?;
    let identity = git_identity::resolve_identity_state(
        &state.config_store,
        &config,
        repository.as_ref(),
        &cwd,
    )
    .await;
    GitManager::commit(&cwd, &message, identity.selected.as_ref())
        .await
        .map_err(|e| e.to_string())
}

/// Who a commit made here would be authored by, and whether that differs from
/// the machine's configured git identity.
#[tauri::command]
pub async fn git_identity_state(
    state: State<'_, AppState>,
    repo: Option<String>,
) -> Result<git_identity::GitIdentityState, String> {
    let (cwd, repository, config) = resolve_repo_target(&state, repo).await?;
    Ok(git_identity::resolve_identity_state(
        &state.config_store,
        &config,
        repository.as_ref(),
        &cwd,
    )
    .await)
}

#[tauri::command]
pub async fn git_push(
    state: State<'_, AppState>,
    remote: Option<String>,
    repo: Option<String>,
) -> Result<GitPushResult, String> {
    // Push as the account selected for this repository rather than whichever one
    // the machine's credential helper answers with. None for SSH remotes and
    // unselected repos — those keep the existing behaviour.
    let (cwd, repository, config) = resolve_repo_target(&state, repo).await?;
    let remote_url = GitManager::remote_url(&cwd, remote.as_deref().unwrap_or("origin"))
        .await
        .ok()
        .flatten();
    let credential =
        git_identity::resolve_push_credential(&config, repository.as_ref(), remote_url.as_deref())
            .await;
    GitActions::new(cwd)
        .push(
            remote.as_deref(),
            credential.as_ref().map(|(token, login)| PushCredential {
                token: token.as_str(),
                username: login.as_deref(),
            }),
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_fetch(state: State<'_, AppState>, repo: Option<String>) -> Result<String, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::fetch(&cwd).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_pull(state: State<'_, AppState>, repo: Option<String>) -> Result<String, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitActions::new(cwd).pull().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_merge(
    state: State<'_, AppState>,
    branch: String,
    repo: Option<String>,
) -> Result<String, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitActions::new(cwd)
        .merge(&branch)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_rebase(
    state: State<'_, AppState>,
    branch: String,
    repo: Option<String>,
) -> Result<String, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitActions::new(cwd)
        .rebase(&branch)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_create_branch(
    state: State<'_, AppState>,
    name: String,
    start_point: Option<String>,
    repo: Option<String>,
) -> Result<String, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::create_branch(&cwd, &name, start_point.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_delete_branch(
    state: State<'_, AppState>,
    name: String,
    repo: Option<String>,
) -> Result<String, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::delete_branch(&cwd, &name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_switch_branch(
    state: State<'_, AppState>,
    name: String,
    repo: Option<String>,
) -> Result<String, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::switch_branch(&cwd, &name)
        .await
        .map_err(|e| e.to_string())
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
    GitActions::new(cwd)
        .pull_default()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_list_files(
    state: State<'_, AppState>,
    repo: Option<String>,
) -> Result<Vec<String>, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::list_tracked_files(&cwd)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_file_sizes(
    state: State<'_, AppState>,
    repo: Option<String>,
) -> Result<Vec<FileSizeRank>, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::rank_files_by_size(&cwd)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_read_file(
    state: State<'_, AppState>,
    path: String,
    repo: Option<String>,
) -> Result<String, String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::read_file(&cwd, &path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_write_file(
    state: State<'_, AppState>,
    path: String,
    content: String,
    repo: Option<String>,
) -> Result<(), String> {
    let cwd = resolve_cwd(&state, repo).await?;
    GitManager::write_file(&cwd, &path, &content)
        .await
        .map_err(|e| e.to_string())
}

/// Parse `owner` and `repo` from the git remote URL of the selected repository.
/// Handles HTTPS (`https://github.com/owner/repo.git`) and SSH (`git@github.com:owner/repo.git`).
#[tauri::command]
pub async fn get_github_repo(
    state: State<'_, AppState>,
    repo: Option<String>,
) -> Result<(String, String, String), String> {
    let config = state
        .config_store
        .load()
        .await
        .map_err(|error| error.to_string())?;
    let repository = repo
        .as_ref()
        .and_then(|name| {
            config
                .git_repositories
                .iter()
                .find(|entry| &entry.name == name)
        })
        .or_else(|| {
            config.selected_git_repository.as_ref().and_then(|name| {
                config
                    .git_repositories
                    .iter()
                    .find(|entry| &entry.name == name)
            })
        })
        .or_else(|| config.git_repositories.first())
        .ok_or("No Git repository is selected")?;
    let cwd = repository
        .active_worktree_path
        .as_ref()
        .unwrap_or(&repository.path);
    let out = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let (owner, repo) = parse_github_owner_repo(&raw)
        .ok_or_else(|| format!("Cannot parse GitHub owner/repo from remote URL: {raw}"))?;
    Ok((repository.name.clone(), owner, repo))
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
        let repo = segments.next()?.to_string();
        if !owner.is_empty() && !repo.is_empty() {
            return Some((owner, repo));
        }
    }
    None
}
