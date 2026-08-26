//! Agent change-sets: what an agent session touched, pinned to the snapshot
//! taken before its first tool call.
//!
//! The MCP recording wrapper writes these; nothing here does. That asymmetry is
//! why the store is read fresh on every call rather than cached: the writer is
//! usually a *different process* — an agent's MCP adapter — and the dashboard
//! has to see a session it did not record.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: String,
    /// Repository the session's snapshot was taken in, which need not be the
    /// one currently selected — a restore has to run where the work happened.
    pub repo_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_sha: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_ref: Option<String>,
    pub started_at: String,
    pub last_tool_at: String,
    pub tool_count: u64,
}

/// Where the daemon keeps them, beside its logs.
pub fn default_store_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".nomoreide")
        .join("agent-sessions.json")
}

/// Every recorded session, newest first — which is the order they were written
/// in, not one this imposes.
///
/// **Anything unreadable is an empty list, never an error.** A store that does
/// not exist yet, holds invalid JSON, or holds something that is not an array
/// all mean the same thing to a caller: no sessions have been recorded. The
/// reference swallows the failure in a `catch`, and a dashboard panel that
/// showed a parse error instead of an empty list would be reporting on the file
/// rather than on the work.
pub fn list_agent_sessions(path: &Path) -> Vec<AgentSession> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn find_agent_session(path: &Path, id: &str) -> Option<AgentSession> {
    list_agent_sessions(path)
        .into_iter()
        .find(|session| session.id == id)
}
