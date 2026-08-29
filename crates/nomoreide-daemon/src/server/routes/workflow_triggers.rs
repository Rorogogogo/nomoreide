//! Configured bindings between an event and a workflow.
//!
//! All five of the domain's endpoints, the stream included.
//!
//! **The queue is empty because nothing fills it.** A fired trigger enqueues a
//! pending run for the dashboard to drain, and the thing that fires triggers —
//! the manager watching the error inbox, the timeline and CI — is not ported
//! yet. So `/pending` answers with an empty queue and an acknowledgement finds
//! nothing to acknowledge. Both are the *correct* answers for a daemon with no
//! trigger manager, and both are the same answers the reference gives when
//! nothing has fired; what is missing here is the producer, not the route.
//!
//! **`/pending` is a static path under a parameterised one.** The reference
//! registers it before its `:id` pattern, so a `GET` reaches the queue and a
//! `DELETE` falls through to the pattern and deletes a trigger whose id is
//! literally `pending`. Mirrored with a fallback rather than tightened.
//!
//! **Everything is a 400, including a schema refusal.** Each route wraps its
//! work in one catch, and the validator's report is what a `ZodError`'s message
//! is: its issue array as pretty JSON. So a client that shows the error shows
//! zod's own report.
//!
//! **A delete never fails on an unknown id.** The caller asked for that trigger
//! to be gone, and afterwards it is.

use crate::server::app::AppState;
use crate::server::body::{percent_decode, read_json_object};
use crate::server::errors::{error, method_not_allowed};
use crate::server::sse;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use nomoreide_core::workflow_triggers::workflow_trigger;
use serde_json::{json, Value};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/workflow-triggers", get(list).post(save))
        .route(
            "/api/workflow-triggers/pending",
            get(pending).fallback(shadowed_trigger_id),
        )
        .route("/api/workflow-triggers/pending/stream", get(pending_stream))
        .route(
            "/api/workflow-triggers/pending/:id/ack",
            axum::routing::post(ack).fallback(method_not_allowed),
        )
        .route(
            "/api/workflow-triggers/:id",
            axum::routing::delete(remove).fallback(method_not_allowed),
        )
}

/// The pending queue, which is empty until something fires a trigger.
async fn pending() -> Response {
    Json(json!({ "ok": true, "pending": [] })).into_response()
}

/// The pending queue as a stream: an empty replay, and then a heartbeat every
/// fifteen seconds.
///
/// **Nothing ever sends on this channel.** No trigger fires in this runtime
/// yet, so the sender exists only to hold the stream open — which is the
/// reference's behaviour too: its stream stays connected with an empty queue
/// rather than closing.
async fn pending_stream() -> Response {
    let live = tokio::sync::broadcast::Sender::<Value>::new(1);
    sse::stream(
        sse::RETRY_AND_PING,
        "pending",
        Vec::<Value>::new(),
        live,
        Some,
    )
}

/// Acknowledging a pending run. `ok` is whether one was removed, and the status
/// follows it — so an id that is not queued is a 404 carrying `ok: false`
/// rather than an error envelope.
async fn ack() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "ok": false }))).into_response()
}

/// What `/api/workflow-triggers/pending` means for a method the queue does not
/// answer: the reference's `:id` pattern, with `pending` as the id.
async fn shadowed_trigger_id(
    state: State<AppState>,
    method: axum::http::Method,
    uri: Uri,
) -> Response {
    if method == axum::http::Method::DELETE {
        remove(state, uri).await
    } else {
        method_not_allowed().await
    }
}

async fn list(State(state): State<AppState>) -> Response {
    match state.config_store.load().await {
        Ok(config) => {
            Json(json!({ "ok": true, "triggers": config.workflow_triggers })).into_response()
        }
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}

async fn save(State(state): State<AppState>, body: Bytes) -> Response {
    let payload = read_json_object(&body);
    let trigger = match workflow_trigger(&payload) {
        Ok(trigger) => trigger,
        Err(report) => return error(StatusCode::BAD_REQUEST, &report),
    };
    // Stored as the *parsed* record rather than as the body: the schema is not
    // strict, so an unknown key validates, and storing the body would keep a
    // field nothing will ever read.
    let stored = match serde_json::to_value(&trigger) {
        Ok(value) => value,
        Err(reason) => return error(StatusCode::BAD_REQUEST, &reason.to_string()),
    };
    match state.config_store.save_workflow_trigger(stored).await {
        Ok(config) => {
            Json(json!({ "ok": true, "triggers": config.workflow_triggers })).into_response()
        }
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}

async fn remove(State(state): State<AppState>, uri: Uri) -> Response {
    let Some(id) = id_from(&uri) else {
        return error(StatusCode::BAD_REQUEST, "Not found");
    };
    match state.config_store.remove_workflow_trigger(&id).await {
        Ok(config) => {
            Json(json!({ "ok": true, "triggers": config.workflow_triggers })).into_response()
        }
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}

/// The `:id` segment, decoded — unlike a snapshot's sha, which is judged as it
/// arrived. The reference decodes this one before looking it up.
fn id_from(uri: &Uri) -> Option<String> {
    let path = uri.path().strip_prefix("/api/workflow-triggers/")?;
    let segment = path.split('/').next()?;
    (!segment.is_empty()).then(|| percent_decode(segment))
}
