//! Whether a newer NoMoreIDE has been released.
//!
//! A notice, not an updater — see [`nomoreide_core::update_check`] for why the
//! daemon does not replace its own binary. This route exists so the dashboard
//! can say so in one quiet line instead of the user finding out by reading a
//! changelog they had no reason to open.

use crate::server::app::AppState;
use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use nomoreide_core::update_check::{self, UpdateStatus};
use serde::Serialize;

pub(crate) fn routes() -> Router<AppState> {
    Router::new().route("/api/update", get(status))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateEnvelope {
    ok: bool,
    #[serde(flatten)]
    update: UpdateStatus,
}

/// Answers from a day-old cache when it has one, so a dashboard that polls does
/// not spend the caller's unauthenticated GitHub allowance on news that changes
/// weekly at most.
async fn status(State(_state): State<AppState>) -> Json<UpdateEnvelope> {
    Json(UpdateEnvelope {
        ok: true,
        update: update_check::check(
            &update_check::default_cache_dir(),
            env!("CARGO_PKG_VERSION"),
        )
        .await,
    })
}
