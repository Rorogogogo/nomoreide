//! The read-only half of the remote surface: CI, pull requests, agent usage,
//! the error inbox and the timeline.
//!
//! Its own module rather than seven more methods on the dispatcher, for the
//! reason the repository's own size budget names: `dispatcher.rs` is already
//! the largest file in the crate, and everything here is one shape repeated —
//! call a route, reshape the answer, drop what must not leave. The dispatcher
//! keeps the routing; this keeps the reshaping.
//!
//! **The reshaping is the security boundary, and it is all in free functions
//! that take JSON and return wire types.** That is deliberate: it means the
//! tests below can assert what does *not* come out — a repository path, a pid,
//! a stack trace naming somebody's home directory — without a daemon, a
//! network, or a GitHub account. A field that must never cross is a field with
//! a test that feeds it in and watches it disappear.
//!
//! Nothing here mutates anything. There is no re-run, no cancel, no merge, no
//! dismiss. The local product has all four; they belong to `nomoreide-actions`
//! and to a person at the machine, and a phone that can watch CI is a different
//! permission from a phone that can restart it.

use axum::http::{Method, StatusCode};
use nomoreide_core::remote::protocol::device_bound::{
    ErrorsRequest, GithubPullRequestRef, GithubPullsRequest, GithubRunJobsRequest,
    GithubRunsRequest, PullRequestFilter, TimelineRequest,
};
use nomoreide_core::remote::protocol::errors::{ErrorCode, ProtocolError};
use nomoreide_core::remote::protocol::limits;
use nomoreide_core::remote::protocol::platform_bound::{
    AgentUsageResponse, ErrorsResponse, GithubPullResponse, GithubPullsResponse,
    GithubRunJobsResponse, GithubRunsResponse, TimelineResponse,
};
use nomoreide_core::remote::protocol::snapshot::{
    IncidentLevel, PullRequestState, RemoteAgentUsage, RemoteClaudeUsage, RemoteCodexUsage,
    RemoteIncident, RemoteModelUsage, RemotePullRequest, RemoteTimelineEntry, RemoteUsageWindow,
    RemoteWorkflowJob, RemoteWorkflowRun, RunConclusion, RunStatus, TimelineSeverity,
};
use nomoreide_core::remote::protocol::PlatformBound;
use serde_json::Value;

use super::dispatcher::RouterDispatcher;

// --- GitHub Actions ----------------------------------------------------------

pub(super) async fn workflow_runs(
    dispatcher: &RouterDispatcher,
    request: &GithubRunsRequest,
) -> Result<PlatformBound, ProtocolError> {
    let wanted = clamp(request.limit, limits::MAX_WORKFLOW_RUNS);
    // The branch is the one caller-supplied value in this path, and a branch
    // name may legitimately contain a `/` — so it is percent-encoded whole,
    // exactly as a service name is, rather than trusted to be one segment.
    let mut path = "/api/github/runs?page=1".to_string();
    if let Some(branch) = request.branch.as_deref().filter(|it| !it.is_empty()) {
        path.push_str(&format!("&branch={}", RouterDispatcher::segment(branch)));
    }
    let (status, body) = dispatcher.call(Method::GET, &path).await?;
    github_failure(status, &body)?;

    // The route omits the key entirely when GitHub sent nothing, which is not
    // the same as an empty list — but for a phone it renders the same, and
    // "GitHub is not connected" already arrived as a refusal above.
    let all = array(&body, "runs");
    let truncated = all.len() > wanted;
    Ok(PlatformBound::GithubRuns(GithubRunsResponse {
        runs: all.iter().take(wanted).map(workflow_run).collect(),
        branch: request.branch.clone(),
        truncated,
    }))
}

pub(super) async fn workflow_run_jobs(
    dispatcher: &RouterDispatcher,
    request: &GithubRunJobsRequest,
) -> Result<PlatformBound, ProtocolError> {
    // The one caller-supplied value on this surface that becomes a whole path
    // segment the route then parses as a number. Percent-encoding would make it
    // safe as a *path*; refusing it makes it safe as an *argument*, and the
    // route's own answer to a non-numeric id is the SPA's 404, which would
    // reach a phone as an unexplained internal error.
    if request.run_id.is_empty() || !request.run_id.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(ProtocolError::new(
            ErrorCode::MalformedFrame,
            "That is not a workflow run id.",
        ));
    }
    let path = format!("/api/github/runs/{}/jobs", request.run_id);
    let (status, body) = dispatcher.call(Method::GET, &path).await?;
    github_failure(status, &body)?;

    let all = array(&body, "jobs");
    let truncated = all.len() > limits::MAX_WORKFLOW_JOBS;
    Ok(PlatformBound::GithubRunJobs(GithubRunJobsResponse {
        run_id: request.run_id.clone(),
        jobs: all
            .iter()
            .take(limits::MAX_WORKFLOW_JOBS)
            .map(workflow_job)
            .collect(),
        truncated,
    }))
}

// --- Pull requests -----------------------------------------------------------

pub(super) async fn pull_requests(
    dispatcher: &RouterDispatcher,
    request: &GithubPullsRequest,
) -> Result<PlatformBound, ProtocolError> {
    let wanted = clamp(request.limit, limits::MAX_PULL_REQUESTS);
    let state = match request.state.unwrap_or(PullRequestFilter::Open) {
        PullRequestFilter::Open => "open",
        PullRequestFilter::Closed => "closed",
        PullRequestFilter::All => "all",
    };
    let (status, body) = dispatcher
        .call(
            Method::GET,
            &format!("/api/github/prs?state={state}&page=1"),
        )
        .await?;
    github_failure(status, &body)?;

    let all = array(&body, "prs");
    let truncated = all.len() > wanted;
    Ok(PlatformBound::GithubPulls(GithubPullsResponse {
        pulls: all.iter().take(wanted).map(pull_request).collect(),
        truncated,
    }))
}

pub(super) async fn pull_request_detail(
    dispatcher: &RouterDispatcher,
    request: &GithubPullRequestRef,
) -> Result<PlatformBound, ProtocolError> {
    let (status, body) = dispatcher
        .call(Method::GET, &format!("/api/github/prs/{}", request.number))
        .await?;
    github_failure(status, &body)?;

    let pull = body.get("pr").cloned().unwrap_or(Value::Null);
    if pull.is_null() {
        return Err(ProtocolError::new(
            ErrorCode::ServiceActionFailed,
            "GitHub did not return that pull request.",
        )
        .with_detail(request.number.to_string()));
    }
    Ok(PlatformBound::GithubPull(GithubPullResponse {
        pull: pull_request(&pull),
    }))
}

// --- Agent usage -------------------------------------------------------------

pub(super) async fn agent_usage(
    dispatcher: &RouterDispatcher,
) -> Result<PlatformBound, ProtocolError> {
    let (_, body) = dispatcher.call(Method::GET, "/api/agent/usage").await?;
    // A machine where neither agent has ever run answers `{}`, and that is a
    // real answer rather than a refusal — the phone renders "nothing yet".
    let usage = body.get("usage").cloned().unwrap_or(Value::Null);
    Ok(PlatformBound::AgentUsage(AgentUsageResponse {
        usage: RemoteAgentUsage {
            claude: usage.get("claude").map(claude_usage),
            codex: usage.get("codex").map(codex_usage),
        },
    }))
}

// --- The error inbox and the timeline ----------------------------------------

pub(super) async fn errors(
    dispatcher: &RouterDispatcher,
    request: &ErrorsRequest,
) -> Result<PlatformBound, ProtocolError> {
    let wanted = clamp(request.limit, limits::MAX_INCIDENTS);
    let (_, body) = dispatcher
        .call(Method::GET, &format!("/api/errors?limit={wanted}"))
        .await?;
    let all = array(&body, "incidents");
    let truncated = all.len() > wanted;
    Ok(PlatformBound::Errors(ErrorsResponse {
        incidents: all.iter().take(wanted).map(incident).collect(),
        truncated,
    }))
}

pub(super) async fn timeline(
    dispatcher: &RouterDispatcher,
    request: &TimelineRequest,
) -> Result<PlatformBound, ProtocolError> {
    let wanted = clamp(request.limit, limits::MAX_TIMELINE_ENTRIES);
    let (_, body) = dispatcher
        .call(Method::GET, &format!("/api/timeline?limit={wanted}"))
        .await?;
    let all = array(&body, "timeline");
    let truncated = all.len() > wanted;
    Ok(PlatformBound::Timeline(TimelineResponse {
        entries: all.iter().take(wanted).map(timeline_entry).collect(),
        truncated,
    }))
}

// --- Reshaping ---------------------------------------------------------------

fn workflow_run(run: &Value) -> RemoteWorkflowRun {
    RemoteWorkflowRun {
        // GitHub sends this as a JSON number; it crosses as a string so a
        // browser's `Number` cannot round it. `run_id` on the way back in is a
        // string for the same reason, and the two must agree.
        id: identifier(run, "id"),
        name: text(run, "name").unwrap_or_else(|| "workflow".to_string()),
        title: text(run, "display_title"),
        branch: text(run, "head_branch"),
        event: text(run, "event"),
        number: run.get("run_number").and_then(Value::as_u64),
        status: run_status(run.get("status").and_then(Value::as_str)),
        conclusion: run
            .get("conclusion")
            .and_then(Value::as_str)
            .map(run_conclusion),
        started_at: text(run, "run_started_at").or_else(|| text(run, "created_at")),
        updated_at: text(run, "updated_at"),
        url: github_url(run, "html_url"),
    }
}

fn workflow_job(job: &Value) -> RemoteWorkflowJob {
    RemoteWorkflowJob {
        id: identifier(job, "id"),
        name: text(job, "name").unwrap_or_else(|| "job".to_string()),
        status: run_status(job.get("status").and_then(Value::as_str)),
        conclusion: job
            .get("conclusion")
            .and_then(Value::as_str)
            .map(run_conclusion),
        started_at: text(job, "started_at"),
        completed_at: text(job, "completed_at"),
        url: github_url(job, "html_url"),
    }
}

/// GitHub's status words, collapsed to the four a phone can draw.
fn run_status(status: Option<&str>) -> RunStatus {
    match status {
        Some("queued" | "requested" | "pending") => RunStatus::Queued,
        Some("in_progress") => RunStatus::InProgress,
        Some("waiting" | "action_required") => RunStatus::Waiting,
        Some("completed") => RunStatus::Completed,
        _ => RunStatus::Unknown,
    }
}

fn run_conclusion(conclusion: &str) -> RunConclusion {
    match conclusion {
        "success" => RunConclusion::Success,
        "failure" => RunConclusion::Failure,
        "cancelled" => RunConclusion::Cancelled,
        "skipped" => RunConclusion::Skipped,
        "timed_out" => RunConclusion::TimedOut,
        "action_required" => RunConclusion::ActionRequired,
        "neutral" => RunConclusion::Neutral,
        "stale" => RunConclusion::Stale,
        _ => RunConclusion::Unknown,
    }
}

fn pull_request(pull: &Value) -> RemotePullRequest {
    RemotePullRequest {
        number: pull
            .get("number")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        title: text(pull, "title").unwrap_or_default(),
        state: match pull.get("state").and_then(Value::as_str) {
            Some("open") => PullRequestState::Open,
            // The daemon has already folded GitHub's merged-is-closed trick
            // into a third word; both spellings are read so this does not
            // depend on that having happened.
            Some("merged") => PullRequestState::Merged,
            Some("closed") => {
                if pull.get("merged_at").is_some_and(|at| !at.is_null()) {
                    PullRequestState::Merged
                } else {
                    PullRequestState::Closed
                }
            }
            _ => PullRequestState::Unknown,
        },
        draft: pull.get("draft").and_then(Value::as_bool).unwrap_or(false),
        // A login, never `name` or `email` — the other two fields on the same
        // object, and the two that identify a person rather than an account.
        author: pull.get("user").and_then(|user| text(user, "login")),
        head_branch: pull.get("head").and_then(|head| text(head, "ref")),
        base_branch: pull.get("base").and_then(|base| text(base, "ref")),
        updated_at: text(pull, "updated_at"),
        url: github_url(pull, "html_url"),
    }
}

fn claude_usage(usage: &Value) -> RemoteClaudeUsage {
    RemoteClaudeUsage {
        five_hour: usage.get("fiveHour").and_then(usage_window),
        weekly: usage.get("weekly").and_then(usage_window),
        cost_usd: number(usage, "costUSD"),
        input_tokens: counter(usage, "inputTokens"),
        output_tokens: counter(usage, "outputTokens"),
        cache_read_input_tokens: counter(usage, "cacheReadInputTokens"),
        cache_creation_input_tokens: counter(usage, "cacheCreationInputTokens"),
        lines_added: counter(usage, "linesAdded"),
        lines_removed: counter(usage, "linesRemoved"),
        // Already dearest-first from the local reader, and bounded here because
        // the number of models in a project's file is not this side's to
        // assume.
        models: usage
            .get("models")
            .and_then(Value::as_array)
            .map(|models| models.iter().take(MAX_MODELS).map(model_usage).collect())
            .unwrap_or_default(),
    }
}

/// How many per-model rows cross. A phone shows two or three; the file can hold
/// every model the account has ever touched.
const MAX_MODELS: usize = 8;

fn model_usage(model: &Value) -> RemoteModelUsage {
    RemoteModelUsage {
        model: text(model, "model").unwrap_or_default(),
        input_tokens: counter(model, "inputTokens"),
        output_tokens: counter(model, "outputTokens"),
        cost_usd: number(model, "costUSD"),
    }
}

fn codex_usage(usage: &Value) -> RemoteCodexUsage {
    RemoteCodexUsage {
        primary: usage.get("primary").and_then(usage_window),
        secondary: usage.get("secondary").and_then(usage_window),
        input_tokens: counter(usage, "inputTokens"),
        output_tokens: counter(usage, "outputTokens"),
        total_tokens: counter(usage, "totalTokens"),
        context_window: usage
            .get("contextWindow")
            .and_then(Value::as_f64)
            .filter(|window| window.is_finite() && *window > 0.0)
            .map(|window| window as u64),
        at: text(usage, "timestamp"),
    }
}

/// A window, or nothing.
///
/// The local reader already drops a window whose reset is not a positive
/// instant, so an object arriving here has one. Read defensively anyway: this
/// is the only field on the usage surface a phone draws a countdown from, and a
/// zero would render as "resets in 56 years".
fn usage_window(window: &Value) -> Option<RemoteUsageWindow> {
    if !window.is_object() {
        return None;
    }
    let resets_at = window
        .get("resetsAtUnix")
        .and_then(Value::as_f64)
        .filter(|reset| reset.is_finite() && *reset > 0.0)
        .map(|reset| reset as i64);
    Some(RemoteUsageWindow {
        used_percent: window
            .get("usedPercent")
            .and_then(Value::as_f64)
            .filter(|percent| percent.is_finite())
            .unwrap_or_default(),
        resets_at_unix: resets_at,
        window_minutes: window
            .get("windowMinutes")
            .and_then(Value::as_f64)
            .filter(|minutes| minutes.is_finite() && *minutes > 0.0)
            .map(|minutes| minutes as u32),
    })
}

fn incident(incident: &Value) -> RemoteIncident {
    RemoteIncident {
        id: identifier(incident, "id"),
        service: text(incident, "service").unwrap_or_default(),
        level: match incident.get("level").and_then(Value::as_str) {
            Some("error") => IncidentLevel::Error,
            Some("warn" | "warning") => IncidentLevel::Warning,
            Some("info") => IncidentLevel::Info,
            _ => IncidentLevel::Unknown,
        },
        title: cut(text(incident, "title").unwrap_or_default()),
        // The basename, and only the basename. A stack trace's path names the
        // checkout, the user's home directory and often the user — and "which
        // file" is the whole of what a phone can use.
        file: text(incident, "file").as_deref().map(basename),
        line: incident
            .get("line")
            .and_then(Value::as_u64)
            .map(|line| line as u32),
        first_seen: text(incident, "firstSeen").unwrap_or_default(),
        last_seen: text(incident, "lastSeen").unwrap_or_default(),
        count: incident.get("count").and_then(Value::as_u64).unwrap_or(1),
        // `logExcerpt` is deliberately not read. See `RemoteIncident`.
    }
}

fn timeline_entry(event: &Value) -> RemoteTimelineEntry {
    RemoteTimelineEntry {
        id: identifier(event, "id"),
        at: text(event, "timestamp").unwrap_or_default(),
        kind: text(event, "kind").unwrap_or_else(|| "unknown".to_string()),
        service: text(event, "service"),
        severity: match event.get("severity").and_then(Value::as_str) {
            Some("error") => TimelineSeverity::Error,
            Some("warning" | "warn") => TimelineSeverity::Warning,
            Some("info") => TimelineSeverity::Info,
            _ => TimelineSeverity::Unknown,
        },
        title: cut(text(event, "title").unwrap_or_default()),
        detail: text(event, "detail").map(cut),
        // `data` is deliberately not read. See `RemoteTimelineEntry`.
    }
}

// --- Reading someone else's JSON ---------------------------------------------

/// The daemon's GitHub routes answer every refusal with a 400 and a sentence —
/// "no repository selected", "no account connected", "your token expired" — and
/// that sentence is the whole of what a person needs. It is passed through
/// rather than replaced, which is what [`ErrorCode::ServiceActionFailed`] is
/// for: the one code that carries the local runtime's own words.
fn github_failure(status: StatusCode, body: &Value) -> Result<(), ProtocolError> {
    if status.is_success() {
        return Ok(());
    }
    let message = body
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("GitHub could not be reached from this machine.");
    Err(ProtocolError::new(
        ErrorCode::ServiceActionFailed,
        cut(message.to_string()),
    ))
}

fn array<'a>(body: &'a Value, key: &str) -> &'a [Value] {
    body.get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

/// A caller's bound, or the protocol's, whichever is smaller. Absent means the
/// maximum — an omitted bound is the safest bound, not an unbounded one.
fn clamp(limit: Option<u32>, ceiling: usize) -> usize {
    limit
        .map(|limit| limit as usize)
        .filter(|limit| *limit > 0)
        .unwrap_or(ceiling)
        .min(ceiling)
}

/// A string field, absent when it is missing or empty. An empty string is a
/// key that serialises for no reason and renders as a blank line.
fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(|text| cut(text.to_string()))
}

/// An id, whatever JSON type it arrived as. GitHub sends numbers, the error
/// inbox sends numbers, the timeline sends strings; all three cross as strings
/// because none of them is arithmetic.
fn identifier(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

fn number(value: &Value, key: &str) -> f64 {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
        .unwrap_or_default()
}

/// A count. Negative and fractional readings are the file being wrong rather
/// than the machine having spent a negative number of tokens, and zero is the
/// honest answer to both.
fn counter(value: &Value, key: &str) -> u64 {
    let read = number(value, key);
    if read > 0.0 {
        read as u64
    } else {
        0
    }
}

/// Only an absolute `https://` URL on GitHub's own host, and nothing else.
///
/// The one field on this surface that a phone will put in front of a person to
/// tap, which makes it the one field where a value out of a payload could
/// become navigation. GitHub sends `html_url`; anything that is not that shape
/// is dropped rather than forwarded, so a hostile or merely surprising payload
/// costs a missing link rather than a link somewhere else.
fn github_url(value: &Value, key: &str) -> Option<String> {
    let url = value.get(key).and_then(Value::as_str)?;
    let rest = url.strip_prefix("https://")?;
    let host = rest.split('/').next().unwrap_or_default();
    let allowed = host == "github.com" || host.ends_with(".github.com");
    (allowed && url.len() <= limits::MAX_SUMMARY_BYTES).then(|| url.to_string())
}

/// The last path component. Handles both separators, because a Windows service
/// writes a stack trace with backslashes in it.
fn basename(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
        .to_string()
}

/// Cut to [`limits::MAX_SUMMARY_BYTES`], on a character boundary.
///
/// Bytes rather than characters, for the reason the limits module gives: a
/// bound counted in `char`s is a bound whose units an attacker picks.
fn cut(mut text: String) -> String {
    if text.len() <= limits::MAX_SUMMARY_BYTES {
        return text;
    }
    let mut end = limits::MAX_SUMMARY_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push('…');
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The point of the module. Every field GitHub, the inbox and the timeline
    /// send that must not leave this machine, fed in at once — and the rendered
    /// answer must not contain any of them.
    #[test]
    fn nothing_smuggles_a_machine_detail_across() {
        let rendered = serde_json::to_string(&json!({
            "run": workflow_run(&json!({
                "id": 1,
                "name": "CI",
                "status": "completed",
                "conclusion": "failure",
                "html_url": "https://github.com/o/r/actions/runs/1",
                "repository": { "full_name": "o/r", "private": true },
                "head_commit": { "author": { "email": "someone@example.com" } },
                "actor": { "email": "someone@example.com" },
            })),
            "pull": pull_request(&json!({
                "number": 1,
                "title": "t",
                "state": "open",
                "body": "the whole description, which does not cross",
                "user": { "login": "roro", "email": "someone@example.com" },
            })),
            "incident": incident(&json!({
                "id": 1,
                "service": "api",
                "level": "error",
                "title": "boom",
                "file": "/Users/someone/Developer/project/server.js",
                "line": 4,
                "firstSeen": "t", "lastSeen": "t", "count": 1,
                "logExcerpt": ["AUTH_TOKEN=sk-secret"],
            })),
            "timeline": timeline_entry(&json!({
                "id": "tl_1", "timestamp": "t", "kind": "service_exited",
                "severity": "error", "title": "api exited",
                "data": { "pid": 4317, "command": "npm run dev", "cwd": "/Users/someone" },
            })),
        }))
        .expect("render");

        for smuggled in [
            "someone@example.com",
            "/Users/someone",
            "AUTH_TOKEN",
            "npm run dev",
            "4317",
            "the whole description",
            "private",
        ] {
            assert!(
                !rendered.contains(smuggled),
                "{smuggled} crossed the boundary: {rendered}"
            );
        }
        // ...while the thing a phone actually needs did.
        assert!(rendered.contains("server.js"), "{rendered}");
    }

    #[test]
    fn a_url_that_is_not_github_is_dropped() {
        for hostile in [
            "http://github.com/o/r",
            "https://github.com.evil.test/o/r",
            "https://evil.test/o/r",
            "javascript:alert(1)",
            "/relative",
        ] {
            assert_eq!(
                github_url(&json!({ "html_url": hostile }), "html_url"),
                None,
                "{hostile} was accepted"
            );
        }
        assert_eq!(
            github_url(&json!({ "html_url": "https://github.com/o/r" }), "html_url"),
            Some("https://github.com/o/r".to_string())
        );
    }

    #[test]
    fn a_merged_pull_request_is_not_merely_closed() {
        let closed = pull_request(&json!({ "number": 1, "state": "closed" }));
        assert_eq!(closed.state, PullRequestState::Closed);
        let merged =
            pull_request(&json!({ "number": 1, "state": "closed", "merged_at": "2026-01-01" }));
        assert_eq!(merged.state, PullRequestState::Merged);
        // The daemon's own third word, which is what actually arrives.
        let folded = pull_request(&json!({ "number": 1, "state": "merged" }));
        assert_eq!(folded.state, PullRequestState::Merged);
    }

    /// A status GitHub invents after this build shipped must read as `Unknown`
    /// rather than as anything confident.
    #[test]
    fn an_unfamiliar_status_is_unknown_rather_than_wrong() {
        assert_eq!(run_status(Some("teleported")), RunStatus::Unknown);
        assert_eq!(run_status(None), RunStatus::Unknown);
        assert_eq!(run_conclusion("teleported"), RunConclusion::Unknown);
        // ...and the three spellings of waiting collapse to one.
        assert_eq!(run_status(Some("requested")), RunStatus::Queued);
        assert_eq!(run_status(Some("pending")), RunStatus::Queued);
    }

    /// An absent bound must be the maximum, never unbounded, and a caller's
    /// bound must never exceed the protocol's.
    #[test]
    fn an_omitted_limit_is_the_ceiling_and_a_large_one_is_clamped() {
        assert_eq!(clamp(None, 30), 30);
        assert_eq!(clamp(Some(0), 30), 30);
        assert_eq!(clamp(Some(10), 30), 10);
        assert_eq!(clamp(Some(u32::MAX), 30), 30);
    }

    #[test]
    fn prose_is_cut_on_a_character_boundary() {
        let long = "é".repeat(limits::MAX_SUMMARY_BYTES);
        let cut = cut(long);
        assert!(cut.len() <= limits::MAX_SUMMARY_BYTES + '…'.len_utf8());
        assert!(cut.ends_with('…'));
    }

    /// A window with no reset is how both agents spell "no window". Reporting
    /// it would draw a countdown to 1970.
    #[test]
    fn a_window_with_no_reset_reports_no_reset() {
        let window =
            usage_window(&json!({ "usedPercent": 40, "resetsAtUnix": 0 })).expect("window");
        assert_eq!(window.resets_at_unix, None);
        assert_eq!(usage_window(&json!("not an object")), None);
    }

    /// Every number in `/api/agent/usage` is coerced rather than validated by
    /// the local reader, so anything can arrive here. None of it may panic, and
    /// none of it may become a negative count.
    #[test]
    fn a_nonsense_usage_reading_becomes_zeroes_rather_than_a_panic() {
        let usage = claude_usage(&json!({
            "costUSD": "not a number",
            "inputTokens": -5,
            "outputTokens": f64::MAX,
            "models": "not an array",
        }));
        assert_eq!(usage.cost_usd, 0.0);
        assert_eq!(usage.input_tokens, 0);
        assert!(usage.models.is_empty());
    }
}
