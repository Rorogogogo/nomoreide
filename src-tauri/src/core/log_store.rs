use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
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

fn classify_severity(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    if lower.contains("error") || lower.contains("fatal") || lower.contains("panic") {
        Some("error".to_string())
    } else if lower.contains("warn") || lower.contains("warning") {
        Some("warning".to_string())
    } else {
        None
    }
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
}

impl LogStore {
    pub fn new(log_dir: PathBuf) -> Self {
        LogStore {
            inner: Arc::new(RwLock::new(Inner {
                buffers: HashMap::new(),
                listeners: vec![],
            })),
            log_dir,
        }
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

        let log_dir = self.log_dir.clone();
        tokio::spawn(async move {
            let _ = append_to_disk(&log_dir, &entry).await;
        });
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
