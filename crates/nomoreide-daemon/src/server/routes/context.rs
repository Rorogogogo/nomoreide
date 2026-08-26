//! The context library over HTTP: what the vault holds, what links what, and
//! the notes a person writes into it.
//!
//! Every refusal here is a flat sentence rather than a zod report, which is the
//! whole reason this domain is cheap: the schemas are strict and the wording is
//! fixed, so a body either parses into what the operation wants or gets one of
//! four sentences back.
//!
//! **A revision is a precondition, not a field.** An update or a delete carries
//! the revision the caller believes the note is at, and a mismatch is a 409
//! carrying the note as it *actually* is — the only refusal on this surface
//! that hands back state. That is what makes two editors safe without locking
//! anything: the loser is told what it missed rather than being told "no".

use crate::server::app::AppState;
use crate::server::errors::{error, method_not_allowed};
use crate::server::routes::query::query_value;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use nomoreide_core::agent_transcripts::{
    default_transcript_homes, list_agent_transcripts, AgentTranscript, DEFAULT_TRANSCRIPT_LIMIT,
};
use nomoreide_core::context_library::{
    ContextAttachment, ContextLibrary, ContextNote, ContextRef, CreateContextNote,
    UpdateContextNote, CONTEXT_KINDS,
};
use nomoreide_core::context_snapshot::{
    context_graph, context_snapshot, ContextListing, ContextQuery,
};
use serde::Serialize;
use serde_json::Value;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/context", get(list))
        .route("/api/context/graph", get(graph))
        .route("/api/context/notes", post(create_note))
        .route(
            "/api/context/notes/:id",
            get(read_note)
                .put(update_note)
                .delete(delete_note)
                .fallback(method_not_allowed),
        )
        .route("/api/context/pins", put(set_pins))
        .route("/api/context/preview", post(preview))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListEnvelope {
    ok: bool,
    #[serde(flatten)]
    listing: ContextListing,
}

async fn list(State(state): State<AppState>, uri: Uri) -> Response {
    match snapshot_for(&state, &query_from(&uri)).await {
        Ok((listing, _)) => Json(ListEnvelope { ok: true, listing }).into_response(),
        Err(message) => error(StatusCode::INTERNAL_SERVER_ERROR, &message),
    }
}

async fn graph(State(state): State<AppState>, uri: Uri) -> Response {
    let query = query_from(&uri);
    let (listing, notes) = match snapshot_for(&state, &query).await {
        Ok(pair) => pair,
        Err(message) => return error(StatusCode::INTERNAL_SERVER_ERROR, &message),
    };
    let config = match state.config_store.load().await {
        Ok(config) => config,
        Err(failure) => {
            return error(StatusCode::INTERNAL_SERVER_ERROR, &failure.to_string());
        }
    };
    Json(serde_json::json!({
        "ok": true,
        "graph": context_graph(&listing, &notes, &config),
    }))
    .into_response()
}

/// The listing, and the notes it was built from.
///
/// The graph needs both: the snapshot decides what is *visible* (it is
/// filtered, sorted and capped), while the edges are read off the notes' own
/// links, which the items no longer carry.
async fn snapshot_for(
    state: &AppState,
    query: &ContextQuery,
) -> Result<(ContextListing, Vec<ContextNote>), String> {
    let config = state
        .config_store
        .load()
        .await
        .map_err(|failure| failure.to_string())?;
    let incidents = state.errors.list(100);
    // Reading every candidate transcript is filesystem work, and so is walking
    // each repository for its Markdown. Neither belongs on the runtime thread.
    let transcripts: Vec<AgentTranscript> = if query.includes_session() {
        let (home, codex_home) = default_transcript_homes();
        tokio::task::spawn_blocking(move || {
            list_agent_transcripts(&home, &codex_home, None, DEFAULT_TRANSCRIPT_LIMIT)
        })
        .await
        .map_err(|join| join.to_string())?
    } else {
        Vec::new()
    };
    let query = query.clone();
    tokio::task::spawn_blocking(
        move || -> Result<(ContextListing, Vec<ContextNote>), String> {
            let library = ContextLibrary::default();
            let notes = library.notes()?;
            let snapshot = context_snapshot(&library, &config, &incidents, &transcripts, &query)?;
            Ok((snapshot, notes))
        },
    )
    .await
    .map_err(|join| join.to_string())?
}

/// `kinds` is split on commas and **silently drops** what it does not
/// recognise. So `kinds=note,widget` is `kinds=note`, and `kinds=widget` is an
/// *empty* set rather than an absent one — which matches nothing at all rather
/// than everything. An absent parameter and a blank one are different things
/// here, and only the absent one means "every kind".
fn query_from(uri: &Uri) -> ContextQuery {
    ContextQuery {
        q: query_value(uri, "q"),
        project_path: query_value(uri, "projectPath"),
        kinds: query_value(uri, "kinds").map(|raw| {
            raw.split(',')
                .filter(|kind| CONTEXT_KINDS.contains(kind))
                .map(str::to_string)
                .collect()
        }),
    }
}

async fn create_note(body: Bytes) -> Response {
    let Some(input) = create_input(&parsed_body(&body)) else {
        return error(StatusCode::BAD_REQUEST, "Invalid context note.");
    };
    match tokio::task::spawn_blocking(move || ContextLibrary::default().create_note(input)).await {
        Ok(Ok(note)) => (StatusCode::CREATED, Json(note_envelope(note))).into_response(),
        Ok(Err(message)) => context_failure(message),
        Err(join) => error(StatusCode::INTERNAL_SERVER_ERROR, &join.to_string()),
    }
}

async fn read_note(uri: Uri) -> Response {
    let id = match note_id(&uri) {
        Ok(id) => id,
        Err((status, message)) => return error(status, message),
    };
    match tokio::task::spawn_blocking(move || ContextLibrary::default().get_note(&id)).await {
        Ok(Ok(note)) => Json(note_envelope(note)).into_response(),
        // **A note that is not there is a 404 here and a 400 everywhere else.**
        // The reference's `getNote` answers `undefined` and this route turns
        // that into a 404, while an update or a delete raises the same words as
        // a validation failure and gets a 400. Same sentence, two statuses,
        // decided by which route is asking — so the split lives here rather
        // than in the shared refusal.
        Ok(Err(message)) if message == "Context note not found." => {
            error(StatusCode::NOT_FOUND, &message)
        }
        Ok(Err(message)) => context_failure(message),
        Err(join) => error(StatusCode::INTERNAL_SERVER_ERROR, &join.to_string()),
    }
}

async fn update_note(uri: Uri, body: Bytes) -> Response {
    let id = match note_id(&uri) {
        Ok(id) => id,
        Err((status, message)) => return error(status, message),
    };
    let Some(input) = update_input(&parsed_body(&body)) else {
        return error(StatusCode::BAD_REQUEST, "Invalid context note update.");
    };
    let target = id.clone();
    match tokio::task::spawn_blocking(move || ContextLibrary::default().update_note(&id, input))
        .await
    {
        Ok(Ok(note)) => Json(note_envelope(note)).into_response(),
        Ok(Err(message)) => refusal(message, &target).await,
        Err(join) => error(StatusCode::INTERNAL_SERVER_ERROR, &join.to_string()),
    }
}

async fn delete_note(uri: Uri, body: Bytes) -> Response {
    let id = match note_id(&uri) {
        Ok(id) => id,
        Err((status, message)) => return error(status, message),
    };
    let Some(revision) = revision_only(&parsed_body(&body)) else {
        return error(
            StatusCode::BAD_REQUEST,
            "A valid note revision is required.",
        );
    };
    let target = id.clone();
    match tokio::task::spawn_blocking(move || ContextLibrary::default().delete_note(&id, &revision))
        .await
    {
        Ok(Ok(())) => Json(serde_json::json!({ "ok": true })).into_response(),
        Ok(Err(message)) => refusal(message, &target).await,
        Err(join) => error(StatusCode::INTERNAL_SERVER_ERROR, &join.to_string()),
    }
}

async fn set_pins(body: Bytes) -> Response {
    let Some(refs) = pins(&parsed_body(&body)) else {
        return error(StatusCode::BAD_REQUEST, "Invalid pinned context.");
    };
    match tokio::task::spawn_blocking(move || ContextLibrary::default().set_pinned(refs)).await {
        Ok(Ok(pinned)) => Json(serde_json::json!({ "ok": true, "pinned": pinned })).into_response(),
        Ok(Err(message)) => context_failure(message),
        Err(join) => error(StatusCode::INTERNAL_SERVER_ERROR, &join.to_string()),
    }
}

async fn preview(State(state): State<AppState>, body: Bytes) -> Response {
    let payload = parsed_body(&body);
    // **`projectPath` is validated and then dropped.** The reference uses it to
    // mark a resolved item as belonging to another project, and this core's
    // `preview` takes no such argument — so a preview scoped to a project comes
    // back unscoped. Left as a gap rather than papered over: the shape of the
    // refusal is right today, and widening `ContextLibrary::preview` is a
    // change to a function the MCP surface also calls.
    let Some((attachment, _project_path)) = preview_input(&payload) else {
        return error(StatusCode::BAD_REQUEST, "Invalid context preview request.");
    };
    // A preview resolves against the **whole** library, unfiltered: an
    // attachment names refs directly, and a ref that happens to be outside the
    // page's current filter is still the thing the caller asked for.
    let (listing, _) = match snapshot_for(&state, &ContextQuery::default()).await {
        Ok(pair) => pair,
        Err(message) => return error(StatusCode::INTERNAL_SERVER_ERROR, &message),
    };
    let items = listing.items();
    match tokio::task::spawn_blocking(move || {
        ContextLibrary::default().preview(&attachment, &items)
    })
    .await
    {
        Ok(Ok(preview)) => {
            // A preview resolves against plain items, so what it hands back has
            // a note's body, revision and links stripped off it. The listing
            // still holds the whole row and the client renders a resolved note
            // from one, so each resolved ref is put back the way the listing
            // has it.
            let resolved: Vec<Value> = preview
                .resolved
                .iter()
                .map(|item| {
                    listing
                        .items
                        .iter()
                        .find(|entry| entry.item().context_ref == item.context_ref)
                        .and_then(|entry| serde_json::to_value(entry).ok())
                        .unwrap_or_else(|| serde_json::to_value(item).unwrap_or(Value::Null))
                })
                .collect();
            Json(serde_json::json!({
                "ok": true,
                "preview": {
                    "context": preview.context,
                    "estimatedTokens": preview.estimated_tokens,
                    "resolved": resolved,
                    "missing": preview.missing,
                    "warnings": preview.warnings,
                },
            }))
            .into_response()
        }
        Ok(Err(message)) => context_failure(message),
        Err(join) => error(StatusCode::INTERNAL_SERVER_ERROR, &join.to_string()),
    }
}

fn note_envelope(note: ContextNote) -> Value {
    serde_json::json!({ "ok": true, "note": note })
}

/// How the library's failures reach the wire.
///
/// There are only two kinds. A **conflict** carries the note as it stands, so
/// the caller can see what it missed; everything else is a flat 400. The split
/// is on the wording because that is what the library gives us — it has one
/// error type — and the conflict is the one message that means "your copy is
/// stale" rather than "your request was wrong".
fn context_failure(message: String) -> Response {
    error(StatusCode::BAD_REQUEST, &message)
}

/// A refusal from an operation that named a note, which is the only place a
/// conflict can arise.
///
/// A conflict answers **409 with the note as it actually is**, so the caller can
/// see what it missed rather than being told to go and look. That is what makes
/// two editors safe here without locking anything, and it is why the note is
/// read *again* after the failure: the whole point is that the caller's copy is
/// the stale one.
async fn refusal(message: String, id: &str) -> Response {
    if !message.starts_with("This note changed outside NoMoreIDE") {
        return context_failure(message);
    }
    let target = id.to_string();
    let current = tokio::task::spawn_blocking(move || ContextLibrary::default().get_note(&target))
        .await
        .ok()
        .and_then(Result::ok);
    (
        StatusCode::CONFLICT,
        Json(serde_json::json!({ "ok": false, "error": message, "current": current })),
    )
        .into_response()
}

/// `[a-zA-Z0-9-]{8,100}`, checked **before** the note is looked for.
///
/// The id names a file in the vault, so a segment that could climb out of it
/// must never reach the filesystem — which is why this refuses rather than
/// answering 404 for something that is not a plausible id at all.
fn note_id(uri: &Uri) -> Result<String, Refusal> {
    let raw = uri.path().split('/').nth(4).unwrap_or_default();
    // **A malformed escape is a 500, not a 400.** `decodeURIComponent` throws a
    // `URIError` rather than returning undefined, and the route's catch only
    // knows the library's two error types — so it rethrows and the dispatcher
    // renders it as an unhandled failure. That is a rough edge in the
    // reference, not a decision, but a client that branches on the status would
    // see a port answering 400 as a different endpoint.
    let id = percent_decode(raw).ok_or((StatusCode::INTERNAL_SERVER_ERROR, "URI malformed"))?;
    let length = id.chars().count();
    if !(8..=100).contains(&length)
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err((StatusCode::BAD_REQUEST, "Invalid context note id."));
    }
    Ok(id)
}

/// A status and the wording that goes with it, small enough not to trip
/// clippy's `result_large_err` in an error position.
type Refusal = (StatusCode, &'static str);

fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = raw.get(index + 1..index + 3)?;
            if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return None;
            }
            decoded.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn parsed_body(body: &[u8]) -> Value {
    serde_json::from_slice::<Value>(body).unwrap_or(Value::Null)
}

/// `noteCreateSchema`. Strict, so an unknown key is a refusal; every array is
/// optional here and required on an update.
fn create_input(payload: &Value) -> Option<CreateContextNote> {
    const KEYS: &[&str] = &[
        "title",
        "body",
        "projectPaths",
        "tags",
        "aliases",
        "sourceKey",
    ];
    let object = payload.as_object()?;
    if object.keys().any(|key| !KEYS.contains(&key.as_str())) {
        return None;
    }
    Some(CreateContextNote {
        title: bounded(object.get("title")?, 1, 120)?,
        body: match object.get("body") {
            None => String::new(),
            Some(value) => sized(value, 1024 * 1024)?,
        },
        project_paths: string_list(object.get("projectPaths"), 50, 2_000)?,
        tags: string_list(object.get("tags"), 100, 100)?,
        aliases: string_list(object.get("aliases"), 100, 120)?,
        source_key: match object.get("sourceKey") {
            None => None,
            Some(value) => Some(bounded(value, 1, 1_000)?),
        },
    })
}

/// `noteUpdateSchema`: the create shape with every array **required**, a
/// required body, a revision, and `sourceKey` omitted — so sending one is a
/// refusal even though creating with one is fine.
fn update_input(payload: &Value) -> Option<UpdateContextNote> {
    const KEYS: &[&str] = &[
        "title",
        "body",
        "projectPaths",
        "tags",
        "aliases",
        "revision",
    ];
    let object = payload.as_object()?;
    if object.keys().any(|key| !KEYS.contains(&key.as_str())) {
        return None;
    }
    Some(UpdateContextNote {
        title: bounded(object.get("title")?, 1, 120)?,
        body: sized(object.get("body")?, 1024 * 1024)?,
        project_paths: string_list(Some(object.get("projectPaths")?), 50, 2_000)?,
        tags: string_list(Some(object.get("tags")?), 100, 100)?,
        aliases: string_list(Some(object.get("aliases")?), 100, 120)?,
        revision: revision(object.get("revision")?)?,
    })
}

fn revision_only(payload: &Value) -> Option<String> {
    let object = payload.as_object()?;
    if object.keys().any(|key| key != "revision") {
        return None;
    }
    revision(object.get("revision")?)
}

/// `z.string().regex(/^[a-f0-9]{64}$/)` — lowercase only, so an uppercase
/// sha256 of exactly the right bytes is still refused.
fn revision(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    (text.len() == 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
    .then(|| text.to_string())
}

fn pins(payload: &Value) -> Option<Vec<ContextRef>> {
    let object = payload.as_object()?;
    if object.keys().any(|key| key != "refs") {
        return None;
    }
    context_refs(object.get("refs")?)
}

fn preview_input(payload: &Value) -> Option<(ContextAttachment, Option<String>)> {
    let object = payload.as_object()?;
    if object
        .keys()
        .any(|key| key != "attachment" && key != "projectPath")
    {
        return None;
    }
    let attachment = object.get("attachment")?.as_object()?;
    if attachment
        .keys()
        .any(|key| key != "refs" && key != "includePinned")
    {
        return None;
    }
    Some((
        ContextAttachment {
            refs: context_refs(attachment.get("refs")?)?,
            include_pinned: attachment.get("includePinned")?.as_bool()?,
        },
        match object.get("projectPath") {
            None => None,
            Some(value) => Some(bounded(value, 1, 2_000)?),
        },
    ))
}

fn context_refs(value: &Value) -> Option<Vec<ContextRef>> {
    let refs = value.as_array()?;
    if refs.len() > 200 {
        return None;
    }
    refs.iter()
        .map(|entry| {
            let object = entry.as_object()?;
            if object.keys().any(|key| key != "kind" && key != "id") {
                return None;
            }
            let kind = object.get("kind")?.as_str()?;
            if !CONTEXT_KINDS.contains(&kind) {
                return None;
            }
            Some(ContextRef {
                kind: kind.to_string(),
                id: bounded(object.get("id")?, 1, 1_000)?,
            })
        })
        .collect()
}

/// `z.string().trim().min(a).max(b)`: the trim is a transform, so it runs first
/// and the bounds apply to what survives it.
fn bounded(value: &Value, min: usize, max: usize) -> Option<String> {
    let text = value.as_str()?.trim();
    let length = text.chars().map(char::len_utf16).sum::<usize>();
    (length >= min && length <= max).then(|| text.to_string())
}

/// A bound with no trim and no minimum — a body may be empty and its
/// whitespace is content.
fn sized(value: &Value, max: usize) -> Option<String> {
    let text = value.as_str()?;
    (text.chars().map(char::len_utf16).sum::<usize>() <= max).then(|| text.to_string())
}

fn string_list(value: Option<&Value>, max_items: usize, max_length: usize) -> Option<Vec<String>> {
    let Some(value) = value else {
        return Some(Vec::new());
    };
    let entries = value.as_array()?;
    if entries.len() > max_items {
        return None;
    }
    entries
        .iter()
        .map(|entry| bounded(entry, 1, max_length))
        .collect()
}
