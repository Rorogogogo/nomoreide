use tauri::State;
use crate::AppState;
use crate::core::log_store::LogEntry;

#[tauri::command]
pub async fn get_logs(
    state: State<'_, AppState>,
    service: String,
    limit: Option<usize>,
) -> Result<Vec<LogEntry>, String> {
    Ok(state.log_store.read(&service, limit.unwrap_or(200)))
}
