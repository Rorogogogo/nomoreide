//! The GitHub REST client.
//!
//! Most responses are passed through as GitHub sent them: an agent reading an
//! issue wants the issue, and a struct here would silently drop every field
//! GitHub adds later. Only the shapes the reference *reshapes* — a pull
//! request, a commit's checks — are modelled, because those are the ones a
//! caller sees differently from what the API returned.
//!
//! The ETag revalidation cache the reference keeps at module scope is not here
//! yet: the only Rust caller is the MCP server, which is a fresh process per
//! tool call, so a cache could never be read. It belongs with the daemon's
//! GitHub routes, where it is what keeps the dashboard's polling affordable.

use regex::Regex;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::fmt;

const GITHUB_API: &str = "https://api.github.com";
const API_VERSION: &str = "2022-11-28";
const JSON_ACCEPT: &str = "application/vnd.github+json";
const DIFF_ACCEPT: &str = "application/vnd.github.diff";
// GitHub rejects API requests that do not identify their client. The former
// Node transport supplied a user agent implicitly; reqwest does not, so the
// native client must make it explicit or every valid token looks forbidden.
const USER_AGENT: &str = concat!("NoMoreIDE/", env!("CARGO_PKG_VERSION"));

/// A base URL an environment variable is allowed to move, which exists so the
/// parity gates can point a runtime at a stub they control.
///
/// Only loopback is honoured, and anything else falls back rather than
/// failing: these requests carry a bearer token or return one, and an override
/// that could name any host would turn one environment variable into a way to
/// post the user's credential somewhere else.
pub(crate) fn loopback_override(variable: &str, fallback: &str) -> String {
    let Ok(override_value) = std::env::var(variable) else {
        return fallback.to_string();
    };
    let override_value = override_value.trim();
    let rest = match override_value
        .strip_prefix("http://")
        .or_else(|| override_value.strip_prefix("https://"))
    {
        Some(rest) => rest,
        None => return fallback.to_string(),
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = match authority.rsplit_once(':') {
        Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) => host,
        _ => authority,
    };
    if !matches!(host, "127.0.0.1" | "localhost" | "[::1]" | "::1") {
        return fallback.to_string();
    }
    override_value.trim_end_matches('/').to_string()
}

/// Where API calls go. GitHub itself, unless the override names loopback.
pub fn api_base() -> String {
    loopback_override("NOMOREIDE_GITHUB_API_BASE", GITHUB_API)
}

#[derive(Debug, Clone)]
pub struct GithubApiError {
    pub message: String,
    pub status: u16,
    pub path: String,
}

impl fmt::Display for GithubApiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for GithubApiError {}

impl GithubApiError {
    fn transport(error: reqwest::Error, path: &str) -> Self {
        Self {
            message: error.to_string(),
            status: 0,
            path: path.to_string(),
        }
    }
}

/// A pull request as the reference reports one: GitHub's own fields, except
/// that a merged pull request is named "merged" rather than "closed", and the
/// two fields GitHub omits on a list response are filled in.
#[derive(Debug, Clone, Serialize)]
pub struct GithubPr {
    pub number: i64,
    pub title: String,
    pub state: String,
    pub body: Value,
    pub html_url: String,
    pub head: Value,
    pub base: Value,
    pub user: Value,
    pub created_at: String,
    pub updated_at: String,
    pub merged_at: Value,
    pub draft: bool,
    pub mergeable: Value,
}

/// One commit's checks, as the reference reports them.
///
/// `sha` and `total_count` are optional because the reference builds this
/// object out of values that can be `undefined` — a pull request head with no
/// sha, a payload with no count — and `JSON.stringify` drops a key whose value
/// is `undefined` rather than writing null.
/// A branch comparison as GitHub reports it, reshaped.
///
/// `head_sha` comes from the *last* commit in the range rather than from a
/// field of its own: GitHub's compare response names the merge base and the
/// two endpoints, but the sha this is wanted for is the tip of the branch
/// being proposed, which is the last commit it listed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubCompareSummary {
    /// `Option`, not a null: the reference copies these two straight off
    /// GitHub's payload, so a field it did not send becomes `undefined` and
    /// disappears from the answer rather than showing up as null.
    pub status: Option<Value>,
    pub ahead_by: Option<Value>,
    pub head_sha: Option<String>,
    pub commits: Vec<Value>,
    pub files: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitCiStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha: Option<String>,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_count: Option<i64>,
    pub runs: Vec<Value>,
}

pub struct GithubManager {
    token: String,
    owner: String,
    repo: String,
    base_url: String,
}

impl GithubManager {
    pub fn new(
        token: impl Into<String>,
        owner: impl Into<String>,
        repo: impl Into<String>,
    ) -> Self {
        Self {
            token: token.into(),
            owner: owner.into(),
            repo: repo.into(),
            base_url: api_base(),
        }
    }

    /// Owner and repository of a github.com remote, or None for any other host
    /// or shape. Both spellings git writes are accepted; nothing else is
    /// guessed at, because guessing wrong would send a token to the wrong repo.
    pub fn parse_remote_url(remote_url: &str) -> Option<(String, String)> {
        let trimmed = remote_url.trim();
        let https = Regex::new(r"^https?://(?:[^@]+@)?github\.com/([^/]+)/([^/]+?)(?:\.git)?/?$")
            .expect("static regex");
        if let Some(captures) = https.captures(trimmed) {
            return Some((captures[1].to_string(), captures[2].to_string()));
        }
        let ssh =
            Regex::new(r"^git@github\.com:([^/]+)/([^/]+?)(?:\.git)?$").expect("static regex");
        ssh.captures(trimmed)
            .map(|captures| (captures[1].to_string(), captures[2].to_string()))
    }

    fn repo_path(&self, suffix: &str) -> String {
        format!("/repos/{}/{}{suffix}", self.owner, self.repo)
    }

    /// The account the token speaks for. Passed through as GitHub sent it —
    /// callers read `login` and `avatar_url`, and a struct here would drop the
    /// rest of a payload the dashboard may grow into.
    pub async fn viewer(&self) -> Result<Value, GithubApiError> {
        self.get("/user").await
    }

    /// The repository itself: default branch, visibility, permissions.
    pub async fn repo_info(&self) -> Result<Value, GithubApiError> {
        self.get(&self.repo_path("")).await
    }

    /// The repository's branches, reshaped down to what a base-branch picker
    /// needs. GitHub sends far more per branch, and this list can be a hundred
    /// of them.
    ///
    /// A branch with no `commit` object is a payload GitHub does not produce;
    /// the reference reads straight through it and raises a `TypeError`, so
    /// this raises too rather than inventing an empty sha that would later be
    /// asked for as a real one.
    pub async fn list_branches(&self) -> Result<Vec<Value>, GithubApiError> {
        let path = self.repo_path("/branches?per_page=100");
        let data = self.get(&path).await?;
        array(&data)
            .iter()
            .map(|branch| {
                let commit = branch.get("commit").ok_or_else(|| GithubApiError {
                    message: "Cannot read properties of undefined (reading 'sha')".into(),
                    status: 0,
                    path: path.clone(),
                })?;
                let mut sha = Map::new();
                if let Some(value) = commit.get("sha") {
                    sha.insert("sha".into(), value.clone());
                }
                let mut out = Map::new();
                copy(&mut out, branch, "name");
                copy(&mut out, branch, "protected");
                out.insert("commit".into(), Value::Object(sha));
                Ok(Value::Object(out))
            })
            .collect()
    }

    /// The files one pull request touches, reshaped: `filename` is renamed to
    /// `path`, and the counts and the patch are carried through as sent — a
    /// field GitHub omitted stays omitted, because a huge diff arrives with no
    /// `patch` at all and a `null` there would read as "no changes".
    pub async fn list_pr_files(&self, number: i64) -> Result<Vec<Value>, GithubApiError> {
        let data = self
            .get(&self.repo_path(&format!("/pulls/{number}/files?per_page=100")))
            .await?;
        Ok(array(&data)
            .iter()
            .map(|file| {
                let mut out = Map::new();
                if let Some(value) = file.get("filename") {
                    out.insert("path".into(), value.clone());
                }
                for key in [
                    "status",
                    "additions",
                    "deletions",
                    "changes",
                    "patch",
                    "blob_url",
                ] {
                    copy(&mut out, file, key);
                }
                Value::Object(out)
            })
            .collect())
    }

    pub async fn list_pr_reviews(&self, number: i64) -> Result<Vec<Value>, GithubApiError> {
        let data = self
            .get(&self.repo_path(&format!("/pulls/{number}/reviews?per_page=100")))
            .await?;
        Ok(array(&data).to_vec())
    }

    /// The jobs of one run, with the same envelope rule as
    /// [`Self::list_workflow_runs`].
    pub async fn list_workflow_run_jobs(
        &self,
        run_id: i64,
    ) -> Result<Option<Value>, GithubApiError> {
        let data = self
            .get(&self.repo_path(&format!("/actions/runs/{run_id}/jobs?per_page=100")))
            .await?;
        Ok(data.get("jobs").cloned())
    }

    /// `page` and `state` arrive already rendered, because the reference puts
    /// whatever the caller sent into the URL — a half-typed page number reaches
    /// GitHub as GitHub's problem, not as a refusal here.
    /// What `head` adds on top of `base`, according to GitHub.
    ///
    /// Both refs are escaped on the way into the path. A branch name may
    /// contain a `/` — `feat/thing` is the usual spelling — and an unescaped
    /// one would split the path segment and ask about a repository that does
    /// not exist.
    pub async fn compare_branches(
        &self,
        base: &str,
        head: &str,
    ) -> Result<GithubCompareSummary, GithubApiError> {
        let path = self.repo_path(&format!(
            "/compare/{}...{}",
            encode_uri_component(base),
            encode_uri_component(head)
        ));
        let data = self.get(&path).await?;
        let commits = array(data.get("commits").unwrap_or(&Value::Null)).to_vec();
        Ok(GithubCompareSummary {
            status: data.get("status").cloned(),
            ahead_by: data.get("ahead_by").cloned(),
            head_sha: commits
                .last()
                .and_then(|commit| commit.get("sha"))
                .and_then(Value::as_str)
                .map(str::to_string),
            commits: commits
                .iter()
                .map(|commit| {
                    let mut out = Map::new();
                    copy(&mut out, commit, "sha");
                    out.insert(
                        "message".into(),
                        Value::String(first_line(
                            commit
                                .get("commit")
                                .and_then(|inner| inner.get("message"))
                                .and_then(Value::as_str)
                                .unwrap_or_default(),
                        )),
                    );
                    Value::Object(out)
                })
                .collect(),
            // A comparison too large for GitHub to enumerate carries no
            // `files` at all, which the reference reads as none.
            files: array(data.get("files").unwrap_or(&Value::Null))
                .iter()
                .map(|file| {
                    let mut out = Map::new();
                    if let Some(value) = file.get("filename") {
                        out.insert("path".into(), value.clone());
                    }
                    for key in ["status", "additions", "deletions", "changes"] {
                        copy(&mut out, file, key);
                    }
                    Value::Object(out)
                })
                .collect(),
        })
    }

    pub async fn list_prs(&self, state: &str, page: &str) -> Result<Vec<GithubPr>, GithubApiError> {
        let path = self.repo_path(&format!("/pulls?state={state}&per_page=30&page={page}"));
        let data = self.get(&path).await?;
        Ok(array(&data).iter().map(normalize_pr).collect())
    }

    pub async fn get_pr(&self, number: i64) -> Result<GithubPr, GithubApiError> {
        let data = self
            .get(&self.repo_path(&format!("/pulls/{number}")))
            .await?;
        Ok(normalize_pr(&data))
    }

    pub async fn pr_diff(&self, number: i64) -> Result<String, GithubApiError> {
        self.text(&self.repo_path(&format!("/pulls/{number}")))
            .await
    }

    pub async fn create_pr(
        &self,
        title: &str,
        body: Option<&str>,
        head: &str,
        base: &str,
        draft: bool,
    ) -> Result<GithubPr, GithubApiError> {
        let mut payload = Map::new();
        payload.insert("title".into(), json!(title));
        // Absent rather than null: the reference spreads an optional field in
        // only when it has one, and GitHub reads a null title as a change.
        if let Some(body) = body {
            payload.insert("body".into(), json!(body));
        }
        payload.insert("head".into(), json!(head));
        payload.insert("base".into(), json!(base));
        payload.insert("draft".into(), json!(draft));
        let data = self
            .send(
                "POST",
                &self.repo_path("/pulls"),
                Some(Value::Object(payload)),
            )
            .await?;
        Ok(normalize_pr(&data))
    }

    /// Squash by default — the common "Squash & merge" button. GitHub answers
    /// 405 when the pull request is not mergeable (conflicts, failing required
    /// checks, branch protection), and that message reaches the caller.
    pub async fn merge_pr(
        &self,
        number: i64,
        method: &str,
        commit_title: Option<&str>,
        commit_message: Option<&str>,
    ) -> Result<Value, GithubApiError> {
        let mut payload = Map::new();
        payload.insert("merge_method".into(), json!(method));
        if let Some(title) = commit_title.filter(|value| !value.is_empty()) {
            payload.insert("commit_title".into(), json!(title));
        }
        if let Some(message) = commit_message.filter(|value| !value.is_empty()) {
            payload.insert("commit_message".into(), json!(message));
        }
        self.send(
            "PUT",
            &self.repo_path(&format!("/pulls/{number}/merge")),
            Some(Value::Object(payload)),
        )
        .await
    }

    /// The issues endpoint answers with pull requests too, and they are dropped
    /// here — a caller asking for issues did not ask for those.
    pub async fn list_issues(&self, state: &str, page: &str) -> Result<Vec<Value>, GithubApiError> {
        let path = self.repo_path(&format!("/issues?state={state}&per_page=30&page={page}"));
        let data = self.get(&path).await?;
        Ok(array(&data)
            .iter()
            .filter(|issue| !has_content(issue.get("pull_request")))
            .cloned()
            .collect())
    }

    pub async fn get_issue(&self, number: i64) -> Result<Value, GithubApiError> {
        self.get(&self.repo_path(&format!("/issues/{number}")))
            .await
    }

    pub async fn create_issue(
        &self,
        title: &str,
        body: Option<&str>,
    ) -> Result<Value, GithubApiError> {
        let mut payload = Map::new();
        payload.insert("title".into(), json!(title));
        if let Some(body) = body {
            payload.insert("body".into(), json!(body));
        }
        self.send(
            "POST",
            &self.repo_path("/issues"),
            Some(Value::Object(payload)),
        )
        .await
    }

    pub async fn list_issue_comments(&self, number: i64) -> Result<Vec<Value>, GithubApiError> {
        let path = self.repo_path(&format!("/issues/{number}/comments?per_page=100"));
        Ok(array(&self.get(&path).await?).to_vec())
    }

    pub async fn add_issue_comment(
        &self,
        number: i64,
        body: &str,
    ) -> Result<Value, GithubApiError> {
        self.send(
            "POST",
            &self.repo_path(&format!("/issues/{number}/comments")),
            Some(json!({ "body": body })),
        )
        .await
    }

    /// A commit nobody has run checks on, and a commit GitHub has never heard
    /// of, are both answered rather than raised: neither has a CI state, and an
    /// agent asking about a stale SHA does not need an exception for it.
    /// One commit's checks, or "unknown" when GitHub has never heard of it.
    ///
    /// `sha` is optional because one caller has no sha to give: a pull request
    /// whose head payload carries none. That call still happens — the reference
    /// interpolates the missing value into the URL, asking after a commit
    /// literally named `undefined` — and is reproduced here so both runtimes
    /// make the same request. GitHub answers 404 to it either way.
    pub async fn commit_checks(&self, sha: Option<&str>) -> Result<CommitCiStatus, GithubApiError> {
        let path = self.repo_path(&format!(
            "/commits/{}/check-runs?per_page=100",
            sha.unwrap_or("undefined")
        ));
        match self.get(&path).await {
            Ok(data) => {
                // A payload with no `check_runs` is one the reference cannot
                // read either: it counts them before looking at them, and
                // raises rather than reporting a commit with no checks.
                let runs = data
                    .get("check_runs")
                    .and_then(Value::as_array)
                    .ok_or_else(|| GithubApiError {
                        message: "Cannot read properties of undefined (reading 'length')".into(),
                        status: 0,
                        path: path.clone(),
                    })?
                    .clone();
                Ok(CommitCiStatus {
                    sha: sha.map(str::to_string),
                    state: derive_state(&runs).to_string(),
                    total_count: data.get("total_count").and_then(Value::as_i64),
                    runs,
                })
            }
            Err(error) if error.status == 404 => Ok(CommitCiStatus {
                sha: sha.map(str::to_string),
                state: "unknown".to_string(),
                total_count: Some(0),
                runs: Vec::new(),
            }),
            Err(error) => Err(error),
        }
    }

    /// The runs GitHub reports, exactly as it reports them.
    ///
    /// `Option`, not an empty list: the reference reads one field out of the
    /// envelope and passes it on, so a payload without that field yields
    /// nothing at all — and a caller that renders "no runs" for a *missing*
    /// field would be reporting a broken response as an empty one.
    pub async fn list_workflow_runs(
        &self,
        branch: Option<&str>,
        page: &str,
    ) -> Result<Option<Value>, GithubApiError> {
        // The branch is appended after the other two, so it is last in the
        // query — which is what the request the reference makes looks like.
        let mut query = format!("per_page=30&page={page}");
        if let Some(branch) = branch {
            query.push_str(&format!("&branch={branch}"));
        }
        let data = self
            .get(&self.repo_path(&format!("/actions/runs?{query}")))
            .await?;
        Ok(data.get("workflow_runs").cloned())
    }

    async fn get(&self, path: &str) -> Result<Value, GithubApiError> {
        self.send("GET", path, None).await
    }

    async fn send(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, GithubApiError> {
        let response = self.dispatch(method, path, body, JSON_ACCEPT).await?;
        let status = response.status();
        let reason = status.canonical_reason().unwrap_or("").to_string();
        let text = response
            .text()
            .await
            .map_err(|error| GithubApiError::transport(error, path))?;
        if !status.is_success() {
            // GitHub explains itself in a `message`; anything else that failed
            // is named by its status line instead.
            let message = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|value| {
                    value
                        .get("message")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or(reason);
            return Err(GithubApiError {
                message,
                status: status.as_u16(),
                path: path.to_string(),
            });
        }
        serde_json::from_str(&text).map_err(|error| GithubApiError {
            message: error.to_string(),
            status: status.as_u16(),
            path: path.to_string(),
        })
    }

    /// A diff is text, and a failed one is whatever the server wrote — not a
    /// `message` field, because a diff response was never JSON to begin with.
    async fn text(&self, path: &str) -> Result<String, GithubApiError> {
        let response = self.dispatch("GET", path, None, DIFF_ACCEPT).await?;
        let status = response.status();
        let reason = status.canonical_reason().unwrap_or("").to_string();
        let text = response.text().await;
        if !status.is_success() {
            return Err(GithubApiError {
                message: text.unwrap_or(reason),
                status: status.as_u16(),
                path: path.to_string(),
            });
        }
        text.map_err(|error| GithubApiError::transport(error, path))
    }

    async fn dispatch(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        accept: &str,
    ) -> Result<reqwest::Response, GithubApiError> {
        let url = format!("{}{path}", self.base_url);
        let client = reqwest::Client::new();
        let mut request = client
            .request(
                reqwest::Method::from_bytes(method.as_bytes()).expect("static method"),
                &url,
            )
            .header("Authorization", format!("Bearer {}", self.token))
            .header("Accept", accept)
            .header("User-Agent", USER_AGENT)
            .header("X-GitHub-Api-Version", API_VERSION);
        if let Some(body) = body {
            request = request.json(&body);
        }
        request
            .send()
            .await
            .map_err(|error| GithubApiError::transport(error, path))
    }
}

/// A commit subject: the first line of its message, trimmed. A body below it
/// is not a title, and a title is what the caller is building.
fn first_line(message: &str) -> String {
    message
        .split(['\r', '\n'])
        .next()
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// `encodeURIComponent`, whose unreserved set is wider than a URL crate's
/// default. Matching it matters because the resulting path is compared against
/// the reference request for request.
fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(byte as char),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}

/// Carry one field across only when it is there. A key the source object does
/// not have becomes `undefined` on the reference's side, which `JSON.stringify`
/// drops — so the way to match it is to not write the key at all. A key it sent
/// as null is a value, and is copied.
fn copy(out: &mut Map<String, Value>, source: &Value, key: &str) {
    if let Some(value) = source.get(key) {
        out.insert(key.to_string(), value.clone());
    }
}

/// Whether the field is there at all. GitHub marks a pull request by *having* a
/// `pull_request` object; an issue does not carry the key.
fn has_content(value: Option<&Value>) -> bool {
    !matches!(value, None | Some(Value::Null))
}

fn normalize_pr(pr: &Value) -> GithubPr {
    let merged_at = pr.get("merged_at").cloned().unwrap_or(Value::Null);
    // GitHub calls a merged pull request "closed"; the two are worth telling
    // apart to anyone reading a list of them.
    let state = if has_content(Some(&merged_at)) {
        "merged".to_string()
    } else {
        pr.get("state")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    GithubPr {
        number: pr.get("number").and_then(Value::as_i64).unwrap_or_default(),
        title: string_at(pr, "title"),
        state,
        body: pr.get("body").cloned().unwrap_or(Value::Null),
        html_url: string_at(pr, "html_url"),
        head: pr.get("head").cloned().unwrap_or(Value::Null),
        base: pr.get("base").cloned().unwrap_or(Value::Null),
        user: pr.get("user").cloned().unwrap_or(Value::Null),
        created_at: string_at(pr, "created_at"),
        updated_at: string_at(pr, "updated_at"),
        merged_at,
        // Absent on a list response, and false is the answer a caller needs.
        draft: pr.get("draft").and_then(Value::as_bool).unwrap_or(false),
        // Absent means GitHub has not computed it yet, which is not the same
        // as "not mergeable" — so it stays null rather than becoming false.
        mergeable: pr.get("mergeable").cloned().unwrap_or(Value::Null),
    }
}

fn string_at(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// One state for a commit's whole check suite. Anything still running wins
/// over anything finished, because the answer is not final yet.
fn derive_state(runs: &[Value]) -> &'static str {
    if runs.is_empty() {
        return "unknown";
    }
    fn status(run: &Value) -> &str {
        run.get("status").and_then(Value::as_str).unwrap_or("")
    }
    fn conclusion(run: &Value) -> &str {
        run.get("conclusion").and_then(Value::as_str).unwrap_or("")
    }
    if runs
        .iter()
        .any(|run| matches!(status(run), "in_progress" | "queued"))
    {
        return "pending";
    }
    if runs
        .iter()
        .all(|run| matches!(conclusion(run), "success" | "skipped" | "neutral"))
    {
        return "success";
    }
    if runs
        .iter()
        .any(|run| matches!(conclusion(run), "failure" | "timed_out"))
    {
        return "failure";
    }
    "error"
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn both_spellings_of_a_github_remote_name_the_same_repository() {
        let expected = Some(("owner".to_string(), "repo".to_string()));
        for remote in [
            "https://github.com/owner/repo.git",
            "https://github.com/owner/repo",
            "https://github.com/owner/repo/",
            "http://user@github.com/owner/repo.git",
            "git@github.com:owner/repo.git",
            "git@github.com:owner/repo",
        ] {
            assert_eq!(
                GithubManager::parse_remote_url(remote),
                expected,
                "{remote}"
            );
        }
    }

    #[tokio::test]
    async fn native_requests_identify_nomoreide_to_github() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let count = stream.read(&mut chunk).unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..count]);
            }
            let body = r#"{"login":"octocat"}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body,
            )
            .unwrap();
            String::from_utf8(request).unwrap()
        });
        let manager = GithubManager {
            token: "valid-token".into(),
            owner: String::new(),
            repo: String::new(),
            base_url: format!("http://{address}"),
        };

        assert_eq!(manager.viewer().await.unwrap()["login"], "octocat");
        let request = server.join().unwrap().to_ascii_lowercase();
        assert!(request.contains(&format!("user-agent: {}", USER_AGENT.to_ascii_lowercase())));
    }

    /// A remote on another host is not a GitHub repository, and a token meant
    /// for github.com must never be sent to one.
    #[test]
    fn a_remote_that_is_not_github_is_not_guessed_at() {
        for remote in [
            "https://gitlab.com/owner/repo.git",
            "git@gitlab.com:owner/repo.git",
            "https://github.com.evil.example/owner/repo.git",
            "https://github.com/owner",
            "",
        ] {
            assert_eq!(GithubManager::parse_remote_url(remote), None, "{remote}");
        }
    }

    #[test]
    fn a_merged_pull_request_is_named_merged_rather_than_closed() {
        let merged =
            normalize_pr(&json!({ "state": "closed", "merged_at": "2026-01-03T00:00:00Z" }));
        assert_eq!(merged.state, "merged");
        let closed = normalize_pr(&json!({ "state": "closed", "merged_at": null }));
        assert_eq!(closed.state, "closed");
    }

    /// A list response omits both, and they mean different things: nobody has
    /// marked it a draft, versus GitHub has not worked out whether it merges.
    #[test]
    fn the_two_fields_a_list_response_omits_get_different_defaults() {
        let pr = normalize_pr(&json!({ "state": "open" }));
        assert!(!pr.draft);
        assert_eq!(pr.mergeable, Value::Null);
    }

    #[test]
    fn a_check_suite_reports_the_state_that_is_not_final_first() {
        let run =
            |status: &str, conclusion: Value| json!({ "status": status, "conclusion": conclusion });
        assert_eq!(derive_state(&[]), "unknown");
        assert_eq!(
            derive_state(&[
                run("completed", json!("failure")),
                run("queued", Value::Null)
            ]),
            "pending"
        );
        assert_eq!(
            derive_state(&[
                run("completed", json!("success")),
                run("completed", json!("skipped"))
            ]),
            "success"
        );
        assert_eq!(
            derive_state(&[
                run("completed", json!("success")),
                run("completed", json!("timed_out"))
            ]),
            "failure"
        );
        assert_eq!(
            derive_state(&[run("completed", json!("cancelled"))]),
            "error"
        );
    }

    /// The override exists for the parity gate. Anything that is not loopback
    /// would be a way to make one environment variable post the user's token
    /// somewhere else, so it is ignored rather than obeyed.
    #[test]
    fn only_a_loopback_api_base_is_honoured() {
        let cases = [
            ("http://127.0.0.1:8080", "http://127.0.0.1:8080"),
            ("http://localhost:1/", "http://localhost:1"),
            ("http://attacker.example", GITHUB_API),
            ("http://127.0.0.1.evil.example", GITHUB_API),
            ("ftp://127.0.0.1", GITHUB_API),
            ("not a url", GITHUB_API),
            ("", GITHUB_API),
        ];
        for (value, expected) in cases {
            std::env::set_var("NOMOREIDE_GITHUB_API_BASE", value);
            assert_eq!(api_base(), expected, "{value}");
        }
        std::env::remove_var("NOMOREIDE_GITHUB_API_BASE");
        assert_eq!(api_base(), GITHUB_API);
    }
}
