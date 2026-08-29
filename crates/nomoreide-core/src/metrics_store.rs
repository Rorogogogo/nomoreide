//! Rolling CPU and memory, for the host and for each running service.
//!
//! The Rust half of `src/core/metrics-store.ts`. A ring per service and one for
//! the host, filled by a timer, so a graph can be drawn from a single request
//! rather than from a client that has been polling since the page opened.
//!
//! **One `ps` per tick, not one per service.** The host's process table already
//! contains every managed process, so a service's cost is a sum over its own
//! subtree of a table that was read anyway — reading it per service would cost
//! a process per service per tick and give answers from slightly different
//! instants.
//!
//! A service's buffer is keyed to the run it belongs to: when `startedAt`
//! changes the buffer is dropped rather than appended to, because a graph that
//! spans a restart draws a line between two different processes.

use crate::host_metrics::HostMetricsCollector;
use crate::system_processes::{read_system_processes, ManagedRoot, SystemProcess};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// How often the sampler runs, and how many ticks each ring keeps — half an
/// hour at three seconds, which is the range the panes are drawn over.
const INTERVAL_MS: u64 = 3_000;
const CAPACITY: usize = 600;

/// A service the runtime says is up, and the process to measure it by.
#[derive(Debug, Clone)]
pub struct RunningService {
    pub name: String,
    pub pid: Option<i64>,
    pub started_at: Option<String>,
}

#[derive(Default)]
struct Buffer {
    started_at: Option<String>,
    samples: Vec<Value>,
    latest: Option<Value>,
}

#[derive(Default)]
struct Inner {
    host_samples: Vec<Value>,
    buffers: HashMap<String, Buffer>,
    system_processes: Vec<Value>,
}

#[derive(Clone)]
pub struct MetricsStore {
    inner: Arc<Mutex<Inner>>,
    collector: Arc<Mutex<HostMetricsCollector>>,
}

impl MetricsStore {
    pub fn new(cwd: impl Into<String>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            collector: Arc::new(Mutex::new(HostMetricsCollector::new(cwd))),
        }
    }

    pub fn interval_ms(&self) -> u64 {
        INTERVAL_MS
    }

    /// Take one reading of the host, the process table, and every running
    /// service. Failures are dropped: a tick that could not read the table is a
    /// gap in a graph, not an error anybody can act on.
    pub async fn sample_once(&self, running: &[RunningService]) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_millis() as f64)
            .unwrap_or(0.0);

        let host = self
            .collector
            .lock()
            .ok()
            .map(|mut collector| collector.sample(now));
        let rows = read_system_processes().await.unwrap_or_default();
        let roots: Vec<ManagedRoot> = running
            .iter()
            .filter_map(|service| {
                Some(ManagedRoot {
                    pid: service.pid?,
                    service: service.name.clone(),
                })
            })
            .collect();
        let classified = crate::system_processes::classify_system_processes(
            &rows,
            &roots,
            std::process::id() as i64,
            None,
        );

        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if let Some(host) = host {
            push_capped(&mut inner.host_samples, host);
        }
        inner.system_processes = classified;

        for service in running {
            let Some(pid) = service.pid else {
                continue;
            };
            let tree = subtree(&rows, pid);
            if tree.is_empty() {
                continue;
            }
            let cpu: f64 = tree.iter().map(|row| row.cpu_percent).sum();
            let rss: f64 = tree.iter().map(|row| row.rss_mb).sum();
            let buffer = inner.buffers.entry(service.name.clone()).or_default();
            // A different run is a different graph.
            if buffer.started_at != service.started_at {
                buffer.started_at = service.started_at.clone();
                buffer.samples.clear();
            }
            let sample = json!({
                "t": crate::js_number::value(now),
                "cpu": crate::js_number::value(round_one(cpu)),
                "rss": crate::js_number::value(round_one(rss)),
            });
            buffer.latest = Some(json!({
                "sampledAt": crate::js_number::value(now),
                "cpuPercent": crate::js_number::value(round_one(cpu)),
                "rssMb": crate::js_number::value(round_one(rss)),
                "processCount": tree.len(),
                "source": "process-tree",
            }));
            push_capped(&mut buffer.samples, sample);
        }

        // A service that stopped keeps nothing: its buffer is keyed to a run
        // that has ended.
        let live: Vec<String> = running.iter().map(|service| service.name.clone()).collect();
        inner.buffers.retain(|name, _| live.contains(name));
    }

    /// One service's series, in the shape the pane draws.
    pub fn read(&self, service: &str) -> Value {
        let mut series = Map::new();
        series.insert("service".into(), Value::String(service.to_string()));
        if let Ok(inner) = self.inner.lock() {
            if let Some(buffer) = inner.buffers.get(service) {
                if let Some(started) = &buffer.started_at {
                    series.insert("startedAt".into(), Value::String(started.clone()));
                }
                series.insert("sampleIntervalMs".into(), Value::from(INTERVAL_MS));
                series.insert("samples".into(), Value::Array(buffer.samples.clone()));
                return Value::Object(series);
            }
        }
        series.insert("sampleIntervalMs".into(), Value::from(INTERVAL_MS));
        series.insert("samples".into(), Value::Array(Vec::new()));
        Value::Object(series)
    }

    /// The whole activity picture: the host, every running service, and the
    /// process table.
    ///
    /// A service appears only while its buffer still belongs to the run the
    /// runtime is reporting — a graph from the previous run would be drawn
    /// against a process that no longer exists.
    pub fn read_activity(&self, running: &[RunningService]) -> Value {
        let Ok(inner) = self.inner.lock() else {
            return json!({ "sampleIntervalMs": INTERVAL_MS });
        };
        let mut services = Map::new();
        for service in running {
            let Some(buffer) = inner.buffers.get(&service.name) else {
                continue;
            };
            let (Some(latest), true) = (&buffer.latest, buffer.started_at == service.started_at)
            else {
                continue;
            };
            let mut row = Map::new();
            row.insert("service".into(), Value::String(service.name.clone()));
            row.insert(
                "startedAt".into(),
                buffer
                    .started_at
                    .clone()
                    .map(Value::String)
                    .unwrap_or(Value::Null),
            );
            if let Value::Object(latest) = latest {
                for (key, value) in latest {
                    row.insert(key.clone(), value.clone());
                }
            }
            services.insert(service.name.clone(), Value::Object(row));
        }

        json!({
            "sampleIntervalMs": INTERVAL_MS,
            "host": {
                "current": inner.host_samples.last().cloned().unwrap_or(Value::Null),
                "samples": inner.host_samples.clone(),
            },
            "services": Value::Object(services),
            "systemProcesses": inner.system_processes.clone(),
        })
    }
}

/// Every process in `pid`'s subtree, including `pid` itself.
fn subtree(rows: &[SystemProcess], pid: i64) -> Vec<&SystemProcess> {
    let mut children: HashMap<i64, Vec<i64>> = HashMap::new();
    for row in rows {
        children.entry(row.ppid).or_default().push(row.pid);
    }
    let mut wanted = std::collections::HashSet::new();
    let mut stack = vec![pid];
    while let Some(current) = stack.pop() {
        if !wanted.insert(current) {
            continue;
        }
        stack.extend(children.get(&current).cloned().unwrap_or_default());
    }
    rows.iter().filter(|row| wanted.contains(&row.pid)).collect()
}

fn push_capped(buffer: &mut Vec<Value>, sample: Value) {
    buffer.push(sample);
    if buffer.len() > CAPACITY {
        let excess = buffer.len() - CAPACITY;
        buffer.drain(..excess);
    }
}

fn round_one(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> MetricsStore {
        MetricsStore::new("/")
    }

    #[test]
    fn an_unknown_service_has_an_empty_series_rather_than_no_answer() {
        let series = store().read("nope");
        assert_eq!(series["service"], Value::from("nope"));
        assert_eq!(series["sampleIntervalMs"], Value::from(3000));
        assert_eq!(series["samples"], Value::Array(Vec::new()));
        assert!(series.get("startedAt").is_none(), "no run to report");
    }

    #[tokio::test]
    async fn a_tick_records_the_host_and_this_process_tree() {
        let store = store();
        let running = [RunningService {
            name: "self".into(),
            pid: Some(std::process::id() as i64),
            started_at: Some("2026-01-01T00:00:00.000Z".into()),
        }];
        store.sample_once(&running).await;

        let activity = store.read_activity(&running);
        assert!(activity["host"]["current"].is_object());
        assert_eq!(activity["host"]["samples"].as_array().map(Vec::len), Some(1));
        assert!(
            activity["systemProcesses"]
                .as_array()
                .is_some_and(|rows| !rows.is_empty()),
            "the machine has processes"
        );
        let series = store.read("self");
        assert_eq!(series["samples"].as_array().map(Vec::len), Some(1));
        assert_eq!(
            series["startedAt"],
            Value::from("2026-01-01T00:00:00.000Z")
        );
    }

    #[tokio::test]
    async fn a_restart_starts_the_graph_again() {
        let store = store();
        let pid = Some(std::process::id() as i64);
        let first = [RunningService {
            name: "self".into(),
            pid,
            started_at: Some("2026-01-01T00:00:00.000Z".into()),
        }];
        store.sample_once(&first).await;
        store.sample_once(&first).await;
        assert_eq!(store.read("self")["samples"].as_array().map(Vec::len), Some(2));

        let restarted = [RunningService {
            name: "self".into(),
            pid,
            started_at: Some("2026-01-01T01:00:00.000Z".into()),
        }];
        store.sample_once(&restarted).await;
        assert_eq!(
            store.read("self")["samples"].as_array().map(Vec::len),
            Some(1),
            "the previous run's samples are not part of this graph"
        );
    }

    #[tokio::test]
    async fn a_service_that_stopped_leaves_no_series_behind() {
        let store = store();
        let running = [RunningService {
            name: "self".into(),
            pid: Some(std::process::id() as i64),
            started_at: Some("2026-01-01T00:00:00.000Z".into()),
        }];
        store.sample_once(&running).await;
        store.sample_once(&[]).await;
        assert_eq!(store.read("self")["samples"], Value::Array(Vec::new()));
        assert_eq!(store.read_activity(&[])["services"], json!({}));
    }
}
