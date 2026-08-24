//! What a terminal session is on the wire, and the small rules about its
//! fields: the label it may carry, and the prompt an agent session may be
//! handed.
//!
//! Lifted from the desktop app, which owned the only PTY implementation in the
//! tree. The daemon needs the same sessions, so the type moved to where both
//! can reach it rather than being written a second time.

use portable_pty::CommandBuilder;
use serde::{Deserialize, Serialize};

/// The largest prompt an agent session will accept in one paste.
pub const MAX_AGENT_PROMPT_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub id: String,
    pub service_name: Option<String>,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub shell: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// How the child ended, once it has. Absent while it is still running.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit: Option<TerminalExit>,
    /// Why the session could not be run at all — a spawn that never produced a
    /// child. Distinct from `exit`, which reports a child that ran.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub presentation: TerminalPresentation,
}

/// What a terminal's child process ended with.
///
/// `signal` is a number rather than a name because that is what a caller
/// compares against: zero for a process that returned on its own, and the
/// signal number for one that was killed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExit {
    pub exit_code: u32,
    pub signal: u32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalPresentation {
    #[default]
    Dock,
    TerminalLaunching,
    Terminal,
}

pub fn encode_agent_prompt_paste(prompt: &str) -> Result<String, String> {
    if prompt.is_empty() {
        return Err("Agent prompt must not be empty.".to_string());
    }
    if prompt.len() > MAX_AGENT_PROMPT_BYTES {
        return Err("Agent prompt is too large.".to_string());
    }
    let normalized = prompt.replace("\r\n", "\n");
    if normalized
        .chars()
        .any(|character| character.is_control() && character != '\n' && character != '\t')
    {
        return Err("Agent prompt contains unsupported terminal control characters.".to_string());
    }
    Ok(format!(
        "\u{1b}[200~{}\u{1b}[201~",
        normalized.replace('\n', "\r")
    ))
}

pub fn validate_agent_prompt_target(session: &TerminalSession) -> Result<(), String> {
    if session.kind.as_deref() != Some("agent") {
        return Err("Only agent sessions can receive a prompt.".to_string());
    }
    if session.state != "running" {
        return Err("Only a running agent session can receive a prompt.".to_string());
    }
    if session.presentation == TerminalPresentation::TerminalLaunching {
        return Err("An agent prompt cannot be inserted while Terminal is opening.".to_string());
    }
    Ok(())
}

pub fn normalize_agent_label(provider: &str, label: Option<&str>) -> String {
    let requested = label.map(str::trim).filter(|label| !label.is_empty());
    let fallback = if provider == "codex" {
        "Codex task"
    } else {
        "Claude task"
    };
    requested.unwrap_or(fallback).chars().take(60).collect()
}

pub fn normalize_session_label(label: &str) -> Result<String, String> {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return Err("Terminal session label must not be empty".to_string());
    }
    if trimmed.encode_utf16().count() > 60 {
        return Err("Terminal session label must be at most 60 characters".to_string());
    }
    Ok(trimmed.to_string())
}

pub fn configure_interactive_terminal_environment(
    command: &mut CommandBuilder,
    provider: Option<&str>,
) {
    command.env_remove("NO_COLOR");
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    if provider == Some("codex") {
        command.env("FORCE_COLOR", "1");
    }
}
