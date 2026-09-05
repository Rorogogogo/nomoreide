//! The sanitized shapes a daemon is allowed to describe itself with.
//!
//! Read this for what is **not** here. A service on this wire has a name, a
//! description, a kind, a port and a state — and no command, no arguments, no
//! working directory, no environment, no process id, no log path and no URL.
//! Those are the fields a remote attacker would want most, and the cheapest way
//! to guarantee they never leave the machine is for the type that crosses the
//! boundary to have nowhere to put them.
//!
//! Every struct is `deny_unknown_fields` in both directions. That is not only
//! about hostile input: it means a local shape growing a field cannot silently
//! start publishing it, because the wire struct is written out by hand and a
//! new field has to be added here on purpose.

use super::version::CapabilitySet;
use serde::{Deserialize, Serialize};

/// What the phone shows at the top of a device page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceSnapshot {
    pub device_id: String,
    /// The name the user gave the machine when pairing. Not the hostname —
    /// a hostname is often an employer, a location or a person's full name.
    pub name: String,
    /// `macos`, `linux`, `windows`. Coarse on purpose: an exact kernel build is
    /// a fingerprint and helps nobody hold a phone.
    pub platform: String,
    pub daemon_version: String,
    pub protocol_version: u32,
    pub capabilities: CapabilitySet,
}

/// A registered service's runtime state, flattened to the few words a phone can
/// act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ServiceState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Errored,
    /// The daemon knows the service exists but cannot say what it is doing —
    /// a foreign process on its port, most often. Deliberately distinct from
    /// `Running`, because the remote surface must never imply it owns something
    /// it did not start.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteService {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The service kind as config records it — `node`, `docker`, and so on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    pub state: ServiceState,
}

/// An agent terminal, as much of it as may leave the machine.
///
/// **What is missing is the point.** A local `TerminalSession` carries `cwd`,
/// `shell`, the argv it was spawned with, and its pid. None of those has a
/// field here, and the reshaping in the daemon's dispatcher is where they are
/// dropped — the same rule that keeps a command line out of [`RemoteService`].
///
/// `workspace` is the exception that proves it: a phone showing three agents
/// needs to tell them apart, and "which repo" is the only thing that does. It
/// is the directory's *final component*, never the path — a name, not a map of
/// somebody's disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteTerminalSession {
    pub id: String,
    /// The tab's label, if it has been named.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// `claude`, `codex` — which CLI is running in it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// The basename of the directory the agent is working in. Never a path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    /// False once the child has exited. The tab may still be on screen.
    pub running: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BundleState {
    Stopped,
    Partial,
    Running,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteBundle {
    pub name: String,
    pub state: BundleState,
    /// The services it names, so a phone can show what a bundle covers without
    /// a second round trip. Names only.
    pub services: Vec<String>,
}

/// One installed agent provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteAgentProvider {
    pub id: String,
    pub name: String,
    /// Whether the CLI behind it is actually installed and runnable.
    pub available: bool,
    /// Whether a *write-capable* turn may be started remotely.
    ///
    /// False for any provider whose native runtime adapter cannot give the same
    /// approval guarantees as the reference one. Such a provider may still be
    /// offered read-only, and the phone must label it that way rather than
    /// hiding it — a missing provider reads as a bug, a labelled one reads as a
    /// decision.
    pub remote_writes: bool,
}

/// One log line, already truncated and redacted by the daemon.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogLine {
    /// RFC 3339, UTC.
    pub at: String,
    pub stream: LogStream,
    pub text: String,
    /// Set when the line was cut at [`super::limits::MAX_LOG_LINE_BYTES`], so
    /// the phone can say so rather than showing a sentence that stops.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogStream {
    Stdout,
    Stderr,
    /// The daemon's own commentary about the service — "started", "exited 1".
    System,
}

// --- GitHub Actions ----------------------------------------------------------

/// How far along a workflow run or one of its jobs is.
///
/// Deliberately not GitHub's full vocabulary. `requested`, `pending` and
/// `queued` all mean "it has not started", and a phone that renders three
/// spellings of waiting is showing GitHub's internals rather than the answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    /// Accepted, not started. Covers GitHub's `queued`, `requested`, `pending`.
    Queued,
    InProgress,
    /// Blocked on something a human must do — a deployment gate, most often.
    Waiting,
    Completed,
    /// A status this build has not heard of. Never a parse failure: GitHub adds
    /// these, and one new word must not blank a phone's whole CI list.
    #[serde(other)]
    Unknown,
}

/// How a completed run or job turned out. Absent while it is still running —
/// which is the distinction the two enums exist to keep: "no conclusion yet" is
/// not "neutral".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunConclusion {
    Success,
    Failure,
    Cancelled,
    Skipped,
    TimedOut,
    /// Waiting on a human — an approval, or a manual step.
    ActionRequired,
    Neutral,
    Stale,
    #[serde(other)]
    Unknown,
}

/// One GitHub Actions run, as much of it as a phone needs.
///
/// **The URL is the deliberate exception to this module's rule**, and it is
/// worth saying why. Everything else here refuses to name the machine's world:
/// no paths, no commands, no hostnames. A run URL names the *repository*, which
/// is not the machine's secret — it is the thing the user pointed NoMoreIDE at,
/// and it is already implied by the fact that these runs exist at all. Without
/// it a red run on a phone is a dead end: the one useful action, "open it and
/// read the log", becomes retyping a URL from memory. So it crosses, and it
/// crosses as GitHub's own `html_url` rather than as anything this side builds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteWorkflowRun {
    /// GitHub's run id, as a string. It is an identifier, not a quantity, and
    /// a JSON number large enough to lose precision in a browser is a bug
    /// waiting for a repository old enough to have one.
    pub id: String,
    /// The workflow's name — "CI", "Release".
    pub name: String,
    /// The commit or pull request title the run is for, when GitHub gives one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// What triggered it — `push`, `pull_request`, `workflow_dispatch`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    /// The run number a person would quote: "CI #412".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<u64>,
    pub status: RunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conclusion: Option<RunConclusion>,
    /// RFC 3339, as GitHub wrote it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// One job inside a run. The row that says *which step* went red.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteWorkflowJob {
    pub id: String,
    pub name: String,
    pub status: RunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conclusion: Option<RunConclusion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

// --- Pull requests -----------------------------------------------------------

/// Merged is its own state rather than a flag on `closed`.
///
/// GitHub reports a merged pull request as closed and puts the difference in a
/// separate timestamp, which means every reader has to know the trick. The
/// daemon already collapses the two locally; the wire does the same, so a phone
/// does not have to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PullRequestState {
    Open,
    Closed,
    Merged,
    #[serde(other)]
    Unknown,
}

/// One pull request, flattened to what fits on a phone.
///
/// **No body.** A description is arbitrary prose of arbitrary length, written
/// by anyone who can open a pull request against a public repository, and it is
/// the one field here that nobody scanning a list reads. The title carries the
/// meaning; the URL carries the rest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemotePullRequest {
    pub number: u64,
    pub title: String,
    pub state: PullRequestState,
    /// A draft is still `Open`. The two are different questions — "can it
    /// merge" and "is it ready" — and collapsing them loses the second.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub draft: bool,
    /// The login that opened it. A handle, never a name or an email.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

// --- Agent usage -------------------------------------------------------------

/// One rate-limit window: how much of it is gone, and when it comes back.
///
/// Not `Eq`, and none of the usage types are: a percentage is a fraction and
/// rounding it to an integer to keep a derive would be inventing precision the
/// source does not have.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteUsageWindow {
    /// 0–100, as the agent reports it. Not clamped here: a provider that says
    /// 103 is telling the user something true about their account, and a phone
    /// showing a full bar is a better answer than one showing a wrong number.
    pub used_percent: f64,
    /// Unix seconds. Absent when the agent did not say — which is how both
    /// agents spell "no window is active" and must not read as "resets at the
    /// epoch".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at_unix: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_minutes: Option<u32>,
}

/// What one model cost, within a provider's reading.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteModelUsage {
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
}

/// Claude Code's own reading of what it has spent.
///
/// **Two fields the local panel shows are missing on purpose.** `cwd` is an
/// absolute path on the user's disk, and `sessionId` is a handle into a
/// transcript. Neither is needed to answer "how much is left", which is the
/// only question a phone is asking.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteClaudeUsage {
    /// The rolling five-hour window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub five_hour: Option<RemoteUsageWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weekly: Option<RemoteUsageWindow>,
    pub cost_usd: f64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub lines_added: u64,
    pub lines_removed: u64,
    /// Dearest first, already bounded by the daemon.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<RemoteModelUsage>,
}

/// Codex's reading, out of its own session rollout.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteCodexUsage {
    /// Codex names its windows rather than describing them, so the names are
    /// carried through rather than guessed at.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary: Option<RemoteUsageWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secondary: Option<RemoteUsageWindow>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    /// The model's context window, when the rollout named one — what the
    /// "how full is this session" bar is drawn against.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// When the reading was taken. A rollout can be days old, and a usage bar
    /// with no date is a bar that quietly stops being true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

/// Both agents' readings. A provider that has never run is an absent key rather
/// than a zeroed one — zero spent and never installed are different answers.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteAgentUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude: Option<RemoteClaudeUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex: Option<RemoteCodexUsage>,
}

// --- The error inbox and the timeline ----------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IncidentLevel {
    Error,
    Warning,
    Info,
    #[serde(other)]
    Unknown,
}

/// One deduped incident from the error inbox.
///
/// **No log excerpt.** The local inbox carries the surrounding lines, and they
/// are raw service output — the exact bytes the log capability redacts a
/// credential out of before sending. Rather than run that redaction twice, the
/// excerpt does not cross: a phone that wants the lines asks for the service's
/// logs, which is a capability of its own and already bounded.
///
/// `file` is the **basename**. A stack trace names somebody's whole home
/// directory, and "which file" is the part that helps.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteIncident {
    pub id: String,
    /// The registered service it was seen in.
    pub service: String,
    pub level: IncidentLevel,
    /// The first line of the error, already cut to
    /// [`super::limits::MAX_SUMMARY_BYTES`].
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    pub first_seen: String,
    pub last_seen: String,
    /// How many times this signature has been seen. The number that tells a
    /// loop from an incident.
    pub count: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TimelineSeverity {
    Info,
    Warning,
    Error,
    #[serde(other)]
    Unknown,
}

/// One thing the runtime did.
///
/// **No `data`.** The local event carries a free-form JSON blob whose contents
/// depend on the event kind — and for a process event that blob is a pid, an
/// exit code and a command line. A wire type with a `serde_json::Value` in it
/// is a wire type with nowhere it *cannot* put those, which is exactly what
/// this module exists to prevent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteTimelineEntry {
    pub id: String,
    /// RFC 3339, as the daemon recorded it.
    pub at: String,
    /// The event kind as the daemon spells it — `service_started`,
    /// `health_check`. A string rather than an enum for the usual reason: a
    /// kind added later must not fail an older reader's parse.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    pub severity: TimelineSeverity,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The point of the whole module. If any of these ever parses, a field that
    /// should never cross the boundary has been added to a wire struct.
    #[test]
    fn a_service_cannot_carry_the_fields_that_matter() {
        for smuggled in [
            r#"{"name":"api","state":"running","command":"npm run dev"}"#,
            r#"{"name":"api","state":"running","cwd":"/Users/someone/work"}"#,
            r#"{"name":"api","state":"running","env":{"TOKEN":"x"}}"#,
            r#"{"name":"api","state":"running","pid":4317}"#,
        ] {
            assert!(
                serde_json::from_str::<RemoteService>(smuggled).is_err(),
                "accepted {smuggled}"
            );
        }
    }

    /// A state this build has not heard of must read as `Unknown`, not as a
    /// parse failure — otherwise a newer daemon's new state breaks an older
    /// phone's whole service list.
    #[test]
    fn an_unfamiliar_state_degrades_to_unknown() {
        let service: RemoteService =
            serde_json::from_str(r#"{"name":"api","state":"quiescing"}"#).expect("parse");
        assert_eq!(service.state, ServiceState::Unknown);
    }

    #[test]
    fn optional_fields_are_omitted_rather_than_null() {
        let service = RemoteService {
            name: "api".into(),
            description: None,
            kind: None,
            port: None,
            state: ServiceState::Stopped,
        };
        let json = serde_json::to_string(&service).expect("serialise");
        assert_eq!(json, r#"{"name":"api","state":"stopped"}"#);
    }

    #[test]
    fn a_clean_log_line_omits_the_truncation_flag() {
        let line = LogLine {
            at: "2026-09-01T00:00:00Z".into(),
            stream: LogStream::Stdout,
            text: "listening".into(),
            truncated: false,
        };
        let json = serde_json::to_string(&line).expect("serialise");
        assert!(!json.contains("truncated"), "{json}");
    }
}
