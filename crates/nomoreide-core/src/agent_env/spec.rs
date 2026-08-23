//! One MCP server, in a form no agent owns.
//!
//! The three config formats spell the same server three different ways, and a
//! *move* has to read it out of one and write it into another. Everything in
//! between is expressed here, so neither side has to know the other's spelling.

use super::ordered::Json;
use super::{Agent, AgentConfigView, OrderedMap, RemoteServer, StdioServer};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    User,
    Project,
}

impl Scope {
    pub fn id(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Project => "project",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "user" => Some(Self::User),
            "project" => Some(Self::Project),
            _ => None,
        }
    }
}

impl Agent {
    /// What the agent is called in a sentence a person reads.
    pub fn display_name(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex CLI",
            Self::Antigravity => "Antigravity",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "antigravity" => Some(Self::Antigravity),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ServerSpec {
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: Option<OrderedMap<Json>>,
    pub url: Option<String>,
    /// `http` or `sse`, as the caller asked or as the source file implied.
    pub transport: Option<String>,
}

impl ServerSpec {
    pub fn is_remote(&self) -> bool {
        self.command.as_deref().unwrap_or_default().is_empty()
            && !self.url.as_deref().unwrap_or_default().is_empty()
    }

    /// `sse` only when it was asked for; everything else is HTTP.
    pub fn is_sse(&self) -> bool {
        self.transport.as_deref() == Some("sse")
    }

    /// The server `key` holds in one of a listing's two maps, read back as
    /// something that can be written into a different agent's format.
    ///
    /// A listing is what a *reader* already produced, so a move carries across
    /// exactly what the listing showed — no second parse of the same file, and
    /// no chance of the two disagreeing.
    pub fn from_view(view: &AgentConfigView, scope: Scope, key: &str) -> Option<Self> {
        let (stdio, remote) = match scope {
            Scope::User => (&view.mcp_servers, &view.remote_mcp_servers),
            Scope::Project => (&view.project_mcp_servers, &view.project_remote_mcp_servers),
        };
        if let Some(server) = stdio.get(key) {
            return Some(Self::from_stdio(server));
        }
        remote.get(key).map(Self::from_remote)
    }

    fn from_stdio(server: &StdioServer) -> Self {
        Self {
            command: Some(server.command.clone()),
            args: server.args.clone().unwrap_or_default(),
            env: server.env.as_ref().map(json_values),
            ..Self::default()
        }
    }

    fn from_remote(server: &RemoteServer) -> Self {
        Self {
            url: Some(server.url.clone()),
            transport: Some(server.transport.to_string()),
            ..Self::default()
        }
    }
}

/// `serde_json::Value` entries as ordered JSON, so an env map written back out
/// keeps the order the file it came from had.
fn json_values(map: &OrderedMap<serde_json::Value>) -> OrderedMap<Json> {
    let mut out = OrderedMap::new();
    for (key, value) in map.iter() {
        out.insert(
            key.to_string(),
            serde_json::from_value(value.clone()).unwrap_or(Json::Null),
        );
    }
    out
}
