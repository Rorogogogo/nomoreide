//! Editing an agent's config file without rewriting the rest of it.
//!
//! These are files the user owns. A tool that adds one MCP server must leave
//! every other key, every other project, and — for Codex — every comment
//! exactly where it found them, so each format is edited in place rather than
//! re-serialised from a model of what this program happens to understand.
//!
//! The written shape of an entry is per-agent and is the other half of the
//! reading rules: Claude stamps a `type` on everything it writes, Codex omits
//! empty `args`, and Antigravity picks between `url` and `httpUrl` by the
//! transport asked for.

use super::ordered::{Json, OrderedMap};
use super::spec::ServerSpec;
use super::{Agent, Reader};
use std::path::Path;
use toml_edit::{Item, Table, Value as TomlValue};

pub(super) enum Document {
    Json(Json),
    Toml(Box<toml_edit::Document>),
}

impl Document {
    /// A file that is absent, or that will not parse, is edited as if it were
    /// empty — the backup taken first is what preserves whatever was there.
    pub(super) fn load(agent: Agent, path: &Path) -> Self {
        let text = std::fs::read_to_string(path).unwrap_or_default();
        match agent.reader() {
            Reader::CodexToml => Self::Toml(Box::new(text.parse().unwrap_or_default())),
            _ => Self::Json(
                serde_json::from_str::<Json>(&text)
                    .ok()
                    .filter(|document| document.as_object().is_some())
                    .unwrap_or_else(Json::object),
            ),
        }
    }

    pub(super) fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
        }
        let text = match self {
            Self::Json(document) => {
                let mut text = serde_json::to_string_pretty(document)
                    .map_err(|error| format!("Failed to render {}: {error}", path.display()))?;
                text.push('\n');
                text
            }
            Self::Toml(document) => document.to_string(),
        };
        std::fs::write(path, text)
            .map_err(|error| format!("Failed to write {}: {error}", path.display()))
    }

    /// The key an agent's own config files its servers under.
    fn servers_key(agent: Agent) -> &'static str {
        match agent.reader() {
            Reader::CodexToml => "mcp_servers",
            _ => "mcpServers",
        }
    }

    pub(super) fn set_user(&mut self, agent: Agent, key: &str, spec: &ServerSpec) {
        match self {
            Self::Json(document) => {
                document
                    .object_at(Self::servers_key(agent))
                    .set(key.to_string(), json_entry(agent, spec));
            }
            Self::Toml(document) => {
                let servers = toml_table(document.as_table_mut(), Self::servers_key(agent));
                servers.insert(key, Item::Table(toml_entry(spec)));
                settle_servers(document.as_table_mut(), Self::servers_key(agent));
            }
        }
    }

    pub(super) fn remove_user(&mut self, agent: Agent, key: &str) -> bool {
        match self {
            Self::Json(document) => document.object_at(Self::servers_key(agent)).remove(key),
            Self::Toml(document) => {
                let servers = toml_table(document.as_table_mut(), Self::servers_key(agent));
                let removed = servers.remove(key).is_some();
                settle_servers(document.as_table_mut(), Self::servers_key(agent));
                removed
            }
        }
    }

    /// Claude's per-project map, keyed by the project directory itself.
    pub(super) fn claude_project(&mut self, project: &str) -> &mut OrderedMap<Json> {
        let document = match self {
            Self::Json(document) => document,
            // Only Claude has project scope, and only Claude is JSON.
            Self::Toml(_) => unreachable!("Codex has no project map to edit"),
        };
        let projects = document.object_at("projects");
        if !matches!(projects.get(project), Some(Json::Object(_))) {
            projects.set(project.to_string(), Json::object());
        }
        projects
            .get_mut(project)
            .expect("just ensured the project is there")
            .object_at("mcpServers")
    }
}

/// Put the server table back the way a write leaves it: its entries in name
/// order, and the whole section after everything else in the file.
///
/// Neither is cosmetic. The reference rewrites this section wholesale on every
/// write, so a config it has touched has both properties — and a config this
/// port has touched has to be the same file, or the two diverge the moment a
/// user edits with one and reads with the other.
fn settle_servers(document: &mut Table, key: &str) {
    let Some(table) = document.get(key).and_then(Item::as_table).cloned() else {
        return;
    };
    let mut entries: Vec<(String, Item)> = table
        .iter()
        .map(|(name, item)| (name.to_string(), item.clone()))
        .collect();
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    document.remove(key);
    // Removed and re-inserted rather than sorted in place, which is also what
    // moves it to the end.
    let servers = toml_table(document, key);
    for (name, item) in entries {
        servers.insert(&name, item);
    }
}

/// Create `key` as a table if it is not one already, and hand it back.
fn toml_table<'a>(parent: &'a mut Table, key: &str) -> &'a mut Table {
    if !parent.get(key).is_some_and(Item::is_table) {
        let mut table = Table::new();
        // Written as `[mcp_servers.name]` rather than an empty `[mcp_servers]`
        // header of its own, which is how the agents' own files spell it.
        table.set_implicit(true);
        parent.insert(key, Item::Table(table));
    }
    parent
        .get_mut(key)
        .and_then(Item::as_table_mut)
        .expect("just ensured a table is there")
}

/// What Claude and Antigravity write for one server.
fn json_entry(agent: Agent, spec: &ServerSpec) -> Json {
    let mut entry = OrderedMap::new();
    let string = |value: &str| Json::String(value.to_string());
    if spec.is_remote() {
        let url = spec.url.clone().unwrap_or_default();
        match agent.reader() {
            // Claude records the transport it was asked for and reaches every
            // remote server through `url`.
            Reader::ClaudeJson => {
                entry.insert(
                    "type".to_string(),
                    string(if spec.is_sse() { "sse" } else { "http" }),
                );
                entry.insert("url".to_string(), string(&url));
            }
            // Antigravity has no transport field: which key holds the URL is
            // what says how to reach it.
            _ => {
                let key = if spec.is_sse() { "url" } else { "httpUrl" };
                entry.insert(key.to_string(), string(&url));
            }
        }
        return Json::Object(entry);
    }
    if matches!(agent.reader(), Reader::ClaudeJson) {
        entry.insert("type".to_string(), string("stdio"));
    }
    entry.insert(
        "command".to_string(),
        string(spec.command.as_deref().unwrap_or_default()),
    );
    entry.insert(
        "args".to_string(),
        Json::Array(spec.args.iter().map(|arg| string(arg)).collect()),
    );
    if let Some(env) = &spec.env {
        entry.insert("env".to_string(), Json::Object(env.clone()));
    }
    Json::Object(entry)
}

/// What Codex writes for one server. It has no transport and no `type`, and it
/// leaves out an empty `args` rather than writing it.
fn toml_entry(spec: &ServerSpec) -> Table {
    let mut table = Table::new();
    if spec.is_remote() {
        table.insert(
            "url",
            Item::Value(spec.url.clone().unwrap_or_default().into()),
        );
        return table;
    }
    table.insert(
        "command",
        Item::Value(spec.command.clone().unwrap_or_default().into()),
    );
    if !spec.args.is_empty() {
        let args: toml_edit::Array = spec.args.iter().collect();
        table.insert("args", Item::Value(TomlValue::Array(args)));
    }
    if let Some(env) = &spec.env {
        let mut values = Table::new();
        for (key, value) in env.iter() {
            let rendered = match value {
                Json::String(text) => text.clone(),
                other => serde_json::to_string(other).unwrap_or_default(),
            };
            values.insert(key, Item::Value(rendered.into()));
        }
        table.insert("env", Item::Table(values));
    }
    table
}

/// The neutral shape kept for an agent that has no project scope of its own.
pub(super) fn stored_entry(spec: &ServerSpec) -> Json {
    let mut entry = OrderedMap::new();
    let string = |value: &str| Json::String(value.to_string());
    if spec.is_remote() {
        entry.insert(
            "transport".to_string(),
            string(if spec.is_sse() { "sse" } else { "http" }),
        );
        entry.insert(
            "url".to_string(),
            string(spec.url.as_deref().unwrap_or_default()),
        );
        return Json::Object(entry);
    }
    entry.insert(
        "command".to_string(),
        string(spec.command.as_deref().unwrap_or_default()),
    );
    if !spec.args.is_empty() {
        entry.insert(
            "args".to_string(),
            Json::Array(spec.args.iter().map(|arg| string(arg)).collect()),
        );
    }
    if let Some(env) = &spec.env {
        entry.insert("env".to_string(), Json::Object(env.clone()));
    }
    Json::Object(entry)
}

/// What Claude writes inside its per-project map. The same shape as its
/// user-scope entries — the project map is still Claude's own file.
pub(super) fn project_entry(agent: Agent, spec: &ServerSpec) -> Json {
    json_entry(agent, spec)
}

/// Read a stored project entry back out. This is the shape [`stored_entry`]
/// wrote, so the two are each other's inverse.
pub(super) fn spec_from_stored(entry: &Json) -> ServerSpec {
    let map = match entry.as_object() {
        Some(map) => map,
        None => return ServerSpec::default(),
    };
    let text = |key: &str| map.get(key).and_then(Json::as_str).map(str::to_string);
    let url = text("url").filter(|url| !url.is_empty());
    if url.is_some() {
        return ServerSpec {
            url,
            transport: text("transport"),
            ..ServerSpec::default()
        };
    }
    ServerSpec {
        command: text("command"),
        args: match map.get("args") {
            Some(Json::Array(values)) => values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect(),
            _ => Vec::new(),
        },
        env: map.get("env").and_then(Json::as_object).cloned(),
        ..ServerSpec::default()
    }
}
