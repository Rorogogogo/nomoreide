//! The provider inventory: what is installed, and what each plugin may reach.
//!
//! Two reads over the same static registries, in two shapes. `/api/extensions`
//! flattens both registries into one neutral row per plugin, for the section
//! that manages plugins; `/api/providers` returns the deploy manifests whole,
//! for the surfaces that render a provider's own tab.
//!
//! Neither names a provider, so a fourth one appears on both without this file
//! changing.

use crate::server::app::AppState;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use nomoreide_core::providers::registry::{deploy_provider_manifests, installed_extensions};
use serde_json::json;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/extensions", get(extensions))
        .route("/api/providers", get(providers))
}

async fn extensions() -> Response {
    Json(json!({ "ok": true, "extensions": installed_extensions() })).into_response()
}

async fn providers() -> Response {
    Json(json!({ "ok": true, "providers": deploy_provider_manifests() })).into_response()
}
