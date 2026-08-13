use crate::core::config::{BundleDef, Config, DatabaseDef, GitRepoDef, LogSourceDef, ServiceDef};
use crate::AppState;
use tauri::State;

#[tauri::command]
pub async fn get_config(state: State<'_, AppState>) -> Result<Config, String> {
    state.config_store.load().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn register_service(
    state: State<'_, AppState>,
    service: ServiceDef,
) -> Result<Config, String> {
    state
        .config_store
        .register_service(service)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_service(state: State<'_, AppState>, name: String) -> Result<Config, String> {
    state
        .config_store
        .remove_service(&name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn register_bundle(
    state: State<'_, AppState>,
    bundle: BundleDef,
) -> Result<Config, String> {
    state
        .config_store
        .register_bundle(bundle)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn register_git_repository(
    state: State<'_, AppState>,
    repo: GitRepoDef,
) -> Result<Config, String> {
    state
        .config_store
        .register_git_repository(repo)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_git_repository(
    state: State<'_, AppState>,
    name: String,
) -> Result<Config, String> {
    state
        .config_store
        .remove_git_repository(&name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn select_git_repository(
    state: State<'_, AppState>,
    name: Option<String>,
) -> Result<Config, String> {
    state
        .config_store
        .select_git_repository(name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_git_board_repositories(
    state: State<'_, AppState>,
    names: Vec<String>,
) -> Result<Config, String> {
    state
        .config_store
        .set_git_board_repositories(names)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_chat_provider(
    state: State<'_, AppState>,
    provider: String,
) -> Result<crate::commands::agent_chat::ProviderInfo, String> {
    if provider != "claude" && provider != "codex" {
        return Err(format!("Unknown chat provider: {provider}"));
    }
    state
        .config_store
        .set_chat_provider(provider.clone())
        .await
        .map_err(|e| e.to_string())?;
    Ok(crate::commands::agent_chat::provider_info(&provider))
}

#[tauri::command]
pub async fn register_database(
    state: State<'_, AppState>,
    db: DatabaseDef,
) -> Result<Config, String> {
    state
        .config_store
        .register_database(db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_database(state: State<'_, AppState>, name: String) -> Result<Config, String> {
    state
        .config_store
        .remove_database(&name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_database_write_access(
    state: State<'_, AppState>,
    name: String,
    unlocked: bool,
) -> Result<Config, String> {
    state
        .config_store
        .set_database_write_access(&name, unlocked)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_github_token(
    state: State<'_, AppState>,
    host: String,
    token: String,
) -> Result<Config, String> {
    let config = state
        .config_store
        .set_github_token(host.clone(), token)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(repository) = config.selected_git_repository.clone() {
        return state
            .config_store
            .set_github_credential(
                &repository,
                crate::core::config::GithubCredentialSelection::Stored { host },
            )
            .await
            .map_err(|e| e.to_string());
    }
    Ok(config)
}

#[tauri::command]
pub async fn remove_github_token(
    state: State<'_, AppState>,
    host: String,
) -> Result<Config, String> {
    state
        .config_store
        .remove_github_token(&host)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn register_log_source(
    state: State<'_, AppState>,
    source: LogSourceDef,
) -> Result<Config, String> {
    state
        .config_store
        .register_log_source(source)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_log_source(state: State<'_, AppState>, name: String) -> Result<Config, String> {
    state
        .config_store
        .remove_log_source(&name)
        .await
        .map_err(|e| e.to_string())
}
