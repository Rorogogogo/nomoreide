//! The GitHub surface.
//!
//! Storing a token is a config write and needs no daemon, the same way
//! repository registration does.

use super::render;
use nomoreide_core::config::{ConfigStore, GithubCredentialSelection};
use nomoreide_core::github_context::{require_github_context, selected_github_cwd, GithubContext};

/// Store a personal access token for `host`, and point the selected repository
/// at it.
///
/// The second half is what makes the token take effect: a repository chooses
/// which account it pushes and comments as, and a token nothing has chosen is
/// only reachable by the legacy host lookup.
pub(super) async fn set_token(
    store: &ConfigStore,
    token: &str,
    host: &str,
) -> Result<String, String> {
    store
        .set_github_token(host.to_string(), token.to_string(), None)
        .await
        .map_err(|error| error.to_string())?;
    let config = store.load().await.map_err(|error| error.to_string())?;
    if let Some(repository) = config.selected_git_repository.clone() {
        store
            .set_github_credential(
                &repository,
                GithubCredentialSelection::Stored {
                    host: host.to_string(),
                },
            )
            .await
            .map_err(|error| error.to_string())?;
    }
    // A sentence, not JSON: the reference reports this one as prose.
    Ok(format!("GitHub token stored for {host}."))
}

/// Where a GitHub tool runs. An absent `cwd` falls back to the selected
/// repository rather than to this process's directory — an agent asking about
/// "the" pull requests means the project the user is looking at.
async fn context(store: &ConfigStore, cwd: Option<&str>) -> Result<GithubContext, String> {
    let directory = match cwd {
        Some(cwd) => cwd.to_string(),
        None => {
            let config = store.load().await.map_err(|error| error.to_string())?;
            let fallback = std::env::current_dir()
                .map(|path| path.to_string_lossy().into_owned())
                .map_err(|error| error.to_string())?;
            selected_github_cwd(&config, &fallback).await
        }
    };
    require_github_context(store, &directory)
        .await
        .map_err(|error| error.to_string())
}

pub(super) async fn list_prs(
    store: &ConfigStore,
    cwd: Option<&str>,
    state: &str,
    page: u64,
) -> Result<String, String> {
    let prs = context(store, cwd)
        .await?
        .manager
        .list_prs(state, &page.to_string())
        .await
        .map_err(|error| error.to_string())?;
    render(&prs)
}

pub(super) async fn get_pr(
    store: &ConfigStore,
    cwd: Option<&str>,
    number: i64,
) -> Result<String, String> {
    let pr = context(store, cwd)
        .await?
        .manager
        .get_pr(number)
        .await
        .map_err(|error| error.to_string())?;
    render(&pr)
}

/// A patch, returned as git wrote it rather than quoted into JSON.
pub(super) async fn get_pr_diff(
    store: &ConfigStore,
    cwd: Option<&str>,
    number: i64,
) -> Result<String, String> {
    context(store, cwd)
        .await?
        .manager
        .pr_diff(number)
        .await
        .map_err(|error| error.to_string())
}

pub(super) async fn create_pr(
    store: &ConfigStore,
    cwd: Option<&str>,
    title: &str,
    body: Option<&str>,
    head: &str,
    base: &str,
    draft: bool,
) -> Result<String, String> {
    let pr = context(store, cwd)
        .await?
        .manager
        .create_pr(title, body, head, base, draft)
        .await
        .map_err(|error| error.to_string())?;
    Ok(format!("Created PR #{}: {}", pr.number, pr.html_url))
}

pub(super) async fn merge_pr(
    store: &ConfigStore,
    cwd: Option<&str>,
    number: i64,
    method: &str,
    commit_title: Option<&str>,
    commit_message: Option<&str>,
) -> Result<String, String> {
    let merged = context(store, cwd)
        .await?
        .manager
        .merge_pr(number, method, commit_title, commit_message)
        .await
        .map_err(|error| error.to_string())?;
    render(&merged)
}

pub(super) async fn list_issues(
    store: &ConfigStore,
    cwd: Option<&str>,
    state: &str,
    page: u64,
) -> Result<String, String> {
    let issues = context(store, cwd)
        .await?
        .manager
        .list_issues(state, &page.to_string())
        .await
        .map_err(|error| error.to_string())?;
    render(&issues)
}

pub(super) async fn get_issue(
    store: &ConfigStore,
    cwd: Option<&str>,
    number: i64,
) -> Result<String, String> {
    let issue = context(store, cwd)
        .await?
        .manager
        .get_issue(number)
        .await
        .map_err(|error| error.to_string())?;
    render(&issue)
}

pub(super) async fn list_issue_comments(
    store: &ConfigStore,
    cwd: Option<&str>,
    number: i64,
) -> Result<String, String> {
    let comments = context(store, cwd)
        .await?
        .manager
        .list_issue_comments(number)
        .await
        .map_err(|error| error.to_string())?;
    render(&comments)
}

pub(super) async fn add_issue_comment(
    store: &ConfigStore,
    cwd: Option<&str>,
    number: i64,
    body: &str,
) -> Result<String, String> {
    let comment = context(store, cwd)
        .await?
        .manager
        .add_issue_comment(number, body)
        .await
        .map_err(|error| error.to_string())?;
    Ok(format!(
        "Comment added: {}",
        comment
            .get("html_url")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
    ))
}

pub(super) async fn create_issue(
    store: &ConfigStore,
    cwd: Option<&str>,
    title: &str,
    body: Option<&str>,
) -> Result<String, String> {
    let issue = context(store, cwd)
        .await?
        .manager
        .create_issue(title, body)
        .await
        .map_err(|error| error.to_string())?;
    Ok(format!(
        "Created issue #{}: {}",
        issue
            .get("number")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or_default(),
        issue
            .get("html_url")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
    ))
}

pub(super) async fn get_commit_ci(
    store: &ConfigStore,
    cwd: Option<&str>,
    sha: &str,
) -> Result<String, String> {
    let checks = context(store, cwd)
        .await?
        .manager
        .commit_checks(Some(sha))
        .await
        .map_err(|error| error.to_string())?;
    render(&checks)
}

pub(super) async fn list_workflow_runs(
    store: &ConfigStore,
    cwd: Option<&str>,
    branch: Option<&str>,
    page: u64,
) -> Result<String, String> {
    let runs = context(store, cwd)
        .await?
        .manager
        .list_workflow_runs(branch, &page.to_string())
        .await
        .map_err(|error| error.to_string())?;
    // A response with no `workflow_runs` renders as `null` here. The reference
    // hands its MCP layer a JavaScript `undefined`, which is not a JSON
    // document at all — a documented difference, confined to a payload GitHub
    // does not produce. The HTTP route, where this shape *is* reachable, omits
    // the field the way the reference does.
    render(&runs)
}
