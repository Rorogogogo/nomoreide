//! Marketplace plugins, which an agent installs as a unit.
//!
//! A plugin is reported beside skills because that is where a person looks for
//! it, but it is not one: it is an install with a *source* it came from, and it
//! can carry skills, MCP servers, subagents and commands at once. Those
//! contents are listed rather than summarised, because the only thing anyone
//! does with a plugin here is uninstall it, and that takes all of them.
//!
//! Nothing is parsed beyond what the listing shows. A plugin whose install
//! directory is gone still appears — it is still installed as far as the agent
//! is concerned, and hiding it would hide the thing that needs fixing.

use std::path::Path;

use serde_json::Value;

use super::{Agent, SkillEntry};
use crate::locale;

/// Every plugin the agent has installed, in the order its own record lists
/// them. Only Claude keeps one this reads; the others report none.
pub(super) fn discover(agent: Agent, home: &Path) -> Vec<SkillEntry> {
    match agent {
        Agent::Claude => claude(home),
        _ => Vec::new(),
    }
}

fn claude(home: &Path) -> Vec<SkillEntry> {
    let path = home
        .join(".claude")
        .join("plugins")
        .join("installed_plugins.json");
    let Ok(source) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(document) = serde_json::from_str::<Value>(&source) else {
        return Vec::new();
    };
    let Some(plugins) = document.get("plugins").and_then(Value::as_object) else {
        return Vec::new();
    };

    plugins
        .iter()
        .map(|(key, records)| {
            // `name@source`, and a key with no `@` names a plugin that came
            // from nowhere the record can spell.
            let (name, source) = match key.split_once('@') {
                Some((name, source)) => (name.to_string(), Some(source.to_string())),
                None => (key.clone(), None),
            };
            let install_path = records
                .as_array()
                .and_then(|records| records.first())
                .and_then(|record| record.get("installPath"))
                .and_then(Value::as_str)
                .map(str::to_string);
            entry(name, source, install_path)
        })
        .collect()
}

fn entry(name: String, source: Option<String>, install_path: Option<String>) -> SkillEntry {
    let root = install_path.as_deref().map(Path::new);
    let skills = root.map(directories).unwrap_or_default();
    let mcps = root.map(mcp_keys).unwrap_or_default();
    let agents = root.map(agent_names).unwrap_or_default();
    let commands = root.map(command_names).unwrap_or_default();
    SkillEntry {
        name,
        source,
        kind: "plugin",
        scope: "user",
        install_path,
        // Always reported, even empty: a plugin that contributes no skills is
        // a different thing from a skill entry, which reports none at all.
        plugin_skills: Some(skills),
        plugin_mcps: non_empty(mcps),
        plugin_agents: non_empty(agents),
        plugin_commands: non_empty(commands),
    }
}

fn non_empty(values: Vec<String>) -> Option<Vec<String>> {
    if values.is_empty() {
        None
    } else {
        Some(values)
    }
}

fn sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort_by(|left, right| locale::compare(left, right));
    values
}

/// The plugin's own skills: one directory each, dotfiles left out.
fn directories(root: &Path) -> Vec<String> {
    let Ok(listing) = std::fs::read_dir(root.join("skills")) else {
        return Vec::new();
    };
    sorted(
        listing
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_dir())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| !name.starts_with('.'))
            .collect(),
    )
}

fn named_files(root: &Path, directory: &str, suffixes: &[&str]) -> Vec<String> {
    let Ok(listing) = std::fs::read_dir(root.join(directory)) else {
        return Vec::new();
    };
    sorted(
        listing
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_file())
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                suffixes
                    .iter()
                    .find_map(|suffix| name.strip_suffix(suffix).map(str::to_string))
            })
            .collect(),
    )
}

fn agent_names(root: &Path) -> Vec<String> {
    named_files(root, "agents", &[".md", ".toml"])
}

fn command_names(root: &Path) -> Vec<String> {
    named_files(root, "commands", &[".md"])
}

/// The keys of the plugin's own `.mcp.json`.
///
/// A document with no `mcpServers` is treated as the server map itself, which
/// is what the reference does — an older plugin wrote the servers at the top
/// level, and those plugins are still installed.
fn mcp_keys(root: &Path) -> Vec<String> {
    let Ok(source) = std::fs::read_to_string(root.join(".mcp.json")) else {
        return Vec::new();
    };
    let Ok(document) = serde_json::from_str::<Value>(&source) else {
        return Vec::new();
    };
    let servers = match document.get("mcpServers") {
        Some(Value::Object(map)) => map.clone(),
        _ => match document {
            Value::Object(map) => map,
            _ => return Vec::new(),
        },
    };
    sorted(servers.keys().cloned().collect())
}
