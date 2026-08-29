//! Host activity, one service's series, and the guarded terminate.
//!
//! **The process list is opt-in.** `/api/metrics` is polled on a timer by an
//! open dashboard, and the host's whole process table is the largest thing the
//! daemon can send. Only the panel that draws it asks for it, and it asks with
//! `includeProcesses=1` — exactly that, so a client that sends `true` gets the
//! smaller answer rather than a surprise.
//!
//! **The series and its log volume travel together**, in that order of
//! authority: the samples define the window, and the buckets are counted over
//! exactly that window. One response rather than two endpoints, because a
//! second request could answer from a slightly later ring buffer and put the
//! two charts a poll apart — and because the panel polls this on a timer, where
//! a second connection per panel is how a browser's six-per-host budget goes.

use crate::server::app::AppState;
use crate::server::body::read_json_object;
use crate::server::errors::{error, method_not_allowed};
use crate::server::routes::query::query_value;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use nomoreide_core::log_volume::bucket_log_volume;
use nomoreide_core::metrics_store::RunningService;
use nomoreide_core::system_processes::{terminate_system_process, ManagedRoot};
use serde_json::{json, Value};

/// How many buffered lines the volume strip is counted over. The ring holds
/// five hundred; the strip is drawn from all of them.
const LOG_TAIL: usize = 500;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/metrics", get(activity))
        .route(
            "/api/services/:name/metrics",
            get(service_series).fallback(method_not_allowed),
        )
        .route("/api/processes/terminate", post(terminate))
}

/// Every service the runtime reports as up, with the process to measure it by.
fn running_services(state: &AppState) -> Vec<RunningService> {
    state
        .runtime
        .status()
        .into_iter()
        .filter(|status| {
            serde_json::to_value(status.state)
                .ok()
                .and_then(|value| value.as_str().map(str::to_string))
                .as_deref()
                == Some("running")
        })
        .map(|status| RunningService {
            name: status.name,
            pid: status.pid.map(i64::from),
            started_at: status.started_at,
        })
        .collect()
}

async fn activity(State(state): State<AppState>, uri: Uri) -> Response {
    let running = running_services(&state);
    let mut metrics = state.metrics.read_activity(&running);
    if query_value(&uri, "includeProcesses").as_deref() != Some("1") {
        if let Some(object) = metrics.as_object_mut() {
            // Removed rather than nulled: the reference spreads an `undefined`
            // over the key, which drops it from the JSON entirely.
            object.shift_remove("systemProcesses");
        }
    }
    Json(json!({ "ok": true, "metrics": metrics })).into_response()
}

async fn service_series(State(state): State<AppState>, Path(name): Path<String>) -> Response {
    let mut series = state.metrics.read(&name);
    let sample_times: Vec<f64> = series
        .get("samples")
        .and_then(Value::as_array)
        .map(|samples| {
            samples
                .iter()
                .filter_map(|sample| sample.get("t").and_then(Value::as_f64))
                .collect()
        })
        .unwrap_or_default();
    let lines: Vec<(String, String)> = state
        .runtime
        .logs(&name, LOG_TAIL)
        .into_iter()
        .map(|line| (line.timestamp, line.text))
        .collect();
    if let Some(object) = series.as_object_mut() {
        object.insert(
            "logVolume".into(),
            Value::Array(bucket_log_volume(&lines, &sample_times)),
        );
    }
    Json(json!({ "ok": true, "metrics": series })).into_response()
}

/// End a process the dashboard listed.
///
/// Two refusals, and they are different refusals on purpose. A body without a
/// usable pid or a command to check against never reaches the guard — there is
/// nothing to check — and is a 400. Everything the guard itself refuses is a
/// 409: the process is gone, or is not the one the caller was looking at, or is
/// one this daemon will not signal.
async fn terminate(State(state): State<AppState>, body: Bytes) -> Response {
    let payload = read_json_object(&body);
    let pid = payload
        .get("pid")
        .and_then(Value::as_f64)
        .unwrap_or(f64::NAN);
    let expected = payload
        .get("expectedCommand")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !is_safe_integer(pid) || expected.is_empty() {
        return error(
            StatusCode::BAD_REQUEST,
            "pid and expectedCommand are required",
        );
    }
    let roots: Vec<ManagedRoot> = running_services(&state)
        .into_iter()
        .filter_map(|service| {
            Some(ManagedRoot {
                pid: service.pid?,
                service: service.name,
            })
        })
        .collect();
    match terminate_system_process(pid, expected, &roots).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(reason) => error(StatusCode::CONFLICT, &reason),
    }
}

fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}
