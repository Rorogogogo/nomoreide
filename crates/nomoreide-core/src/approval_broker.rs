//! Bridges an agent CLI's tool-permission hook to whoever is watching the run.
//!
//! The hook is a child process of the spawned agent. It POSTs an approval
//! request and *blocks*; the broker emits that request onto the run's event
//! stream and parks the caller until a decision arrives back. Keyed by the
//! agent CLI's own session id, which both the stream (from its init event) and
//! the hook (from its stdin payload) already know.
//!
//! Every path that cannot reach a human denies. A request naming no session, a
//! session nobody opened, and a session that ends while a request is still
//! parked all answer `deny` — the last one at teardown, so a blocked hook is
//! never left waiting on a run that is gone.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

/// What the hook asked about: one tool call, awaiting a verdict.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub request_id: String,
    pub name: String,
    pub input: serde_json::Value,
}

/// The verdict. `reason` is prose for the agent, present only when the broker
/// itself decided — a user's plain allow carries none.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalDecision {
    pub decision: Decision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Allow,
    Deny,
}

impl ApprovalDecision {
    pub fn deny(reason: &str) -> Self {
        Self {
            decision: Decision::Deny,
            reason: Some(reason.to_string()),
        }
    }
}

/// Refused because the request named no session, or named one nobody opened.
pub const NO_SESSION: &str = "No active agent session to approve.";
/// Refused at teardown, because the run ended with the request still parked.
pub const RUN_ENDED: &str = "The agent session ended before you responded.";

/// Where a run's approval requests are delivered. The broker never renders the
/// request itself — a caller hands in whatever puts it in front of a human.
type Emit = Arc<dyn Fn(ApprovalRequest) + Send + Sync>;

struct Channel {
    emit: Emit,
    pending: HashMap<String, oneshot::Sender<ApprovalDecision>>,
}

/// The registry of open runs. Cloneable, and every clone shares one state, so
/// the hook endpoint and the decision endpoint can hold their own handles.
#[derive(Clone, Default)]
pub struct ApprovalBroker {
    channels: Arc<Mutex<HashMap<String, Channel>>>,
}

impl ApprovalBroker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a run's emitter so its approvals can reach a human.
    ///
    /// Re-opening an id replaces the channel. Anything parked under the old one
    /// is denied rather than dropped, because dropping its sender would answer
    /// the blocked hook with a broken channel instead of a verdict.
    pub fn open_run(&self, session_id: &str, emit: Emit) {
        let replaced = {
            let mut channels = self.channels.lock().unwrap();
            channels.insert(
                session_id.to_string(),
                Channel {
                    emit,
                    pending: HashMap::new(),
                },
            )
        };
        if let Some(channel) = replaced {
            deny_all(channel, RUN_ENDED);
        }
    }

    /// Tear a run down, denying everything still awaiting a decision.
    pub fn close_run(&self, session_id: &str) {
        let channel = self.channels.lock().unwrap().remove(session_id);
        if let Some(channel) = channel {
            deny_all(channel, RUN_ENDED);
        }
    }

    /// Ask for a verdict, blocking until one arrives.
    ///
    /// An absent session id and an empty one are the same thing: no run. The
    /// empty string is a real case — it arrives whenever a hook fires before
    /// the CLI has reported its session — and looking it up as a key would find
    /// a channel only by accident.
    pub async fn request_approval(
        &self,
        session_id: Option<&str>,
        request_id: &str,
        name: &str,
        input: serde_json::Value,
    ) -> ApprovalDecision {
        let session_id = session_id.filter(|id| !id.is_empty());
        let request = ApprovalRequest {
            request_id: request_id.to_string(),
            name: name.to_string(),
            input,
        };

        let (sender, receiver) = oneshot::channel();
        let emit = {
            let Some(session_id) = session_id else {
                return ApprovalDecision::deny(NO_SESSION);
            };
            let mut channels = self.channels.lock().unwrap();
            let Some(channel) = channels.get_mut(session_id) else {
                return ApprovalDecision::deny(NO_SESSION);
            };
            channel.pending.insert(request_id.to_string(), sender);
            channel.emit.clone()
        };

        // Emitted outside the lock: the emitter reaches a live event stream,
        // and holding the registry while it writes would let one slow watcher
        // stall every other run's approvals.
        emit(request);

        // The sender is only ever dropped by a teardown that denies first, so a
        // closed channel still means denied.
        receiver
            .await
            .unwrap_or_else(|_| ApprovalDecision::deny(RUN_ENDED))
    }

    /// Deliver a decision. False when the request is unknown or already
    /// answered, which is what lets a caller tell a stale click from a live one.
    pub fn resolve(&self, session_id: &str, request_id: &str, decision: ApprovalDecision) -> bool {
        let sender = {
            let mut channels = self.channels.lock().unwrap();
            channels
                .get_mut(session_id)
                .and_then(|channel| channel.pending.remove(request_id))
        };
        match sender {
            Some(sender) => sender.send(decision).is_ok(),
            None => false,
        }
    }

    /// Whether a run is open. Used by callers that want to report a missing
    /// stream rather than silently deny.
    pub fn has_run(&self, session_id: &str) -> bool {
        self.channels.lock().unwrap().contains_key(session_id)
    }
}

fn deny_all(channel: Channel, reason: &str) {
    for (_, sender) in channel.pending {
        let _ = sender.send(ApprovalDecision::deny(reason));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    /// Every wait in this module is bounded.
    ///
    /// A seeded sweep showed why: removing the empty-id guard does not make
    /// `treats_an_empty_session_id_as_no_session` *fail*, it makes it park on a
    /// channel nothing will ever resolve and hang forever. A hung test reports
    /// nothing and burns a CI job's whole timeout, so a regression has to come
    /// back as a failure with a name on it.
    const PATIENCE: Duration = Duration::from_secs(10);

    async fn bounded<T>(what: &str, work: impl std::future::Future<Output = T>) -> T {
        match tokio::time::timeout(PATIENCE, work).await {
            Ok(value) => value,
            Err(_) => panic!("{what} never completed - a decision was never delivered"),
        }
    }

    /// Spin until the emitter has been called, rather than sleeping a guessed
    /// interval. Bounded for the same reason as [`bounded`].
    async fn emitted(seen: &Arc<Mutex<Vec<ApprovalRequest>>>) -> ApprovalRequest {
        bounded("the request was never emitted", async {
            loop {
                if let Some(request) = seen.lock().unwrap().first().cloned() {
                    return request;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
    }

    fn recorder() -> (Emit, Arc<Mutex<Vec<ApprovalRequest>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let emit: Emit = Arc::new(move |request| sink.lock().unwrap().push(request));
        (emit, seen)
    }

    #[tokio::test]
    async fn denies_a_request_that_names_no_session() {
        let broker = ApprovalBroker::new();
        let decision = broker.request_approval(None, "r1", "Bash", json!({})).await;
        assert_eq!(decision, ApprovalDecision::deny(NO_SESSION));
    }

    #[tokio::test]
    async fn denies_a_request_for_a_session_nobody_opened() {
        let broker = ApprovalBroker::new();
        let decision = broker
            .request_approval(Some("ghost"), "r1", "Bash", json!({}))
            .await;
        assert_eq!(decision, ApprovalDecision::deny(NO_SESSION));
    }

    /// An empty id is not a key to look up. A hook that fires before the CLI has
    /// reported its session sends one, and treating it as a name would match a
    /// channel only by accident.
    #[tokio::test]
    async fn treats_an_empty_session_id_as_no_session() {
        let broker = ApprovalBroker::new();
        let (emit, seen) = recorder();
        broker.open_run("", emit);

        let decision = bounded(
            "an empty session id parked instead of denying",
            broker.request_approval(Some(""), "r1", "Bash", json!({})),
        )
        .await;

        assert_eq!(decision, ApprovalDecision::deny(NO_SESSION));
        assert!(seen.lock().unwrap().is_empty(), "nothing should be emitted");
    }

    #[tokio::test]
    async fn a_decision_reaches_the_parked_request() {
        let broker = ApprovalBroker::new();
        let (emit, seen) = recorder();
        broker.open_run("s1", emit);

        let asking = {
            let broker = broker.clone();
            tokio::spawn(async move {
                broker
                    .request_approval(Some("s1"), "r1", "Bash", json!({ "command": "ls" }))
                    .await
            })
        };

        // The request must be emitted and parked before a decision can land.
        let request = emitted(&seen).await;
        assert_eq!(request.request_id, "r1");
        assert_eq!(request.name, "Bash");
        assert_eq!(request.input, json!({ "command": "ls" }));

        assert!(broker.resolve(
            "s1",
            "r1",
            ApprovalDecision {
                decision: Decision::Allow,
                reason: None,
            },
        ));
        assert_eq!(
            bounded("the allowed request", asking).await.unwrap(),
            ApprovalDecision {
                decision: Decision::Allow,
                reason: None,
            }
        );
    }

    #[tokio::test]
    async fn closing_a_run_denies_what_is_still_parked() {
        let broker = ApprovalBroker::new();
        let (emit, seen) = recorder();
        broker.open_run("s1", emit);

        let asking = {
            let broker = broker.clone();
            tokio::spawn(async move {
                broker
                    .request_approval(Some("s1"), "r1", "Bash", json!({}))
                    .await
            })
        };
        emitted(&seen).await;

        broker.close_run("s1");

        assert_eq!(
            bounded("the denied request", asking).await.unwrap(),
            ApprovalDecision::deny(RUN_ENDED)
        );
        assert!(!broker.has_run("s1"));
    }

    /// Teardown must answer the hook, not merely drop it. A dropped sender is
    /// indistinguishable to the waiter from a crash, so the deny is explicit.
    #[tokio::test]
    async fn a_request_parked_on_a_reopened_run_is_denied_not_dropped() {
        let broker = ApprovalBroker::new();
        let (first, seen) = recorder();
        broker.open_run("s1", first);

        let asking = {
            let broker = broker.clone();
            tokio::spawn(async move {
                broker
                    .request_approval(Some("s1"), "r1", "Bash", json!({}))
                    .await
            })
        };
        emitted(&seen).await;

        let (second, _) = recorder();
        broker.open_run("s1", second);

        assert_eq!(
            bounded("the request the reopen displaced", asking)
                .await
                .unwrap(),
            ApprovalDecision::deny(RUN_ENDED)
        );
    }

    #[test]
    fn resolving_an_unknown_request_reports_false() {
        let broker = ApprovalBroker::new();
        let (emit, _) = recorder();
        broker.open_run("s1", emit);

        assert!(!broker.resolve("s1", "missing", ApprovalDecision::deny("no")));
        assert!(!broker.resolve("other", "r1", ApprovalDecision::deny("no")));
    }

    #[tokio::test]
    async fn a_request_can_only_be_resolved_once() {
        let broker = ApprovalBroker::new();
        let (emit, seen) = recorder();
        broker.open_run("s1", emit);

        let asking = {
            let broker = broker.clone();
            tokio::spawn(async move {
                broker
                    .request_approval(Some("s1"), "r1", "Bash", json!({}))
                    .await
            })
        };
        emitted(&seen).await;

        assert!(broker.resolve("s1", "r1", ApprovalDecision::deny("first")));
        assert!(!broker.resolve("s1", "r1", ApprovalDecision::deny("second")));
        assert_eq!(
            bounded("the first decision", asking).await.unwrap(),
            ApprovalDecision::deny("first")
        );
    }

    /// Two runs are independent: a decision for one must not answer the other.
    #[tokio::test]
    async fn runs_do_not_share_pending_requests() {
        let broker = ApprovalBroker::new();
        let (one, seen_one) = recorder();
        let (two, seen_two) = recorder();
        broker.open_run("s1", one);
        broker.open_run("s2", two);

        let first = {
            let broker = broker.clone();
            tokio::spawn(async move {
                broker
                    .request_approval(Some("s1"), "r", "Bash", json!({}))
                    .await
            })
        };
        let second = {
            let broker = broker.clone();
            tokio::spawn(async move {
                broker
                    .request_approval(Some("s2"), "r", "Bash", json!({}))
                    .await
            })
        };
        emitted(&seen_one).await;
        emitted(&seen_two).await;

        broker.close_run("s1");
        assert_eq!(
            bounded("the closed run's request", first).await.unwrap(),
            ApprovalDecision::deny(RUN_ENDED)
        );

        assert!(broker.resolve(
            "s2",
            "r",
            ApprovalDecision {
                decision: Decision::Allow,
                reason: None,
            },
        ));
        assert_eq!(
            bounded("the other run's request", second)
                .await
                .unwrap()
                .decision,
            Decision::Allow
        );
    }

    /// Closing a run nobody opened is a no-op, not a panic — the stream and the
    /// hook race, and the stream can lose.
    #[test]
    fn closing_an_unknown_run_is_harmless() {
        ApprovalBroker::new().close_run("never-opened");
    }

    #[tokio::test]
    async fn the_emitter_runs_outside_the_registry_lock() {
        let broker = ApprovalBroker::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let reentrant = {
            let broker = broker.clone();
            let calls = calls.clone();
            let emit: Emit = Arc::new(move |_| {
                // Re-entering the broker from inside the emitter would deadlock
                // if the lock were still held while emitting.
                let _ = broker.has_run("s1");
                calls.fetch_add(1, Ordering::SeqCst);
            });
            emit
        };
        broker.open_run("s1", reentrant);

        let asking = {
            let broker = broker.clone();
            tokio::spawn(async move {
                broker
                    .request_approval(Some("s1"), "r1", "Bash", json!({}))
                    .await
            })
        };
        bounded(
            "the emitter never ran - the registry lock was still held",
            async {
                while calls.load(Ordering::SeqCst) == 0 {
                    tokio::task::yield_now().await;
                }
            },
        )
        .await;
        broker.close_run("s1");
        assert_eq!(
            bounded("the request", asking).await.unwrap(),
            ApprovalDecision::deny(RUN_ENDED)
        );
    }

    /// The decision is what the hook reads, so its wire shape is load-bearing:
    /// a plain allow carries no `reason` key at all.
    #[test]
    fn a_decision_serializes_the_way_the_hook_reads_it() {
        assert_eq!(
            serde_json::to_string(&ApprovalDecision {
                decision: Decision::Allow,
                reason: None,
            })
            .unwrap(),
            r#"{"decision":"allow"}"#
        );
        assert_eq!(
            serde_json::to_string(&ApprovalDecision::deny(NO_SESSION)).unwrap(),
            r#"{"decision":"deny","reason":"No active agent session to approve."}"#
        );
    }
}
