//! The hosted profile registry: browsing it, installing from it, and putting a
//! profile into it.
//!
//! **These routes are registered before the profile routes next door.** Two of
//! them are exact paths under `/api/agent-env/profiles/`, where that module
//! matches `:name` — so `install-from-registry` would otherwise be read as a
//! profile called `install-from-registry` and answered with a 405.
//!
//! **The status code is derived from the error text, not from a type.** An
//! upstream failure carries "HTTP <code>" in its message; a 4xx is surfaced as
//! itself, everything else becomes 502. Installing adds two more substring
//! rules: "already exists" is 409, and a handful of archive complaints are 422.
//! That is a match on prose, which means a profile whose *name* contains one of
//! these phrases can steer its own status code. Reproduced as found — it is the
//! contract the dashboard reads.
//!
//! **Reading is anonymous; writing is not.** Browsing and installing work
//! signed out, because a public profile is public. Publishing and registering a
//! GitHub repository check for a token *before* doing anything and answer 401
//! without it — but only after the body has been validated, so a request that
//! is wrong in both ways reports the body.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

use nomoreide_core::agent_profiles::{self, registry_config as config, PublishRequest};

use crate::server::app::AppState;
use crate::server::body::{decode_uri_component, read_json_object};
use crate::server::errors::error;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/agent-env/registry/profiles", get(browse))
        .route(
            "/api/agent-env/profiles/install-from-registry",
            post(install),
        )
        .route(
            "/api/agent-env/profiles/register-github",
            post(register_github),
        )
        .route(
            "/api/agent-env/profiles/:name/publish",
            post(publish).fallback(publish),
        )
}

/// Upstream errors carry "HTTP <code>": surface a 4xx as itself, else 502.
///
/// A 5xx from the registry becomes a 502 here rather than being passed through,
/// which is the honest answer — this daemon is the gateway and the failure was
/// behind it.
fn upstream_status(message: &str) -> StatusCode {
    let code = message
        .split("HTTP ")
        .nth(1)
        .and_then(|rest| rest.get(..3))
        .and_then(|code| code.parse::<u16>().ok());
    match code {
        Some(code) if (400..500).contains(&code) => {
            StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_GATEWAY)
        }
        _ => StatusCode::BAD_GATEWAY,
    }
}

/// An install adds two rules to [`upstream_status`]: a name collision is a
/// conflict, and an archive this runtime will not accept is unprocessable.
fn install_status(message: &str) -> StatusCode {
    if message.contains("already exists") {
        return StatusCode::CONFLICT;
    }
    const UNPROCESSABLE: [&str; 5] = [
        "Profile archive contains",
        "Archive has",
        "Archive is missing",
        "This is a brainctl-era profile archive",
        "Could not extract the archive",
    ];
    if UNPROCESSABLE.iter().any(|start| message.starts_with(start)) {
        return StatusCode::UNPROCESSABLE_ENTITY;
    }
    upstream_status(message)
}

fn failed(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "ok": false, "error": message }))).into_response()
}

/// Is this machine signed in? Publishing and registering both refuse without a
/// token rather than letting the registry say so, because the remedy is local.
fn signed_in() -> bool {
    config::api_token_with_source().is_some()
}

/// A trimmed, non-empty string field. Anything else — a number, a blank, an
/// absent key — is no value, which is what every `z.string().min(1)` here
/// means.
fn required<'a>(body: &'a Value, key: &str) -> Option<&'a str> {
    body.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

/// An optional string, which a schema accepts as absent but not as a number.
fn optional<'a>(body: &'a Value, key: &str) -> Result<Option<&'a str>, ()> {
    match body.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value)),
        Some(_) => Err(()),
    }
}

/// Public profiles, as the browse tab lists them.
///
/// Every field is renamed on the way through, and a null becomes an *absent*
/// key rather than a null — the reference maps them to `undefined`, which
/// `JSON.stringify` drops.
async fn browse(uri: Uri) -> Response {
    let query = crate::server::routes::query::query_value(&uri, "q");
    let sort = crate::server::routes::query::query_value(&uri, "sort");

    // The schema trims the query, caps it at 100 characters, and accepts one of
    // four sorts. A blank query is no query, not a query for nothing.
    let query = query
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if query
        .as_ref()
        .is_some_and(|value| value.chars().count() > 100)
    {
        return failed(StatusCode::BAD_REQUEST, "Invalid registry profile query.");
    }
    let sort = match sort.as_deref().filter(|value| !value.is_empty()) {
        None => "recent".to_string(),
        Some(value) if ["recent", "stars", "downloads", "alpha"].contains(&value) => {
            value.to_string()
        }
        Some(_) => return failed(StatusCode::BAD_REQUEST, "Invalid registry profile query."),
    };

    match agent_profiles::list_public_profiles(query.as_deref(), &sort).await {
        Ok(profiles) => Json(json!({ "ok": true, "profiles": profiles })).into_response(),
        Err(message) => failed(upstream_status(&message), &message),
    }
}

/// Install a published profile into this machine's profile store.
async fn install(State(state): State<AppState>, body: Bytes) -> Response {
    let _ = &state;
    let payload = read_json_object(&body);
    let Some(slug) = required(&payload, "slug") else {
        return failed(StatusCode::BAD_REQUEST, "slug is required.");
    };
    let force = payload
        .get("force")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    // `as` is `z.string().min(1).optional()`: absent is fine, blank is not.
    let rename_to = match payload.get("as") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if !value.is_empty() => Some(value.as_str()),
        Some(_) => return failed(StatusCode::BAD_REQUEST, "slug is required."),
    };
    // `z.record(z.string())`: every value must be a string, and one that is
    // not fails the whole body rather than being quietly dropped — a
    // credential silently discarded is a profile installed without it.
    let supplied: BTreeMap<String, String> = match payload.get("credentials") {
        None | Some(Value::Null) => BTreeMap::new(),
        Some(Value::Object(map)) => {
            let mut supplied = BTreeMap::new();
            for (key, value) in map {
                let Some(text) = value.as_str() else {
                    return failed(StatusCode::BAD_REQUEST, "slug is required.");
                };
                supplied.insert(key.clone(), text.to_string());
            }
            supplied
        }
        Some(_) => return failed(StatusCode::BAD_REQUEST, "slug is required."),
    };
    let token = config::api_token_with_source().map(|(token, _)| token);

    match agent_profiles::install(slug, force, rename_to, &supplied, token.as_deref()).await {
        Ok(outcome) => merged(&outcome),
        Err(message) => failed(install_status(&message), &message),
    }
}

/// Register a GitHub repository as a profile the registry serves without an
/// upload.
async fn register_github(State(state): State<AppState>, body: Bytes) -> Response {
    let _ = &state;
    let payload = read_json_object(&body);
    let (Some(repo_url), Some(slug), Some(title)) = (
        required(&payload, "repoUrl"),
        required(&payload, "slug"),
        required(&payload, "title"),
    ) else {
        return failed(
            StatusCode::BAD_REQUEST,
            "repoUrl, slug, and title are required.",
        );
    };
    if !signed_in() {
        return failed(StatusCode::UNAUTHORIZED, "Sign in to the registry first.");
    }
    let (Ok(summary), Ok(ref_name), Ok(profile_path)) = (
        optional(&payload, "summary"),
        optional(&payload, "refName"),
        optional(&payload, "profilePath"),
    ) else {
        return failed(
            StatusCode::BAD_REQUEST,
            "repoUrl, slug, and title are required.",
        );
    };

    match agent_profiles::register_github(repo_url, slug, title, summary, ref_name, profile_path)
        .await
    {
        Ok(result) => Json(json!({ "ok": true, "result": result })).into_response(),
        Err(message) => failed(upstream_status(&message), &message),
    }
}

/// Publish a local profile under a registry slug.
///
/// A failure whose message *contains* "not found" is a 404 — including one
/// raised by an upstream call rather than by the missing local profile, which
/// is the reference's own imprecision.
async fn publish(State(state): State<AppState>, method: Method, uri: Uri, body: Bytes) -> Response {
    if method != Method::POST {
        return error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
    }
    let Some(name) = published_name(&uri) else {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "URI malformed");
    };
    let payload = read_json_object(&body);
    let (Some(slug), Some(title)) = (required(&payload, "slug"), required(&payload, "title"))
    else {
        return failed(StatusCode::BAD_REQUEST, "slug and title are required.");
    };
    if !signed_in() {
        return failed(StatusCode::UNAUTHORIZED, "Sign in to the registry first.");
    }
    let (Ok(summary), Ok(version), Ok(changelog)) = (
        optional(&payload, "summary"),
        optional(&payload, "version"),
        optional(&payload, "changelog"),
    ) else {
        return failed(StatusCode::BAD_REQUEST, "slug and title are required.");
    };
    let visibility = match payload.get("visibility") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if value == "public" || value == "private" => {
            Some(value.as_str())
        }
        Some(_) => return failed(StatusCode::BAD_REQUEST, "slug and title are required."),
    };

    let cwd = state.workspace_cwd().await;
    let request = PublishRequest {
        name: &name,
        slug,
        title,
        summary,
        version,
        changelog,
        visibility,
    };
    match agent_profiles::publish(request, std::path::Path::new(&cwd)).await {
        Ok(outcome) => merged(&outcome),
        Err(message) => {
            let status = if message.contains("not found") {
                StatusCode::NOT_FOUND
            } else {
                upstream_status(&message)
            };
            failed(status, &message)
        }
    }
}

/// The `:name` segment, decoded — the profile routes next door decode theirs
/// the same way, and a profile really can be called `a b`.
fn published_name(uri: &Uri) -> Option<String> {
    let rest = uri
        .path()
        .strip_prefix("/api/agent-env/profiles/")?
        .strip_suffix("/publish")?;
    decode_uri_component(rest)
}

/// `{ ok: true, ...result }` — spread into the envelope rather than nested,
/// which is what the reference does with both of these outcomes.
fn merged<T: serde::Serialize>(value: &T) -> Response {
    let mut body = Map::new();
    body.insert("ok".into(), Value::Bool(true));
    if let Ok(Value::Object(fields)) = serde_json::to_value(value) {
        body.extend(fields);
    }
    Json(Value::Object(body)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_four_hundred_from_upstream_is_passed_through() {
        assert_eq!(
            upstream_status("Create profile failed: HTTP 422 — nope"),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(
            upstream_status("Lookup failed: HTTP 401"),
            StatusCode::UNAUTHORIZED
        );
    }

    #[test]
    fn anything_else_is_a_bad_gateway() {
        assert_eq!(
            upstream_status("Upload failed: HTTP 500 — boom"),
            StatusCode::BAD_GATEWAY
        );
        assert_eq!(
            upstream_status("the network went away"),
            StatusCode::BAD_GATEWAY
        );
        assert_eq!(upstream_status("HTTP 99"), StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn an_install_has_two_rules_of_its_own() {
        assert_eq!(
            install_status("Profile \"x\" already exists."),
            StatusCode::CONFLICT
        );
        assert_eq!(
            install_status("Archive is missing profile.json"),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(
            install_status("Download failed: HTTP 404"),
            StatusCode::NOT_FOUND
        );
    }

    /// The prose match is the contract, and it cuts both ways: a profile whose
    /// own name carries the phrase steers the status. Pinned so the behaviour
    /// is deliberate rather than discovered.
    #[test]
    fn a_name_can_steer_its_own_status() {
        assert_eq!(
            install_status("Profile \"already exists here\" could not be read."),
            StatusCode::CONFLICT
        );
    }

    #[test]
    fn a_publish_name_comes_back_decoded() {
        assert_eq!(
            published_name(&"/api/agent-env/profiles/a%20b/publish".parse().unwrap()).as_deref(),
            Some("a b")
        );
        assert_eq!(
            published_name(&"/api/agent-env/profiles/plain/publish".parse().unwrap()).as_deref(),
            Some("plain")
        );
    }
}
