//! What the coding agents on this machine are configured with.
//!
//! Five agents are known — Claude Code, Codex, Antigravity, Cursor, and
//! Windsurf — and this
//! module answers three questions about each: whether its CLI is installed,
//! what MCP servers and skills it is configured with, and whether that setup
//! looks broken. Everything here reads; nothing writes.
//!
//! The agents are deliberately *not* handled uniformly, because they are
//! not uniform. Each stores its servers in a different file, in a different
//! format, under different rules for what a remote server's transport is; the
//! differences are spelled out on [`Reader`] rather than smoothed away, since
//! smoothing them away is exactly how this drifts from what the agents do.

mod availability;
mod backup;
mod changes;
mod documents;
mod ordered;
mod plugins;
mod readers;
mod skills;
mod spec;
mod store;
mod writers;

pub(crate) use backup::copy_tree;
pub use changes::{
    apply as apply_changes, preview as preview_changes, Action, Category, ChangePreview,
    PendingChange,
};
pub use ordered::{Json, OrderedMap};
pub use spec::{Scope, ServerSpec};
pub use writers::SnapshotOutcome;
pub use writers::{
    add_mcp, move_mcp_scope, move_skill_scope, remove_mcp, snapshot_agent, AddOutcome, ChangeReport,
};

use serde::Serialize;
use std::path::{Path, PathBuf};

/// The agents this knows about, in the order every answer reports them.
pub const AGENTS: [Agent; 5] = [
    Agent::Claude,
    Agent::Codex,
    Agent::Antigravity,
    Agent::Cursor,
    Agent::Windsurf,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Agent {
    Claude,
    Codex,
    Antigravity,
    Cursor,
    Windsurf,
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
    /// `~/.cursor/mcp.json`: JSON, `url` is streamable HTTP, headers kept.
    CursorJson,
    /// `~/.codeium/windsurf/mcp_config.json`: JSON, `serverUrl` preferred over
    /// `url`, both streamable HTTP, headers kept.
    WindsurfJson,
    /// Not an agent's format at all: the project-scope store this program
    /// keeps for the agents that have nowhere of their own to record one.
    /// It spells the transport out in a `transport` key, because nothing here
    /// has to guess what an agent would have meant.
    ProjectStore,
}

impl Agent {
    pub fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Antigravity => "antigravity",
            Self::Cursor => "cursor",
            Self::Windsurf => "windsurf",
        }
    }

    /// The executable a user would type. It is also what PATH is searched for.
    pub fn command(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Antigravity => "antigravity",
            Self::Cursor => "cursor",
            Self::Windsurf => "windsurf",
        }
    }

    pub(crate) fn reader(self) -> Reader {
        match self {
            Self::Claude => Reader::ClaudeJson,
            Self::Codex => Reader::CodexToml,
            Self::Antigravity => Reader::AntigravityJson,
            Self::Cursor => Reader::CursorJson,
            Self::Windsurf => Reader::WindsurfJson,
        }
    }

    /// Where its config lives, relative to the user's home directory.
    fn config_relative_path(self) -> &'static str {
        match self {
            Self::Claude => ".claude.json",
            Self::Codex => ".codex/config.toml",
            Self::Antigravity => ".gemini/antigravity-cli/mcp_config.json",
            Self::Cursor => ".cursor/mcp.json",
            Self::Windsurf => ".codeium/windsurf/mcp_config.json",
        }
    }

    pub fn config_path(self, home: &Path) -> PathBuf {
        home.join(self.config_relative_path())
    }

    /// Where a skill installed for this agent goes: the first of its user
    /// directories, which for Codex is the portable one.
    pub(super) fn user_skills_directory(self, home: &Path) -> Option<PathBuf> {
        self.user_skills_relative_paths()
            .first()
            .map(|relative| home.join(relative))
    }

    /// Where an *install* puts a user-scope skill. Every agent has one, so
    /// this cannot fail the way the project-scope question can.
    pub(super) fn install_skills_directory(self, home: &Path) -> PathBuf {
        self.user_skills_directory(home)
            .unwrap_or_else(|| home.join(".claude").join("skills"))
    }

    /// Where a named skill already is, among this agent's user directories.
    ///
    /// Reading and writing are not symmetric for Codex: a skill is installed
    /// into the first directory but may be found in either, so anything acting
    /// on an existing skill has to look in both.
    pub(super) fn installed_user_skill(self, home: &Path, name: &str) -> Option<PathBuf> {
        self.user_skills_relative_paths()
            .iter()
            .map(|relative| home.join(relative).join(name))
            .find(|candidate| candidate.is_dir())
    }

    /// Where a *write* puts a project-scoped skill: in the project itself,
    /// not wherever a read might have walked up to.
    pub(super) fn project_skills_directory(self, project: &Path) -> Option<PathBuf> {
        self.project_skills_relative_path()
            .map(|relative| project.join(relative))
    }

    /// The skills directories in the user's home, in the order a listing
    /// reports them.
    ///
    /// Codex has two: the portable `~/.agents/skills`, which is also where a
    /// skill installed *into* Codex goes, and its own `~/.codex/skills`. Both
    /// are user scope, listed in that order with each sorted on its own — so
    /// the combined listing is not sorted overall.
    fn user_skills_relative_paths(self) -> &'static [&'static str] {
        match self {
            Self::Claude => &[".claude/skills"],
            Self::Codex => &[".agents/skills", ".codex/skills"],
            Self::Antigravity => &[".gemini/skills"],
            Self::Cursor => &[".cursor/skills"],
            // Its own directory only. `~/.agents/skills` is the portable
            // directory *Codex* installs into, and Windsurf does not read it —
            // listing it here made `setup windsurf` find Codex's copy, report
            // "skill identical" and write nothing where Windsurf would look.
            // `--setup auto` runs codex before windsurf, so that was the
            // common path rather than a corner case.
            Self::Windsurf => &[".codeium/windsurf/skills"],
        }
    }

    /// The skills directory looked for in a project. Claude and Codex disagree
    /// on where it lives, which is why this is not one constant.
    fn project_skills_relative_path(self) -> Option<&'static str> {
        match self {
            Self::Claude => Some(".claude/skills"),
            Self::Codex => Some(".agents/skills"),
            Self::Antigravity => None,
            Self::Cursor => Some(".cursor/skills"),
            Self::Windsurf => Some(".windsurf/skills"),
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
    /// Where it came from: `local` for a skill someone put in a directory, the
    /// marketplace for a plugin. Absent when a plugin's record does not say.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub kind: &'static str,
    pub scope: &'static str,
    /// Absent when a plugin is recorded as installed but its record carries no
    /// path — it is still installed, and still worth reporting.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_path: Option<String>,
    /// The four below describe a *plugin* and are absent on a skill. The skills
    /// list is present even when empty, which is what tells the two apart.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_skills: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_mcps: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_agents: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_commands: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigView {
    pub agent: &'static str,
    pub config_path: String,
    /// Whether the agent has a config here *that could be read*. Only the
    /// Claude's reader lets a parse failure clear this; the others report a
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

/// Where [`install_user_skill`] would put a skill of this name.
///
/// Exposed so that callers which have to *find* an installed skill ask the
/// same question the installer answers, rather than rebuilding the path and
/// getting a subtly different one.
pub fn install_skill_destination(agent: Agent, name: &str) -> PathBuf {
    agent.install_skills_directory(&home()).join(name)
}

/// Put a skill into an agent's own user-scope skills directory, replacing
/// whatever was installed under that name.
///
/// An agent with no skills directory of its own — Antigravity — has nowhere
/// for one to go, and says so rather than writing somewhere it invented.
pub fn install_user_skill(
    agent: Agent,
    name: &str,
    source: &Path,
) -> Result<Option<PathBuf>, String> {
    let directory = install_skill_destination(agent, name);
    // Whatever is being replaced is copied aside first. Unlike a *copy* between
    // agents, which keeps nothing because the two are the same skill under the
    // same name, an install overwrites a skill the user may have edited in
    // place, and that version exists nowhere else.
    let taken = if directory.is_dir() {
        Some(backup::directory(&directory, name)?)
    } else {
        None
    };
    // Replaced rather than merged: a skill is the directory, and leaving files
    // from an older version beside the new ones would make it neither.
    std::fs::remove_dir_all(&directory).ok();
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create {}: {error}", directory.display()))?;
    copy_tree(source, &directory)?;
    Ok(taken)
}

/// Move a skill's directory into the backup store and return where it went.
///
/// Public because `nomoreide setup` clears a stale copy of its own skill out
/// of Codex's second skills directory, and a backup written somewhere else
/// would be a second place to look for the same kind of thing.
pub fn backup_skill_directory(source: &Path, name: &str) -> Result<PathBuf, String> {
    backup::directory(source, name)
}

/// Copy a file beside itself before something replaces it.
///
/// Exposed because the settings editor backs up a file this module does not
/// otherwise own, and a second implementation of the naming rule would be a
/// second set of backups nobody thinks to look in.
pub fn backup_config_file(path: &Path) -> Result<Option<PathBuf>, String> {
    backup::file(path)
}

pub(crate) fn home() -> PathBuf {
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
            ["claude", "codex", "antigravity", "cursor", "windsurf"]
        );
        assert_eq!(
            status().iter().map(|entry| entry.agent).collect::<Vec<_>>(),
            ["claude", "codex", "antigravity", "cursor", "windsurf"]
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
    fn codex_keeps_user_skills_in_two_places_and_installs_into_the_first() {
        // The portable directory comes first, and is the one a write targets;
        // Codex's own is still read, after it.
        assert_eq!(
            Agent::Codex.user_skills_relative_paths(),
            [".agents/skills", ".codex/skills"]
        );
        assert_eq!(
            Agent::Codex.user_skills_directory(Path::new("/h")),
            Some(PathBuf::from("/h/.agents/skills"))
        );
        assert_eq!(
            Agent::Claude.user_skills_relative_paths(),
            [".claude/skills"]
        );
        // Antigravity reads one directory of its own, and installs into it.
        assert_eq!(
            Agent::Antigravity.user_skills_relative_paths(),
            [".gemini/skills"]
        );
        assert_eq!(
            Agent::Antigravity.user_skills_directory(Path::new("/h")),
            Some(PathBuf::from("/h/.gemini/skills"))
        );
        assert_eq!(
            Agent::Cursor.config_path(Path::new("/h")),
            PathBuf::from("/h/.cursor/mcp.json")
        );
        assert_eq!(
            Agent::Windsurf.config_path(Path::new("/h")),
            PathBuf::from("/h/.codeium/windsurf/mcp_config.json")
        );
        assert_eq!(
            Agent::Windsurf.user_skills_relative_paths(),
            // Not Codex's portable root: sharing it made an install a no-op.
            [".codeium/windsurf/skills"]
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
        assert_eq!(
            Agent::Cursor.project_skills_relative_path(),
            Some(".cursor/skills")
        );
        assert_eq!(
            Agent::Windsurf.project_skills_relative_path(),
            Some(".windsurf/skills")
        );
    }

    #[test]
    fn every_agent_id_parses_back_to_the_same_agent() {
        for agent in AGENTS {
            assert_eq!(Agent::parse(agent.id()), Some(agent));
            assert!(!agent.display_name().is_empty());
            assert!(!agent.command().is_empty());
        }
        assert_eq!(Agent::parse("Cursor"), None);
    }
}
