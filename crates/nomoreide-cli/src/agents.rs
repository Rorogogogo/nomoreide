//! `nomoreide agents [status|doctor|read]` — the Rust half of
//! `src/cli/agents.ts`.
//!
//! Read-only by construction. Everything here reports what an agent's config
//! already says; the surface that *writes* one is `nomoreide profile apply`,
//! which is a different command for the same reason `git-actions` is a
//! different module from `git-manager`.

use nomoreide_core::agent_env;

use crate::commands::{CliError, CliResult};

const USAGE: &str = "Usage: nomoreide agents [status|doctor|read [claude|codex|antigravity]]";

pub fn run(subcommand: Option<&str>, args: &[String]) -> CliResult {
    let cwd = std::env::current_dir().ok();
    match subcommand {
        None | Some("status") => {
            status(cwd.as_deref());
            Ok(())
        }
        Some("doctor") => doctor(cwd.as_deref()),
        Some("read") => read(cwd.as_deref(), args),
        _ => Err(CliError::usage(USAGE)),
    }
}

fn status(cwd: Option<&std::path::Path>) {
    let availability = agent_env::status();
    let configs = agent_env::read_configs(cwd);
    println!("Agent\tInstalled\tMCPs\tSkills\tConfig");
    for config in &configs {
        let installed = availability
            .iter()
            .find(|entry| entry.agent == config.agent)
            .is_some_and(|entry| entry.available);
        // All four MCP maps, because an agent can register a server at user
        // scope, at project scope, or as a remote — and a count that named
        // only one of them would report zero for a working setup.
        let mcp_count = config.mcp_servers.len()
            + config.remote_mcp_servers.len()
            + config.project_mcp_servers.len()
            + config.project_remote_mcp_servers.len();
        println!(
            "{}\t{}\t{}\t{}\t{}",
            config.agent,
            if installed { "yes" } else { "no" },
            mcp_count,
            config.skills.len(),
            if config.exists {
                config.config_path.as_str()
            } else {
                "(none)"
            },
        );
    }
}

/// Exit 1 when anything is wrong, so `nomoreide agents doctor` can gate a
/// script. The checks themselves still print — a caller that wants the detail
/// reads stdout, and a caller that only wants a verdict reads the code.
fn doctor(cwd: Option<&std::path::Path>) -> CliResult {
    let report = agent_env::doctor(cwd);
    for check in &report.checks {
        let status = if check.status == "ok" { "ok" } else { "warn" };
        println!("{status}\t{}\t{}", check.label, check.message);
    }
    if report.has_issues {
        // Not a usage error and not a runtime failure — a report whose answer
        // is "no". The reference returns 1 here, and it never reaches the
        // catch that would have made it 2.
        return Err(CliError::Silent);
    }
    Ok(())
}

fn read(cwd: Option<&std::path::Path>, args: &[String]) -> CliResult {
    let names: Vec<&str> = agent_env::AGENTS.iter().map(|agent| agent.id()).collect();
    let agent = args.iter().find(|arg| !arg.starts_with("--"));
    if let Some(agent) = agent {
        if !names.contains(&agent.as_str()) {
            return Err(CliError::usage(format!(
                "Unknown agent \"{agent}\". Use one of: {}",
                names.join(", ")
            )));
        }
    }
    let configs = agent_env::read_configs(cwd);
    // With an agent named the reference prints that one config; without one it
    // prints the array. Note it indexes `[0]` after filtering, so a named agent
    // that somehow read back nothing would print `undefined` — unreachable,
    // because the name was checked against the same list the reader walks.
    let value = match agent {
        Some(agent) => configs
            .iter()
            .find(|config| config.agent == agent.as_str())
            .map(serde_json::to_value)
            .transpose()
            .map_err(|error| CliError::Failure(error.to_string()))?
            .unwrap_or(serde_json::Value::Null),
        None => {
            serde_json::to_value(&configs).map_err(|error| CliError::Failure(error.to_string()))?
        }
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&value)
            .map_err(|error| CliError::Failure(error.to_string()))?
    );
    Ok(())
}
