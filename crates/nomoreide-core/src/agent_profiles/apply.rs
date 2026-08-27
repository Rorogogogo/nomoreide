//! Writing a profile into an agent's live configuration.
//!
//! Two modes with different answers. A dry run reports what *would* happen,
//! item by item, with the warnings that say where a target agent cannot hold
//! everything the profile carries — Codex has nowhere to put a remote server's
//! transport, so applying one there loses it, and the caller is told before
//! rather than after. A real run reports what was applied, what was skipped,
//! and every backup it took on the way.
//!
//! Plugins are reported but not installed: a profile carrying a *bundled*
//! plugin is not yet ported, and one that merely names a plugin it does not
//! carry is skipped exactly as the reference skips it.

use super::{store, Profile};
use crate::agent_env::{self, Agent, Json, Scope, ServerSpec};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewItem {
    pub category: &'static str,
    pub name: String,
    /// Only a plugin has one, and it names where the plugin came from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub status: &'static str,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPreview {
    pub profile: String,
    pub agent: &'static str,
    pub items: Vec<PreviewItem>,
    pub unresolved_credentials: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    pub profile: String,
    pub agent: &'static str,
    pub mcps_applied: Vec<String>,
    pub skills_applied: Vec<String>,
    pub plugins_applied: Vec<String>,
    pub skipped: Vec<String>,
    pub backups: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(untagged)]
pub enum Applied {
    Preview(ApplyPreview),
    Outcome(ApplyOutcome),
}

pub fn apply(
    name: &str,
    agent: Agent,
    dry_run: bool,
    skip_mcps: &[String],
    skip_skills: &[String],
    skip_plugins: &[String],
    cwd: &Path,
) -> Result<Applied, String> {
    let profile = super::get(name)?;
    if dry_run {
        return Ok(Applied::Preview(preview(&profile, agent, cwd)));
    }
    Ok(Applied::Outcome(run(
        &profile,
        agent,
        skip_mcps,
        skip_skills,
        skip_plugins,
        cwd,
    )?))
}

fn preview(profile: &Profile, agent: Agent, cwd: &Path) -> ApplyPreview {
    // A preview is a *comparison*, so it has to read what the agent already
    // has: an entry the target does not carry is an addition, one it carries
    // identically is a no-op, and one it carries differently is the only kind
    // worth stopping for.
    let views = agent_env::read_configs(Some(cwd));
    let live = views.iter().find(|view| view.agent == agent.id());

    let mut items = Vec::new();
    for (key, entry) in profile.mcps.iter() {
        items.push(PreviewItem {
            category: "mcp",
            name: key.to_string(),
            id: None,
            status: match live.and_then(|view| live_mcp(view, key)) {
                None => "add",
                Some(existing) if existing == canonical_mcp(entry) => "identical",
                Some(_) => "conflict",
            },
            warnings: mcp_warnings(agent, entry),
        });
    }
    for skill in &profile.skills {
        let name = entry_name(skill).unwrap_or_default().to_string();
        // Contents are not diffed: a user-scope directory already under this
        // name is a conflict whatever is in it.
        let installed = live.is_some_and(|view| {
            view.skills
                .iter()
                .any(|entry| entry.scope == "user" && entry.name == name)
        });
        items.push(PreviewItem {
            category: "skill",
            name,
            id: None,
            status: if installed { "conflict" } else { "add" },
            warnings: Vec::new(),
        });
    }
    for plugin in &profile.plugins {
        let name = entry_name(plugin).unwrap_or_default().to_string();
        items.push(PreviewItem {
            category: "plugin",
            id: Some(plugin_id(plugin)),
            status: "add",
            warnings: plugin_warnings(agent, &name),
            name,
        });
    }
    ApplyPreview {
        profile: profile.name.clone(),
        agent: agent.id(),
        items,
        unresolved_credentials: Vec::new(),
    }
}

/// What a target agent cannot keep. Only Codex loses anything, and only when
/// there is something to lose: its config stores a URL and nothing else, so a
/// plain HTTP server with no headers survives the trip intact and is not warned
/// about.
fn mcp_warnings(agent: Agent, entry: &Json) -> Vec<String> {
    let field = |key: &str| entry.as_object().and_then(|map| map.get(key));
    let remote = field("kind").and_then(Json::as_str) == Some("remote");
    let loses =
        field("headers").is_some() || field("transport").and_then(Json::as_str) == Some("sse");
    if remote && loses && matches!(agent, Agent::Codex) {
        return vec![
            "Codex config only stores a URL for remote MCPs; transport and headers will be dropped."
                .to_string(),
        ];
    }
    Vec::new()
}

/// One MCP entry reduced to a form two spellings of the same server share.
///
/// The comparison is by value and not by text: an absent `args` and an empty
/// one are the same server, and an env map is ordered so that two files listing
/// the same variables in different orders still match.
fn canonical_mcp(entry: &Json) -> String {
    let field = |key: &str| entry.as_object().and_then(|map| map.get(key));
    let text = |key: &str| {
        field(key)
            .and_then(Json::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let map = |key: &str| {
        let mut pairs: Vec<(String, String)> = field(key)
            .and_then(Json::as_object)
            .map(|object| {
                object
                    .iter()
                    .map(|(name, value)| {
                        (
                            name.to_string(),
                            value.as_str().unwrap_or_default().to_string(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        pairs.sort_by(|left, right| crate::locale::compare(&left.0, &right.0));
        pairs
    };
    if text("kind") == "local" {
        let args: Vec<String> = field("args")
            .and_then(|value| match value {
                Json::Array(items) => Some(
                    items
                        .iter()
                        .map(|item| item.as_str().unwrap_or_default().to_string())
                        .collect(),
                ),
                _ => None,
            })
            .unwrap_or_default();
        return format!(
            "local\u{1}{}\u{1}{args:?}\u{1}{:?}",
            text("command"),
            map("env")
        );
    }
    format!(
        "remote\u{1}{}\u{1}{}\u{1}{:?}\u{1}{:?}",
        text("transport"),
        text("url"),
        map("headers"),
        map("env")
    )
}

/// The server the agent already has under this key, in the same canonical form.
fn live_mcp(view: &agent_env::AgentConfigView, key: &str) -> Option<String> {
    if let Some(server) = view.mcp_servers.get(key) {
        let mut pairs: Vec<(String, String)> = server
            .env
            .as_ref()
            .map(|env| {
                env.iter()
                    .map(|(name, value)| {
                        (
                            name.to_string(),
                            value.as_str().unwrap_or_default().to_string(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        pairs.sort_by(|left, right| crate::locale::compare(&left.0, &right.0));
        let args = server.args.clone().unwrap_or_default();
        return Some(format!(
            "local\u{1}{}\u{1}{args:?}\u{1}{pairs:?}",
            server.command
        ));
    }
    let server = view.remote_mcp_servers.get(key)?;
    let mut headers: Vec<(String, String)> = server
        .headers
        .as_ref()
        .map(|map| {
            map.iter()
                .map(|(name, value)| {
                    (
                        name.to_string(),
                        value.as_str().unwrap_or_default().to_string(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    headers.sort_by(|left, right| crate::locale::compare(&left.0, &right.0));
    let env: Vec<(String, String)> = Vec::new();
    Some(format!(
        "remote\u{1}{}\u{1}{}\u{1}{headers:?}\u{1}{env:?}",
        server.transport, server.url
    ))
}

/// A plugin captured from one agent and applied to another arrives as files
/// rather than as that agent's own plugin format.
fn plugin_warnings(agent: Agent, name: &str) -> Vec<String> {
    if matches!(agent, Agent::Claude) {
        return Vec::new();
    }
    vec![format!(
        "Plugin \"{name}\" will be installed as portable assets rather than a native {} plugin.",
        agent.id()
    )]
}

/// `<sourceAgent>:<name>@<version>`, with a plugin that was never published
/// reported as local.
pub(super) fn plugin_id(plugin: &Json) -> String {
    let field = |key: &str| {
        plugin
            .as_object()
            .and_then(|map| map.get(key))
            .and_then(Json::as_str)
    };
    format!(
        "{}:{}@{}",
        field("sourceAgent").unwrap_or("claude"),
        field("name").unwrap_or_default(),
        field("version").unwrap_or("local")
    )
}

fn run(
    profile: &Profile,
    agent: Agent,
    skip_mcps: &[String],
    skip_skills: &[String],
    skip_plugins: &[String],
    cwd: &Path,
) -> Result<ApplyOutcome, String> {
    let mut applied = Vec::new();
    let mut skipped = Vec::new();
    // One copy of the config before anything is written, then one per server —
    // the same rhythm the writes themselves keep.
    let mut backups = agent_env::snapshot_agent(agent)?.backups;

    for (key, entry) in profile.mcps.iter() {
        if skip_mcps.iter().any(|name| name == key) {
            skipped.push(format!("mcp \"{key}\""));
            continue;
        }
        let outcome = agent_env::add_mcp(agent, key, &spec_of(entry), Scope::User, cwd)?;
        backups.extend(outcome.backups);
        applied.push(key.to_string());
    }

    let mut skills_applied = Vec::new();
    for skill in &profile.skills {
        let name = entry_name(skill).unwrap_or_default().to_string();
        if skip_skills.contains(&name) {
            skipped.push(format!("skill \"{name}\""));
            continue;
        }
        // A profile may name a skill it does not carry — one built by hand, or
        // one whose bundle was never captured. There is nothing to install.
        match store::bundled_skill(&profile.name, &name) {
            Some(source) => {
                if let Some(taken) = agent_env::install_user_skill(agent, &name, &source)? {
                    backups.push(taken.to_string_lossy().into_owned());
                }
                skills_applied.push(name);
            }
            None => skipped.push(format!("skill \"{name}\" (missing from profile bundle)")),
        }
    }

    for plugin in &profile.plugins {
        let name = entry_name(plugin).unwrap_or_default().to_string();
        if skip_plugins.contains(&name) {
            skipped.push(format!("plugin \"{name}\""));
            continue;
        }
        skipped.push(format!("plugin \"{name}\" (missing from profile bundle)"));
    }

    Ok(ApplyOutcome {
        profile: profile.name.clone(),
        agent: agent.id(),
        mcps_applied: applied,
        skills_applied,
        plugins_applied: Vec::new(),
        skipped,
        backups,
    })
}

/// A profile entry read back as something an agent's config can be given.
fn spec_of(entry: &Json) -> ServerSpec {
    let field = |key: &str| {
        entry
            .as_object()
            .and_then(|map| map.get(key))
            .and_then(Json::as_str)
            .map(str::to_string)
    };
    let object = |key: &str| {
        entry
            .as_object()
            .and_then(|map| map.get(key))
            .and_then(Json::as_object)
            .cloned()
    };
    ServerSpec {
        command: field("command"),
        args: entry
            .as_object()
            .and_then(|map| map.get("args"))
            .and_then(|args| match args {
                Json::Array(values) => Some(
                    values
                        .iter()
                        .filter_map(|value| value.as_str().map(str::to_string))
                        .collect(),
                ),
                _ => None,
            })
            .unwrap_or_default(),
        env: object("env"),
        url: field("url"),
        transport: field("transport"),
    }
}

fn entry_name(entry: &Json) -> Option<&str> {
    entry.as_object()?.get("name")?.as_str()
}
