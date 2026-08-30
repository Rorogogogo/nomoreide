//! Reads over a connected deploy provider: which projects it has, and what a
//! linked one has deployed.
//!
//! The Rust half of the read routes in `src/web/routes/provider-routes.ts`.
//! Nothing here names Vercel or Cloudflare — the id is a path segment and the
//! client comes from the registry — so a third provider adds no route.
//!
//! **One failure status.** Both reads answer 500 for everything: an unknown
//! provider, one that is not connected, and a vendor that refused. That is the
//! reference's shape, and it follows from where its `try` starts — the lookup
//! is inside the same block as the request. A port that gave the unknown
//! provider a 404 would be more tasteful and would diverge.
//!
//! **A missing project is not a failure.** `deployments` answers 200 with an
//! empty list and an explicit `project: null`, because the dashboard's job in
//! that state is to help the user link one, and an error would render as a
//! broken panel instead.
//!
//! Deliberately not here yet: `status`, `env`, `domains`, the OAuth pair, and
//! the write actions. `status` needs the provider error to carry the HTTP
//! status it arrived with, so it can tell `auth_error` from `connection_error`
//! — the shared error type flattens both to a message today, and widening it
//! is its own change rather than a detail of these two routes.

use crate::server::app::AppState;
use crate::server::errors::error;
use crate::server::routes::query::query_value;
use axum::extract::{Path, State};
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::{Json, Router};
use nomoreide_core::providers::registry::{require_provider_context, ProviderContext};
use serde_json::{json, Value};

/// The most deployments one request will return, however large a `limit` asks
/// for.
const MAX_DEPLOYMENTS: u32 = 100;

/// What both vendors' managers fall back to when the caller names no limit.
/// Spelled here because the route has to send *something*, and sending a
/// different number would be a divergence nobody reading the route would see.
const DEFAULT_DEPLOYMENTS: u32 = 20;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        // The reference's pattern routes do not guard the verb for these two
        // reads. Keeping that observable behavior matters until the reference
        // and native route can tighten it together.
        .route("/api/providers/:provider/projects", any(projects))
        .route("/api/providers/:provider/deployments", any(deployments))
}

async fn context(state: &AppState, provider: &str) -> Result<ProviderContext, Response> {
    let config = state
        .config_store
        .load()
        .await
        .map_err(|failure| error(StatusCode::INTERNAL_SERVER_ERROR, &failure.to_string()))?;
    let cwd = state.workspace_cwd().await;
    require_provider_context(provider, &state.config_store, &config, &cwd)
        .await
        .map_err(|failure| error(StatusCode::INTERNAL_SERVER_ERROR, &failure))
}

async fn projects(
    State(state): State<AppState>,
    Path(provider): Path<String>,
    uri: Uri,
) -> Response {
    let context = match context(&state, &provider).await {
        Ok(context) => context,
        Err(response) => return response,
    };
    // A search of only spaces is no search: the reference trims and then treats
    // the empty string as absent, so `?search=%20%20` reaches the vendor as no
    // filter rather than as a filter nothing matches.
    let search = query_value(&uri, "search")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    match context.client.list_projects(search.as_deref()).await {
        Ok(projects) => {
            let mut body = serde_json::Map::new();
            body.insert("ok".into(), Value::Bool(true));
            body.insert("projects".into(), json!(projects));
            // Absent rather than null when nothing is linked, because the
            // reference builds this from `context.project?.id`.
            if let Some(linked) = context
                .project
                .as_ref()
                .and_then(|project| project.id.clone())
            {
                body.insert("linkedProjectId".into(), linked);
            }
            Json(Value::Object(body)).into_response()
        }
        Err(failure) => error(StatusCode::INTERNAL_SERVER_ERROR, &failure),
    }
}

async fn deployments(
    State(state): State<AppState>,
    Path(provider): Path<String>,
    uri: Uri,
) -> Response {
    let context = match context(&state, &provider).await {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Some(project) = context.project.as_ref() else {
        return Json(json!({ "ok": true, "deployments": [], "project": Value::Null }))
            .into_response();
    };
    let Some(project_id) = project.identifier() else {
        return Json(json!({ "ok": true, "deployments": [], "project": Value::Null }))
            .into_response();
    };

    // Anything that is not one of the two named targets is no target at all,
    // rather than a filter the vendor would reject.
    let target =
        query_value(&uri, "target").filter(|value| value == "production" || value == "preview");
    let limit = deployment_limit(query_value(&uri, "limit").as_deref());

    match context
        .client
        .list_deployments(
            project_id,
            target.as_deref(),
            limit.unwrap_or(DEFAULT_DEPLOYMENTS),
        )
        .await
    {
        Ok(deployments) => Json(json!({
            "ok": true,
            "project": project,
            "deployments": deployments,
        }))
        .into_response(),
        Err(failure) => error(StatusCode::INTERNAL_SERVER_ERROR, &failure),
    }
}

/// `Number.parseInt(value, 10)` of the query value, kept only when it came out
/// a positive number, and capped.
///
/// `parseInt` is not `Number()`: it reads the leading digits and ignores
/// whatever follows, so `20abc` is twenty and `abc` is nothing at all. A value
/// at or below zero is *dropped* rather than clamped, which is what lets the
/// vendors' own default apply instead of a limit of one.
fn deployment_limit(raw: Option<&str>) -> Option<u32> {
    let parsed = parse_int(raw.unwrap_or(""))?;
    (parsed > 0).then(|| parsed.min(i64::from(MAX_DEPLOYMENTS)) as u32)
}

/// The leading integer of a string, the way `Number.parseInt` reads one.
fn parse_int(raw: &str) -> Option<i64> {
    let text = raw.trim_start();
    let (sign, digits) = match text.strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, text.strip_prefix('+').unwrap_or(text)),
    };
    let leading: String = digits.chars().take_while(char::is_ascii_digit).collect();
    // Saturating, because `parseInt` of a number too large for an integer is a
    // float rather than a failure, and either way it is over the cap.
    leading
        .parse::<i64>()
        .ok()
        .or((!leading.is_empty()).then_some(i64::MAX))
        .map(|value| sign * value)
}
