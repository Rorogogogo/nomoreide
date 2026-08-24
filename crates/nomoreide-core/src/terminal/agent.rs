//! Which program an agent terminal runs, and where a session's working
//! directory comes from.
//!
//! Both CLIs take a positional first prompt and queue it themselves until their
//! TUI is ready, so the prompt is an argv entry rather than keystrokes injected
//! after spawn — injecting raced the TUI's own startup and the paste was
//! silently dropped.

use std::ffi::OsString;

#[cfg(target_os = "macos")]
use crate::process_manager::service_path;

#[derive(Debug, PartialEq)]
pub struct AgentInvocation {
    pub executable: String,
    pub args: Vec<String>,
}

/// A session id and a model name are both spawned as their own argv entries, so
/// the hazard is not injection but a value starting with `-` that the CLI reads
/// as a flag. Both providers issue UUIDs for sessions, so anything else is
/// refused outright; a model name only has its leading character constrained,
/// because aliases (`opus`), dated ids (`claude-haiku-4-5-20251001`) and
/// namespaced ids (`openai/gpt-5`) all have to pass.
fn is_session_id(value: &str) -> bool {
    (8..=64).contains(&value.len())
        && value
            .chars()
            .all(|character| character.is_ascii_hexdigit() || character == '-')
}

fn is_model_name(value: &str) -> bool {
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && value.len() <= 64
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '/' | '-')
        })
}

pub fn derive_agent_invocation(
    provider: &str,
    prompt: &str,
    resume_id: Option<&str>,
    model: Option<&str>,
    claude_bin: &str,
    codex_bin: &str,
) -> Result<AgentInvocation, String> {
    if let Some(id) = resume_id {
        if !is_session_id(id) {
            return Err(format!("Invalid session id: {id}"));
        }
    }
    if let Some(model) = model {
        if !is_model_name(model) {
            return Err(format!("Invalid model name: {model}"));
        }
    }

    // Both CLIs accept a positional initial prompt and queue it until the TUI
    // is ready — far more reliable than injecting keystrokes after spawn. A
    // blank prompt simply opens the provider's interactive TUI, and a resumed
    // session carries its own history, so an empty prompt is never forwarded as
    // an empty positional argument.
    match provider {
        "claude" => {
            let mut args = Vec::new();
            if let Some(model) = model {
                args.extend(["--model".to_string(), model.to_string()]);
            }
            if let Some(id) = resume_id {
                args.extend(["--resume".to_string(), id.to_string()]);
            }
            if !prompt.trim().is_empty() {
                args.push(prompt.to_string());
            }
            Ok(AgentInvocation {
                executable: claude_bin.to_string(),
                args,
            })
        }
        "codex" => {
            let mut args = vec!["--no-alt-screen".to_string()];
            // `-m` is a global option, so it has to precede the `resume`
            // subcommand rather than follow it.
            if let Some(model) = model {
                args.extend(["-m".to_string(), model.to_string()]);
            }
            if let Some(id) = resume_id {
                args.extend(["resume".to_string(), id.to_string()]);
            }
            if !prompt.trim().is_empty() {
                args.push(prompt.to_string());
            }
            Ok(AgentInvocation {
                executable: codex_bin.to_string(),
                args,
            })
        }
        _ => Err(format!("Unsupported agent provider: {provider}")),
    }
}

pub fn agent_binary(env_name: &str, default: &str) -> String {
    std::env::var(env_name)
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default.to_string())
}

#[cfg(unix)]
pub fn default_terminal_shell_from(shell: Option<OsString>) -> OsString {
    shell
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| OsString::from("/bin/sh"))
}

#[cfg(windows)]
pub fn default_terminal_shell_from(comspec: Option<OsString>) -> OsString {
    comspec
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| OsString::from("cmd.exe"))
}

#[cfg(unix)]
pub fn default_terminal_shell() -> OsString {
    default_terminal_shell_from(std::env::var_os("SHELL"))
}

#[cfg(windows)]
pub fn default_terminal_shell() -> OsString {
    default_terminal_shell_from(std::env::var_os("COMSPEC"))
}

#[cfg(target_os = "macos")]
pub fn agent_path_override() -> Option<OsString> {
    Some(OsString::from(service_path()))
}

#[cfg(not(target_os = "macos"))]
pub fn agent_path_override() -> Option<OsString> {
    None
}

#[derive(Debug, PartialEq)]
pub struct SessionScope {
    pub service_name: Option<String>,
    pub work_dir: String,
}

pub fn resolve_session_scope(
    is_agent: bool,
    supplied_service_name: Option<String>,
    supplied_cwd: Option<String>,
    configured_service_cwd: Option<String>,
    workspace_cwd: Option<String>,
    current_dir: String,
) -> SessionScope {
    if is_agent {
        return SessionScope {
            service_name: None,
            work_dir: workspace_cwd.unwrap_or(current_dir),
        };
    }

    SessionScope {
        service_name: supplied_service_name,
        work_dir: supplied_cwd
            .or(configured_service_cwd)
            .or(workspace_cwd)
            .unwrap_or(current_dir),
    }
}
