//! The debugging context packet an agent reads before it touches a service.
//!
//! A port of the reference's `src/core/agent-context.ts`. It is deliberately
//! text, not JSON: the packet exists to be pasted into a prompt, so its shape
//! is prose an agent can follow rather than a structure it has to walk.
//!
//! Every input is borrowed as it already reads on the wire — timestamps
//! included. The reference renders timestamps verbatim and compares them as
//! strings, and ISO-8601 UTC sorts lexicographically, so nothing here needs to
//! parse a clock.

/// One buffered output line of a service.
#[derive(Debug, Clone, Copy)]
pub struct LogLine<'a> {
    pub stream: &'a str,
    pub text: &'a str,
    pub timestamp: &'a str,
}

/// One debug-timeline event.
#[derive(Debug, Clone, Copy)]
pub struct TimelineLine<'a> {
    pub timestamp: &'a str,
    pub severity: &'a str,
    pub title: &'a str,
    pub detail: Option<&'a str>,
}

/// A service's registered definition, as far as the packet reports it.
#[derive(Debug, Clone, Copy)]
pub struct ServiceSnapshot<'a> {
    pub name: &'a str,
    /// Absent for kinds that have no command of their own — a compose service
    /// is one. The reference interpolates the missing value straight into the
    /// packet, so the line reads `command: undefined`, and so does this.
    pub command: Option<&'a str>,
    pub cwd: Option<&'a str>,
    pub port: Option<u16>,
}

/// What the runtime knows about a service right now. `None` means the runtime
/// is not tracking it at all — never started, or started by nobody.
#[derive(Debug, Clone, Copy)]
pub struct RuntimeSnapshot<'a> {
    pub state: &'a str,
    pub pid: Option<u32>,
    pub url: Option<&'a str>,
    pub exit_code: Option<i32>,
    /// When the current generation of the process began. The health check uses
    /// it to ignore errors an earlier run left in the buffer.
    pub started_at: Option<&'a str>,
}

pub struct AgentContextInput<'a> {
    pub service: ServiceSnapshot<'a>,
    pub status: Option<RuntimeSnapshot<'a>>,
    pub health_summary: &'a str,
    pub recent_logs: &'a [LogLine<'a>],
    pub timeline: &'a [TimelineLine<'a>],
}

/// The newest lines the packet quotes. Both budgets are the reference's.
const LOG_BUDGET: usize = 8;
const TIMELINE_BUDGET: usize = 10;

/// Lines worth quoting when a service has written more than the packet can
/// hold. Deliberately wider than the health check's own error pattern: this one
/// decides what an agent gets to read, so it would rather over-include.
fn is_significant(line: &LogLine<'_>) -> bool {
    line.stream == "stderr" || contains_any(line.text, &["error", "warn", "fail", "exception"])
}

/// Case-insensitive substring search, matching a JavaScript `/…/i` alternation
/// over plain literals.
pub(crate) fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    let lowered = haystack.to_lowercase();
    needles.iter().any(|needle| lowered.contains(needle))
}

pub fn build_service_agent_context(input: &AgentContextInput<'_>) -> String {
    let mut lines = Vec::new();
    lines.push(format!(
        "Investigate NoMoreIDE service \"{}\".",
        input.service.name
    ));
    lines.push(String::new());
    lines.push("Service:".to_string());
    lines.push(format!(
        "- command: {}",
        input.service.command.unwrap_or("undefined")
    ));
    lines.push(format!(
        "- cwd: {}",
        input.service.cwd.unwrap_or("undefined")
    ));
    lines.push(format!(
        "- configured port: {}",
        input
            .service
            .port
            .map_or_else(|| "not configured".to_string(), |port| port.to_string())
    ));
    lines.push(format!(
        "- runtime url: {}",
        input
            .status
            .and_then(|status| status.url)
            .unwrap_or("not detected")
    ));
    lines.push(format!(
        "- state: {}",
        input.status.map_or("unknown", |status| status.state)
    ));
    lines.push(format!(
        "- pid: {}",
        input
            .status
            .and_then(|status| status.pid)
            .map_or_else(|| "n/a".to_string(), |pid| pid.to_string())
    ));
    lines.push(String::new());
    lines.push("Health:".to_string());
    lines.push(format!("- {}", input.health_summary));
    lines.push(String::new());
    lines.push("Recent logs:".to_string());
    lines.extend(format_logs(input.recent_logs));
    lines.push(String::new());
    lines.push("Recent timeline:".to_string());
    lines.extend(format_timeline(input.timeline));
    lines.push(String::new());
    lines.join("\n")
}

fn format_logs(logs: &[LogLine<'_>]) -> Vec<String> {
    let significant = logs
        .iter()
        .filter(|line| is_significant(line))
        .collect::<Vec<_>>();
    // Nothing stood out, so the plain tail is the best the packet can do.
    let source = if significant.is_empty() {
        logs.iter().collect::<Vec<_>>()
    } else {
        significant
    };
    if source.is_empty() {
        return vec!["- none".to_string()];
    }
    source[source.len().saturating_sub(LOG_BUDGET)..]
        .iter()
        .map(|line| format!("- {} {}: {}", line.timestamp, line.stream, line.text))
        .collect()
}

fn format_timeline(events: &[TimelineLine<'_>]) -> Vec<String> {
    if events.is_empty() {
        return vec!["- none".to_string()];
    }
    events[events.len().saturating_sub(TIMELINE_BUDGET)..]
        .iter()
        .map(|event| {
            // An empty detail is as absent as a missing one: the reference
            // tests it for truthiness, and "" is not truthy.
            let detail = event
                .detail
                .filter(|detail| !detail.is_empty())
                .map_or_else(String::new, |detail| format!(" — {detail}"));
            format!(
                "- {} [{}] {}{}",
                event.timestamp, event.severity, event.title, detail
            )
        })
        .collect()
}
