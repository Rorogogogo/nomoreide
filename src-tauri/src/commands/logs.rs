use crate::core::log_store::LogEntry;
use crate::AppState;
use tauri::State;

#[tauri::command]
pub async fn get_logs(
    state: State<'_, AppState>,
    service: String,
    limit: Option<usize>,
) -> Result<Vec<LogEntry>, String> {
    Ok(state.log_store.read(&service, limit.unwrap_or(200)))
}
