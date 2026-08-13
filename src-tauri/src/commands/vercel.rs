//! Vercel deployment visibility and controls for the desktop app.
//!
//! The Rust counterpart of `src/web/routes/vercel-routes.ts`. Reads go through
//! the read-safe `VercelManager`; the four state-changing operations are
//! funnelled through the single `vercel_deployment_action` command below, so
//! the write boundary has exactly one door here too.

use serde_json::Value;
use std::sync::Mutex;
use tauri::State;

use crate::core::config::{Config, ConfigStore, VercelConnectionDef};
use crate::core::vercel_auth::{cli_status, public_connection, read_cli_session};
use crate::core::vercel_context::{require_actions, require_context, selected_cwd};
use crate::core::vercel_oauth;
use crate::AppState;

/// Where a browser sign-in has got to.
///
/// Module state for the same reason the Node side keeps it: the flow spans a
/// command that starts it and a background task that finishes it minutes later,
/// and the UI polls for the result rather than holding a call open.
#[derive(Debug, Clone, Default)]
struct LoginPhase {
    /// "idle" | "pending" | "connected" | "error"
    phase: String,
    error: Option<String>,
}

static LOGIN_PHASE: Mutex<Option<LoginPhase>> = Mutex::new(None);

fn set_phase(phase: &str, error: Option<String>) {
    if let Ok(mut guard) = LOGIN_PHASE.lock() {
        *guard = Some(LoginPhase {
            phase: phase.to_string(),
            error,
        });
    }
}

async fn load_config(state: &State<'_, AppState>) -> Result<Config, String> {
    state
        .config_store
        .load()
        .await
        .map_err(|error| error.to_string())
}

/// The working directory Vercel operations run against.
fn git_cwd(config: &Config) -> String {
    let fallback = std::env::current_dir()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string());
    selected_cwd(config, &fallback)
}

// ---------------------------------------------------------------------------
// Browser sign-in (OAuth authorization code + PKCE, loopback redirect)
// ---------------------------------------------------------------------------

/// Begins a browser sign-in and returns the URL the user must open.
///
/// The loopback listener outlives this command: it is handed to a background
/// task that waits for the redirect, exchanges the code, and stores the
/// tokens. The frontend learns the outcome from `vercel_oauth_phase`.
#[tauri::command]
pub async fn vercel_oauth_start(_state: State<'_, AppState>) -> Result<Value, String> {
    let pending = match vercel_oauth::begin().await {
        Ok(pending) => pending,
        Err(error) => {
            set_phase("error", Some(error.clone()));
            return Err(error);
        }
    };
    let url = pending.authorize_url.clone();
    let client_id = pending.client_id.clone();
    set_phase("pending", None);

    let config_path = ConfigStore::default_path();
    tauri::async_runtime::spawn(async move {
        match pending.wait_for_tokens().await {
            Ok(tokens) => {
                let store = ConfigStore::new(config_path);
                let saved = store
                    .set_vercel_connection(VercelConnectionDef {
                        source: "oauth".into(),
                        token: Some(tokens.access_token),
                        refresh_token: tokens.refresh_token,
                        expires_at: Some(tokens.expires_at),
                        client_id: Some(client_id),
                        team_id: None,
                        team_slug: None,
                        username: None,
                    })
                    .await;
                match saved {
                    Ok(_) => set_phase("connected", None),
                    Err(error) => set_phase("error", Some(error.to_string())),
                }
            }
            Err(error) => set_phase("error", Some(error)),
        }
    });

    Ok(serde_json::json!({ "ok": true, "url": url }))
}

#[tauri::command]
pub async fn vercel_oauth_phase() -> Result<Value, String> {
    let phase = LOGIN_PHASE
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .unwrap_or_else(|| LoginPhase {
            phase: "idle".into(),
            error: None,
        });
    Ok(match phase.error {
        Some(error) => serde_json::json!({ "phase": phase.phase, "error": error }),
        None => serde_json::json!({ "phase": phase.phase }),
    })
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn vercel_status(state: State<'_, AppState>) -> Result<Value, String> {
    let config = load_config(&state).await?;
    let cli = cli_status().await;
    let repository_name = config.selected_git_repository.clone().or_else(|| {
        config
            .git_repositories
            .first()
            .map(|repo| repo.name.clone())
    });

    let mut body = serde_json::json!({
        "ok": true,
        "connection": public_connection(&config),
        "cliAvailable": cli.available,
        "cliError": cli.error,
        "repositoryName": repository_name,
    });

    if config.vercel.is_none() && !cli.available {
        body["status"] = Value::String("not_configured".into());
        return Ok(body);
    }

    let cwd = git_cwd(&config);
    match require_context(&state.config_store, &config, &cwd).await {
        Ok(context) => {
            let viewer = context.manager.viewer().await;
            match viewer {
                Ok(viewer) => {
                    let teams = context.manager.list_teams().await.unwrap_or_default();
                    // The CLI being logged in is enough to work: a user who
                    // never opened this tab still gets a connected dashboard
                    // rather than a setup screen.
                    if body["connection"].is_null() {
                        body["connection"] = serde_json::json!({ "source": "cli" });
                    }
                    body["status"] = Value::String(
                        if context.project.is_some() {
                            "connected"
                        } else {
                            "no_project"
                        }
                        .into(),
                    );
                    body["user"] = serde_json::json!({
                        "username": viewer.get("username").cloned().unwrap_or(Value::Null),
                        "avatar": viewer.get("avatar").cloned().unwrap_or(Value::Null),
                    });
                    body["teams"] = Value::Array(teams);
                    body["project"] = context.project.clone().unwrap_or(Value::Null);
                    body["teamId"] = context
                        .credential
                        .team_id
                        .clone()
                        .map(Value::String)
                        .unwrap_or(Value::Null);
                }
                Err(error) => {
                    body["status"] = Value::String(
                        if error.status == 401 || error.status == 403 {
                            "auth_error"
                        } else {
                            "connection_error"
                        }
                        .into(),
                    );
                    body["error"] = Value::String(error.message);
                }
            }
        }
        Err(error) => {
            body["status"] = Value::String("connection_error".into());
            body["error"] = Value::String(error);
        }
    }
    Ok(body)
}

#[tauri::command]
pub async fn vercel_connect(
    state: State<'_, AppState>,
    source: String,
    token: Option<String>,
) -> Result<(), String> {
    let connection = if source == "cli" {
        let session = read_cli_session()
            .await
            .ok_or("No Vercel CLI login found. Run `vercel login` first.")?;
        VercelConnectionDef {
            source: "cli".into(),
            token: None,
            refresh_token: None,
            expires_at: None,
            client_id: None,
            team_id: session.current_team,
            team_slug: None,
            username: None,
        }
    } else {
        let token = token
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .ok_or("A Vercel token is required.")?;
        VercelConnectionDef {
            source: "stored".into(),
            token: Some(token),
            refresh_token: None,
            expires_at: None,
            client_id: None,
            team_id: None,
            team_slug: None,
            username: None,
        }
    };

    state
        .config_store
        .set_vercel_connection(connection)
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn vercel_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    set_phase("idle", None);
    state
        .config_store
        .remove_vercel_connection()
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn vercel_set_scope(
    state: State<'_, AppState>,
    team_id: Option<String>,
    team_slug: Option<String>,
) -> Result<(), String> {
    state
        .config_store
        .set_vercel_scope(team_id, team_slug)
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn vercel_list_projects(
    state: State<'_, AppState>,
    search: Option<String>,
) -> Result<Value, String> {
    let config = load_config(&state).await?;
    let cwd = git_cwd(&config);
    let context = require_context(&state.config_store, &config, &cwd).await?;
    let projects = context
        .manager
        .list_projects(search.as_deref(), None, None)
        .await
        .map_err(|error| error.message)?;
    Ok(serde_json::json!({
        "projects": projects,
        "linkedProjectId": context
            .project
            .as_ref()
            .and_then(|project| project.get("id").cloned())
            .unwrap_or(Value::Null),
    }))
}

/// Pin (or clear, with an empty projectId) the selected repo's project.
#[tauri::command]
pub async fn vercel_set_project(
    state: State<'_, AppState>,
    project_id: Option<String>,
) -> Result<(), String> {
    let config = load_config(&state).await?;
    let repository = config
        .selected_git_repository
        .clone()
        .or_else(|| {
            config
                .git_repositories
                .first()
                .map(|repo| repo.name.clone())
        })
        .ok_or("No Git repository is selected.")?;
    state
        .config_store
        .set_vercel_project(&repository, project_id)
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// The linked project read in full. `vercel_status` already carries a project,
/// but it may have come from the list endpoint, which omits the build settings
/// — this always reads the single-project endpoint so the settings panel gets
/// them.
#[tauri::command]
pub async fn vercel_get_project(state: State<'_, AppState>) -> Result<Value, String> {
    let config = load_config(&state).await?;
    let cwd = git_cwd(&config);
    let context = require_context(&state.config_store, &config, &cwd).await?;
    let project_id = linked_project_id(&context.project)?;
    context
        .manager
        .get_project(&project_id)
        .await
        .map_err(|error| error.message)
}

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

/// Keys only — see `VercelManager::list_env`.
#[tauri::command]
pub async fn vercel_list_env(state: State<'_, AppState>) -> Result<Value, String> {
    let config = load_config(&state).await?;
    let cwd = git_cwd(&config);
    let context = require_context(&state.config_store, &config, &cwd).await?;
    let project_id = linked_project_id(&context.project)?;
    let env = context
        .manager
        .list_env(&project_id)
        .await
        .map_err(|error| error.message)?;
    Ok(Value::Array(env))
}

/// Reveal one variable's value — one key at a time, so putting a secret on the
/// wire is always a deliberate act. Not exposed to the agent surface.
#[tauri::command]
pub async fn vercel_env_value(state: State<'_, AppState>, id: String) -> Result<Value, String> {
    let config = load_config(&state).await?;
    let cwd = git_cwd(&config);
    let context = require_context(&state.config_store, &config, &cwd).await?;
    let project_id = linked_project_id(&context.project)?;
    let value = context
        .manager
        .env_value(&project_id, &id)
        .await
        .map_err(|error| error.message)?;
    Ok(serde_json::json!({ "value": value }))
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn vercel_list_domains(state: State<'_, AppState>) -> Result<Value, String> {
    let config = load_config(&state).await?;
    let cwd = git_cwd(&config);
    let context = require_context(&state.config_store, &config, &cwd).await?;
    let project_id = linked_project_id(&context.project)?;
    let domains = context
        .manager
        .list_domains(&project_id)
        .await
        .map_err(|error| error.message)?;
    Ok(Value::Array(domains))
}

/// The linked project's id, or the same refusal the Node routes give.
fn linked_project_id(project: &Option<Value>) -> Result<String, String> {
    project
        .as_ref()
        .and_then(|project| project.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "No Vercel project is linked to this repository.".to_string())
}

// ---------------------------------------------------------------------------
// Deployments
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn vercel_list_deployments(
    state: State<'_, AppState>,
    target: Option<String>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let config = load_config(&state).await?;
    let cwd = git_cwd(&config);
    let context = require_context(&state.config_store, &config, &cwd).await?;

    let Some(project) = context.project.clone() else {
        return Ok(serde_json::json!({ "deployments": [], "project": null }));
    };
    let project_id = project
        .get("id")
        .and_then(Value::as_str)
        .ok_or("The linked Vercel project has no id.")?;
    let target = target.filter(|value| value == "production" || value == "preview");

    let deployments = context
        .manager
        .list_deployments(project_id, target.as_deref(), limit.map(|n| n.min(100)))
        .await
        .map_err(|error| error.message)?;
    Ok(serde_json::json!({ "deployments": deployments, "project": project }))
}

#[tauri::command]
pub async fn vercel_get_deployment(
    state: State<'_, AppState>,
    id: String,
) -> Result<Value, String> {
    let config = load_config(&state).await?;
    let cwd = git_cwd(&config);
    let context = require_context(&state.config_store, &config, &cwd).await?;
    context
        .manager
        .get_deployment(&id)
        .await
        .map_err(|error| error.message)
}

#[tauri::command]
pub async fn vercel_deployment_logs(
    state: State<'_, AppState>,
    id: String,
    limit: Option<u32>,
) -> Result<Value, String> {
    let config = load_config(&state).await?;
    let cwd = git_cwd(&config);
    let context = require_context(&state.config_store, &config, &cwd).await?;
    let logs = context
        .manager
        .deployment_build_logs(&id, limit.map(|n| n.min(2_000)))
        .await
        .map_err(|error| error.message)?;
    Ok(Value::Array(logs))
}

/// Runtime logs, which answer a different question from the build logs above:
/// why a *deployed* request failed. Empty when the account's plan does not
/// serve them.
#[tauri::command]
pub async fn vercel_runtime_logs(
    state: State<'_, AppState>,
    id: String,
    limit: Option<u32>,
) -> Result<Value, String> {
    let config = load_config(&state).await?;
    let cwd = git_cwd(&config);
    let context = require_context(&state.config_store, &config, &cwd).await?;
    let logs = context
        .manager
        .deployment_runtime_logs(&id, limit.map(|n| n.min(1_000)))
        .await
        .map_err(|error| error.message)?;
    Ok(Value::Array(logs))
}

/// The write boundary's single door. Every deploy-changing operation arrives
/// here, named by `action`, so there is one place to audit what this
/// integration can change and one place a guard would go.
#[tauri::command]
pub async fn vercel_deployment_action(
    state: State<'_, AppState>,
    id: String,
    action: String,
) -> Result<Value, String> {
    let config = load_config(&state).await?;
    let cwd = git_cwd(&config);
    let context = require_context(&state.config_store, &config, &cwd).await?;
    let actions = require_actions(&state.config_store, &config).await?;

    let project_id = || -> Result<String, String> {
        context
            .project
            .as_ref()
            .and_then(|project| project.get("id").and_then(Value::as_str))
            .map(str::to_string)
            .ok_or_else(|| "No Vercel project is linked to this repository.".to_string())
    };

    match action.as_str() {
        "redeploy" => {
            // Read the original first: a redeploy has to inherit its name and
            // target, or a production retry silently comes back as a preview.
            let deployment = context
                .manager
                .get_deployment(&id)
                .await
                .map_err(|error| error.message)?;
            let name = deployment.get("name").and_then(Value::as_str).unwrap_or("");
            let uid = deployment.get("uid").and_then(Value::as_str).unwrap_or(&id);
            let target = deployment.get("target").and_then(Value::as_str);
            let created = actions
                .redeploy(uid, name, target)
                .await
                .map_err(|error| error.message)?;
            Ok(serde_json::json!({ "deployment": created }))
        }
        "cancel" => {
            actions.cancel(&id).await.map_err(|error| error.message)?;
            Ok(serde_json::json!({ "ok": true }))
        }
        "promote" => {
            actions
                .promote(&project_id()?, &id)
                .await
                .map_err(|error| error.message)?;
            Ok(serde_json::json!({ "ok": true }))
        }
        "rollback" => {
            actions
                .rollback(&project_id()?, &id, Some("Rolled back from NoMoreIDE"))
                .await
                .map_err(|error| error.message)?;
            Ok(serde_json::json!({ "ok": true }))
        }
        other => Err(format!("Unknown Vercel deployment action \"{other}\".")),
    }
}
