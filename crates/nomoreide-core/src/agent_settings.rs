//! Each coding agent's *settings* file — the one a person edits by hand —
//! which is not the MCP config [`crate::agent_env`] reads.
//!
//! Every supported agent except Codex keeps JSON; Codex keeps TOML, in the very file its
//! MCP servers live in, so a write here can move an agent's servers as a side
//! effect. Every write parses the content first, copies the previous version
//! beside it, and replaces the file atomically. This is a human-only surface:
//! deliberately not reachable from the MCP server, the same boundary the
//! database writer keeps.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::agent_env::{backup_config_file, home, Agent};
use crate::filesystem::{atomic_write, AtomicWriteOptions};
use crate::js_json;

/// What one agent's settings file holds, and what can be done to it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettings {
    pub agent: &'static str,
    pub path: String,
    pub exists: bool,
    pub format: &'static str,
    /// The file as it is on disk, empty when there is no file yet. A file that
    /// does not parse is still returned in full: the point of the editor is to
    /// fix one, so refusing to show it would strand the person who has to.
    pub content: String,
    /// Absent rather than null when the file declares no model, or declares
    /// one that is not a string, or cannot be parsed at all.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Whether the curated model switch understands this agent's file.
    pub model_editable: bool,
}

/// A settings file's syntax, which follows from the agent and nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Json,
    Toml,
}

impl Format {
    fn id(self) -> &'static str {
        match self {
            Self::Json => "json",
            Self::Toml => "toml",
        }
    }

    /// The spelling that goes in a refusal, which is the format's name shouted.
    fn label(self) -> &'static str {
        match self {
            Self::Json => "JSON",
            Self::Toml => "TOML",
        }
    }
}

fn format_of(agent: Agent) -> Format {
    match agent {
        Agent::Codex => Format::Toml,
        _ => Format::Json,
    }
}

fn settings_path(agent: Agent, home: &Path) -> PathBuf {
    match agent {
        Agent::Claude => home.join(".claude").join("settings.json"),
        Agent::Codex => home.join(".codex").join("config.toml"),
        Agent::Antigravity => home.join(".gemini").join("settings.json"),
        Agent::Cursor => home.join(".cursor").join("mcp.json"),
        Agent::Windsurf => home
            .join(".codeium")
            .join("windsurf")
            .join("mcp_config.json"),
    }
}

/// Antigravity's `settings.json` has no documented model key, so the curated
/// switch has nothing to write there.
fn model_editable(agent: Agent) -> bool {
    matches!(agent, Agent::Claude | Agent::Codex)
}

/// Parse, insisting the document is an object.
///
/// The message is the one the reference produces, which is its parser's own
/// diagnostic behind a fixed prefix — so a person pasting a broken file is told
/// where it broke, not merely that it did.
fn parse_document(
    content: &str,
    format: Format,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let refuse = |detail: String| format!("Not valid {}: {detail}", format.label());
    match format {
        Format::Json => match js_json::parse(content) {
            Ok(serde_json::Value::Object(map)) => Ok(map),
            Ok(_) => Err(refuse("top-level value must be an object".to_string())),
            Err(message) => Err(refuse(message)),
        },
        Format::Toml => match toml::from_str::<toml::Value>(content) {
            Ok(toml::Value::Table(table)) => Ok(toml_table_to_json(table)),
            // TOML has no other top-level shape, so this arm cannot be reached
            // by a document that parsed; it is here so the match is total.
            Ok(_) => Err(refuse("top-level value must be an object".to_string())),
            Err(error) => Err(refuse(toml_detail(&error))),
        },
    }
}

fn toml_table_to_json(table: toml::value::Table) -> serde_json::Map<String, serde_json::Value> {
    let mut map = serde_json::Map::new();
    for (key, value) in table {
        map.insert(key, toml_value_to_json(value));
    }
    map
}

fn toml_value_to_json(value: toml::Value) -> serde_json::Value {
    match value {
        toml::Value::String(text) => serde_json::Value::String(text),
        toml::Value::Integer(number) => serde_json::Value::from(number),
        toml::Value::Float(number) => serde_json::Value::from(number),
        toml::Value::Boolean(flag) => serde_json::Value::Bool(flag),
        toml::Value::Datetime(stamp) => serde_json::Value::String(stamp.to_string()),
        toml::Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(toml_value_to_json).collect())
        }
        toml::Value::Table(table) => serde_json::Value::Object(toml_table_to_json(table)),
    }
}

/// The reference's TOML parser reports one line; this one reports a rendered
/// snippet across several. Only the first sentence is the diagnostic.
fn toml_detail(error: &toml::de::Error) -> String {
    error
        .message()
        .lines()
        .next()
        .unwrap_or_default()
        .to_string()
}

/// Read one agent's settings file. A file that is not there is not an error:
/// an agent that has never been configured has no file yet, and the editor
/// opens on an empty document.
pub fn read_agent_settings(agent: Agent) -> AgentSettings {
    read_agent_settings_in(agent, &home())
}

pub fn read_agent_settings_in(agent: Agent, home: &Path) -> AgentSettings {
    let path = settings_path(agent, home);
    let format = format_of(agent);
    let (content, exists) = match std::fs::read_to_string(&path) {
        Ok(text) => (text, true),
        Err(_) => (String::new(), false),
    };

    let model = if exists && !content.trim().is_empty() {
        parse_document(&content, format)
            .ok()
            .and_then(|document| match document.get("model") {
                Some(serde_json::Value::String(text)) => Some(text.clone()),
                _ => None,
            })
    } else {
        None
    };

    AgentSettings {
        agent: agent.id(),
        path: path.to_string_lossy().into_owned(),
        exists,
        format: format.id(),
        content,
        model,
        model_editable: model_editable(agent),
    }
}

/// The settings after a write, and where the previous version went.
pub struct WrittenSettings {
    pub settings: AgentSettings,
    pub backup: Option<String>,
}

/// Validate, back up, and replace the whole settings file.
pub fn write_agent_settings(agent: Agent, content: &str) -> Result<WrittenSettings, String> {
    write_agent_settings_in(agent, content, &home())
}

pub fn write_agent_settings_in(
    agent: Agent,
    content: &str,
    home: &Path,
) -> Result<WrittenSettings, String> {
    let path = settings_path(agent, home);
    parse_document(content, format_of(agent))?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    let backup = backup_config_file(&path)?;
    let body = if content.ends_with('\n') {
        content.to_string()
    } else {
        format!("{content}\n")
    };
    atomic_write(&path, body, AtomicWriteOptions::default())
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))?;

    Ok(WrittenSettings {
        settings: read_agent_settings_in(agent, home),
        backup: backup.map(|path| path.to_string_lossy().into_owned()),
    })
}

/// The curated model switch.
///
/// A JSON file is parsed, edited, and written back out; Codex's TOML gets a
/// line edit instead, so the comments and the formatting of a file this program
/// did not write survive being touched. A blank model clears the key rather
/// than setting it to nothing.
pub fn set_agent_model(agent: Agent, model: &str) -> Result<WrittenSettings, String> {
    set_agent_model_in(agent, model, &home())
}

pub fn set_agent_model_in(
    agent: Agent,
    model: &str,
    home: &Path,
) -> Result<WrittenSettings, String> {
    let trimmed = model.trim();
    let current = read_agent_settings_in(agent, home);
    if !current.model_editable {
        return Err(format!(
            "Model switching isn't supported for \"{}\".",
            agent.id()
        ));
    }

    let next = match format_of(agent) {
        Format::Json => {
            let mut document = if current.content.trim().is_empty() {
                serde_json::Map::new()
            } else {
                parse_document(&current.content, Format::Json)?
            };
            if trimmed.is_empty() {
                document.shift_remove("model");
            } else {
                document.insert(
                    "model".to_string(),
                    serde_json::Value::String(trimmed.to_string()),
                );
            }
            format!(
                "{}\n",
                serde_json::to_string_pretty(&serde_json::Value::Object(document))
                    .map_err(|error| error.to_string())?
            )
        }
        Format::Toml => toml_with_model(&current.content, trimmed),
    };

    write_agent_settings_in(agent, &next, home)
}

/// Replace the root table's `model = …` line, or put one at the top.
///
/// Only the text above the first `[section]` is the root table: a `model` key
/// under a section belongs to that section and is a different setting.
fn toml_with_model(content: &str, model: &str) -> String {
    let section = section_start(content);
    let (root, rest) = match section {
        Some(index) => (&content[..index], &content[index..]),
        None => (content, ""),
    };

    let line = format!("model = {}", serde_json::Value::String(model.to_string()));
    match root_model_line(root) {
        Some(span) if !model.is_empty() => {
            format!("{}{}{}{}", &root[..span.0], line, &root[span.1..], rest)
        }
        Some(span) => {
            // Take the newline with the line, so clearing a model does not
            // leave the blank line it lived on behind.
            let end = if root[span.1..].starts_with('\n') {
                span.1 + 1
            } else {
                span.1
            };
            format!("{}{}{}", &root[..span.0], &root[end..], rest)
        }
        None if !model.is_empty() => format!("{line}\n{content}"),
        None => content.to_string(),
    }
}

/// Where the first `[` that opens a table sits, counting from the whitespace
/// in front of it — the reference's `/^\s*\[/m`, whose `\s` spans newlines.
fn section_start(content: &str) -> Option<usize> {
    let pattern = regex::Regex::new(r"(?m)^\s*\[").expect("a literal pattern");
    pattern.find(content).map(|found| found.start())
}

/// The span of the root table's `model = …` line, whitespace in front included.
fn root_model_line(root: &str) -> Option<(usize, usize)> {
    let pattern = regex::Regex::new(r"(?m)^\s*model\s*=.*$").expect("a literal pattern");
    pattern.find(root).map(|found| (found.start(), found.end()))
}

#[cfg(test)]
mod agent_tests {
    use super::*;

    #[test]
    fn cursor_and_windsurf_edit_their_stable_json_config_paths() {
        let home = Path::new("/home/tester");
        assert_eq!(
            settings_path(Agent::Cursor, home),
            PathBuf::from("/home/tester/.cursor/mcp.json")
        );
        assert_eq!(
            settings_path(Agent::Windsurf, home),
            PathBuf::from("/home/tester/.codeium/windsurf/mcp_config.json")
        );
        assert_eq!(format_of(Agent::Cursor), Format::Json);
        assert_eq!(format_of(Agent::Windsurf), Format::Json);
        assert!(!model_editable(Agent::Cursor));
        assert!(!model_editable(Agent::Windsurf));
    }
}
