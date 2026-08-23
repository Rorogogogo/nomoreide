//! What the coding agents on this machine are configured with.
//!
//! Three agents are known — Claude Code, Codex, and Antigravity — and this
//! module answers three questions about each: whether its CLI is installed,
//! what MCP servers and skills it is configured with, and whether that setup
//! looks broken. Everything here reads; nothing writes.
//!
//! The three agents are deliberately *not* handled uniformly, because they are
//! not uniform. Each stores its servers in a different file, in a different
//! format, under different rules for what a remote server's transport is; the
//! differences are spelled out on [`Reader`] rather than smoothed away, since
//! smoothing them away is exactly how this drifts from what the agents do.

mod availability;
mod ordered;
mod readers;
mod skills;

pub use ordered::OrderedMap;

use serde::Serialize;
use std::path::{Path, PathBuf};

/// The agents this knows about, in the order every answer reports them.
pub const AGENTS: [Agent; 3] = [Agent::Claude, Agent::Codex, Agent::Antigravity];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Agent {
    Claude,
    Codex,
    Antigravity,
}

/// How an agent's config file is written, and what that format implies.
///
/// The transport rules are the sharp edge: only Claude reads a remote server's
/// declared `type`. Codex reports every remote server as `http` however the
/// file spells it, and Antigravity reports every one as `sse` — so a `type`
/// key in either of those files is read and then ignored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Reader {
    /// `~/.claude.json`: JSON, per-server `type` honoured (default `http`),
    /// `headers` kept, and project scope read from its own `projects` map.
    /// The only reader that reports a config it cannot parse as absent.
    ClaudeJson,
    /// `~/.codex/config.toml`: TOML, every remote server `http`, `headers`
    /// dropped, no project scope.
    CodexToml,
    /// Antigravity's JSON: every remote server `sse`, `headers` kept, no
    /// project scope.
    AntigravityJson,
}

impl Agent {
    pub fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Antigravity => "antigravity",
        }
    }

    /// The executable a user would type. It is also what PATH is searched for.
    pub fn command(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Antigravity => "antigravity",
        }
    }

    pub(crate) fn reader(self) -> Reader {
        match self {
            Self::Claude => Reader::ClaudeJson,
            Self::Codex => Reader::CodexToml,
            Self::Antigravity => Reader::AntigravityJson,
        }
    }

    /// Where its config lives, relative to the user's home directory.
    fn config_relative_path(self) -> &'static str {
        match self {
            Self::Claude => ".claude.json",
            Self::Codex => ".codex/config.toml",
            Self::Antigravity => ".gemini/antigravity-cli/mcp_config.json",
        }
    }

    pub fn config_path(self, home: &Path) -> PathBuf {
        home.join(self.config_relative_path())
    }

    /// The skills directory in the user's home, for the agents that have one.
    fn user_skills_relative_path(self) -> Option<&'static str> {
        match self {
            Self::Claude => Some(".claude/skills"),
            Self::Codex => Some(".codex/skills"),
            // Antigravity has no skills of its own to find.
            Self::Antigravity => None,
        }
    }

    /// The skills directory looked for in a project. Claude and Codex disagree
    /// on where it lives, which is why this is not one constant.
    fn project_skills_relative_path(self) -> Option<&'static str> {
        match self {
            Self::Claude => Some(".claude/skills"),
            Self::Codex => Some(".agents/skills"),
            Self::Antigravity => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub agent: &'static str,
    pub command: &'static str,
    pub available: bool,
    /// Absent rather than null when the command is not installed: a path that
    /// does not exist has no spelling to report.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StdioServer {
    /// Empty when the entry declared neither a command nor a usable URL. Such
    /// an entry is still reported rather than dropped, so a user who mistyped
    /// one can see it in the listing instead of wondering where it went.
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<OrderedMap<serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteServer {
    pub transport: &'static str,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<OrderedMap<serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    pub name: String,
    pub source: &'static str,
    pub kind: &'static str,
    pub scope: &'static str,
    pub install_path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigView {
    pub agent: &'static str,
    pub config_path: String,
    /// Whether the agent has a config here *that could be read*. Only the
    /// Claude reader lets a parse failure clear this; the other two report a
    /// file they could not parse as present but empty.
    pub exists: bool,
    pub mcp_servers: OrderedMap<StdioServer>,
    pub remote_mcp_servers: OrderedMap<RemoteServer>,
    pub project_mcp_servers: OrderedMap<StdioServer>,
    pub project_remote_mcp_servers: OrderedMap<RemoteServer>,
    pub skills: Vec<SkillEntry>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DoctorCheck {
    pub label: &'static str,
    pub status: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub checks: Vec<DoctorCheck>,
    pub has_issues: bool,
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// Which agent CLIs are installed, in the fixed agent order.
pub fn status() -> Vec<AgentStatus> {
    AGENTS
        .iter()
        .map(|agent| {
            let resolved = availability::on_path(agent.command());
            AgentStatus {
                agent: agent.id(),
                command: agent.command(),
                available: resolved.is_some(),
                resolved_path: resolved.map(|path| path.to_string_lossy().into_owned()),
            }
        })
        .collect()
}

/// Every agent's MCP servers and skills. `cwd` is the project directory that
/// project scope is resolved against; absent, it is this process's own.
pub fn read_configs(cwd: Option<&Path>) -> Vec<AgentConfigView> {
    let home = home();
    let cwd = project_directory(cwd);
    AGENTS
        .iter()
        .map(|agent| readers::read(*agent, &home, &cwd))
        .collect()
}

/// The same two facts `status` and `read_configs` answer, restated as checks:
/// every agent's CLI first, then every agent's config file.
pub fn doctor(cwd: Option<&Path>) -> DoctorReport {
    let home = home();
    let cwd = project_directory(cwd);
    let mut checks = Vec::with_capacity(AGENTS.len() * 2);
    for agent in AGENTS {
        checks.push(match availability::on_path(agent.command()) {
            Some(path) => DoctorCheck {
                label: "Agent CLI",
                status: "ok",
                message: format!("{} is available ({})", agent.id(), path.display()),
            },
            None => DoctorCheck {
                label: "Agent CLI",
                status: "warn",
                message: format!("{} is not available on PATH", agent.id()),
            },
        });
    }
    for agent in AGENTS {
        // Asked of the reader rather than of the filesystem, so "no config"
        // means the same thing here as it does in a listing.
        let view = readers::read(agent, &home, &cwd);
        checks.push(if view.exists {
            DoctorCheck {
                label: "Config file",
                status: "ok",
                message: format!("{} config found at {}", agent.id(), view.config_path),
            }
        } else {
            DoctorCheck {
                label: "Config file",
                status: "warn",
                message: format!("{} has no config at {}", agent.id(), view.config_path),
            }
        });
    }
    let has_issues = checks.iter().any(|check| check.status != "ok");
    DoctorReport { checks, has_issues }
}

fn project_directory(cwd: Option<&Path>) -> PathBuf {
    cwd.map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_agent_is_reported_in_the_same_fixed_order() {
        assert_eq!(
            AGENTS.iter().map(|agent| agent.id()).collect::<Vec<_>>(),
            ["claude", "codex", "antigravity"]
        );
        assert_eq!(
            status().iter().map(|entry| entry.agent).collect::<Vec<_>>(),
            ["claude", "codex", "antigravity"]
        );
    }

    #[test]
    fn a_status_with_no_path_reports_no_path_at_all() {
        let absent = AgentStatus {
            agent: "antigravity",
            command: "antigravity",
            available: false,
            resolved_path: None,
        };
        assert_eq!(
            serde_json::to_string(&absent).unwrap(),
            r#"{"agent":"antigravity","command":"antigravity","available":false}"#
        );
    }

    #[test]
    fn the_two_project_skill_directories_differ() {
        assert_eq!(
            Agent::Claude.project_skills_relative_path(),
            Some(".claude/skills")
        );
        assert_eq!(
            Agent::Codex.project_skills_relative_path(),
            Some(".agents/skills")
        );
        assert_eq!(Agent::Antigravity.project_skills_relative_path(), None);
    }
}
