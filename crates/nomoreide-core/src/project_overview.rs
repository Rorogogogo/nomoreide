//! Per-project summaries for the all-projects lens.
//!
//! The Rust half of `src/core/project-overview.ts`. The Git, GitHub and Vercel
//! pages each read the daemon's *selected* repository, which is global state —
//! so "show me all projects" cannot be served by asking those pages nicely.
//! Everything here resolves a project from its own path instead and never
//! touches the selection, which is what lets an overview exist without the act
//! of looking changing what the rest of the app is pointed at.
//!
//! **One project failing is normal**: no remote, no Vercel link, a token that
//! does not cover it. A failure therefore rides on that project's own row and
//! the request still succeeds, so one unreachable project cannot blank a page
//! that is mostly about the others.

use crate::config::{ConfigStore, GitRepoDef};
use crate::git_manager::GitManager;
use serde_json::{Map, Value};

/// The three lenses the page offers. Anything else is a 404 at the route.
pub const OVERVIEW_DOMAINS: [&str; 3] = ["git", "github", "vercel"];

pub async fn build_project_overview(
    store: &ConfigStore,
    domain: &str,
) -> Result<Vec<Value>, String> {
    let config = store.load().await.map_err(|error| error.to_string())?;
    let mut rows = Vec::with_capacity(config.git_repositories.len());
    // Sequential where the reference runs six at a time. The bound is there to
    // keep a large workspace from bursting into a rate limit, not to change the
    // answer: results keep input order either way.
    for repository in &config.git_repositories {
        rows.push(summarize(store, repository, domain).await);
    }
    Ok(rows)
}

async fn summarize(store: &ConfigStore, repository: &GitRepoDef, domain: &str) -> Value {
    // The worktree actually read, which may not be the repository's own path.
    let cwd = repository
        .active_worktree_path
        .clone()
        .unwrap_or_else(|| repository.path.clone());

    let mut row = Map::new();
    row.insert("name".into(), Value::String(repository.name.clone()));
    row.insert("path".into(), Value::String(repository.path.clone()));
    row.insert("cwd".into(), Value::String(cwd.clone()));

    let summary = match domain {
        "git" => git_overview(&cwd).await.map(|value| ("git", value)),
        "github" => github_overview(store, &cwd).await.map(|v| ("github", v)),
        "vercel" => vercel_overview(store, &cwd).await.map(|v| ("vercel", v)),
        _ => Err(format!("Unknown overview domain: {domain}")),
    };
    match summary {
        Ok((key, value)) => {
            row.insert(key.into(), value);
        }
        Err(message) => {
            row.insert("error".into(), Value::String(message));
        }
    }
    Value::Object(row)
}

async fn git_overview(cwd: &str) -> Result<Value, String> {
    let status = GitManager::status(cwd).await.map_err(|e| e.to_string())?;
    let mut summary = Map::new();
    summary.insert("branch".into(), Value::String(status.branch));
    // Any index or working-tree change, untracked included: the card counts
    // "things you have not committed", not "files git will commit".
    summary.insert("dirty".into(), Value::from(status.files.len()));
    summary.insert("ahead".into(), Value::from(status.ahead));
    summary.insert("behind".into(), Value::from(status.behind));
    if let Some(upstream) = status.upstream {
        summary.insert("upstream".into(), Value::String(upstream));
    }
    Ok(Value::Object(summary))
}

async fn github_overview(store: &ConfigStore, cwd: &str) -> Result<Value, String> {
    let Some(context) = crate::github_context::optional_github_context(store, cwd).await else {
        return Err("No GitHub repository resolves for this project.".into());
    };
    let prs = context
        .manager
        .list_prs("open", "1")
        .await
        .map_err(|error| error.to_string())?;

    // CI is a nice-to-have on a card: a repository with no Actions, or a token
    // without the checks scope, should still show its pull-request count rather
    // than turning the whole row into an error.
    let checks = match context.manager.repo_info().await {
        Ok(info) => {
            let branch = info
                .get("default_branch")
                .and_then(Value::as_str)
                .unwrap_or("HEAD")
                .to_string();
            context
                .manager
                .commit_checks(Some(&branch))
                .await
                .ok()
                .and_then(|status| normalize_checks(&status.state))
        }
        Err(_) => None,
    };

    let mut summary = Map::new();
    summary.insert("owner".into(), Value::String(context.owner));
    summary.insert("repo".into(), Value::String(context.repo));
    summary.insert("openPullRequests".into(), Value::from(prs.len()));
    if let Some(checks) = checks {
        summary.insert("checks".into(), Value::String(checks.into()));
    }
    Ok(Value::Object(summary))
}

/// The card distinguishes three outcomes; anything else reads as unknown and is
/// left off rather than guessed at.
fn normalize_checks(state: &str) -> Option<&'static str> {
    match state {
        "success" => Some("success"),
        "failure" => Some("failure"),
        "pending" | "in_progress" | "queued" => Some("pending"),
        _ => None,
    }
}

async fn vercel_overview(store: &ConfigStore, cwd: &str) -> Result<Value, String> {
    let config = store.load().await.map_err(|error| error.to_string())?;
    // A provider that will not connect and a repository with no linked project
    // are the same answer here: there is nothing to put on the card.
    let context =
        crate::providers::registry::require_provider_context("vercel", store, &config, cwd)
            .await
            .map_err(|_| "No Vercel project is linked to this project.".to_string())?;
    let Some(project) = context.project.as_ref() else {
        return Err("No Vercel project is linked to this project.".into());
    };
    let Some(identifier) = project.id.as_ref().and_then(Value::as_str) else {
        return Err("No Vercel project is linked to this project.".into());
    };

    // Production only, and only the latest: the card answers "is what users see
    // healthy", not "what has been built lately".
    let latest = context
        .client
        .list_deployments(identifier, Some("production"), 1)
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .next();

    let mut summary = Map::new();
    summary.insert("projectId".into(), Value::String(identifier.to_string()));
    summary.insert(
        "projectName".into(),
        project.name.clone().unwrap_or(Value::Null),
    );
    if let Some(deployment) = latest {
        let raw = serde_json::to_value(&deployment).unwrap_or(Value::Null);
        for key in ["state", "url", "createdAt"] {
            if let Some(value) = raw.get(key).filter(|value| !value.is_null()) {
                summary.insert(key.into(), value.clone());
            }
        }
    }
    Ok(Value::Object(summary))
}
