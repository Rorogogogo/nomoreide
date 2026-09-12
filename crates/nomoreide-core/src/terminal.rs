//! Daemon-owned PTY sessions: the terminal tabs the dashboard renders, the
//! agent sessions it launches, and moving one of those into macOS Terminal.app
//! and back.
//!
//! The PTY belongs to whichever process owns this manager and never moves.
//! *Presentation* is what moves — a session is either drawn in the dock or
//! relayed to an external terminal — which is why an agent can be handed to
//! Terminal.app without being restarted.

mod agent;
#[cfg(unix)]
pub mod attach;
#[cfg(unix)]
mod detection;
#[cfg(unix)]
mod external;
mod manager;
mod prompt;
mod service;
mod session;
mod spawn;
#[cfg(test)]
mod tests;

pub use agent::{
    agent_binary, default_terminal_shell, derive_agent_invocation, resolve_session_scope,
    AgentInvocation, SessionScope,
};
pub use manager::{TerminalManager, TerminalMirror};
pub use prompt::awaiting_choice;
pub use service::{resolve_service_terminal, service_terminal_env, ServiceTerminal};
pub use session::{
    encode_agent_prompt_paste, normalize_agent_label, normalize_session_label,
    TerminalPresentation, TerminalSession, MAX_AGENT_PROMPT_BYTES,
};
pub use spawn::TerminalSpawnSpec;

/// One-use credentials for a local terminal relay. Never broadcast these.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttachment {
    pub session: TerminalSession,
    pub socket_path: String,
    pub token: String,
}
