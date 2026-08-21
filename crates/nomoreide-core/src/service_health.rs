//! One service's health verdict, computed from what the runtime already knows.
//!
//! A port of the reference's `src/core/service-health.ts`. Nothing here probes
//! anything: the verdict is a reading of the runtime state and the buffered
//! output, so it costs nothing to ask for and cannot itself disturb a service.
//!
//! The error pattern below is deliberately **not** the log store's severity
//! classifier. The classifier decides what earns a place on the debug timeline
//! and is written to keep `0 errors` off it; this one decides whether a running
//! service looks troubled, and the reference casts it wider on purpose — a
//! plain substring scan, so a line merely mentioning failure counts.
//!
//! One branch of the reference has no native counterpart: it downgrades a
//! running service to a warning once its process tree passes 1 GB of RSS. No
//! native runtime samples a process tree, so that reading never exists here and
//! the branch is absent rather than stubbed. It sits ahead of the error-log
//! check in the reference, so its absence cannot change any other verdict —
//! only turn one that would have been "high memory" into whatever the logs say.

use crate::agent_context::{
    build_service_agent_context, contains_any, AgentContextInput, LogLine, RuntimeSnapshot,
    ServiceSnapshot, TimelineLine,
};
use serde::Serialize;

/// The reference's `/error|failed|exception|panic|fatal|traceback|exit status/i`.
const ERROR_LOG_NEEDLES: &[&str] = &[
    "error",
    "failed",
    "exception",
    "panic",
    "fatal",
    "traceback",
    "exit status",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthStatus {
    Unknown,
    Healthy,
    Warning,
    Unhealthy,
}

pub struct HealthInput<'a> {
    pub service: ServiceSnapshot<'a>,
    pub status: Option<RuntimeSnapshot<'a>>,
    pub logs: &'a [LogLine<'a>],
    pub timeline: &'a [TimelineLine<'a>],
}

pub struct ServiceHealth {
    pub status: HealthStatus,
    pub summary: String,
    /// Index into the logs the verdict was computed from, so a caller can
    /// report the whole entry in whatever shape it already has one.
    pub last_error_log: Option<usize>,
    pub agent_context: String,
}

pub fn compute_service_health(input: &HealthInput<'_>) -> ServiceHealth {
    let last_error_log = last_error_log(input);
    let (status, summary) = verdict(input, last_error_log);
    let agent_context = build_service_agent_context(&AgentContextInput {
        service: input.service,
        status: input.status,
        health_summary: &summary,
        recent_logs: input.logs,
        timeline: input.timeline,
    });
    ServiceHealth {
        status,
        summary,
        last_error_log,
        agent_context,
    }
}

/// The newest error line this generation of the process wrote.
///
/// The start timestamp is what keeps a restart honest: the log buffer outlives
/// the process, so without it a service that has just been repaired would go on
/// reporting the error that prompted the repair. ISO-8601 UTC compares
/// correctly as text, which is how the reference compares it too.
fn last_error_log(input: &HealthInput<'_>) -> Option<usize> {
    let started_at = input.status.and_then(|status| status.started_at);
    input
        .logs
        .iter()
        .enumerate()
        .rev()
        .find_map(|(index, line)| {
            let recent = started_at.map_or(true, |started_at| line.timestamp >= started_at);
            (contains_any(line.text, ERROR_LOG_NEEDLES) && recent).then_some(index)
        })
}

fn verdict(input: &HealthInput<'_>, last_error_log: Option<usize>) -> (HealthStatus, String) {
    let Some(status) = input.status else {
        return (HealthStatus::Unknown, "Service is not running.".to_string());
    };
    match status.state {
        "stopped" => (HealthStatus::Unknown, "Service is not running.".to_string()),
        "exited" => (
            HealthStatus::Unhealthy,
            format!(
                "Service exited with code {}.",
                status
                    .exit_code
                    .map_or_else(|| "unknown".to_string(), |code| code.to_string())
            ),
        ),
        _ => match last_error_log {
            Some(index) => (
                HealthStatus::Warning,
                format!("Recent error log: {}", input.logs[index].text),
            ),
            None => (
                HealthStatus::Healthy,
                "Service is running without detected warnings.".to_string(),
            ),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service() -> ServiceSnapshot<'static> {
        ServiceSnapshot {
            name: "api",
            command: Some("node server.js"),
            cwd: Some("/srv/api"),
            port: Some(3000),
        }
    }

    fn running(started_at: Option<&'static str>) -> RuntimeSnapshot<'static> {
        RuntimeSnapshot {
            state: "running",
            pid: Some(4321),
            url: Some("http://localhost:3000"),
            exit_code: None,
            started_at,
        }
    }

    fn health(status: Option<RuntimeSnapshot<'_>>, logs: &[LogLine<'_>]) -> ServiceHealth {
        compute_service_health(&HealthInput {
            service: service(),
            status,
            logs,
            timeline: &[],
        })
    }

    #[test]
    fn an_untracked_service_is_unknown_rather_than_unhealthy() {
        let verdict = health(None, &[]);
        assert_eq!(verdict.status, HealthStatus::Unknown);
        assert_eq!(verdict.summary, "Service is not running.");
        assert!(verdict.agent_context.contains("- state: unknown"));
        assert!(verdict.agent_context.contains("- pid: n/a"));
    }

    #[test]
    fn an_exit_reports_its_code_and_says_unknown_when_it_has_none() {
        let exited = RuntimeSnapshot {
            state: "exited",
            exit_code: Some(3),
            ..running(None)
        };
        assert_eq!(
            health(Some(exited), &[]).summary,
            "Service exited with code 3."
        );
        let signalled = RuntimeSnapshot {
            exit_code: None,
            ..exited
        };
        assert_eq!(
            health(Some(signalled), &[]).summary,
            "Service exited with code unknown."
        );
        assert_eq!(health(Some(signalled), &[]).status, HealthStatus::Unhealthy);
    }

    /// The pattern is a substring scan, not the timeline classifier: the
    /// reference would rather call a healthy service troubled than let a real
    /// failure read as healthy.
    #[test]
    fn any_line_mentioning_failure_makes_a_running_service_a_warning() {
        for text in [
            "Error: upstream refused",
            "0 errors, 0 warnings",
            "task FAILED",
            "exit status 1",
            "Traceback (most recent call last):",
        ] {
            let logs = [LogLine {
                stream: "stdout",
                text,
                timestamp: "2026-08-21T10:00:00.000Z",
            }];
            let verdict = health(Some(running(None)), &logs);
            assert_eq!(verdict.status, HealthStatus::Warning, "{text}");
            assert_eq!(verdict.summary, format!("Recent error log: {text}"));
            assert_eq!(verdict.last_error_log, Some(0));
        }
        let quiet = [LogLine {
            stream: "stdout",
            text: "ready in 240 ms",
            timestamp: "2026-08-21T10:00:00.000Z",
        }];
        assert_eq!(
            health(Some(running(None)), &quiet).status,
            HealthStatus::Healthy
        );
    }

    /// The buffer outlives the process, so a restart must not keep reporting
    /// what the previous generation wrote.
    #[test]
    fn errors_older_than_the_current_start_are_left_behind() {
        let logs = [
            LogLine {
                stream: "stderr",
                text: "Error: from the run before",
                timestamp: "2026-08-21T09:59:00.000Z",
            },
            LogLine {
                stream: "stdout",
                text: "listening",
                timestamp: "2026-08-21T10:00:01.000Z",
            },
        ];
        let started = Some("2026-08-21T10:00:00.000Z");
        assert_eq!(
            health(Some(running(started)), &logs).status,
            HealthStatus::Healthy
        );
        // Without a start timestamp there is no window, so the error stands.
        assert_eq!(
            health(Some(running(None)), &logs).status,
            HealthStatus::Warning
        );
    }

    #[test]
    fn the_newest_error_is_the_one_reported() {
        let logs = [
            LogLine {
                stream: "stderr",
                text: "Error: first",
                timestamp: "2026-08-21T10:00:01.000Z",
            },
            LogLine {
                stream: "stderr",
                text: "Error: second",
                timestamp: "2026-08-21T10:00:02.000Z",
            },
        ];
        let verdict = health(Some(running(None)), &logs);
        assert_eq!(verdict.last_error_log, Some(1));
        assert_eq!(verdict.summary, "Recent error log: Error: second");
    }
}
