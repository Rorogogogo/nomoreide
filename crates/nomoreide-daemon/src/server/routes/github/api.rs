//! The GitHub API, proxied for the dashboard: pull requests, issues, CI, and
//! Actions runs.
//!
//! Every route here is the same three steps — find the selected repository,
//! resolve the account that speaks for it, ask GitHub — and every one of them
//! answers a failure with **400**, whatever went wrong. That is flatter than it
//! looks: "no repository selected", "no account connected", "your token
//! expired", and "that pull request does not exist" all arrive as a 400 with a
//! sentence, because to the panel asking they are the same event — it cannot be
//! filled in, and here is why.
//!
//! Nothing here reshapes a GitHub payload beyond what the reference reshapes. A
//! panel reading an issue wants the issue, and a struct here would silently
//! drop every field GitHub adds later.

use crate::server::app::AppState;
use crate::server::body::{read_json_object, string_field};
use crate::server::errors::error;
use crate::server::query::{js_number_or, js_number_string};
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use nomoreide_core::git_manager::GitManager;
use nomoreide_core::github_context::{optional_github_context, require_github_context};
use nomoreide_core::github_manager::GithubManager;
use serde::Deserialize;
use serde_json::{json, Map, Value};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/github/branches", get(branches))
        .route("/api/github/prs", get(list_prs).post(create_pr))
        .route("/api/github/prs/:number", get(get_pr))
        .route("/api/github/prs/:number/merge", post(merge_pr))
        .route("/api/github/prs/:number/review", get(review))
        .route("/api/github/prs/:number/diff", get(pr_diff))
        .route("/api/github/issues", get(list_issues).post(create_issue))
        .route("/api/github/issues/:number", get(get_issue))
        .route(
            "/api/github/issues/:number/comments",
            get(list_comments).post(add_comment),
        )
        .route("/api/github/ci/:sha", get(commit_ci))
        .route("/api/github/runs", get(list_runs))
        .route("/api/github/runs/:run_id/jobs", get(run_jobs))
}

// --- Branches ---------------------------------------------------------------

/// The base-branch picker's whole payload: the repository, its branches, and
/// which branch this checkout is on.
async fn branches(State(state): State<AppState>) -> Response {
    let cwd = state.workspace_cwd().await;
    let manager = match manager_for(&state, &cwd).await {
        Ok(manager) => manager,
        Err(response) => return response,
    };
    // All three at once, and the local read is allowed to fail on its own — a
    // detached or empty checkout still has branches worth listing.
    let (repository, branches, status) = tokio::join!(
        manager.repo_info(),
        manager.list_branches(),
        GitManager::status(&cwd),
    );
    let repository = match repository {
        Ok(repository) => repository,
        Err(reason) => return refused(&reason.message),
    };
    let branches = match branches {
        Ok(branches) => branches,
        Err(reason) => return refused(&reason.message),
    };
    let current = status
        .ok()
        .map(|status| status.branch)
        .filter(|branch| !branch.is_empty());
    Json(json!({
        "ok": true,
        "repository": repository,
        // `??`, so a repository that really has no default branch reports null
        // rather than dropping the key.
        "defaultBranch": nullish(repository.get("default_branch")),
        "currentBranch": current,
        "branches": branches,
    }))
    .into_response()
}

// --- Pull requests ----------------------------------------------------------

#[derive(Deserialize)]
struct ListQuery {
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    page: Option<String>,
    #[serde(default)]
    branch: Option<String>,
}

impl ListQuery {
    /// The two values that go straight into GitHub's own query string.
    ///
    /// Neither is validated, because the reference does not validate them: an
    /// unknown state and a half-typed page are forwarded, and GitHub is the one
    /// that objects. Refusing here instead would reject combinations GitHub
    /// happily accepts.
    fn state(&self) -> &str {
        match self.state.as_deref() {
            Some(state) if !state.is_empty() => state,
            _ => "open",
        }
    }

    fn page(&self) -> String {
        js_number_string(js_number_or(self.page.as_deref(), 1.0))
    }
}

async fn list_prs(State(state): State<AppState>, Query(query): Query<ListQuery>) -> Response {
    let manager = match selected_manager(&state).await {
        Ok(manager) => manager,
        Err(response) => return response,
    };
    match manager.list_prs(query.state(), &query.page()).await {
        Ok(prs) => Json(json!({ "ok": true, "prs": prs })).into_response(),
        Err(reason) => refused(&reason.message),
    }
}

async fn create_pr(State(state): State<AppState>, body: Bytes) -> Response {
    let manager = match selected_manager(&state).await {
        Ok(manager) => manager,
        Err(response) => return response,
    };
    let body = read_json_object(&body);
    let title = trimmed(&body, "title");
    let head = trimmed(&body, "head");
    let base = trimmed(&body, "base");
    if title.is_empty() || head.is_empty() || base.is_empty() {
        return refused("title, head, and base are required");
    }
    match manager
        .create_pr(
            &title,
            string_field(&body, "body"),
            &head,
            &base,
            body.get("draft") == Some(&Value::Bool(true)),
        )
        .await
    {
        Ok(pr) => Json(json!({ "ok": true, "pr": pr })).into_response(),
        Err(reason) => refused(&reason.message),
    }
}

async fn get_pr(State(state): State<AppState>, Path(number): Path<String>) -> Response {
    let Some(number) = numeric_path(&number) else {
        return not_found();
    };
    let manager = match selected_manager(&state).await {
        Ok(manager) => manager,
        Err(response) => return response,
    };
    match manager.get_pr(number).await {
        Ok(pr) => Json(json!({ "ok": true, "pr": pr })).into_response(),
        Err(reason) => refused(&reason.message),
    }
}

/// Merge, with the method the caller asked for — or a squash, which is what an
/// unrecognised one becomes rather than a refusal.
async fn merge_pr(
    State(state): State<AppState>,
    Path(number): Path<String>,
    body: Bytes,
) -> Response {
    let Some(number) = numeric_path(&number) else {
        return not_found();
    };
    let manager = match selected_manager(&state).await {
        Ok(manager) => manager,
        Err(response) => return response,
    };
    let body = read_json_object(&body);
    // A filter rather than a fallback: `unwrap_or` here would forward whatever
    // the caller sent, and GitHub rejects an unknown merge method — so a typo
    // that should quietly become a squash would fail the merge instead.
    let method = string_field(&body, "method")
        .filter(|method| matches!(*method, "merge" | "squash" | "rebase"))
        .unwrap_or("squash");
    match manager
        .merge_pr(
            number,
            method,
            string_field(&body, "commitTitle"),
            string_field(&body, "commitMessage"),
        )
        .await
    {
        Ok(result) => {
            let mut answer = Map::new();
            answer.insert("ok".into(), Value::Bool(true));
            if let Value::Object(fields) = result {
                answer.extend(fields);
            }
            Json(Value::Object(answer)).into_response()
        }
        Err(reason) => refused(&reason.message),
    }
}

/// Everything the review screen shows, in one round trip's worth of latency:
/// the pull request, its files, its reviews, its comments, and its head CI.
///
/// Two waves rather than one, because the CI lookup is keyed on the head sha
/// the first call reports.
async fn review(State(state): State<AppState>, Path(number): Path<String>) -> Response {
    let Some(number) = numeric_path(&number) else {
        return not_found();
    };
    let manager = match selected_manager(&state).await {
        Ok(manager) => manager,
        Err(response) => return response,
    };
    let pr = match manager.get_pr(number).await {
        Ok(pr) => pr,
        Err(reason) => return refused(&reason.message),
    };
    // Absent when the payload's head carries no sha. Kept as "absent" rather
    // than flattened to an empty string, because the two produce different
    // requests — see `GithubManager::commit_checks`.
    let sha = pr
        .head
        .get("sha")
        .and_then(Value::as_str)
        .map(str::to_string);
    let (files, reviews, comments, checks) = tokio::join!(
        manager.list_pr_files(number),
        manager.list_pr_reviews(number),
        manager.list_issue_comments(number),
        manager.commit_checks(sha.as_deref()),
    );
    let files = match files {
        Ok(files) => files,
        Err(reason) => return refused(&reason.message),
    };
    let reviews = match reviews {
        Ok(reviews) => reviews,
        Err(reason) => return refused(&reason.message),
    };
    let comments = match comments {
        Ok(comments) => comments,
        Err(reason) => return refused(&reason.message),
    };
    let checks = match checks {
        Ok(checks) => checks,
        Err(reason) => return refused(&reason.message),
    };
    Json(json!({
        "ok": true,
        "cockpit": {
            "pr": pr,
            "files": files,
            "reviews": reviews,
            "comments": comments,
            "checks": checks,
        },
    }))
    .into_response()
}

/// The diff as text — the one route here that does not answer JSON when it
/// succeeds. It still answers the JSON envelope when it fails, because that is
/// what the reference's `catch` sends.
async fn pr_diff(State(state): State<AppState>, Path(number): Path<String>) -> Response {
    let Some(number) = numeric_path(&number) else {
        return not_found();
    };
    let manager = match selected_manager(&state).await {
        Ok(manager) => manager,
        Err(response) => return response,
    };
    match manager.pr_diff(number).await {
        Ok(diff) => (
            [(
                axum::http::header::CONTENT_TYPE,
                HeaderValue::from_static("text/plain; charset=utf-8"),
            )],
            diff,
        )
            .into_response(),
        Err(reason) => refused(&reason.message),
    }
}

// --- Issues -----------------------------------------------------------------

async fn list_issues(State(state): State<AppState>, Query(query): Query<ListQuery>) -> Response {
    let manager = match selected_manager(&state).await {
        Ok(manager) => manager,
        Err(response) => return response,
    };
    match manager.list_issues(query.state(), &query.page()).await {
        Ok(issues) => Json(json!({ "ok": true, "issues": issues })).into_response(),
        Err(reason) => refused(&reason.message),
    }
}

async fn create_issue(State(state): State<AppState>, body: Bytes) -> Response {
    let manager = match selected_manager(&state).await {
        Ok(manager) => manager,
        Err(response) => return response,
    };
    let body = read_json_object(&body);
    let title = trimmed(&body, "title");
    if title.is_empty() {
        return refused("title is required");
    }
    match manager
        .create_issue(&title, string_field(&body, "body"))
        .await
    {
        Ok(issue) => Json(json!({ "ok": true, "issue": issue })).into_response(),
        Err(reason) => refused(&reason.message),
    }
}

async fn get_issue(State(state): State<AppState>, Path(number): Path<String>) -> Response {
    let Some(number) = numeric_path(&number) else {
        return not_found();
    };
    let manager = match selected_manager(&state).await {
        Ok(manager) => manager,
        Err(response) => return response,
    };
    match manager.get_issue(number).await {
        Ok(issue) => Json(json!({ "ok": true, "issue": issue })).into_response(),
        Err(reason) => refused(&reason.message),
    }
}

async fn list_comments(State(state): State<AppState>, Path(number): Path<String>) -> Response {
    let Some(number) = numeric_path(&number) else {
        return not_found();
    };
    let manager = match selected_manager(&state).await {
        Ok(manager) => manager,
        Err(response) => return response,
    };
    match manager.list_issue_comments(number).await {
        Ok(comments) => Json(json!({ "ok": true, "comments": comments })).into_response(),
        Err(reason) => refused(&reason.message),
    }
}

async fn add_comment(
    State(state): State<AppState>,
    Path(number): Path<String>,
    body: Bytes,
) -> Response {
    let Some(number) = numeric_path(&number) else {
        return not_found();
    };
    let manager = match selected_manager(&state).await {
        Ok(manager) => manager,
        Err(response) => return response,
    };
    let body = read_json_object(&body);
    let text = trimmed(&body, "body");
    if text.is_empty() {
        return refused("body is required");
    }
    match manager.add_issue_comment(number, &text).await {
        Ok(comment) => Json(json!({ "ok": true, "comment": comment })).into_response(),
        Err(reason) => refused(&reason.message),
    }
}

// --- CI and Actions ---------------------------------------------------------

/// One commit's checks.
///
/// The only route here that answers **200 with an empty result** when no
/// account is connected, instead of a 400. The commit list renders a CI badge
/// beside every row, and a repository with no GitHub connection is not an error
/// to show forty times over — it is a page with no badges.
async fn commit_ci(State(state): State<AppState>, Path(sha): Path<String>) -> Response {
    if !is_sha(&sha) {
        return not_found();
    }
    let cwd = state.workspace_cwd().await;
    let Some(context) = optional_github_context(&state.config_store, &cwd).await else {
        return Json(json!({
            "ok": true,
            "status": { "sha": sha, "state": "unknown", "totalCount": 0, "runs": [] },
        }))
        .into_response();
    };
    match context.manager.commit_checks(Some(&sha)).await {
        Ok(status) => Json(json!({ "ok": true, "status": status })).into_response(),
        Err(reason) => refused(&reason.message),
    }
}

async fn list_runs(State(state): State<AppState>, Query(query): Query<ListQuery>) -> Response {
    let manager = match selected_manager(&state).await {
        Ok(manager) => manager,
        Err(response) => return response,
    };
    // An empty `?branch=` is no branch at all, so the query is built without it
    // rather than with a blank one.
    let branch = query.branch.as_deref().filter(|branch| !branch.is_empty());
    match manager.list_workflow_runs(branch, &query.page()).await {
        Ok(runs) => optional_field("runs", runs),
        Err(reason) => refused(&reason.message),
    }
}

async fn run_jobs(State(state): State<AppState>, Path(run_id): Path<String>) -> Response {
    let Some(run_id) = numeric_path(&run_id) else {
        return not_found();
    };
    let manager = match selected_manager(&state).await {
        Ok(manager) => manager,
        Err(response) => return response,
    };
    match manager.list_workflow_run_jobs(run_id).await {
        Ok(jobs) => optional_field("jobs", jobs),
        Err(reason) => refused(&reason.message),
    }
}

// --- Shared -----------------------------------------------------------------

/// The account that speaks for the selected repository, or the refusal to send
/// instead.
async fn selected_manager(state: &AppState) -> Result<GithubManager, Response> {
    let cwd = state.workspace_cwd().await;
    manager_for(state, &cwd).await
}

async fn manager_for(state: &AppState, cwd: &str) -> Result<GithubManager, Response> {
    require_github_context(&state.config_store, cwd)
        .await
        .map(|context| context.manager)
        .map_err(|reason| refused(&reason.to_string()))
}

/// `{ok: true, <name>: <value>}` — with the field left out entirely when GitHub
/// did not send it. The reference reads the field off the envelope and spreads
/// the result in, so a missing one becomes `undefined` and `JSON.stringify`
/// drops the key rather than writing an empty list the caller would render as
/// "nothing to show".
fn optional_field(name: &str, value: Option<Value>) -> Response {
    let mut answer = Map::new();
    answer.insert("ok".into(), Value::Bool(true));
    if let Some(value) = value {
        answer.insert(name.to_string(), value);
    }
    Json(Value::Object(answer)).into_response()
}

/// Every failure on these routes, whatever caused it.
fn refused(message: &str) -> Response {
    error(StatusCode::BAD_REQUEST, message)
}

/// A path that did not match the shape the reference's pattern requires.
///
/// The reference matches these routes by regex, so `/api/github/prs/abc` never
/// reaches a handler at all — it falls past every route to the dispatcher's own
/// HTML 404. Here the path pattern is looser, so the handler sends that answer
/// itself.
fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(
            axum::http::header::CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        )],
        "Not found",
    )
        .into_response()
}

/// `\d+`, the way the reference's route patterns spell it.
fn numeric_path(value: &str) -> Option<i64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    // A number too long to hold is still a match for the pattern; the reference
    // would carry it as an imprecise float, and either way GitHub is the one
    // that answers. Saturating keeps the request shaped like a request.
    Some(value.parse::<i64>().unwrap_or(i64::MAX))
}

/// `[0-9a-f]{4,64}` — the reference will not send just anything down a path
/// that becomes part of a URL it signs a token onto.
fn is_sha(value: &str) -> bool {
    (4..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// A string field, trimmed — and empty for anything that was not a string,
/// which is how the reference's `typeof x === "string" ? x.trim() : ""` reads.
fn trimmed(body: &Value, key: &str) -> String {
    string_field(body, key)
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// `?? null` — a field GitHub omitted or sent as null becomes an explicit null
/// rather than a missing key.
fn nullish(value: Option<&Value>) -> Value {
    match value {
        Some(Value::Null) | None => Value::Null,
        Some(value) => value.clone(),
    }
}
