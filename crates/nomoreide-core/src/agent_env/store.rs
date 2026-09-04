//! Project-scoped MCP servers for the agents that have no place for them.
//!
//! Claude records per-project servers in its own config, keyed by the project
//! directory. Several agents have nowhere this module writes them — so a
//! project-scoped server for either is kept here instead, in a file this
//! program owns inside the project. Nothing reads it back into an agent's
//! listing, because neither agent would read it either; it is a record of what
//! the user asked for, not a config either CLI honours.

use super::ordered::{Json, OrderedMap};
use super::{backup, Agent};
use std::path::{Path, PathBuf};

/// `.nomoreide/project-mcps.json`, beside the logs.
///
/// This lived under a directory named for the old brand until the cleanup — one
/// project-local dotdir per product is the point, and there was no reason for
/// this to be the exception.
pub(super) fn path(project: &Path) -> PathBuf {
    project.join(".nomoreide").join("project-mcps.json")
}

fn load(path: &Path) -> Json {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Json>(&text).ok())
        .filter(|document| document.as_object().is_some())
        .unwrap_or_else(Json::object)
}

fn save(path: &Path, document: &Json) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    let mut text = serde_json::to_string_pretty(document)
        .map_err(|error| format!("Failed to render {}: {error}", path.display()))?;
    text.push('\n');
    std::fs::write(path, text)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

/// Add or replace one server, returning the backup taken first, if any.
pub(super) fn set(
    project: &Path,
    agent: Agent,
    key: &str,
    entry: Json,
) -> Result<Option<PathBuf>, String> {
    let path = path(project);
    let taken = backup::file(&path)?;
    let mut document = load(&path);
    document
        .object_at(agent.id())
        .get_mut("mcpServers")
        .and_then(Json::as_object_mut)
        .map(|servers| servers.set(key.to_string(), entry.clone()))
        .unwrap_or_else(|| {
            let mut servers = OrderedMap::new();
            servers.insert(key.to_string(), entry);
            document
                .object_at(agent.id())
                .set("mcpServers".to_string(), Json::Object(servers));
        });
    save(&path, &document)?;
    Ok(taken)
}

/// Remove one server. The boolean says whether it was there to remove.
pub(super) fn remove(
    project: &Path,
    agent: Agent,
    key: &str,
) -> Result<(bool, Option<PathBuf>), String> {
    let path = path(project);
    let mut document = load(&path);
    let present = document
        .object_at(agent.id())
        .get("mcpServers")
        .and_then(Json::as_object)
        .is_some_and(|servers| servers.contains_key(key));
    if !present {
        return Ok((false, None));
    }
    let taken = backup::file(&path)?;
    if let Some(servers) = document
        .object_at(agent.id())
        .get_mut("mcpServers")
        .and_then(Json::as_object_mut)
    {
        servers.remove(key);
    }
    save(&path, &document)?;
    Ok((true, taken))
}

/// The stored entry for one server, if it is there.
pub(super) fn get(project: &Path, agent: Agent, key: &str) -> Option<Json> {
    load(&path(project))
        .as_object()?
        .get(agent.id())?
        .as_object()?
        .get("mcpServers")?
        .as_object()?
        .get(key)
        .cloned()
}

/// Everything recorded for one agent in this project, as config entries.
///
/// Deserialised from the stored text rather than converted from [`Json`], so
/// the entries arrive in the order the file holds them.
pub(super) fn project_entries<T: serde::de::DeserializeOwned + Default>(
    project: &Path,
    agent: Agent,
) -> OrderedMap<T> {
    #[derive(serde::Deserialize)]
    struct Shelf<T> {
        #[serde(rename = "mcpServers")]
        mcp_servers: Option<OrderedMap<T>>,
    }

    std::fs::read_to_string(path(project))
        .ok()
        .and_then(|text| serde_json::from_str::<OrderedMap<Shelf<T>>>(&text).ok())
        .and_then(|mut shelves| {
            shelves
                .get_mut(agent.id())
                .and_then(|shelf| shelf.mcp_servers.take())
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_agent_keeps_its_own_shelf_in_one_file() {
        let project = std::env::temp_dir().join(format!(
            "nomoreide-store-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::remove_dir_all(&project).ok();
        std::fs::create_dir_all(&project).unwrap();

        let entry = |command: &str| {
            let mut map = OrderedMap::new();
            map.insert("command".to_string(), Json::String(command.to_string()));
            Json::Object(map)
        };
        set(&project, Agent::Codex, "one", entry("true")).unwrap();
        set(&project, Agent::Antigravity, "one", entry("false")).unwrap();

        assert_eq!(get(&project, Agent::Codex, "one"), Some(entry("true")));
        assert_eq!(
            get(&project, Agent::Antigravity, "one"),
            Some(entry("false"))
        );

        // Removing one agent's entry leaves the other agent's alone.
        assert!(remove(&project, Agent::Codex, "one").unwrap().0);
        assert_eq!(get(&project, Agent::Codex, "one"), None);
        assert_eq!(
            get(&project, Agent::Antigravity, "one"),
            Some(entry("false"))
        );

        // Removing something absent is not a write, so nothing is backed up.
        assert_eq!(
            remove(&project, Agent::Codex, "one").unwrap(),
            (false, None)
        );
        std::fs::remove_dir_all(&project).ok();
    }
}
