//! The debug timeline: a short, ordered account of what the runtime did.
//!
//! It is deliberately not the log store. Logs are everything a service wrote;
//! the timeline is the handful of moments worth reconstructing afterwards — a
//! service started, exited, reported a URL, or printed something that looked
//! like a failure. Both are capped in memory and appended to disk, so a crash
//! leaves the account behind even though the buffer does not survive it.

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

const MAX_EVENTS: usize = 500;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum TimelineEventKind {
    #[serde(rename = "service.lifecycle")]
    ServiceLifecycle,
    #[serde(rename = "service.log")]
    ServiceLog,
    #[serde(rename = "service.health")]
    ServiceHealth,
    #[serde(rename = "service.port")]
    ServicePort,
    #[serde(rename = "service.http")]
    ServiceHttp,
    #[serde(rename = "mcp.tool")]
    McpTool,
    #[serde(rename = "git.change")]
    GitChange,
    #[serde(rename = "user.action")]
    UserAction,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TimelineSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEvent {
    pub id: String,
    pub timestamp: DateTime<Utc>,
    pub kind: TimelineEventKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    pub severity: TimelineSeverity,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// An event before the store has stamped it with an id and a time.
#[derive(Debug, Clone)]
pub struct NewTimelineEvent {
    pub kind: TimelineEventKind,
    pub service: Option<String>,
    pub severity: TimelineSeverity,
    pub title: String,
    pub detail: Option<String>,
    pub data: Option<Value>,
    /// Set when the event describes something that already happened — a log
    /// line carries the time it was written, not the time it was classified.
    pub timestamp: Option<DateTime<Utc>>,
}

impl NewTimelineEvent {
    pub fn new(
        kind: TimelineEventKind,
        severity: TimelineSeverity,
        title: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            service: None,
            severity,
            title: title.into(),
            detail: None,
            data: None,
            timestamp: None,
        }
    }

    pub fn service(mut self, service: impl Into<String>) -> Self {
        self.service = Some(service.into());
        self
    }

    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }

    pub fn at(mut self, timestamp: DateTime<Utc>) -> Self {
        self.timestamp = Some(timestamp);
        self
    }
}

#[derive(Clone)]
pub struct TimelineStore {
    events: Arc<RwLock<Vec<TimelineEvent>>>,
    path: PathBuf,
}

impl TimelineStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            events: Arc::new(RwLock::new(Vec::new())),
            path,
        }
    }

    /// Record an event and hand back the stamped form.
    ///
    /// The disk append is spawned rather than awaited: the timeline is an
    /// account of an operation, not the operation itself, so a slow or failing
    /// write must never hold up — or fail — the thing it is describing.
    pub fn append(&self, event: NewTimelineEvent) -> TimelineEvent {
        let event = TimelineEvent {
            id: Uuid::new_v4().to_string(),
            timestamp: event.timestamp.unwrap_or_else(Utc::now),
            kind: event.kind,
            service: event.service,
            severity: event.severity,
            title: event.title,
            detail: event.detail,
            data: event.data,
        };
        {
            let mut events = self.events.write().unwrap();
            events.push(event.clone());
            if events.len() > MAX_EVENTS {
                let excess = events.len() - MAX_EVENTS;
                events.drain(0..excess);
            }
        }
        let path = self.path.clone();
        let written = event.clone();
        tokio::spawn(async move {
            let _ = append_to_disk(&path, &written).await;
        });
        event
    }

    /// The most recent events, oldest first.
    pub fn read(&self, limit: usize) -> Vec<TimelineEvent> {
        let events = self.events.read().unwrap();
        let start = events.len().saturating_sub(limit);
        events[start..].to_vec()
    }
}

async fn append_to_disk(path: &PathBuf, event: &TimelineEvent) -> Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut line = serde_json::to_vec(event)?;
    line.push(b'\n');
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await?;
    file.write_all(&line).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> TimelineStore {
        TimelineStore::new(
            std::env::temp_dir()
                .join(format!("nomoreide-timeline-{}", Uuid::new_v4()))
                .join("timeline.log"),
        )
    }

    #[tokio::test]
    async fn events_are_stamped_and_read_back_newest_last() {
        let store = store();
        for index in 0..3 {
            store.append(NewTimelineEvent::new(
                TimelineEventKind::ServiceLifecycle,
                TimelineSeverity::Info,
                format!("event {index}"),
            ));
        }
        let events = store.read(500);
        assert_eq!(
            events
                .iter()
                .map(|event| event.title.as_str())
                .collect::<Vec<_>>(),
            vec!["event 0", "event 1", "event 2"]
        );
        assert_eq!(store.read(1)[0].title, "event 2");
        // Ids distinguish two events that are otherwise identical.
        assert_ne!(events[0].id, events[1].id);
    }

    #[tokio::test]
    async fn the_buffer_keeps_only_the_most_recent_events() {
        let store = store();
        for index in 0..(MAX_EVENTS + 25) {
            store.append(NewTimelineEvent::new(
                TimelineEventKind::ServiceLog,
                TimelineSeverity::Warning,
                format!("event {index}"),
            ));
        }
        let events = store.read(MAX_EVENTS * 2);
        assert_eq!(events.len(), MAX_EVENTS);
        assert_eq!(events[0].title, "event 25");
    }

    #[test]
    fn events_serialize_the_way_the_reference_writes_them() {
        let event = TimelineEvent {
            id: "id".into(),
            timestamp: "2026-08-21T00:00:00Z".parse().unwrap(),
            kind: TimelineEventKind::ServicePort,
            service: Some("api".into()),
            severity: TimelineSeverity::Info,
            title: "api reported http://localhost:3000".into(),
            detail: None,
            data: None,
        };
        let rendered = serde_json::to_value(&event).unwrap();
        assert_eq!(rendered["kind"], "service.port");
        assert_eq!(rendered["severity"], "info");
        // Absent optionals are omitted rather than sent as null.
        assert!(rendered.get("detail").is_none());
        assert!(rendered.get("data").is_none());
    }
}
