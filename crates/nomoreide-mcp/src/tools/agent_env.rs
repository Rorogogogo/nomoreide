//! `nomoreide_agents_status`, `nomoreide_agents_read_configs`, and
//! `nomoreide_agents_doctor`.
//!
//! All three read the machine the adapter is running on — PATH, the user's
//! home, the project directory asked about — so none of them needs the daemon.
//! Asking it would only put the answer one hop further from what the caller
//! actually wants to know.

use crate::tools::render;
use nomoreide_core::agent_env;
use nomoreide_core::agent_env::{Agent, Scope, ServerSpec};
use std::path::{Path, PathBuf};

pub(crate) fn status() -> Result<String, String> {
    render(&agent_env::status())
}

pub(crate) fn read_configs(cwd: Option<&str>) -> Result<String, String> {
    render(&agent_env::read_configs(cwd.map(Path::new)))
}

pub(crate) fn doctor(cwd: Option<&str>) -> Result<String, String> {
    render(&agent_env::doctor(cwd.map(Path::new)))
}

/// The arguments common to every write: which agent, which scope, and the
/// directory project scope is resolved against.
pub(crate) struct Target<'a> {
    pub agent: &'a str,
    pub scope: Option<&'a str>,
    pub cwd: Option<&'a str>,
}

impl Target<'_> {
    fn parts(&self) -> Result<(Agent, Scope, PathBuf), String> {
        let agent =
            Agent::parse(self.agent).ok_or_else(|| format!("Unknown agent {}", self.agent))?;
        // An absent scope is the user's own, which is where a server lives
        // unless someone says otherwise.
        let scope = self
            .scope
            .map_or(Some(Scope::User), Scope::parse)
            .ok_or_else(|| format!("Unknown scope {}", self.scope.unwrap_or_default()))?;
        Ok((agent, scope, project_directory(self.cwd)))
    }
}

fn project_directory(cwd: Option<&str>) -> PathBuf {
    cwd.map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

pub(crate) fn add_mcp(target: Target<'_>, key: &str, spec: &ServerSpec) -> Result<String, String> {
    let (agent, scope, cwd) = target.parts()?;
    render(&agent_env::add_mcp(agent, key, spec, scope, &cwd)?)
}

pub(crate) fn remove_mcp(target: Target<'_>, key: &str) -> Result<String, String> {
    let (agent, scope, cwd) = target.parts()?;
    render(&agent_env::remove_mcp(agent, key, scope, &cwd))
}

pub(crate) fn move_mcp_scope(
    target: Target<'_>,
    key: &str,
    from: &str,
    to: &str,
) -> Result<String, String> {
    let (agent, _, cwd) = target.parts()?;
    let (from, to) = scopes(from, to)?;
    render(&agent_env::move_mcp_scope(agent, key, from, to, &cwd))
}

pub(crate) fn move_skill_scope(
    target: Target<'_>,
    name: &str,
    from: &str,
    to: &str,
) -> Result<String, String> {
    let (agent, _, cwd) = target.parts()?;
    let (from, to) = scopes(from, to)?;
    render(&agent_env::move_skill_scope(agent, name, from, to, &cwd))
}

pub(crate) fn snapshot_agent(target: Target<'_>) -> Result<String, String> {
    let (agent, _, _) = target.parts()?;
    render(&agent_env::snapshot_agent(agent)?)
}

fn scopes(from: &str, to: &str) -> Result<(Scope, Scope), String> {
    let parse = |value: &str| Scope::parse(value).ok_or_else(|| format!("Unknown scope {value}"));
    Ok((parse(from)?, parse(to)?))
}
