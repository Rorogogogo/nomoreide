use tauri::State;
use serde_json::Value;
use crate::AppState;

#[tauri::command]
pub async fn list_workflows(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    Ok(config.workflows)
}

#[tauri::command]
pub async fn save_workflow(
    state: State<'_, AppState>,
    workflow: Value,
) -> Result<Vec<Value>, String> {
    let config = state.config_store.save_workflow(workflow).await.map_err(|e| e.to_string())?;
    Ok(config.workflows)
}

#[tauri::command]
pub async fn delete_workflow(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<Value>, String> {
    let config = state.config_store.remove_workflow(&id).await.map_err(|e| e.to_string())?;
    Ok(config.workflows)
}
