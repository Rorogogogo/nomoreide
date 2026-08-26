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
    super::check_name(name)?;
    if store::exists(name) {
        return Err(format!("Profile \"{name}\" already exists."));
    }
    let views = agent_env::read_configs(Some(cwd));
    let view = views
        .iter()
        .find(|view| view.agent == agent.id())
        .ok_or_else(|| format!("Unknown agent {}", agent.id()))?;

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
        name: name.to_string(),
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
        store::bundle_skill(name, &skill.name, Path::new(installed))?;
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
