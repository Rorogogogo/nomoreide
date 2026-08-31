//! Agent profiles: a saved bundle of MCP servers, skills and plugins that can
//! be captured from one agent and applied to another.
//!
//! **These routes decode `:name`, and the settings routes next door do not.**
//! Two families in one URL space with opposite answers — a profile really can
//! be called `a b`, so its path is percent-encoded and has to come back out,
//! where an agent's name is one of three literals and never needs to.
//!
//! **Two exact paths shadow the parameterised one.** `/profiles/snapshot` and
//! `/profiles/import` are matched before `/profiles/:name`, so a profile
//! actually called `snapshot` cannot be POSTed to — though it is still
//! readable, because those exact routes only claim POST.
//!
//! **404 and 500 are split by a substring.** The reference reports a failure
//! from the `:name` route as 404 when the message *contains* "not found", and
//! 500 otherwise. That is not a typed error, and a profile whose own name holds
//! the phrase can turn an unrelated failure into a 404. Reproduced as found.

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Map, Value};

use nomoreide_core::agent_env::{Agent, Json as OrderedJson, OrderedMap};
use nomoreide_core::agent_profiles::{self, ImportOutcome};

use crate::server::app::AppState;
use crate::server::body::{decode_uri_component, read_json_object};
use crate::server::errors::error;

/// A profile archive is a tarball; the upload path buffers the whole thing.
const MAX_UPLOAD_BYTES: usize = 64 * 1024 * 1024;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/agent-env/profiles",
            get(collection).post(collection).fallback(collection),
        )
        // Only POST is the snapshot endpoint. Every other method is a request
        // for the *profile* called `snapshot`, because the reference registers
        // this as an exact POST route and lets the rest fall through to the
        // parameterised one below.
        .route(
            "/api/agent-env/profiles/snapshot",
            post(take_snapshot).fallback(single),
        )
        .route(
            "/api/agent-env/profiles/import",
            post(import_profile)
                .fallback(single)
                .layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES)),
        )
        .route(
            "/api/agent-env/profiles/:name/registry-diff",
            get(registry_diff).fallback(registry_diff),
        )
        .route(
            "/api/agent-env/profiles/:name/:action",
            post(action).fallback(action),
        )
        .route(
            "/api/agent-env/profiles/:name",
            get(single).patch(single).delete(single).fallback(single),
        )
}

/// The `:name` segment, decoded — which is what the reference does, and the
/// opposite of how the settings routes read theirs.
// The refusal is a whole `Response`, which is large; there is one of them per
// request and boxing it would only move the allocation.
#[allow(clippy::result_large_err)]
fn name_of(uri: &Uri, trailing: Option<&str>) -> Result<String, Response> {
    let path = uri.path();
    let rest = path
        .strip_prefix("/api/agent-env/profiles/")
        .unwrap_or_default();
    let raw = match trailing {
        Some(suffix) => rest.strip_suffix(suffix).unwrap_or(rest),
        None => rest,
    };
    // `decodeURIComponent` throws on a broken escape rather than passing it
    // through, and the route's catch only knows the store's own errors — so it
    // rethrows and the dispatcher renders it as an unhandled failure.
    decode_uri_component(raw.trim_end_matches('/'))
        .ok_or_else(|| error(StatusCode::INTERNAL_SERVER_ERROR, "URI malformed"))
}

/// The reference's split: a message that *contains* "not found" is a 404.
fn failure(message: String) -> Response {
    let status = if message.contains("not found") {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    };
    error(status, &message)
}

fn agent_field(payload: &Value) -> Option<Agent> {
    Agent::parse(payload.get("agent")?.as_str()?)
}

async fn collection(method: Method, body: Bytes) -> Response {
    match method {
        Method::GET => match agent_profiles::list() {
            Ok(profiles) => Json(json!({ "ok": true, "profiles": profiles })).into_response(),
            Err(message) => error(StatusCode::INTERNAL_SERVER_ERROR, message.as_str()),
        },
        Method::POST => {
            let payload = read_json_object(&body);
            let name = payload.get("name").and_then(Value::as_str);
            let Some(name) = name.filter(|value| !value.is_empty()) else {
                return error(StatusCode::BAD_REQUEST, "name is required.");
            };
            // One schema covers the whole body, so a description that is not a
            // string fails the same parse the name does — and the route has
            // only the one sentence for a body that would not parse.
            let description = match payload.get("description") {
                None => None,
                Some(Value::String(text)) => Some(text.as_str()),
                Some(_) => return error(StatusCode::BAD_REQUEST, "name is required."),
            };
            match agent_profiles::create(name, description) {
                Ok(profile) => Json(json!({ "ok": true, "profile": profile })).into_response(),
                Err(message) => error(StatusCode::INTERNAL_SERVER_ERROR, message.as_str()),
            }
        }
        _ => crate::server::errors::unmatched().await,
    }
}

async fn single(method: Method, uri: Uri, body: Bytes) -> Response {
    let name = match name_of(&uri, None) {
        Ok(name) => name,
        Err(refusal) => return refusal,
    };
    match method {
        Method::GET => match agent_profiles::get(&name) {
            Ok(profile) => Json(json!({ "ok": true, "profile": profile })).into_response(),
            Err(message) => failure(message),
        },
        Method::PATCH => {
            let payload = read_json_object(&body);
            let Some(patch) = profile_patch(&payload) else {
                return error(StatusCode::BAD_REQUEST, "Invalid profile patch.");
            };
            match agent_profiles::update(
                &name,
                patch.description.as_deref(),
                patch.mcps,
                patch.skills,
                patch.plugins,
            ) {
                Ok(profile) => Json(json!({ "ok": true, "profile": profile })).into_response(),
                Err(message) => failure(message),
            }
        }
        Method::DELETE => match agent_profiles::delete(&name) {
            Ok(_) => Json(json!({ "ok": true })).into_response(),
            Err(message) => failure(message),
        },
        _ => error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed"),
    }
}

/// The four fields a patch may carry. Every one is optional, and one left out
/// is left alone — a patch that sends only a description must not empty the
/// profile. A field of the wrong *type* is a refusal rather than a no-op.
#[derive(Default)]
struct ProfilePatch {
    description: Option<String>,
    mcps: Option<OrderedMap<OrderedJson>>,
    skills: Option<Vec<OrderedJson>>,
    plugins: Option<Vec<OrderedJson>>,
}

fn profile_patch(payload: &Value) -> Option<ProfilePatch> {
    let object = payload.as_object()?;
    let mut patch = ProfilePatch::default();
    if let Some(value) = present(object, "description")? {
        patch.description = Some(value.as_str()?.to_string());
    }
    if let Some(value) = present(object, "mcps")? {
        let mut map = OrderedMap::new();
        for (key, entry) in value.as_object()? {
            if !valid_mcp(entry) {
                return None;
            }
            map.insert(
                key.clone(),
                serde_json::from_value(entry.clone()).unwrap_or(OrderedJson::Null),
            );
        }
        patch.mcps = Some(map);
    }
    if let Some(value) = present(object, "skills")? {
        let items = value.as_array()?;
        if !items.iter().all(named_item) {
            return None;
        }
        patch.skills = Some(ordered_list(items));
    }
    if let Some(value) = present(object, "plugins")? {
        let items = value.as_array()?;
        if !items.iter().all(valid_plugin) {
            return None;
        }
        patch.plugins = Some(ordered_list(items));
    }
    Some(patch)
}

/// An MCP entry as a *profile* spells it, which is not how an agent's config
/// does: a discriminated union on `kind`, with the fields that kind requires.
/// An entry carrying a bare `command` is an agent-config entry and is refused,
/// because storing it would put a shape in the profile that nothing can apply.
fn valid_mcp(entry: &Value) -> bool {
    let Some(object) = entry.as_object() else {
        return false;
    };
    match object.get("kind").and_then(Value::as_str) {
        Some("local") => object
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(|command| !command.is_empty()),
        Some("remote") => {
            let transport = object.get("transport").and_then(Value::as_str);
            let url = object.get("url").and_then(Value::as_str);
            matches!(transport, Some("http") | Some("sse"))
                && url.is_some_and(|url| !url.is_empty())
        }
        _ => false,
    }
}

/// A skill in a profile is a name and nothing else.
fn named_item(entry: &Value) -> bool {
    entry
        .get("name")
        .and_then(Value::as_str)
        .is_some_and(|name| !name.is_empty())
}

/// A plugin additionally has to say where it came from and under what key its
/// bundle is stored.
fn valid_plugin(entry: &Value) -> bool {
    named_item(entry)
        && matches!(
            entry.get("sourceAgent").and_then(Value::as_str),
            Some("claude") | Some("codex") | Some("antigravity")
        )
        && entry
            .get("bundleKey")
            .and_then(Value::as_str)
            .is_some_and(|key| !key.is_empty())
}

/// Each entry carried across as ordered JSON, so a profile written back out
/// keeps the key order the caller sent rather than a sorted one.
fn ordered_list(values: &[Value]) -> Vec<OrderedJson> {
    values
        .iter()
        .map(|value| serde_json::from_value(value.clone()).unwrap_or(OrderedJson::Null))
        .collect()
}

/// Whether the caller sent this field, and a refusal if they sent `null`.
///
/// `Ok(None)` — really `Some(None)` here — is an omitted field, which a patch
/// leaves alone. An explicit `null` is a *value*, and one of the wrong type for
/// every field this patch accepts, so it refuses the whole patch rather than
/// being read as an omission.
fn present<'a>(object: &'a Map<String, Value>, key: &str) -> Option<Option<&'a Value>> {
    match object.get(key) {
        None => Some(None),
        Some(Value::Null) => None,
        Some(value) => Some(Some(value)),
    }
}

async fn take_snapshot(body: Bytes) -> Response {
    let payload = read_json_object(&body);
    let agent = agent_field(&payload);
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let (Some(agent), Some(name)) = (agent, name) else {
        return error(StatusCode::BAD_REQUEST, "agent and name are required.");
    };
    let description = payload.get("description").and_then(Value::as_str);
    match agent_profiles::snapshot(agent, name, description, &cwd()) {
        Ok(profile) => Json(json!({ "ok": true, "profile": profile })).into_response(),
        Err(message) => error(StatusCode::INTERNAL_SERVER_ERROR, message.as_str()),
    }
}

/// `apply-preview`, `apply`, `export` and `refresh`, and nothing else — an
/// unrecognised action is not a route at all, so it falls through to the
/// shell rather than answering.
async fn action(method: Method, uri: Uri, body: Bytes) -> Response {
    let path = uri.path();
    // Matched against the path as it arrived. The reference's pattern is tested
    // before anything is decoded, so `%61pply` is not `apply` — it matches no
    // route at all and reaches the shell.
    let action = path.rsplit('/').next().unwrap_or_default().to_string();
    if !matches!(
        action.as_str(),
        "apply-preview" | "apply" | "export" | "refresh"
    ) {
        return crate::server::errors::unmatched().await;
    }
    if method != Method::POST {
        return error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
    }
    let name = match name_of(&uri, Some(&format!("/{action}"))) {
        Ok(name) => name,
        Err(refusal) => return refusal,
    };
    let payload = read_json_object(&body);

    if action == "export" {
        let output = payload
            .get("outputPath")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        return match agent_profiles::export(&name, output, &cwd()) {
            Ok(outcome) => Json(json!({
                "ok": true,
                "archivePath": outcome.archive_path,
                "credentials": outcome.credentials,
            }))
            .into_response(),
            Err(message) => error(StatusCode::INTERNAL_SERVER_ERROR, message.as_str()),
        };
    }

    let Some(agent) = agent_field(&payload) else {
        return error(StatusCode::BAD_REQUEST, "agent is required.");
    };

    match action.as_str() {
        "apply-preview" => match agent_profiles::apply(&name, agent, true, &[], &[], &[], &cwd()) {
            Ok(applied) => merged(applied),
            Err(message) => error(StatusCode::INTERNAL_SERVER_ERROR, message.as_str()),
        },
        "apply" => {
            let skip = payload.get("skip");
            // One schema covers the body, so a `skip` that is not an object
            // fails the same parse `agent` does — and gets the same sentence.
            if skip.is_some_and(|value| !value.is_object()) {
                return error(StatusCode::BAD_REQUEST, "agent is required.");
            }
            let mcps = skip_list(skip, "mcps");
            let skills = skip_list(skip, "skills");
            let plugins = skip_list(skip, "plugins");
            match agent_profiles::apply(&name, agent, false, &mcps, &skills, &plugins, &cwd()) {
                Ok(applied) => merged(applied),
                Err(message) => error(StatusCode::INTERNAL_SERVER_ERROR, message.as_str()),
            }
        }
        "refresh" => match agent_profiles::refresh(agent, &name, &cwd()) {
            Ok(profile) => Json(json!({ "ok": true, "profile": profile })).into_response(),
            Err(message) => error(StatusCode::INTERNAL_SERVER_ERROR, message.as_str()),
        },
        _ => error(StatusCode::INTERNAL_SERVER_ERROR, "Not implemented."),
    }
}

/// `{ ok: true, ...result }` — the reference spreads these into the envelope
/// rather than nesting them under a key.
fn merged<T: serde::Serialize>(value: T) -> Response {
    let Ok(Value::Object(mut object)) = serde_json::to_value(value) else {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "Unserializable result.");
    };
    let mut envelope = Map::new();
    envelope.insert("ok".to_string(), Value::Bool(true));
    envelope.append(&mut object);
    Json(Value::Object(envelope)).into_response()
}

fn skip_list(skip: Option<&Value>, key: &str) -> Vec<String> {
    skip.and_then(|value| value.get(key))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

async fn registry_diff(method: Method, uri: Uri) -> Response {
    if method != Method::GET {
        return error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
    }
    if let Err(refusal) = name_of(&uri, Some("/registry-diff")) {
        return refusal;
    }
    error(
        StatusCode::NOT_FOUND,
        "Profile is not linked to the registry.",
    )
}

/// A JSON body names an archive already on disk; anything else is the archive
/// itself, uploaded from a browser.
async fn import_profile(headers: HeaderMap, uri: Uri, body: Bytes) -> Response {
    let json_body = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("application/json"));

    if json_body {
        let payload = read_json_object(&body);
        let archive = payload
            .get("archivePath")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        let Some(archive) = archive else {
            return error(StatusCode::BAD_REQUEST, "archivePath is required.");
        };
        let force = payload
            .get("force")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let rename = payload.get("as").and_then(Value::as_str);
        let supplied = credentials(&payload);
        return import_outcome(agent_profiles::import(
            std::path::Path::new(archive),
            force,
            rename,
            &supplied,
        ));
    }

    if body.is_empty() {
        return error(StatusCode::BAD_REQUEST, "Empty upload.");
    }
    let directory =
        std::env::temp_dir().join(format!("nomoreide-profile-upload-{}", std::process::id()));
    if let Err(reason) = std::fs::create_dir_all(&directory) {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Failed to create {}: {reason}", directory.display()),
        );
    }
    let archive = directory.join("profile.tar.gz");
    let written = std::fs::write(&archive, &body);
    let force = crate::server::body::parse_query(&uri)
        .get("force")
        .map(String::as_str)
        == Some("1");
    let answer = match written {
        Ok(()) => import_outcome(agent_profiles::import(
            &archive,
            force,
            None,
            &std::collections::BTreeMap::new(),
        )),
        Err(reason) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Failed to write {}: {reason}", archive.display()),
        ),
    };
    let _ = std::fs::remove_dir_all(&directory);
    answer
}

fn import_outcome(result: Result<ImportOutcome, String>) -> Response {
    match result {
        Ok(outcome) => merged(outcome),
        Err(message) => error(StatusCode::INTERNAL_SERVER_ERROR, message.as_str()),
    }
}

fn credentials(payload: &Value) -> std::collections::BTreeMap<String, String> {
    payload
        .get("credentials")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|text| (key.clone(), text.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The directory a snapshot and an apply resolve project scope against.
fn cwd() -> std::path::PathBuf {
    std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
}

/// Unused today, and here so the module compiles against the shared state the
/// other route modules take.
#[allow(dead_code)]
fn state_unused(_: State<AppState>) {}
