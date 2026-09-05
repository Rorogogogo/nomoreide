//! Agent change-sets: what an agent session touched, pinned to the snapshot
//! taken before its first tool call.
//!
//! The daemon records dock sessions and other runtimes may record MCP sessions.
//! The store is therefore read fresh on every call rather than cached: a writer
//! may be a *different process*, and the dashboard has to see work it did not
//! record itself.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: String,
    /// Human-readable task name, normally derived from the first prompt line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
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

/// How many sessions the store keeps. Past this the oldest is dropped: the
/// change-set panel is a view of recent work, and a session whose snapshot has
/// long since been pruned has nothing left to restore.
const MAX_SESSIONS: usize = 50;

/// Record a session, newest first, replacing any earlier one with the same id.
///
/// Rewrites the whole file rather than appending because the order is the
/// content: the dashboard reads the list as it stands, and an append-only log
/// would need a reader that knew to fold it.
pub fn save_agent_session(path: &Path, session: AgentSession) -> std::io::Result<()> {
    let mut sessions = list_agent_sessions(path);
    sessions.retain(|existing| existing.id != session.id);
    sessions.insert(0, session);
    sessions.truncate(MAX_SESSIONS);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let rendered = serde_json::to_string_pretty(&sessions)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    std::fs::write(path, format!("{rendered}\n"))
}
