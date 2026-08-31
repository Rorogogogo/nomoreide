//! Capturing what an agent is configured with, as a profile.
//!
//! A snapshot is the agent-environment reader's answer, rewritten into the
//! profile's own vocabulary. Only *user* scope is taken: a profile is meant to
//! be carried to another machine, and a project-scoped server belongs to the
//! project it was set up in rather than to the person.

use super::{store, Profile};
use crate::agent_env::{self, Agent, Json, OrderedMap};
use std::path::Path;

pub fn snapshot(
    agent: Agent,
    name: &str,
    description: Option<&str>,
    cwd: &Path,
) -> Result<Profile, String> {
    let name = super::check_name(name)?;
    if store::exists(&name) {
        return Err(format!("Profile \"{name}\" already exists."));
    }
    let views = agent_env::read_configs(Some(cwd));
    let view = views
        .iter()
        .find(|view| view.agent == agent.id())
        .ok_or_else(|| format!("Unknown agent {}", agent.id()))?;
    // An agent with neither a readable config nor a user skill has nothing to
    // snapshot, and saving the empty profile that would result is worse than
    // refusing: it looks like a successful capture of a setup, and applying it
    // later would report "0 MCPs, 0 skills" as though that were the answer.
    if !view.exists && view.skills.is_empty() {
        return Err(format!(
            "Agent \"{}\" has no live config to snapshot.",
            agent.id()
        ));
    }

    let mut mcps = OrderedMap::new();
    for (key, server) in view.mcp_servers.iter() {
        mcps.insert(key.to_string(), local_entry(server));
    }
    for (key, server) in view.remote_mcp_servers.iter() {
        mcps.insert(key.to_string(), remote_entry(server));
    }

    // User scope only, and the skill's files come with it — a profile that
    // named a skill without carrying it would apply to nothing.
    let skills: Vec<&agent_env::SkillEntry> = view
        .skills
        .iter()
        .filter(|skill| skill.scope == "user")
        .collect();
    let profile = Profile {
        name: name.clone(),
        description: description.map(str::to_string),
        source_agent: Some(agent.id().to_string()),
        mcps,
        skills: skills.iter().map(|skill| named(&skill.name)).collect(),
        plugins: Vec::new(),
    };
    store::save(&profile)?;
    for skill in skills {
        // A plugin recorded without an install path has nothing to bundle, and
        // the empty path fails here exactly as the reference's `undefined` does.
        let installed = skill.install_path.as_deref().unwrap_or_default();
        store::bundle_skill(&name, &skill.name, Path::new(installed))?;
    }
    Ok(profile)
}

fn named(name: &str) -> Json {
    let mut entry = OrderedMap::new();
    entry.insert("name".to_string(), Json::String(name.to_string()));
    Json::Object(entry)
}

fn local_entry(server: &agent_env::StdioServer) -> Json {
    let mut entry = OrderedMap::new();
    entry.insert("kind".to_string(), Json::String("local".to_string()));
    entry.insert("command".to_string(), Json::String(server.command.clone()));
    if let Some(args) = &server.args {
        entry.insert(
            "args".to_string(),
            Json::Array(args.iter().map(|arg| Json::String(arg.clone())).collect()),
        );
    }
    if let Some(env) = &server.env {
        entry.insert("env".to_string(), Json::Object(json_values(env)));
    }
    Json::Object(entry)
}

fn remote_entry(server: &agent_env::RemoteServer) -> Json {
    let mut entry = OrderedMap::new();
    entry.insert("kind".to_string(), Json::String("remote".to_string()));
    entry.insert(
        "transport".to_string(),
        Json::String(server.transport.to_string()),
    );
    entry.insert("url".to_string(), Json::String(server.url.clone()));
    if let Some(headers) = &server.headers {
        entry.insert("headers".to_string(), Json::Object(json_values(headers)));
    }
    Json::Object(entry)
}

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

/// Rebuild an existing profile from an agent's environment as it is now.
///
/// The new bundle is captured into a *sibling* profile first and only swapped
/// in once it is whole, so a read that fails halfway leaves the last good
/// profile untouched. The original is moved aside rather than deleted, and
/// moved back if the swap itself fails — the window where neither is in place
/// is a single rename.
pub fn refresh(agent: Agent, name: &str, cwd: &Path) -> Result<Profile, String> {
    let name = super::check_name(name)?;
    let existing = super::get(&name)?;
    let token = uuid::Uuid::new_v4().to_string();
    let staging_name = format!("{name}.refresh-{token}");

    let captured = snapshot(agent, &staging_name, existing.description.as_deref(), cwd)?;
    let staging_dir = store::directory_of(&staging_name);
    let current_dir = store::directory_of(&name);
    let held = store::profiles_root().join(format!(".profile-backup-{token}"));

    let restore = |taken: bool| {
        if taken {
            let _ = std::fs::rename(&held, &current_dir);
        }
        let _ = std::fs::remove_dir_all(&staging_dir);
    };

    // The captured profile is written under the name it will answer to, not the
    // staging name it was built under.
    let renamed = Profile {
        name: name.clone(),
        ..captured
    };
    if let Err(reason) = store::write_at(&staging_dir, &renamed) {
        restore(false);
        return Err(reason);
    }

    let had_current = current_dir.is_dir();
    if had_current {
        if let Err(error) = std::fs::rename(&current_dir, &held) {
            restore(false);
            return Err(format!(
                "Failed to set aside {}: {error}",
                current_dir.display()
            ));
        }
    }
    if let Err(error) = std::fs::rename(&staging_dir, &current_dir) {
        restore(had_current);
        return Err(format!(
            "Failed to install {}: {error}",
            current_dir.display()
        ));
    }
    let _ = std::fs::remove_dir_all(&held);
    super::get(&name)
}
