//! A bounded, in-memory feed of MCP tool calls.
//!
//! The Rust half of `src/core/tool-call-store.ts`. A ring of the most recent
//! calls, plus subscribers for the live stream.
//!
//! **Nothing writes to the daemon's copy today.** The reference creates this in
//! the web layer and only ever records into it from an *in-process* MCP server;
//! the daemon's MCP clients are separate processes, so `/api/agent/tool-calls`
//! answers with an empty list in both runtimes. The store is ported anyway
//! because the endpoint has to answer the same shape, and because the writer is
//! the missing half rather than this.

use serde::Serialize;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

/// How many calls are kept. Old ones are dropped from the front, so the feed
/// stays a feed rather than growing for the life of the daemon.
const CAPACITY: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRecord {
    pub id: u64,
    pub tool: String,
    pub started_at: String,
    pub duration_ms: u64,
    /// `ok` or `error`.
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Default)]
struct Inner {
    records: Vec<ToolCallRecord>,
    next_id: u64,
}

/// How many calls a stream may fall behind before it starts losing them.
const EVENT_BACKLOG: usize = 256;

#[derive(Clone)]
pub struct ToolCallStore {
    inner: Arc<Mutex<Inner>>,
    /// Live calls, for `/api/agent/tool-calls/stream`.
    ///
    /// A broadcast channel rather than a callback list because a stream must
    /// unsubscribe when its reader goes away, and dropping a receiver is that.
    events: broadcast::Sender<ToolCallRecord>,
}

impl Default for ToolCallStore {
    fn default() -> Self {
        Self {
            inner: Arc::default(),
            events: broadcast::Sender::new(EVENT_BACKLOG),
        }
    }
}

impl ToolCallStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Ids start at 1 and never repeat within a daemon's life.
    pub fn record(&self, mut entry: ToolCallRecord) -> ToolCallRecord {
        let Ok(mut inner) = self.inner.lock() else {
            return entry;
        };
        inner.next_id += 1;
        entry.id = inner.next_id;
        inner.records.push(entry.clone());
        if inner.records.len() > CAPACITY {
            let excess = inner.records.len() - CAPACITY;
            inner.records.drain(..excess);
        }
        drop(inner);
        // An error here is "nobody is listening", which is the usual case.
        let _ = self.events.send(entry.clone());
        entry
    }

    /// Live calls, from the moment of subscription. The replay a stream opens
    /// with comes from [`Self::recent`].
    pub fn subscribe(&self) -> broadcast::Receiver<ToolCallRecord> {
        self.events.subscribe()
    }

    /// The most recent `limit`, oldest first — the tail of the ring, not the
    /// head, so a feed rendered top-down reads in the order things happened.
    pub fn recent(&self, limit: usize) -> Vec<ToolCallRecord> {
        let Ok(inner) = self.inner.lock() else {
            return Vec::new();
        };
        if limit >= inner.records.len() {
            return inner.records.clone();
        }
        inner.records[inner.records.len() - limit..].to_vec()
    }
}

/// The `limit` a request asked for, clamped.
///
/// A limit that is absent, blank, unreadable, zero or negative is the default;
/// anything above the ceiling is the ceiling. Untestable through a daemon while
/// the store is always empty — see the module note — so this carries its own
/// unit test rather than relying on the parity gate.
pub fn clamp_limit(limit: f64) -> usize {
    if !limit.is_finite() || limit <= 0.0 {
        return 100;
    }
    (limit as usize).min(500)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(tool: &str) -> ToolCallRecord {
        ToolCallRecord {
            id: 0,
            tool: tool.to_string(),
            started_at: "2026-01-01T00:00:00.000Z".to_string(),
            duration_ms: 1,
            status: "ok".to_string(),
            session_id: None,
            args: None,
            error: None,
        }
    }

    #[test]
    fn ids_start_at_one_and_keep_counting() {
        let store = ToolCallStore::new();
        assert_eq!(store.record(call("a")).id, 1);
        assert_eq!(store.record(call("b")).id, 2);
    }

    #[test]
    fn the_ring_drops_from_the_front() {
        let store = ToolCallStore::new();
        for index in 0..CAPACITY + 10 {
            store.record(call(&format!("tool-{index}")));
        }
        let all = store.recent(usize::MAX);
        assert_eq!(all.len(), CAPACITY);
        assert_eq!(all[0].tool, "tool-10", "the oldest ten were dropped");
    }

    #[test]
    fn recent_returns_the_tail_oldest_first() {
        let store = ToolCallStore::new();
        for index in 0..5 {
            store.record(call(&format!("tool-{index}")));
        }
        let tail = store.recent(2);
        assert_eq!(tail.len(), 2);
        assert_eq!(tail[0].tool, "tool-3");
        assert_eq!(tail[1].tool, "tool-4");
    }

    #[test]
    fn a_limit_that_is_not_a_positive_number_is_the_default() {
        assert_eq!(clamp_limit(5.0), 5);
        assert_eq!(clamp_limit(0.0), 100);
        assert_eq!(clamp_limit(-1.0), 100);
        assert_eq!(clamp_limit(f64::NAN), 100);
        assert_eq!(clamp_limit(99_999.0), 500);
        assert_eq!(clamp_limit(500.0), 500);
    }
}
