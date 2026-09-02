//! The context every route handler shares, and the credential check that stands
//! in front of the ones that speak for the runtime.

use crate::runtime::DaemonRuntime;
use crate::server::errors::error;
use crate::server::routes::deploy_providers::oauth::ProviderLogins;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use nomoreide_core::agent_profiles::auth::AuthStates;
use nomoreide_core::approval_broker::ApprovalBroker;
use nomoreide_core::config::ConfigStore;
use nomoreide_core::error_inbox::ErrorInbox;
use nomoreide_core::event_sink::{EventSink, EventSinkError, SharedEventSink};
use nomoreide_core::metrics_store::MetricsStore;
use nomoreide_core::terminal::TerminalManager;
use nomoreide_core::test_runner::TestRunner;
use nomoreide_core::tool_call_store::ToolCallStore;
use nomoreide_core::usage_history::UsageHistory;
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use subtle::ConstantTimeEq;
use tokio::sync::broadcast;
use tokio::sync::mpsc;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) credential: String,
    pub(crate) owner_id: String,
    pub(crate) config_store: ConfigStore,
    pub(crate) runtime: Arc<DaemonRuntime>,
    pub(crate) errors: ErrorInbox,
    /// The same channel a SIGTERM pulls on. A shutdown asked for over HTTP has
    /// to drain the runtime the way a signalled one does, so both go through
    /// here rather than one of them exiting the process directly.
    pub(crate) shutdown: mpsc::Sender<()>,
    pub(crate) terminal: TerminalManager,
    /// Where a terminal session's lifecycle events go.
    ///
    /// Nothing subscribes yet — the daemon has no event stream of its own until
    /// the dashboard moves onto it — so this discards. It is threaded through
    /// anyway because the manager emits unconditionally, and a sink that exists
    /// is what lets the stream be added without touching the manager again.
    pub(crate) events: SharedEventSink,
    /// The same events, readable. `events` is write-only through its trait, and
    /// a stream has to subscribe — so the channel behind it is held here too.
    pub(crate) event_stream: broadcast::Sender<RuntimeEvent>,
    /// Hands out `term_1`, `term_2`, … the way the reference does. Sessions the
    /// caller named (`svc:<service>`) do not draw from it.
    pub(crate) session_counter: Arc<AtomicU64>,
    /// The MCP tool-call feed the dashboard renders.
    ///
    /// Nothing writes to it yet: the reference records here only from an
    /// in-process MCP server, and this daemon's MCP clients are separate
    /// processes. It exists so `/api/agent/tool-calls` answers the same shape,
    /// and so the writer is the only piece still missing.
    pub(crate) tool_calls: ToolCallStore,
    /// Per-service test runs. Shared because a run outlives the request that
    /// started it: the POST answers while the child is still going, and the
    /// stream that reports the rest is a later request.
    pub(crate) tests: TestRunner,
    /// Rolling CPU and memory for the host and every running service.
    ///
    /// Shared rather than rebuilt per request because it *is* the history: a
    /// store built fresh for a request would have one sample in it, and a graph
    /// needs the ones before.
    pub(crate) metrics: MetricsStore,
    /// Token and cost totals over time.
    ///
    /// Shared rather than rebuilt per request because it carries the dedup keys
    /// the sampler writes through: a store built fresh each tick would re-seed
    /// from the file every time and append a duplicate row on the first sample
    /// after every restart.
    pub(crate) usage_history: Arc<UsageHistory>,
    /// Parks a blocked tool-permission hook until a human decides.
    ///
    /// No run opens one here yet — the agent event stream is still the
    /// TypeScript daemon's — so every request this broker sees is one it
    /// denies. That is the point: the refusals in front of a decision are the
    /// part a hook depends on, and they answer the same either way.
    pub(crate) approvals: ApprovalBroker,
    /// Registry sign-ins waiting on a browser.
    ///
    /// In the daemon rather than in the route module because a sign-in spans
    /// three requests — `start` mints the state, `finish` settles it from a
    /// browser tab, `outcome` collects it — and only something outliving all
    /// three can tie them together.
    pub(crate) registry_auth: AuthStates,
    /// Deploy-provider browser sign-ins waiting on a callback.
    ///
    /// Here rather than in the route module for the same reason
    /// `registry_auth` is: a sign-in spans three unrelated requests — the
    /// dashboard's `start`, the browser's `callback`, and however many
    /// `status` polls — and only something outliving all three can tie them
    /// together.
    pub(crate) provider_logins: ProviderLogins,
    /// The relay connection, and whether it is up.
    ///
    /// Held here so `nomoreide remote pair` can ask a *running* daemon to dial
    /// the moment it writes a credential, rather than the machine sitting
    /// offline until something restarts it.
    pub(crate) relay: crate::remote::supervisor::RelaySupervisor,
}

/// One runtime event: what happened, and the thing it happened to.
///
/// Named rather than typed because a single channel carries every producer's
/// events — a terminal session changing, and whatever is wired in next — and
/// each stream takes only the names it serves.
#[derive(Clone, Debug)]
pub(crate) struct RuntimeEvent {
    pub(crate) name: String,
    pub(crate) payload: Value,
}

/// How many events a stream may fall behind before it starts losing them. A
/// slow reader must never be able to block a producer, so this drops rather
/// than waits.
pub(crate) const EVENT_BACKLOG: usize = 256;

/// A sink that fans its events out to whoever is streaming.
///
/// The managers emit unconditionally into a [`SharedEventSink`], so this is the
/// whole of what `/api/terminal/events` needed: nothing in the terminal manager
/// changed to make it stream.
pub(crate) struct BroadcastEventSink {
    events: broadcast::Sender<RuntimeEvent>,
}

impl BroadcastEventSink {
    pub(crate) fn new(events: broadcast::Sender<RuntimeEvent>) -> Self {
        Self { events }
    }
}

impl EventSink for BroadcastEventSink {
    /// A send with no listeners is not a failure — the usual state of a daemon
    /// nobody has a dashboard open against.
    fn emit(&self, event: &str, payload: Value) -> Result<(), EventSinkError> {
        let _ = self.events.send(RuntimeEvent {
            name: event.to_string(),
            payload,
        });
        Ok(())
    }
}

impl AppState {
    /// The directory a request that named no repository runs in: the selected
    /// repository's active worktree when that is still a worktree, else its
    /// path, else wherever the daemon was started.
    pub(crate) async fn workspace_cwd(&self) -> String {
        let fallback = std::env::current_dir()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default();
        let Ok(config) = self.config_store.load().await else {
            return fallback;
        };
        nomoreide_core::config::selected_git_cwd(&config, &fallback).await
    }

    /// The next `term_<n>`.
    ///
    /// The counter lives here rather than on the manager because which ids a
    /// caller hands out is that caller's convention — the desktop app uses a
    /// different one against the same manager.
    pub(crate) fn next_session_id(&self) -> String {
        format!(
            "term_{}",
            self.session_counter.fetch_add(1, Ordering::Relaxed) + 1
        )
    }
}

/// Reject anything that does not carry the daemon's local credential.
///
/// This is a layer over the authenticated router rather than a line inside each
/// handler: a handler that forgot the check would be an authentication hole
/// that reads exactly like the handlers around it, and the number of handlers
/// only grows. Mounting a route in the authenticated router is what guards it.
pub(crate) async fn require_credential(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    if !authorized(request.headers(), &state.credential) {
        return error(StatusCode::UNAUTHORIZED, "Authentication required.");
    }
    next.run(request).await
}

/// Compared in constant time: a credential that leaks its prefix through timing
/// is guessable byte by byte.
fn authorized(headers: &HeaderMap, credential: &str) -> bool {
    let bearer = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let websocket = headers
        .get(axum::http::header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            value
                .split(',')
                .map(str::trim)
                .find_map(|protocol| protocol.strip_prefix("nomoreide-bearer."))
        });
    bearer
        .into_iter()
        .chain(websocket)
        .any(|candidate| bool::from(candidate.as_bytes().ct_eq(credential.as_bytes())))
}

#[cfg(test)]
mod tests {
    use super::authorized;
    use axum::http::{header, HeaderMap, HeaderValue};

    #[test]
    fn accepts_bearer_headers_and_websocket_subprotocols() {
        let mut bearer = HeaderMap::new();
        bearer.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer secret"),
        );
        assert!(authorized(&bearer, "secret"));

        let mut websocket = HeaderMap::new();
        websocket.insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_static("nomoreide, nomoreide-bearer.secret"),
        );
        assert!(authorized(&websocket, "secret"));
        assert!(!authorized(&websocket, "different"));
    }
}
