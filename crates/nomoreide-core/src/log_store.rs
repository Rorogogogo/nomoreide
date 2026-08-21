use crate::timeline::{NewTimelineEvent, TimelineEventKind, TimelineSeverity, TimelineStore};
use anyhow::Result;
use chrono::{DateTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock, RwLock};
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;

const MAX_LINES: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub service: String,
    pub stream: String, // "stdout" | "stderr"
    pub text: String,
    pub timestamp: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub severity: Option<String>, // "error" | "warning" | "info"
}

impl LogEntry {
    pub fn new(
        service: impl Into<String>,
        stream: impl Into<String>,
        text: impl Into<String>,
    ) -> Self {
        let text = text.into();
        let severity = classify_severity(&text);
        LogEntry {
            service: service.into(),
            stream: stream.into(),
            text,
            timestamp: Utc::now(),
            severity,
        }
    }
}

/// What a line's *text* says about itself, or `None` for ordinary output.
///
/// This is the reference's classifier, not a paraphrase of it. The previous
/// Rust rules were a substring scan that had drifted: they called any line
/// containing "error" an error, so `0 errors` and `terrorist` both raised one,
/// and they missed the crash signatures below entirely. The verdict decides
/// which lines become timeline events and which service reports itself
/// unhealthy, so two classifiers that disagree would put a line in the timeline
/// that the log panel had painted as ordinary.
fn classify_severity(text: &str) -> Option<String> {
    static CRASH_SIGNALS: OnceLock<Regex> = OnceLock::new();
    static ERROR_WORD: OnceLock<Regex> = OnceLock::new();
    static NO_ERRORS: OnceLock<Regex> = OnceLock::new();
    static WARNING_WORDS: OnceLock<Regex> = OnceLock::new();

    let crash_signals = CRASH_SIGNALS.get_or_init(|| {
        Regex::new(
            r"(?i)\b(panic|fatal|traceback|uncaught|unhandled|EADDRINUSE|ECONNREFUSED|segmentation fault)\b",
        )
        .expect("valid crash-signal pattern")
    });
    let error_word =
        ERROR_WORD.get_or_init(|| Regex::new(r"(?i)\berror\b").expect("valid pattern"));
    let no_errors =
        NO_ERRORS.get_or_init(|| Regex::new(r"(?i)0 errors?\b").expect("valid pattern"));
    let warning_words = WARNING_WORDS
        .get_or_init(|| Regex::new(r"(?i)\b(warn|warning|deprecated)\b").expect("valid pattern"));

    if crash_signals.is_match(text) {
        return Some("error".to_string());
    }
    // A build that reports "0 errors" is announcing success, not failing.
    if error_word.is_match(text) && !no_errors.is_match(text) {
        return Some("error".to_string());
    }
    if warning_words.is_match(text) {
        return Some("warning".to_string());
    }
    None
}

/// A line that reads like a service announcing it is up. Such a line earns a
/// timeline entry even though it says nothing is wrong, because "when did it
/// come up" is half of what the timeline is read for.
fn is_readiness_line(text: &str) -> bool {
    static READINESS: OnceLock<Regex> = OnceLock::new();
    READINESS
        .get_or_init(|| {
            Regex::new(r"(?i)\b(ready|listening|local:|server started)\b")
                .expect("valid readiness pattern")
        })
        .is_match(text)
}

type Listener = Box<dyn Fn(LogEntry) + Send + Sync>;

struct Inner {
    /// ring buffer per service
    buffers: HashMap<String, Vec<LogEntry>>,
    listeners: Vec<Listener>,
}

#[derive(Clone)]
pub struct LogStore {
    inner: Arc<RwLock<Inner>>,
    log_dir: PathBuf,
    timeline: Option<TimelineStore>,
}

impl LogStore {
    pub fn new(log_dir: PathBuf) -> Self {
        LogStore {
            inner: Arc::new(RwLock::new(Inner {
                buffers: HashMap::new(),
                listeners: vec![],
            })),
            log_dir,
            timeline: None,
        }
    }

    /// Also raise a timeline event for lines that say something happened.
    /// Optional because only the daemon keeps a timeline; Tauri stores logs
    /// without one.
    pub fn with_timeline(mut self, timeline: TimelineStore) -> Self {
        self.timeline = Some(timeline);
        self
    }

    pub fn append(&self, entry: LogEntry) {
        {
            let mut inner = self.inner.write().unwrap();
            let buf = inner.buffers.entry(entry.service.clone()).or_default();
            buf.push(entry.clone());
            if buf.len() > MAX_LINES {
                buf.drain(0..buf.len() - MAX_LINES);
            }
            for listener in &inner.listeners {
                listener(entry.clone());
            }
        } // lock released here

        self.append_timeline_event(&entry);

        let log_dir = self.log_dir.clone();
        tokio::spawn(async move {
            let _ = append_to_disk(&log_dir, &entry).await;
        });
    }

    /// Ordinary output is not timeline material — only a line that classified
    /// as a problem, or that reads like the service announcing it is up.
    fn append_timeline_event(&self, entry: &LogEntry) {
        let Some(timeline) = &self.timeline else {
            return;
        };
        if entry.severity.is_none() && !is_readiness_line(&entry.text) {
            return;
        }
        let severity = match entry.severity.as_deref() {
            Some("error") => TimelineSeverity::Error,
            Some("warning") => TimelineSeverity::Warning,
            _ => TimelineSeverity::Info,
        };
        timeline.append(
            NewTimelineEvent::new(
                TimelineEventKind::ServiceLog,
                severity,
                format!("{} {}", entry.service, entry.stream),
            )
            .service(entry.service.clone())
            .detail(entry.text.clone())
            // The line's own time, not the time it was classified.
            .at(entry.timestamp),
        );
    }

    pub fn read(&self, service: &str, limit: usize) -> Vec<LogEntry> {
        let inner = self.inner.read().unwrap();
        inner
            .buffers
            .get(service)
            .map(|buf| {
                let start = buf.len().saturating_sub(limit);
                buf[start..].to_vec()
            })
            .unwrap_or_default()
    }

    pub fn subscribe<F>(&self, listener: F)
    where
        F: Fn(LogEntry) + Send + Sync + 'static,
    {
        let mut inner = self.inner.write().unwrap();
        inner.listeners.push(Box::new(listener));
    }
}

async fn append_to_disk(log_dir: &PathBuf, entry: &LogEntry) -> Result<()> {
    tokio::fs::create_dir_all(log_dir).await?;
    let safe_name = entry.service.replace(['/', '\\', ':'], "_");
    let path = log_dir.join(format!("{safe_name}.log"));
    let line = serde_json::to_string(entry)? + "\n";
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .await?;
    file.write_all(line.as_bytes()).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timeline::TimelineEventKind;

    /// Every verdict here was produced by running the reference's own regexes,
    /// not by reading them. The subtle ones are the point: `\berror\b` never
    /// matches the plural, so "no errors here" is ordinary output; "panicked"
    /// is not "panic"; and `Local:` only counts as readiness when a word
    /// follows the colon, which Vite's spaced banner does not.
    #[test]
    fn severity_matches_the_reference_classifier() {
        for (text, expected) in [
            ("just some ordinary output", None),
            ("an error occurred", Some("error")),
            ("Error: connect ECONNREFUSED 127.0.0.1:5432", Some("error")),
            ("listen EADDRINUSE: address already in use", Some("error")),
            ("segmentation fault (core dumped)", Some("error")),
            ("Uncaught TypeError", Some("error")),
            ("Traceback (most recent call last):", Some("error")),
            // A word that merely contains "error" is not an error.
            ("terrorist attack averted", None),
            // `\berror\b` does not match the plural, so neither of these fires.
            ("no errors here", None),
            ("compiled with 0 errors", None),
            ("compiled with 0 error", None),
            // "panicked" is not the word "panic".
            ("panicked at src/main.rs", None),
            ("warn: slow query", Some("warning")),
            ("deprecated API used", Some("warning")),
            // "Warning" inside a longer word has no leading boundary.
            ("DeprecationWarning: foo", None),
        ] {
            assert_eq!(classify_severity(text).as_deref(), expected, "{text:?}");
        }
    }

    #[test]
    fn readiness_matches_the_reference_classifier() {
        for (text, expected) in [
            ("listening on port 3000", true),
            ("server started", true),
            ("ready in 320ms", true),
            ("Local:3000", true),
            // The trailing boundary needs a word character after the colon,
            // and Vite's banner puts spaces there.
            ("  ➜  Local:   http://localhost:5173/", false),
            ("just some ordinary output", false),
        ] {
            assert_eq!(is_readiness_line(text), expected, "{text:?}");
        }
    }

    #[tokio::test]
    async fn only_notable_lines_reach_the_timeline() {
        let root =
            std::env::temp_dir().join(format!("nomoreide-log-timeline-{}", uuid::Uuid::new_v4()));
        let timeline = TimelineStore::new(root.join("timeline.log"));
        let logs = LogStore::new(root.join("logs")).with_timeline(timeline.clone());

        logs.append(LogEntry::new("api", "stdout", "just some ordinary output"));
        assert!(timeline.read(500).is_empty());

        logs.append(LogEntry::new("api", "stdout", "listening on port 3000"));
        logs.append(LogEntry::new("api", "stderr", "an error occurred"));
        let events = timeline.read(500);
        assert_eq!(events.len(), 2);

        // A readiness line says nothing is wrong, so it is recorded as info.
        assert_eq!(events[0].kind, TimelineEventKind::ServiceLog);
        assert_eq!(events[0].severity, TimelineSeverity::Info);
        assert_eq!(events[0].title, "api stdout");
        assert_eq!(events[0].detail.as_deref(), Some("listening on port 3000"));
        assert_eq!(events[0].service.as_deref(), Some("api"));

        assert_eq!(events[1].severity, TimelineSeverity::Error);
        assert_eq!(events[1].title, "api stderr");

        let _ = std::fs::remove_dir_all(root);
    }
}
