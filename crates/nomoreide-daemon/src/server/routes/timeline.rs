//! The debug timeline: what the runtime did, across every service.

use crate::server::app::AppState;
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use nomoreide_daemon_client::protocol::TimelineEnvelope;
use serde::Deserialize;

pub(crate) fn routes() -> Router<AppState> {
    Router::new().route("/api/timeline", get(timeline))
}

/// The reference reads this leniently and clamps it: anything missing,
/// unparsable, or not positive falls back to the default, and no caller can ask
/// for more than the buffer holds.
#[derive(Deserialize)]
struct TimelineQuery {
    #[serde(default)]
    limit: Option<String>,
}

const DEFAULT_TIMELINE_LIMIT: usize = 120;
const MAX_TIMELINE_LIMIT: usize = 500;

async fn timeline(State(state): State<AppState>, Query(query): Query<TimelineQuery>) -> Response {
    let limit = query
        .limit
        .and_then(|limit| limit.parse::<usize>().ok())
        .filter(|limit| *limit > 0)
        .map_or(DEFAULT_TIMELINE_LIMIT, |limit| {
            limit.min(MAX_TIMELINE_LIMIT)
        });
    (
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(TimelineEnvelope {
            ok: true,
            timeline: state.runtime.timeline(limit),
        }),
    )
        .into_response()
}
