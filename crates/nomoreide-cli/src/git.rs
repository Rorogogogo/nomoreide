//! `nomoreide git <subcommand>` — the Rust half of `src/cli/git.ts`.
//!
//! Everything here goes through the **read-safe** `git_manager`, which is the
//! whole point of the split: `reset --hard`, `clean`, `push --force` and
//! `branch -D` have no implementation to reach from this surface, so no
//! argument to this command can destroy work. The two exceptions are
//! deliberate and narrow — `stage`/`unstage` move the index, and `commit`
//! writes one — and each is an explicit subcommand rather than a flag on
//! another one.

use nomoreide_core::config::{ConfigStore, GitRepoDef};
use nomoreide_core::git_identity;
use nomoreide_core::git_manager::GitManager;

use crate::commands::{CliError, CliResult};
use crate::flags::{parse_flags, positional_args};

const USAGE: &str =
    "Usage: nomoreide git [status|branch|switch|create-branch|fetch|diff|staged-diff|log|stage|unstage|commit]";

pub async fn run(subcommand: Option<&str>, args: &[String], store: &ConfigStore) -> CliResult {
    let flags = parse_flags(args);
    let cwd = match flags.nullish("cwd") {
        Some(cwd) => cwd.to_string(),
        None => std::env::current_dir()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
    };
    let positional = positional_args(args);

    match subcommand {
        Some("status") => status(&cwd).await,
        Some("add-repo") => add_repo(&positional, &flags, store).await,
        Some("select-repo") => select_repo(&positional, store).await,
        Some("diff") => {
            println!(
                "{}",
                GitManager::diff(&cwd, positional.first().map(String::as_str)).await?
            );
            Ok(())
        }
        Some("staged-diff") => {
            println!(
                "{}",
                GitManager::staged_diff(&cwd, positional.first().map(String::as_str)).await?
            );
            Ok(())
        }
        Some("log") => log(&cwd, &flags).await,
        Some("branch") => branch(&cwd).await,
        Some("switch") => {
            let name = require(positional.first(), "branch name")?;
            println!("{}", GitManager::switch_branch(&cwd, name).await?);
            Ok(())
        }
        Some("create-branch") => {
            let name = require(positional.first(), "branch name")?;
            // No start point: the reference's CLI branches from HEAD, and the
            // flag that would choose one exists only on the HTTP surface.
            println!("{}", GitManager::create_branch(&cwd, name, None).await?);
            Ok(())
        }
        Some("fetch") => {
            println!("{}", GitManager::fetch(&cwd).await?);
            Ok(())
        }
        Some("stage") => {
            GitManager::stage(&cwd, &positional).await?;
            println!("Staged {}", positional.join(", "));
            Ok(())
        }
        Some("unstage") => {
            GitManager::unstage(&cwd, &positional).await?;
            println!("Unstaged {}", positional.join(", "));
            Ok(())
        }
        Some("commit") => commit(&cwd, &flags, store).await,
        _ => Err(CliError::usage(USAGE)),
    }
}

async fn status(cwd: &str) -> CliResult {
    let status = GitManager::status(cwd).await?;
    // The tracking suffix is assembled the reference's way, including its
    // quirk: the arrows appear only when one of the counts is non-zero, so a
    // branch that is level with its upstream reports no upstream at all.
    let tracking = if status.ahead != 0 || status.behind != 0 {
        let ahead = if status.ahead != 0 {
            format!("↑{}", status.ahead)
        } else {
            String::new()
        };
        let behind = if status.behind != 0 {
            format!("↓{}", status.behind)
        } else {
            String::new()
        };
        let upstream = status
            .upstream
            .as_deref()
            .map(|upstream| format!(" vs {upstream}"))
            .unwrap_or_default();
        format!(" ({ahead}{behind}{upstream})")
    } else {
        String::new()
    };
    let branch = if status.branch.is_empty() {
        "(detached)"
    } else {
        &status.branch
    };
    println!("Branch\t{branch}{tracking}");
    for file in &status.files {
        println!("{}{}\t{}", file.index, file.working_tree, file.path);
    }
    Ok(())
}

async fn add_repo(
    positional: &[String],
    flags: &crate::flags::Flags,
    store: &ConfigStore,
) -> CliResult {
    let name = require(positional.first(), "repository name")?;
    let path = flags
        .truthy("path")
        .ok_or_else(|| CliError::usage("--path is required"))?;
    store
        .register_git_repository(GitRepoDef {
            name: name.to_string(),
            path: path.to_string(),
            // Everything else is left for `register_git_repository` to keep:
            // it merges the credential and provider projects an existing
            // registration of the same name already carried, so re-running
            // `add-repo` does not silently unlink a repository's GitHub
            // account.
            active_worktree_path: None,
            github_credential: None,
            provider_projects: None,
            legacy_vercel_project_id: None,
        })
        .await?;
    println!("Registered Git repository {name}");
    Ok(())
}

async fn select_repo(positional: &[String], store: &ConfigStore) -> CliResult {
    let name = require(positional.first(), "repository name")?;
    store.select_git_repository(Some(name.to_string())).await?;
    println!("Selected Git repository {name}");
    Ok(())
}

async fn log(cwd: &str, flags: &crate::flags::Flags) -> CliResult {
    // `Number(flags.limit)` with a default of 10, and **no validation** — the
    // reference interpolates whatever `Number()` produced straight into the
    // `-N` argument, so `--limit banana` reaches git as `-NaN` and git refuses
    // it in its own words. Refusing earlier here would be friendlier and would
    // change both the message and the exit code, so the count is passed
    // through as JavaScript would have spelled it.
    let count = match flags.truthy("limit") {
        Some(value) => js_number_text(nomoreide_core::js_number::parse(value)),
        None => "10".to_string(),
    };
    for entry in GitManager::log_with_count(cwd, &count).await? {
        // Eight characters, not git's own abbreviation length: the reference
        // slices the full hash rather than asking git to shorten it.
        let short: String = entry.hash.chars().take(8).collect();
        println!("{short}\t{}", entry.subject);
    }
    Ok(())
}

async fn branch(cwd: &str) -> CliResult {
    for branch in GitManager::branches(cwd).await? {
        let marker = if branch.current { "*" } else { " " };
        let scope = if branch.remote { "remote" } else { "local" };
        println!(
            "{marker}\t{}\t{scope}\t{}",
            branch.name,
            branch.upstream.as_deref().unwrap_or("-")
        );
    }
    Ok(())
}

async fn commit(cwd: &str, flags: &crate::flags::Flags, store: &ConfigStore) -> CliResult {
    let message = flags
        .truthy("message")
        .ok_or_else(|| CliError::usage("--message is required"))?;
    // The identity is resolved per commit rather than written into `git
    // config`: NoMoreIDE stamps an author without changing anything about the
    // machine it is running on.
    let identity = git_identity::resolve_identity_for_cwd(store, cwd).await?;
    println!(
        "{}",
        GitManager::commit(cwd, message, identity.selected.as_ref()).await?
    );
    if let Some(selected) = &identity.selected {
        println!("Authored as {} <{}>", selected.name, selected.email);
    }
    Ok(())
}

/// A number spelled the way JavaScript's string conversion spells it.
///
/// Only the cases a `--limit` can actually reach are covered: `NaN`, the two
/// infinities, and finite values. Rust and JavaScript agree on the shortest
/// round-trip spelling of a finite `f64` except in the exponent forms, which a
/// commit count never lands in — and a value that did would be refused by git
/// either way.
fn js_number_text(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value.is_sign_negative() {
            "-Infinity".to_string()
        } else {
            "Infinity".to_string()
        };
    }
    if value.fract() == 0.0 && value.abs() < 1e21 {
        return format!("{}", value as i64);
    }
    format!("{value}")
}

fn require<'a>(value: Option<&'a String>, label: &str) -> Result<&'a str, CliError> {
    value
        .map(String::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CliError::usage(format!("{label} is required")))
}
