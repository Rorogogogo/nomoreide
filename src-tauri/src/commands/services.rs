use tauri::State;
use crate::AppState;
use crate::core::process_manager::ServiceStatus;

#[tauri::command]
pub async fn list_services(state: State<'_, AppState>) -> Result<Vec<ServiceStatus>, String> {
    Ok(state.process_manager.status())
}

#[tauri::command]
pub async fn start_service(
    state: State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let def = config.services.iter()
        .find(|s| s.name == name)
        .cloned()
        .ok_or_else(|| format!("Service '{name}' not found"))?;
    state.process_manager.start_service(&def).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stop_service(
    state: State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    state.process_manager.stop_service(&name).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn restart_service(
    state: State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let def = config.services.iter()
        .find(|s| s.name == name)
        .cloned()
        .ok_or_else(|| format!("Service '{name}' not found"))?;
    state.process_manager.restart_service(&def).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_bundle(
    state: State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let bundle = config.bundles.iter()
        .find(|b| b.name == name)
        .cloned()
        .ok_or_else(|| format!("Bundle '{name}' not found"))?;

    for svc_name in &bundle.services {
        if let Some(def) = config.services.iter().find(|s| &s.name == svc_name) {
            state.process_manager.start_service(def).await.map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_bundle(
    state: State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let bundle = config.bundles.iter()
        .find(|b| b.name == name)
        .cloned()
        .ok_or_else(|| format!("Bundle '{name}' not found"))?;

    for svc_name in &bundle.services {
        state.process_manager.stop_service(svc_name).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}
