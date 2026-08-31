//! `nomoreide profile <subcommand>` — the Rust half of `src/cli/profile.ts`.
//!
//! Profiles are the one CLI surface that *writes* an agent's configuration, so
//! `apply` is the command to be careful with. It takes a `--dry-run` that
//! reports what it would touch, it backs up every file it replaces and prints
//! where the backups went, and it never carries a credential it did not
//! resolve — an unresolved one stays a placeholder and is reported by name.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use nomoreide_core::agent_env::{Agent, AGENTS};
use nomoreide_core::agent_profiles::{self, registry_config, Applied, PublishRequest};

use crate::commands::{CliError, CliResult};
use crate::flags::{parse_flags, positional_args, Flags};

const USAGE: &str = concat!(
    "Usage: nomoreide profile <subcommand>\n",
    "  list                                  saved profiles\n",
    "  show <name>                           full profile JSON\n",
    "  snapshot <agent> <name> [--description <text>]\n",
    "  apply <name> <agent> [--dry-run] [--skip-mcps a,b] [--skip-skills x,y] [--skip-plugins p,q]\n",
    "  export <name> [--output <path>]      credential-redacted .tar.gz\n",
    "  import <archive> [--force] [--as <name>]\n",
    "  delete <name>\n",
    "  publish <name> --slug <slug> --title <title> [--version <v>] [--summary <text>]\n",
    "  install <slug> [--force] [--as <name>]   install from the hosted registry",
);

pub async fn run(subcommand: Option<&str>, args: &[String]) -> CliResult {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let flags = parse_flags(args);
    let positional = positional_args(args);
    let has = |flag: &str| args.iter().any(|arg| arg == flag);

    match subcommand {
        None | Some("list") => list(),
        Some("show") => {
            let name = require(positional.first(), "profile name")?;
            let profile = agent_profiles::get(name).map_err(CliError::Failure)?;
            print_json(&serde_json::to_value(profile).map_err(json_fail)?)
        }
        Some("snapshot") => snapshot(&positional, &flags, &cwd),
        Some("apply") => apply(&positional, &flags, has("--dry-run"), &cwd),
        Some("export") => export(&positional, &flags, &cwd),
        Some("import") => import(&positional, &flags, has("--force")),
        Some("delete") => {
            let name = require(positional.first(), "profile name")?;
            agent_profiles::delete(name).map_err(CliError::Failure)?;
            println!("Deleted profile \"{name}\"");
            Ok(())
        }
        Some("publish") => publish(&positional, &flags, &cwd).await,
        Some("install") => install(&positional, &flags, has("--force")).await,
        _ => Err(CliError::usage(USAGE)),
    }
}

fn list() -> CliResult {
    let profiles = agent_profiles::list().map_err(CliError::Failure)?;
    if profiles.is_empty() {
        println!("No profiles yet. Create one with: nomoreide profile snapshot <agent> <name>");
        return Ok(());
    }
    println!("Name\tMCPs\tSkills\tPlugins\tUpdated\tDescription");
    for profile in &profiles {
        println!(
            "{}\t{}\t{}\t{}\t{}\t{}",
            profile.name,
            profile.mcp_count,
            profile.skill_count,
            profile.plugin_count,
            profile.updated_at,
            profile.description.as_deref().unwrap_or(""),
        );
    }
    Ok(())
}

fn snapshot(positional: &[String], flags: &Flags, cwd: &Path) -> CliResult {
    let agent = require_agent(positional.first())?;
    let name = require(positional.get(1), "profile name")?;
    let profile = agent_profiles::snapshot(agent, name, flags.nullish("description"), cwd)
        .map_err(CliError::Failure)?;
    println!(
        "Snapshotted {} into \"{}\" ({} MCPs, {} skills, {} plugins)",
        agent.id(),
        profile.name,
        profile.mcps.len(),
        profile.skills.len(),
        profile.plugins.len(),
    );
    Ok(())
}

fn apply(positional: &[String], flags: &Flags, dry_run: bool, cwd: &Path) -> CliResult {
    let name = require(positional.first(), "profile name")?;
    let agent = require_agent(positional.get(1))?;
    let applied = agent_profiles::apply(
        name,
        agent,
        dry_run,
        &split_list(flags.nullish("skipMcps")),
        &split_list(flags.nullish("skipSkills")),
        &split_list(flags.nullish("skipPlugins")),
        cwd,
    )
    .map_err(CliError::Failure)?;

    match applied {
        Applied::Preview(preview) => {
            println!("Item\tStatus");
            for item in &preview.items {
                let warnings = if item.warnings.is_empty() {
                    String::new()
                } else {
                    format!(" ({})", item.warnings.join("; "))
                };
                println!("{} {}\t{}{warnings}", item.category, item.name, item.status);
            }
            if !preview.unresolved_credentials.is_empty() {
                println!(
                    "Unresolved credentials: {}",
                    preview.unresolved_credentials.join(", ")
                );
            }
        }
        Applied::Outcome(outcome) => {
            let skipped = if outcome.skipped.is_empty() {
                String::new()
            } else {
                format!(", skipped {}", outcome.skipped.join(", "))
            };
            println!(
                "Applied \"{}\" to {}: {} MCPs, {} skills, {} plugins{skipped}",
                outcome.profile,
                outcome.agent,
                outcome.mcps_applied.len(),
                outcome.skills_applied.len(),
                outcome.plugins_applied.len(),
            );
            for backup in &outcome.backups {
                println!("Backup: {backup}");
            }
        }
    }
    Ok(())
}

fn export(positional: &[String], flags: &Flags, cwd: &Path) -> CliResult {
    let name = require(positional.first(), "profile name")?;
    let outcome =
        agent_profiles::export(name, flags.nullish("output"), cwd).map_err(CliError::Failure)?;
    println!(
        "Exported to {} (credentials redacted)",
        outcome.archive_path
    );
    if !outcome.credentials.is_empty() {
        println!(
            "Importers must supply: {}",
            outcome
                .credentials
                .iter()
                .map(|spec| spec.key.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    Ok(())
}

fn import(positional: &[String], flags: &Flags, force: bool) -> CliResult {
    let archive = require(positional.first(), "archive path")?;
    let outcome = agent_profiles::import(
        Path::new(archive),
        force,
        flags.nullish("as"),
        &BTreeMap::new(),
    )
    .map_err(CliError::Failure)?;
    println!(
        "Imported \"{}\" ({} MCPs, {} skills, {} plugins)",
        outcome.name, outcome.mcp_count, outcome.skill_count, outcome.plugin_count
    );
    report_missing(&outcome.missing_credentials);
    Ok(())
}

async fn publish(positional: &[String], flags: &Flags, cwd: &Path) -> CliResult {
    let name = require(positional.first(), "profile name")?;
    let (Some(slug), Some(title)) = (flags.truthy("slug"), flags.truthy("title")) else {
        return Err(CliError::usage("--slug and --title are required"));
    };
    // Checked before anything is packed: the reference refuses here rather
    // than letting the registry answer 401 after the archive has been built.
    if registry_config::api_token().is_err() {
        return Err(CliError::usage(
            "Not signed in to the registry. Sign in from the web UI (Agent Environments) or set NOMOREIDE_API_TOKEN.",
        ));
    }
    let outcome = agent_profiles::publish(
        PublishRequest {
            name,
            slug,
            title,
            summary: flags.nullish("summary"),
            version: flags.nullish("version"),
            changelog: None,
            visibility: None,
        },
        cwd,
    )
    .await
    .map_err(CliError::Failure)?;
    println!(
        "Published \"{}\" v{} to the registry (credentials redacted)",
        outcome.slug, outcome.version
    );
    Ok(())
}

async fn install(positional: &[String], flags: &Flags, force: bool) -> CliResult {
    let slug = require(positional.first(), "registry slug")?;
    let token = registry_config::api_token().ok();
    let outcome = agent_profiles::install(
        slug,
        force,
        flags.nullish("as"),
        &BTreeMap::new(),
        token.as_deref(),
    )
    .await
    .map_err(CliError::Failure)?;
    println!(
        "Installed \"{}\" v{} ({} MCPs, {} skills, {} plugins)",
        outcome.imported.name,
        outcome.version,
        outcome.imported.mcp_count,
        outcome.imported.skill_count,
        outcome.imported.plugin_count,
    );
    report_missing(&outcome.imported.missing_credentials);
    Ok(())
}

/// Placeholders are kept rather than dropped, so importing again with the
/// secrets in hand finishes the job instead of starting over.
fn report_missing(missing: &[nomoreide_core::agent_profiles::Credential]) {
    if missing.is_empty() {
        return;
    }
    println!(
        "Credentials still needed (placeholders kept): {}",
        missing
            .iter()
            .map(|spec| spec.key.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    );
}

/// A comma-separated `--skip-*` list. Blank entries are dropped, and a list
/// that is entirely blank is the same as not passing the flag.
fn split_list(value: Option<&str>) -> Vec<String> {
    value
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn require<'a>(value: Option<&'a String>, label: &str) -> Result<&'a str, CliError> {
    value
        .map(String::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CliError::usage(format!("{label} is required")))
}

fn require_agent(value: Option<&String>) -> Result<Agent, CliError> {
    let names = || {
        AGENTS
            .iter()
            .map(|agent| agent.id())
            .collect::<Vec<_>>()
            .join(", ")
    };
    value
        .and_then(|value| AGENTS.iter().copied().find(|agent| agent.id() == value))
        .ok_or_else(|| CliError::usage(format!("agent is required (one of: {})", names())))
}

fn print_json(value: &serde_json::Value) -> CliResult {
    println!(
        "{}",
        serde_json::to_string_pretty(value).map_err(json_fail)?
    );
    Ok(())
}

fn json_fail(error: serde_json::Error) -> CliError {
    CliError::Failure(error.to_string())
}
