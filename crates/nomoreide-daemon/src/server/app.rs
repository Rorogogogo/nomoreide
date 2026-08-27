//! The context every route handler shares, and the credential check that stands
//! in front of the ones that speak for the runtime.

use crate::runtime::DaemonRuntime;
use crate::server::errors::error;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use nomoreide_core::approval_broker::ApprovalBroker;
use nomoreide_core::config::ConfigStore;
use nomoreide_core::error_inbox::ErrorInbox;
use nomoreide_core::event_sink::{EventSink, EventSinkError, SharedEventSink};
use nomoreide_core::terminal::TerminalManager;
use nomoreide_core::tool_call_store::ToolCallStore;
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use subtle::ConstantTimeEq;
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
    /// Parks a blocked tool-permission hook until a human decides.
    ///
    /// No run opens one here yet — the agent event stream is still the
    /// TypeScript daemon's — so every request this broker sees is one it
    /// denies. That is the point: the refusals in front of a decision are the
    /// part a hook depends on, and they answer the same either way.
    pub(crate) approvals: ApprovalBroker,
}

/// A sink that drops what it is given.
pub(crate) struct DiscardingEventSink;

impl EventSink for DiscardingEventSink {
    fn emit(&self, _event: &str, _payload: Value) -> Result<(), EventSinkError> {
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
    let Some(candidate) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return false;
    };
    bool::from(candidate.as_bytes().ct_eq(credential.as_bytes()))
}
