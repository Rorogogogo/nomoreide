//! The five operations that change an agent's environment.
//!
//! Two shapes of answer. `add_mcp` and `snapshot_agent` report on themselves;
//! the three that can be asked to act on something absent report through a
//! *change report* instead, where "the server you named is not there" is an
//! outcome with a message rather than a failed call. That distinction is the
//! reference's, and it matters: a caller applying several changes wants to
//! know which ones landed, not to have the first refusal end the batch.
//!
//! Every write backs the file up first — see [`super::backup`].

use super::documents::{stored_entry, Document};
use super::spec::{Scope, ServerSpec};
use super::{backup, readers, store, Agent};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AddOutcome {
    pub ok: bool,
    pub agent: &'static str,
    pub key: String,
    pub backups: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotOutcome {
    pub agent: &'static str,
    pub backups: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub category: &'static str,
    pub action: &'static str,
    pub name: String,
    pub source_agent: &'static str,
    pub source_scope: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_agent: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_scope: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChangeResult {
    pub change: Change,
    pub ok: bool,
    pub summary: String,
    pub backups: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChangeReport {
    pub ok: bool,
    pub applied: u32,
    pub failed: u32,
    pub results: Vec<ChangeResult>,
    pub backups: Vec<String>,
}

impl ChangeReport {
    fn of(change: Change, summary: String, outcome: Result<Vec<PathBuf>, String>) -> Self {
        let (ok, backups, error) = match outcome {
            Ok(backups) => (true, backups, None),
            Err(message) => (false, Vec::new(), Some(message)),
        };
        let backups: Vec<String> = backups
            .into_iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        Self {
            ok,
            applied: u32::from(ok),
            failed: u32::from(!ok),
            results: vec![ChangeResult {
                change,
                ok,
                summary,
                backups: backups.clone(),
                error,
            }],
            backups,
        }
    }
}

fn strings(backups: Vec<Option<PathBuf>>) -> Vec<String> {
    backups
        .into_iter()
        .flatten()
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

/// Add or replace one MCP server.
///
/// The one call here that refuses outright: a server that is neither something
/// to run nor something to connect to is not a server, and there is nothing
/// sensible to write.
pub fn add_mcp(
    agent: Agent,
    key: &str,
    spec: &ServerSpec,
    scope: Scope,
    cwd: &Path,
) -> Result<AddOutcome, String> {
    let has_command = !spec.command.as_deref().unwrap_or_default().is_empty();
    if !has_command && !spec.is_remote() {
        return Err("Provide either command (stdio server) or url (remote server).".to_string());
    }
    let backups = match (scope, agent) {
        (Scope::Project, Agent::Codex | Agent::Antigravity | Agent::Cursor | Agent::Windsurf) => {
            // These agents use the guarded project store, so what the user asked for is
            // recorded where this program can find it again.
            vec![store::set(cwd, agent, key, stored_entry(spec))?]
        }
        (scope, agent) => {
            let path = agent.config_path(&super::home());
            let taken = backup::file(&path)?;
            let mut document = Document::load(agent, &path);
            match scope {
                Scope::User => document.set_user(agent, key, spec),
                Scope::Project => document.claude_project(&cwd.to_string_lossy()).set(
                    key.to_string(),
                    super::documents::project_entry(agent, spec),
                ),
            }
            document.save(&path)?;
            vec![taken]
        }
    };
    Ok(AddOutcome {
        ok: true,
        agent: agent.id(),
        key: key.to_string(),
        backups: strings(backups),
    })
}

/// Copy an agent's config aside without changing it.
pub fn snapshot_agent(agent: Agent) -> Result<SnapshotOutcome, String> {
    let taken = backup::file(&agent.config_path(&super::home()))?;
    Ok(SnapshotOutcome {
        agent: agent.id(),
        backups: strings(vec![taken]),
    })
}

pub fn remove_mcp(agent: Agent, key: &str, scope: Scope, cwd: &Path) -> ChangeReport {
    let change = Change {
        category: "mcp",
        action: "remove",
        name: key.to_string(),
        source_agent: agent.id(),
        source_scope: scope.id(),
        target_agent: None,
        target_scope: None,
    };
    let summary = format!(
        "Remove MCP \"{key}\" from {} ({})",
        agent.display_name(),
        scope.id()
    );
    ChangeReport::of(
        change,
        summary,
        peek(agent, key, scope, cwd).and_then(|_| take(agent, key, scope, cwd)),
    )
}

pub fn move_mcp_scope(agent: Agent, key: &str, from: Scope, to: Scope, cwd: &Path) -> ChangeReport {
    let change = Change {
        category: "mcp",
        action: "move",
        name: key.to_string(),
        source_agent: agent.id(),
        source_scope: from.id(),
        target_agent: Some(agent.id()),
        target_scope: Some(to.id()),
    };
    let summary = format!(
        "Move MCP \"{key}\" from {} ({}) to {} ({})",
        agent.display_name(),
        from.id(),
        agent.display_name(),
        to.id()
    );
    ChangeReport::of(change, summary, move_server(agent, key, from, to, cwd))
}

fn move_server(
    agent: Agent,
    key: &str,
    from: Scope,
    to: Scope,
    cwd: &Path,
) -> Result<Vec<PathBuf>, String> {
    if from == to {
        return Err("Source and target are the same; nothing to move.".to_string());
    }
    // Looked up before anything is written, so a move that cannot find its
    // source leaves both scopes exactly as they were.
    let spec = peek(agent, key, from, cwd)?;
    // Target first, then source. A move that fails halfway then leaves the
    // server in both places rather than in neither.
    let added = add_mcp(agent, key, &spec, to, cwd)?;
    let mut backups: Vec<PathBuf> = added.backups.into_iter().map(PathBuf::from).collect();
    backups.extend(take(agent, key, from, cwd)?);
    Ok(backups)
}

fn missing_server(agent: Agent, key: &str, scope: Scope) -> String {
    format!(
        "MCP \"{key}\" not found in {} {} scope.",
        agent.display_name(),
        scope.id()
    )
}

/// What the server at `key` is, without changing anything.
fn peek(agent: Agent, key: &str, scope: Scope, cwd: &Path) -> Result<ServerSpec, String> {
    if uses_store(agent, scope) {
        return store::get(cwd, agent, key)
            .map(|entry| super::documents::spec_from_stored(&entry))
            .ok_or_else(|| missing_server(agent, key, scope));
    }
    let view = readers::read(agent, &super::home(), cwd);
    ServerSpec::from_view(&view, scope, key).ok_or_else(|| missing_server(agent, key, scope))
}

/// Remove one server, handing back the backups taken on the way.
fn take(agent: Agent, key: &str, scope: Scope, cwd: &Path) -> Result<Vec<PathBuf>, String> {
    if uses_store(agent, scope) {
        let (removed, taken) = store::remove(cwd, agent, key)?;
        if !removed {
            return Err(missing_server(agent, key, scope));
        }
        return Ok(taken.into_iter().collect());
    }
    let path = agent.config_path(&super::home());
    let taken = backup::file(&path)?;
    let mut document = Document::load(agent, &path);
    let removed = match scope {
        Scope::User => document.remove_user(agent, key),
        Scope::Project => document.claude_project(&cwd.to_string_lossy()).remove(key),
    };
    if !removed {
        return Err(missing_server(agent, key, scope));
    }
    document.save(&path)?;
    Ok(taken.into_iter().collect())
}

/// Whether this scope for this agent lives in the project store rather than in
/// the agent's own config.
fn uses_store(agent: Agent, scope: Scope) -> bool {
    matches!(scope, Scope::Project) && !matches!(agent, Agent::Claude)
}

pub fn move_skill_scope(
    agent: Agent,
    name: &str,
    from: Scope,
    to: Scope,
    cwd: &Path,
) -> ChangeReport {
    let change = Change {
        category: "skill",
        action: "move",
        name: name.to_string(),
        source_agent: agent.id(),
        source_scope: from.id(),
        target_agent: Some(agent.id()),
        target_scope: Some(to.id()),
    };
    let summary = format!(
        "Move skill \"{name}\" from {} ({}) to {} ({})",
        agent.display_name(),
        from.id(),
        agent.display_name(),
        to.id()
    );
    ChangeReport::of(change, summary, move_skill(agent, name, from, to, cwd))
}

fn move_skill(
    agent: Agent,
    name: &str,
    from: Scope,
    to: Scope,
    cwd: &Path,
) -> Result<Vec<PathBuf>, String> {
    if from == to {
        return Err("Source and target are the same; nothing to move.".to_string());
    }
    let home = super::home();
    let directory = |scope: Scope| -> Result<PathBuf, String> {
        match scope {
            Scope::User => agent
                .user_skills_directory(&home)
                .ok_or_else(|| no_project_skills(agent)),
            Scope::Project => agent
                .project_skills_directory(cwd)
                .ok_or_else(|| no_project_skills(agent)),
        }
    };
    // The source is wherever the skill actually is; the target is where this
    // agent puts one it is given.
    let source = match from {
        Scope::User => agent
            .installed_user_skill(&home, name)
            .unwrap_or_else(|| directory(Scope::User).unwrap_or_default().join(name)),
        Scope::Project => directory(from)?.join(name),
    };
    let target = directory(to)?.join(name);
    if !source.is_dir() {
        return Err(format!(
            "Skill \"{name}\" not found in {} {} scope.",
            agent.display_name(),
            from.id()
        ));
    }
    // The source directory stops existing, so the backup is the only copy of
    // it left until the target is written.
    let taken = backup::directory(&source, name)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    backup::copy_tree(&source, &target)?;
    std::fs::remove_dir_all(&source)
        .map_err(|error| format!("Failed to remove {}: {error}", source.display()))?;
    Ok(vec![taken])
}

fn no_project_skills(agent: Agent) -> String {
    format!(
        "{} has no project-scoped skills; Claude, Codex, Cursor, and Windsurf support project skills.",
        agent.display_name()
    )
}
