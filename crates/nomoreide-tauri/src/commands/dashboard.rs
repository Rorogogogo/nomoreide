use crate::AppState;
use nomoreide_core::process_manager::ServiceStatus;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardData {
    pub config: serde_json::Value,
    pub runtime: RuntimeData,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeData {
    pub services: Vec<ServiceStatus>,
}

#[tauri::command]
pub async fn get_dashboard(state: State<'_, AppState>) -> Result<DashboardData, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let services = state.process_manager.status();

    Ok(DashboardData {
        config: config.public_value(),
        runtime: RuntimeData { services },
    })
}
