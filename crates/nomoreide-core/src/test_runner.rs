//! Run a service's test command and report it as it happens.
//!
//! The Rust half of `src/core/test-runner.ts`. Output is streamed into the log
//! store under a synthetic `<service>:test` channel, which is what puts an
//! assertion failure in front of the error inbox: the inbox subscribes to the
//! log store, so a failing test becomes an incident with no extra wiring.
//!
//! **A run is asynchronous.** `run` answers as soon as the child is spawned,
//! with a run that is still `running`; everything after that — each line, the
//! exit, the final status — reaches a caller through [`TestRunner::events`].
//!
//! On a non-zero exit a synthetic `ERROR: …` line is appended to the same
//! channel, so a failed run surfaces as a top-level incident rather than only
//! as whatever the runner happened to print.

use crate::config::Config;
use crate::log_store::{LogEntry, LogStore};
use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::broadcast;

/// What a service is tested with when it declares nothing of its own.
const DEFAULT_TEST_COMMAND: &str = "npm test";
/// How many events a subscriber may fall behind before it starts losing them.
const EVENT_BACKLOG: usize = 512;

/// The log channel a service's test output is appended under.
pub fn test_channel(service: &str) -> String {
    format!("{service}:test")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRun {
    pub id: u64,
    pub service: String,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    /// `running`, `passed`, `failed` or `error`.
    pub status: String,
    pub started_at: String,
    /// Read from the runner's own output, best effort — see [`count_failures`].
    pub failing_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
}

/// One thing that happened to a run.
///
/// The `type` is also the stream's `event:` name, and it changes frame to
/// frame — a status, then a line, then a status. Every other stream in the
/// daemon has a fixed name; this one does not.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRunEvent {
    #[serde(rename = "type")]
    pub kind: String,
    pub run: TestRun,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<TestRunLine>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRunLine {
    pub stream: String,
    pub text: String,
}

#[derive(Default)]
struct Inner {
    /// The current or most recent run per service. A finished one is kept, so
    /// a stream opened afterwards can replay what happened.
    runs: HashMap<String, TestRun>,
    next_id: u64,
}

#[derive(Clone)]
pub struct TestRunner {
    inner: Arc<Mutex<Inner>>,
    logs: LogStore,
    events: broadcast::Sender<TestRunEvent>,
}

impl TestRunner {
    pub fn new(logs: LogStore) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            logs,
            events: broadcast::Sender::new(EVENT_BACKLOG),
        }
    }

    /// The live event channel, handed out as the sender so a stream can hold
    /// it open — see `server::sse::stream`.
    pub fn events(&self) -> broadcast::Sender<TestRunEvent> {
        self.events.clone()
    }

    /// The current or most recent run for a service, if it has ever been run.
    pub fn current(&self, service: &str) -> Option<TestRun> {
        self.inner.lock().ok()?.runs.get(service).cloned()
    }

    fn is_running(&self, service: &str) -> bool {
        self.current(service)
            .is_some_and(|run| run.status == "running")
    }

    /// Start the test command for a service.
    ///
    /// Refuses a second concurrent run, and refuses a service that is not
    /// registered — the command would otherwise be the default one, run
    /// against a working directory nobody chose.
    pub async fn run(
        &self,
        config: &Config,
        cwd: &str,
        service: &str,
        pattern: Option<&str>,
    ) -> Result<TestRun, String> {
        if self.is_running(service) {
            return Err(format!("A test run is already in progress for {service}."));
        }
        let (command, working_dir) = resolve_command(config, cwd, service, pattern)?;
        let run = {
            let mut inner = self.inner.lock().map_err(|_| "runner is poisoned")?;
            inner.next_id += 1;
            let run = TestRun {
                id: inner.next_id,
                service: service.to_string(),
                command: command.clone(),
                pattern: pattern.filter(|p| !p.trim().is_empty()).map(str::to_string),
                status: "running".to_string(),
                started_at: now(),
                failing_count: 0,
                exit_code: None,
                ended_at: None,
            };
            inner.runs.insert(service.to_string(), run.clone());
            run
        };
        self.emit("status", &run, None);

        let mut child = match spawn(&command, &working_dir) {
            Ok(child) => child,
            Err(reason) => {
                // A command that never started is an `error`, not a `failed` —
                // nothing ran to fail.
                let finished = self.finish(service, "error", None, Some(&reason));
                return Ok(finished.unwrap_or(run));
            }
        };

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let runner = self.clone();
        let service_owned = service.to_string();
        tokio::spawn(async move {
            let mut readers = Vec::new();
            if let Some(stdout) = stdout {
                readers.push(tokio::spawn(pump(
                    runner.clone(),
                    service_owned.clone(),
                    "stdout",
                    stdout,
                )));
            }
            if let Some(stderr) = stderr {
                readers.push(tokio::spawn(pump(
                    runner.clone(),
                    service_owned.clone(),
                    "stderr",
                    stderr,
                )));
            }
            let status = child.wait().await;
            // Every line is drained before the terminal status goes out, so a
            // client that renders the run sees the output that explains it.
            for reader in readers {
                let _ = reader.await;
            }
            match status {
                Ok(status) => {
                    let code = status.code();
                    if code == Some(0) {
                        runner.finish(&service_owned, "passed", code, None);
                    } else {
                        let failing = runner
                            .current(&service_owned)
                            .map(|run| run.failing_count)
                            .unwrap_or(0);
                        let detail = if failing > 0 {
                            format!("{failing} failing")
                        } else {
                            "non-zero exit".to_string()
                        };
                        let command = runner
                            .current(&service_owned)
                            .map(|run| run.command)
                            .unwrap_or_default();
                        let shown = code
                            .map(|code| code.to_string())
                            .unwrap_or_else(|| "?".to_string());
                        let message = format!(
                            "ERROR: {service_owned} tests failed ({detail}) — exit {shown} — {command}"
                        );
                        runner.finish(&service_owned, "failed", code, Some(&message));
                    }
                }
                Err(error) => {
                    runner.finish(&service_owned, "error", None, Some(&error.to_string()));
                }
            }
        });
        Ok(run)
    }

    /// Take one line of output into account: count it, log it, announce it.
    fn observe(&self, service: &str, stream: &str, text: &str) {
        if text.trim().is_empty() {
            return;
        }
        let run = {
            let Ok(mut inner) = self.inner.lock() else {
                return;
            };
            let Some(run) = inner.runs.get_mut(service) else {
                return;
            };
            count_failures(run, text);
            run.clone()
        };
        self.append(service, stream, text);
        self.emit(
            "output",
            &run,
            Some(TestRunLine {
                stream: stream.to_string(),
                text: text.to_string(),
            }),
        );
    }

    fn finish(
        &self,
        service: &str,
        status: &str,
        exit_code: Option<i32>,
        message: Option<&str>,
    ) -> Option<TestRun> {
        if let Some(message) = message {
            self.append(service, "stderr", message);
        }
        let run = {
            let mut inner = self.inner.lock().ok()?;
            let run = inner.runs.get_mut(service)?;
            run.status = status.to_string();
            run.exit_code = exit_code;
            run.ended_at = Some(now());
            run.clone()
        };
        self.emit("status", &run, None);
        Some(run)
    }

    fn append(&self, service: &str, stream: &str, text: &str) {
        self.logs
            .append(LogEntry::new(test_channel(service), stream, text));
    }

    fn emit(&self, kind: &str, run: &TestRun, line: Option<TestRunLine>) {
        let _ = self.events.send(TestRunEvent {
            kind: kind.to_string(),
            run: run.clone(),
            line,
        });
    }
}

/// Read one of the child's pipes line by line.
async fn pump<R>(runner: TestRunner, service: String, stream: &'static str, reader: R)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        runner.observe(&service, stream, &line);
    }
}

/// The command to run and where to run it.
///
/// An unregistered service is refused rather than defaulted: the fallback
/// command would run in a directory nobody chose for it.
fn resolve_command(
    config: &Config,
    cwd: &str,
    service: &str,
    pattern: Option<&str>,
) -> Result<(String, String), String> {
    let definition = config
        .services
        .iter()
        .find(|definition| definition.name == service)
        .ok_or_else(|| format!("Service {service} is not registered."))?;
    let mut command = definition
        .test
        .as_deref()
        .map(str::trim)
        .filter(|test| !test.is_empty())
        .unwrap_or(DEFAULT_TEST_COMMAND)
        .to_string();
    let working_dir = match definition.cwd.as_deref().filter(|cwd| !cwd.is_empty()) {
        Some(declared) if Path::new(declared).is_absolute() => declared.to_string(),
        Some(declared) => Path::new(cwd).join(declared).to_string_lossy().into_owned(),
        None => cwd.to_string(),
    };
    if let Some(pattern) = pattern.map(str::trim).filter(|pattern| !pattern.is_empty()) {
        command = format!("{command} {pattern}");
    }
    Ok((command, working_dir))
}

/// Through a shell, because a test command is written as a shell line — with
/// its own quoting, and often a `&&`.
fn spawn(command: &str, cwd: &str) -> Result<tokio::process::Child, String> {
    let mut child = Command::new("/bin/sh");
    child
        .arg("-c")
        .arg(command)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        // Its own process group, so a runner that spawns workers can be
        // stopped as a whole rather than orphaning them. `process_group` is
        // tokio's own; the `CommandExt` trait is not needed for it.
        child.process_group(0);
    }
    child.spawn().map_err(|error| error.to_string())
}

/// Count failures from the runner's own words.
///
/// A summary line wins outright — `3 failed` means three, however many `FAIL`
/// lines came before it — so the count is the maximum reported, not a running
/// total plus a summary on top.
fn count_failures(run: &mut TestRun, text: &str) {
    if let Some(count) = summary_failures(text) {
        run.failing_count = run.failing_count.max(count);
        return;
    }
    if is_fail_line(text) {
        run.failing_count += 1;
    }
}

/// `<n> failed`, case-insensitively, anywhere in the line.
fn summary_failures(text: &str) -> Option<u64> {
    let lower = text.to_lowercase();
    let at = lower.find(" failed")?;
    let digits: String = lower[..at]
        .chars()
        .rev()
        .take_while(char::is_ascii_digit)
        .collect();
    if digits.is_empty() {
        return None;
    }
    digits.chars().rev().collect::<String>().parse().ok()
}

/// A line that opens with `FAIL`, `✗` or `×` — the three spellings the common
/// runners use.
fn is_fail_line(text: &str) -> bool {
    let trimmed = text.trim_start();
    for marker in ["FAIL", "\u{2717}", "\u{00d7}"] {
        if let Some(rest) = trimmed.strip_prefix(marker) {
            if rest.starts_with(char::is_whitespace) {
                return true;
            }
        }
    }
    false
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run() -> TestRun {
        TestRun {
            id: 1,
            service: "api".into(),
            command: "npm test".into(),
            pattern: None,
            status: "running".into(),
            started_at: now(),
            failing_count: 0,
            exit_code: None,
            ended_at: None,
        }
    }

    #[test]
    fn a_summary_wins_over_the_lines_before_it() {
        let mut run = run();
        count_failures(&mut run, "FAIL a.test.js");
        count_failures(&mut run, "FAIL b.test.js");
        assert_eq!(run.failing_count, 2);
        count_failures(&mut run, "Tests: 5 failed, 1 passed");
        assert_eq!(run.failing_count, 5);
        // And a smaller summary does not walk it back.
        count_failures(&mut run, "1 failed");
        assert_eq!(run.failing_count, 5);
    }

    #[test]
    fn only_a_marker_followed_by_space_is_a_failure() {
        assert!(is_fail_line("FAIL a.test.js"));
        assert!(is_fail_line("  \u{2717} it works"));
        assert!(is_fail_line("\u{00d7} it works"));
        // A word that merely starts with the marker is not one.
        assert!(!is_fail_line("FAILURE_THRESHOLD=1"));
        assert!(!is_fail_line("failed to connect"));
        assert!(!is_fail_line(""));
    }

    #[test]
    fn a_summary_needs_digits_immediately_before_it() {
        assert_eq!(summary_failures("3 failed"), Some(3));
        assert_eq!(summary_failures("Tests: 12 failed, 2 passed"), Some(12));
        assert_eq!(summary_failures("nothing failed"), None);
        assert_eq!(summary_failures("all good"), None);
    }
}
