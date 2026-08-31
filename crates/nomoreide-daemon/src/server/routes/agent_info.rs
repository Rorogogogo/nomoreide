//! What the agents have on this machine: `GET /api/agent`.
//!
//! One route, and the widest answer the daemon gives. It is exact, so a wrong
//! method falls through to the SPA shell's 404 rather than answering 405.
//!
//! Like `/api/agent/usage`, this is anchored to the directory the daemon was
//! started in rather than the selected repository: the per-project state both
//! agents keep is keyed by absolute path, and the selected repository is a
//! dashboard preference that has nothing to do with where an agent ran.

use crate::server::app::AppState;
use crate::server::routes::daemon_cwd;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use nomoreide_core::agent_info::build_agent_info;
use serde_json::json;

pub(crate) fn routes() -> Router<AppState> {
    Router::new().route("/api/agent", get(agent))
}

async fn agent() -> Response {
    Json(json!({ "ok": true, "agent": build_agent_info(&daemon_cwd()).await })).into_response()
}
