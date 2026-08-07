//! Per-project summaries for the all-projects lens.
//!
//! The Rust counterpart of `src/core/project-overview.ts`, and it exists for
//! the same reason: the Git, GitHub, and Vercel views each read the *selected*
//! repository, which is global state, so "show me all projects" cannot be
//! served by asking those views nicely. Everything here resolves a project from
//! its own path and never touches `selected_git_repository`, so the act of
//! looking does not change what the rest of the app is pointed at.
//!
//! One project failing is normal (no remote, no Vercel link, a token that does
//! not cover it), so a failure rides on that project's own row rather than
//! failing the whole command.

use serde_json::Value;
use tauri::State;
use tokio::process::Command;
use tokio::task::JoinSet;

use crate::core::config::{Config, ConfigStore, GitRepoDef};
use crate::core::git_manager::GitManager;
use crate::core::github_auth;
use crate::core::vercel_context::require_context;
use crate::AppState;

/// How many projects are summarized concurrently.
///
/// Each GitHub row costs two API calls and each Vercel row up to three, so an
/// unbounded fan-out over a large workspace would burst straight into a rate
/// limit. Six keeps a realistic workspace responsive without doing that.
const CONCURRENCY: usize = 6;

#[tauri::command]
pub async fn project_overview(
    state: State<'_, AppState>,
    domain: String,
) -> Result<Value, String> {
    if !matches!(domain.as_str(), "git" | "github" | "vercel") {
        return Err(format!("Unknown overview domain: {domain}"));
    }
    let config = state
        .config_store
        .load()
        .await
        .map_err(|error| error.to_string())?;

    let store = state.config_store.clone();
    let mut rows: Vec<Option<Value>> = vec![None; config.git_repositories.len()];
    let mut running: JoinSet<(usize, Value)> = JoinSet::new();
    let mut next = 0usize;

    // A bounded pool rather than an unbounded fan-out, with each task tagged by
    // its index so the grid keeps config order — it must not reshuffle between
    // reads just because a project answered faster this time.
    while next < config.git_repositories.len() || !running.is_empty() {
        while running.len() < CONCURRENCY && next < config.git_repositories.len() {
            let index = next;
            next += 1;
            let store = store.clone();
            let config = config.clone();
            let repository = config.git_repositories[index].clone();
            let domain = domain.clone();
            running.spawn(async move {
                (index, summarize(&store, &config, &repository, &domain).await)
            });
        }
        if let Some(Ok((index, row))) = running.join_next().await {
            rows[index] = Some(row);
        }
    }

    Ok(Value::Array(rows.into_iter().flatten().collect()))
}

async fn summarize(
    config_store: &ConfigStore,
    config: &Config,
    repository: &GitRepoDef,
    domain: &str,
) -> Value {
    let cwd = repository
        .active_worktree_path
        .clone()
        .unwrap_or_else(|| repository.path.clone());

    let result = match domain {
        "git" => git_overview(&cwd).await,
        "github" => github_overview(config, repository).await,
        _ => vercel_overview(config_store, config, &cwd).await,
    };

    let mut row = serde_json::json!({
        "name": repository.name,
        "path": repository.path,
        "cwd": cwd,
    });
    match result {
        Ok(summary) => {
            row[domain] = summary;
        }
        Err(error) => {
            row["error"] = Value::String(error);
        }
    }
    row
}

async fn git_overview(cwd: &str) -> Result<Value, String> {
    let status = GitManager::status(cwd).await.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "branch": status.branch,
        "dirty": status.files.len(),
        "ahead": status.ahead,
        "behind": status.behind,
        "upstream": status.upstream,
    }))
}

async fn github_overview(config: &Config, repository: &GitRepoDef) -> Result<Value, String> {
    let cwd = repository
        .active_worktree_path
        .as_ref()
        .unwrap_or(&repository.path);
    let (owner, repo) =
        remote_slug(cwd).await.ok_or("No GitHub repository resolves for this project.")?;
    let (token, host, _) = github_auth::resolve(config, Some(&repository.name), "github.com")
        .await
        .map_err(|error| error.to_string())?;

    let prs = gh_json(
        &token,
        &host,
        &format!("/repos/{owner}/{repo}/pulls?state=open&per_page=100"),
    )
    .await?;
    let open = prs.as_array().map(Vec::len).unwrap_or(0);

    // CI is a nice-to-have on a card: a repo with no Actions, or a token
    // without the checks scope, should still show its PR count rather than an
    // error, so this whole chain degrades to `null`.
    let checks = default_branch_checks(&token, &host, &owner, &repo).await;

    Ok(serde_json::json!({
        "owner": owner,
        "repo": repo,
        "openPullRequests": open,
        "checks": checks,
    }))
}

async fn default_branch_checks(
    token: &str,
    host: &str,
    owner: &str,
    repo: &str,
) -> Option<String> {
    let info = gh_json(token, host, &format!("/repos/{owner}/{repo}")).await.ok()?;
    let branch = info.get("default_branch").and_then(Value::as_str)?;
    let runs = gh_json(
        token,
        host,
        &format!("/repos/{owner}/{repo}/commits/{branch}/check-runs?per_page=100"),
    )
    .await
    .ok()?;

    let runs = runs.get("check_runs").and_then(Value::as_array)?;
    if runs.is_empty() {
        return None;
    }
    let conclusion = |run: &Value| {
        run.get("conclusion")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    if runs
        .iter()
        .any(|run| run.get("status").and_then(Value::as_str) != Some("completed"))
    {
        return Some("pending".into());
    }
    if runs
        .iter()
        .any(|run| matches!(conclusion(run).as_str(), "failure" | "timed_out" | "cancelled"))
    {
        return Some("failure".into());
    }
    Some("success".into())
}

async fn vercel_overview(
    config_store: &ConfigStore,
    config: &Config,
    cwd: &str,
) -> Result<Value, String> {
    let context = require_context(config_store, config, cwd).await?;
    let project = context
        .project
        .clone()
        .ok_or("No Vercel project is linked to this project.")?;
    let project_id = project
        .get("id")
        .and_then(Value::as_str)
        .ok_or("The linked Vercel project has no id.")?;

    // Production only, and only the latest: the card answers "is what users
    // see healthy", not "what has been built lately".
    let deployments = context
        .manager
        .list_deployments(project_id, Some("production"), Some(1))
        .await
        .map_err(|error| error.message)?;
    let latest = deployments.first();

    Ok(serde_json::json!({
        "projectId": project_id,
        "projectName": project.get("name").cloned().unwrap_or(Value::Null),
        "state": latest.and_then(|d| d.get("state")).cloned().unwrap_or(Value::Null),
        "url": latest.and_then(|d| d.get("url")).cloned().unwrap_or(Value::Null),
        "createdAt": latest.and_then(|d| d.get("createdAt")).cloned().unwrap_or(Value::Null),
    }))
}

async fn remote_slug(cwd: &str) -> Option<(String, String)> {
    let output = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(cwd)
        .output()
        .await
        .ok()?;
    let remote = String::from_utf8_lossy(&output.stdout);
    let trimmed = remote.trim().trim_end_matches(".git");
    let path = trimmed
        .strip_prefix("git@github.com:")
        .or_else(|| trimmed.strip_prefix("https://github.com/"))
        .or_else(|| trimmed.strip_prefix("http://github.com/"))?;
    let mut parts = path.splitn(2, '/');
    Some((parts.next()?.to_string(), parts.next()?.to_string()))
}

async fn gh_json(token: &str, host: &str, path: &str) -> Result<Value, String> {
    let base = if host == "github.com" {
        "https://api.github.com".to_string()
    } else {
        format!("https://{host}/api/v3")
    };
    let response = reqwest::Client::new()
        .get(format!("{base}{path}"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "nomoreide")
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("GitHub returned {} for {path}", response.status()));
    }
    response.json().await.map_err(|error| error.to_string())
}
