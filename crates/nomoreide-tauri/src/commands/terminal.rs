//! The desktop app's terminal commands.
//!
//! The PTY manager itself lives in `nomoreide_core::terminal`, which the daemon
//! shares. What stays here is the part that is genuinely Tauri's: resolving a
//! request against the app's own config and context library, and the
//! `#[tauri::command]` surface the frontend calls.

use crate::event_sink::tauri_event_sink;
use crate::AppState;
use nomoreide_core::agent_transcripts::{
    list_agent_transcripts as read_agent_transcripts, AgentTranscript, DEFAULT_TRANSCRIPT_LIMIT,
};
use nomoreide_core::context_library::{ContextAttachment, ContextLibrary};
use nomoreide_core::event_sink::emit_event;
use nomoreide_core::one_time_skills::{
    compose_one_time_skill_prompt, resolve_one_time_skill, OneTimeSkillSelection,
};
use nomoreide_core::terminal::{
    agent_binary, default_terminal_shell, derive_agent_invocation, normalize_agent_label,
    normalize_session_label, resolve_session_scope, TerminalSession, TerminalSpawnSpec,
};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fmt::Display;
use tauri::{AppHandle, State};
use uuid::Uuid;

/// The agent session the frontend asks for. The provider's argv is derived from
/// it; the caller never names a program.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTerminalRequest {
    provider: String,
    prompt: String,
    label: Option<String>,
    one_time_skill: Option<OneTimeSkillSelection>,
    resume_id: Option<String>,
    context: Option<ContextAttachment>,
}

/// An agent session must not start against a config that failed to load — its
/// prompt and its working directory both come from there. A plain shell falls
/// back to the current directory instead, which is what it did before there was
/// any config to read.
fn resolve_config_load<T, E: Display>(
    required: bool,
    result: Result<T, E>,
) -> Result<Option<T>, String> {
    if required {
        result.map(Some).map_err(|error| error.to_string())
    } else {
        Ok(result.ok())
    }
}

#[tauri::command]
pub async fn list_terminal_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<TerminalSession>, String> {
    Ok(state.terminal_manager.list_sessions())
}

#[tauri::command]
pub async fn list_agent_transcripts(
    state: State<'_, AppState>,
    scope: Option<String>,
) -> Result<Vec<AgentTranscript>, String> {
    let config = state
        .config_store
        .load()
        .await
        .map_err(|error| error.to_string())?;
    let repo_path = config
        .selected_git_repository
        .as_ref()
        .and_then(|selected| {
            config
                .git_repositories
                .iter()
                .find(|repo| &repo.name == selected)
        })
        .or_else(|| config.git_repositories.first())
        .map(|repo| {
            repo.active_worktree_path
                .clone()
                .unwrap_or_else(|| repo.path.clone())
        })
        .unwrap_or(
            std::env::current_dir()
                .map_err(|error| error.to_string())?
                .to_string_lossy()
                .into_owned(),
        );
    let home = dirs::home_dir().ok_or_else(|| "Home directory is unavailable".to_string())?;
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    tauri::async_runtime::spawn_blocking(move || {
        read_agent_transcripts(
            &home,
            &codex_home,
            (scope.as_deref() != Some("all")).then_some(repo_path.as_str()),
            DEFAULT_TRANSCRIPT_LIMIT,
        )
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn create_terminal_session(
    app: AppHandle,
    state: State<'_, AppState>,
    service_name: Option<String>,
    cwd: Option<String>,
    agent: Option<AgentTerminalRequest>,
) -> Result<TerminalSession, String> {
    let sink = tauri_event_sink(app);
    let is_agent = agent.is_some();
    let config = if is_agent || cwd.is_none() {
        resolve_config_load(is_agent, state.config_store.load().await)?
    } else {
        None
    };
    let configured_service_cwd = if is_agent {
        None
    } else {
        service_name.as_ref().and_then(|name| {
            config
                .as_ref()
                .and_then(|config| config.services.iter().find(|service| &service.name == name))
                .and_then(|service| service.cwd.clone())
        })
    };
    let workspace_cwd = if is_agent || service_name.is_none() {
        config.as_ref().and_then(|config| {
            config
                .selected_git_repository
                .as_ref()
                .and_then(|selected| {
                    config
                        .git_repositories
                        .iter()
                        .find(|repo| &repo.name == selected)
                })
                .or_else(|| config.git_repositories.first())
                .map(|repo| {
                    repo.active_worktree_path
                        .clone()
                        .unwrap_or_else(|| repo.path.clone())
                })
        })
    } else {
        None
    };
    let current_dir = std::env::current_dir()
        .map_err(|error| error.to_string())?
        .to_string_lossy()
        .into_owned();
    let scope = resolve_session_scope(
        is_agent,
        service_name,
        cwd,
        configured_service_cwd,
        workspace_cwd,
        current_dir,
    );
    let session_service_name = scope.service_name;

    let id = if is_agent {
        format!("agent:{}", Uuid::new_v4())
    } else {
        session_service_name
            .as_ref()
            .map(|name| format!("svc:{name}"))
            .unwrap_or_else(|| Uuid::new_v4().to_string())
    };

    let (shell, args, label, kind, provider) = if let Some(request) = &agent {
        if request.resume_id.is_some() && request.one_time_skill.is_some() {
            return Err("A temporary skill cannot be attached to a resumed session.".into());
        }
        let context_prompt = if let Some(attachment) = &request.context {
            let library = ContextLibrary::default();
            let notes = library.notes()?;
            let configured = config
                .as_ref()
                .ok_or_else(|| "Agent configuration is unavailable.".to_string())?;
            let items = crate::commands::context::all_context_items(configured, &notes).await?;
            library.assemble_prompt(&request.prompt, attachment, &items)?
        } else {
            request.prompt.clone()
        };
        let prompt = if let Some(selection) = &request.one_time_skill {
            let skill_prompt = resolve_one_time_skill(selection).await?;
            compose_one_time_skill_prompt(&skill_prompt, &context_prompt)?
        } else {
            context_prompt
        };
        let invocation = derive_agent_invocation(
            &request.provider,
            &prompt,
            request.resume_id.as_deref(),
            None,
            &agent_binary("NOMOREIDE_CLAUDE_BIN", "claude"),
            &agent_binary("NOMOREIDE_CODEX_BIN", "codex"),
        )?;
        (
            OsString::from(invocation.executable),
            invocation.args,
            Some(normalize_agent_label(
                &request.provider,
                request.label.as_deref(),
            )),
            Some("agent".to_string()),
            Some(request.provider.clone()),
        )
    } else {
        let kind = if session_service_name.is_some() {
            "service"
        } else {
            "shell"
        };
        (
            default_terminal_shell(),
            Vec::new(),
            session_service_name.clone(),
            Some(kind.to_string()),
            None,
        )
    };

    state.terminal_manager.create(
        sink,
        TerminalSpawnSpec {
            id,
            service_name: session_service_name,
            cwd: scope.work_dir,
            shell,
            args,
            env: Vec::new(),
            label,
            kind,
            provider,
        },
    )
}

#[tauri::command]
pub async fn rename_terminal_session(
    state: State<'_, AppState>,
    id: String,
    label: String,
) -> Result<TerminalSession, String> {
    state
        .terminal_manager
        .rename_session(&id, normalize_session_label(&label)?)
}

/// Flush buffered startup output and switch the session to live emission. The
/// frontend calls this once its listener is attached.
#[tauri::command]
pub async fn start_terminal_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let sink = tauri_event_sink(app);
    if let Some(pending) = state.terminal_manager.take_pending_output(&id) {
        if !pending.is_empty() {
            let data = String::from_utf8_lossy(&pending).into_owned();
            let _ = emit_event(sink.as_ref(), &format!("terminal-output-{id}"), data);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn write_terminal_input(
    state: State<'_, AppState>,
    id: String,
    data: String,
) -> Result<(), String> {
    state.terminal_manager.write_input(&id, data.as_bytes())
}

#[tauri::command]
pub async fn resize_terminal(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.terminal_manager.resize(&id, cols, rows)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCapabilities {
    external_terminal: bool,
}

#[tauri::command]
pub async fn get_terminal_capabilities() -> TerminalCapabilities {
    TerminalCapabilities {
        external_terminal: cfg!(target_os = "macos"),
    }
}

#[tauri::command]
pub async fn open_terminal_in_system_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<TerminalSession, String> {
    state
        .terminal_manager
        .open_in_terminal(tauri_event_sink(app), &id)
}

#[tauri::command]
pub async fn reclaim_terminal_to_dock(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<TerminalSession, String> {
    let sink = tauri_event_sink(app);
    state.terminal_manager.reclaim_to_dock(sink.as_ref(), &id)
}

#[tauri::command]
pub async fn insert_agent_prompt(
    state: State<'_, AppState>,
    id: String,
    prompt: String,
) -> Result<TerminalSession, String> {
    let manager = state.terminal_manager.clone();
    tauri::async_runtime::spawn_blocking(move || manager.insert_agent_prompt(&id, &prompt))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn close_terminal_session(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.terminal_manager.close_session(&id)
}

#[cfg(test)]
mod tests {
    use super::resolve_config_load;

    #[test]
    fn agent_config_load_errors_are_propagated() {
        let result = resolve_config_load::<(), _>(true, Err("config unavailable"));

        assert_eq!(result.unwrap_err(), "config unavailable");
    }

    #[test]
    fn legacy_non_agent_config_load_errors_remain_best_effort() {
        let result = resolve_config_load::<(), _>(false, Err("config unavailable"));

        assert_eq!(result.unwrap(), None);
    }
}
