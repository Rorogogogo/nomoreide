//! Live auth state for every MCP server an agent has, asked of the agent's own
//! CLI.
//!
//! The Rust half of `src/core/mcp-auth.ts`. `claude mcp list` and
//! `codex mcp list --json` are the authoritative source: they health-check each
//! server, they cover stdio and remote transports the same way, and they stay
//! correct as tokens expire. Reimplementing that against the config files would
//! be a second opinion that goes stale.
//!
//! **This reflects a cold re-spawn**, not what a long-lived `claude` session's
//! `/mcp` shows. A server that a running session is holding open can report
//! `failed` here and be fine there.

use crate::exec_file::{exec_file_capturing, ExecOptions};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentName {
    ClaudeCode,
    Codex,
}

impl AgentName {
    /// Only two agents carry MCP config. Anything else — an unknown name, a
    /// blank one, an absent parameter — is Claude Code, which is what the
    /// dashboard shows by default.
    pub fn parse(value: Option<&str>) -> Self {
        if value == Some("codex") {
            Self::Codex
        } else {
            Self::ClaudeCode
        }
    }
}

/// Normalised across agents:
///
/// - `connected` — reachable and authenticated, or healthy with no auth needed.
/// - `needs-auth` — an OAuth or login step is required first.
/// - `no-auth` — a local server with no auth concept.
/// - `failed` — errored, or would not start on a fresh health check.
/// - `unknown` — pending approval, or a status line nobody has mapped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum McpAuthState {
    Connected,
    NeedsAuth,
    NoAuth,
    Failed,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct McpAuthStatus {
    pub name: String,
    pub state: McpAuthState,
}

/// A health check costs seconds, and the tab that shows this reloads on focus.
const CACHE_TTL: Duration = Duration::from_millis(15_000);

struct CacheEntry {
    at: Instant,
    statuses: Vec<McpAuthStatus>,
}

fn cache() -> &'static Mutex<HashMap<&'static str, CacheEntry>> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<&'static str, CacheEntry>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_key(agent: AgentName) -> &'static str {
    match agent {
        AgentName::ClaudeCode => "claude-code",
        AgentName::Codex => "codex",
    }
}

pub async fn mcp_auth_statuses(agent: AgentName) -> Vec<McpAuthStatus> {
    let key = cache_key(agent);
    if let Ok(cache) = cache().lock() {
        if let Some(entry) = cache.get(key) {
            if entry.at.elapsed() < CACHE_TTL {
                return entry.statuses.clone();
            }
        }
    }
    let statuses = match agent {
        AgentName::Codex => codex_statuses().await,
        AgentName::ClaudeCode => claude_statuses().await,
    };
    if let Ok(mut cache) = cache().lock() {
        cache.insert(
            key,
            CacheEntry {
                at: Instant::now(),
                statuses: statuses.clone(),
            },
        );
    }
    statuses
}

fn cli(program: &str, args: &[&str]) -> Vec<String> {
    let mut argv = vec![program.to_string()];
    argv.extend(args.iter().map(|arg| arg.to_string()));
    argv
}

const CLI_OPTIONS: ExecOptions<'static> = ExecOptions {
    timeout: Duration::from_millis(30_000),
    max_buffer: 1 << 20,
    cwd: None,
};

/// A missing CLI is no servers, not a failure — the page degrades to empty
/// rather than showing an error about a tool the user may not have installed.
async fn claude_statuses() -> Vec<McpAuthStatus> {
    // The CLI exits non-zero while still printing a usable table, so the table
    // is read either way — which is what `exec_file_capturing` is for.
    match exec_file_capturing(&cli("claude", &["mcp", "list"]), &CLI_OPTIONS).await {
        Ok(attempt) => parse_claude_list(&String::from_utf8_lossy(&attempt.output.stdout)),
        Err(_) => Vec::new(),
    }
}

/// One server per line: `<name>: <url-or-command> - <status>`.
///
/// The name is everything before the **first** `": "` and the status everything
/// after the **last** `" - "`, so a line whose command contains either
/// separator still parses. A line with no separator, or whose `" - "` comes
/// before its `": "`, is not a server line and is skipped rather than becoming
/// a server with a blank name.
pub fn parse_claude_list(stdout: &str) -> Vec<McpAuthStatus> {
    let mut statuses = Vec::new();
    for line in stdout.split('\n') {
        let trimmed = line.trim();
        let Some(separator) = trimmed.rfind(" - ") else {
            continue;
        };
        let Some(colon) = trimmed.find(": ") else {
            continue;
        };
        if colon > separator {
            continue;
        }
        let name = trimmed[..colon].trim();
        let status = trimmed[separator + 3..].trim();
        if !name.is_empty() {
            statuses.push(McpAuthStatus {
                name: name.to_string(),
                state: claude_state(status),
            });
        }
    }
    statuses
}

fn claude_state(status: &str) -> McpAuthState {
    let status = status.to_lowercase();
    if status.contains("needs authentication") {
        return McpAuthState::NeedsAuth;
    }
    if status.contains("connected") {
        return McpAuthState::Connected;
    }
    if status.contains("failed") || status.contains("error") {
        return McpAuthState::Failed;
    }
    McpAuthState::Unknown
}

/// Codex is stricter than Claude: a non-zero exit means no servers, because
/// the reference's `catch` wraps the parse too and a failed run never reaches
/// it.
async fn codex_statuses() -> Vec<McpAuthStatus> {
    match exec_file_capturing(&cli("codex", &["mcp", "list", "--json"]), &CLI_OPTIONS).await {
        Ok(attempt) if attempt.failure.is_none() => {
            parse_codex_list(&String::from_utf8_lossy(&attempt.output.stdout))
        }
        _ => Vec::new(),
    }
}

pub fn parse_codex_list(stdout: &str) -> Vec<McpAuthStatus> {
    let Ok(Value::Array(entries)) = serde_json::from_str::<Value>(stdout) else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| {
            // A name that is not a string is not a server anyone can act on.
            let name = entry.get("name")?.as_str()?;
            Some(McpAuthStatus {
                name: name.to_string(),
                state: codex_state(entry.get("auth_status").and_then(Value::as_str)),
            })
        })
        .collect()
}

/// **Order matters**: `not_logged_in` contains `logged_in`, so the negatives
/// are tested first. Getting this backwards reports an agent that needs a login
/// as connected, which is the one wrong answer that costs a person time.
fn codex_state(auth: Option<&str>) -> McpAuthState {
    let status = auth.unwrap_or_default().to_lowercase();
    if status.is_empty() || status == "unsupported" || status == "not_required" || status == "none"
    {
        return McpAuthState::NoAuth;
    }
    for needle in [
        "not_logged_in",
        "logged_out",
        "needs",
        "unauth",
        "expired",
        "required",
    ] {
        if status.contains(needle) {
            return McpAuthState::NeedsAuth;
        }
    }
    if status == "ok"
        || status.contains("logged_in")
        || status.contains("authenticated")
        || status.contains("authorized")
        || status.contains("connected")
    {
        return McpAuthState::Connected;
    }
    McpAuthState::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(statuses: &[McpAuthStatus]) -> Vec<&str> {
        statuses.iter().map(|status| status.name.as_str()).collect()
    }

    #[test]
    fn anything_that_is_not_codex_is_claude_code() {
        assert_eq!(AgentName::parse(Some("codex")), AgentName::Codex);
        assert_eq!(AgentName::parse(Some("Codex")), AgentName::ClaudeCode);
        assert_eq!(AgentName::parse(Some("claude-code")), AgentName::ClaudeCode);
        assert_eq!(AgentName::parse(Some("")), AgentName::ClaudeCode);
        assert_eq!(AgentName::parse(None), AgentName::ClaudeCode);
    }

    #[test]
    fn a_line_that_is_not_a_server_is_skipped() {
        let statuses = parse_claude_list(
            "Checking MCP server health...\n\
             \n\
             linear: https://mcp.linear.app/sse - \u{2717} Needs authentication\n\
             just a sentence with a colon: nothing\n\
             no name - here: value\n\
             : leading colon - \u{2713} Connected\n",
        );
        assert_eq!(names(&statuses), ["linear"]);
    }

    #[test]
    fn the_name_ends_at_the_first_colon_and_the_status_starts_at_the_last_dash() {
        let statuses = parse_claude_list("weird: http://x/a - b - \u{2713} Connected\n");
        assert_eq!(statuses[0].name, "weird");
        assert_eq!(statuses[0].state, McpAuthState::Connected);
    }

    #[test]
    fn every_claude_status_spelling_maps() {
        let statuses = parse_claude_list(
            "a: x - \u{2717} Needs authentication\n\
             b: x - \u{2713} Connected\n\
             c: x - \u{2717} Failed to connect\n\
             d: x - \u{2717} Error: spawn ENOENT\n\
             e: x - awaiting approval\n",
        );
        let states: Vec<McpAuthState> = statuses.iter().map(|status| status.state).collect();
        assert_eq!(
            states,
            [
                McpAuthState::NeedsAuth,
                McpAuthState::Connected,
                McpAuthState::Failed,
                McpAuthState::Failed,
                McpAuthState::Unknown,
            ]
        );
    }

    #[test]
    fn a_negative_that_contains_a_positive_is_read_as_the_negative() {
        // `not_logged_in` contains `logged_in`.
        assert_eq!(codex_state(Some("not_logged_in")), McpAuthState::NeedsAuth);
        assert_eq!(codex_state(Some("logged_in")), McpAuthState::Connected);
    }

    #[test]
    fn every_codex_status_maps() {
        for status in ["unsupported", "not_required", "none", ""] {
            assert_eq!(codex_state(Some(status)), McpAuthState::NoAuth, "{status}");
        }
        assert_eq!(codex_state(None), McpAuthState::NoAuth);
        for status in ["logged_out", "expired", "needs_login", "auth_required"] {
            assert_eq!(
                codex_state(Some(status)),
                McpAuthState::NeedsAuth,
                "{status}"
            );
        }
        for status in ["authenticated", "authorized", "ok", "connected"] {
            assert_eq!(
                codex_state(Some(status)),
                McpAuthState::Connected,
                "{status}"
            );
        }
        assert_eq!(codex_state(Some("something-else")), McpAuthState::Unknown);
    }

    #[test]
    fn an_entry_with_no_usable_name_is_dropped() {
        let statuses = parse_codex_list(
            r#"[{"name":"a","auth_status":"ok"},{"auth_status":"ok"},{"name":7}]"#,
        );
        assert_eq!(names(&statuses), ["a"]);
    }

    #[test]
    fn output_that_is_not_an_array_is_no_servers() {
        assert!(parse_codex_list("{}").is_empty());
        assert!(parse_codex_list("not json").is_empty());
        assert!(parse_codex_list("").is_empty());
    }
}
