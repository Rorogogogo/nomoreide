//! Terminal sessions: listing the tabs the daemon owns, opening one, and moving
//! an agent session between the web dock and macOS Terminal.app.
//!
//! The PTY data stream is not here — it belongs on a socket, and the tools that
//! reach these endpoints only ever ask about a session, never read from it.

use crate::server::app::AppState;
use crate::server::errors::{error, method_not_allowed};
use crate::server::routes::query::query_value;
use crate::server::sse;
use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use futures_util::StreamExt;
use nomoreide_core::agent_transcripts::{
    default_transcript_homes, list_agent_transcripts, AgentTranscript, DEFAULT_TRANSCRIPT_LIMIT,
};
use nomoreide_core::context_library::{ContextAttachment, ContextRef, CONTEXT_KINDS};
use nomoreide_core::one_time_skills::{
    compose_one_time_skill_prompt, resolve_one_time_skill, OneTimeSkillSelection,
};
use nomoreide_core::terminal::{
    agent_binary, derive_agent_invocation, encode_agent_prompt_paste, normalize_agent_label,
    resolve_service_terminal, ServiceTerminal, TerminalSession, TerminalSpawnSpec,
    MAX_AGENT_PROMPT_BYTES,
};
use nomoreide_daemon_client::protocol::{
    TerminalExitInfo, TerminalSessionEnvelope, TerminalSessionInfo, TerminalSessionsEnvelope,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::OsString;

/// Moving a session between the dock and an external terminal is a real change
/// to where a running agent is being driven from, so it is not something a
/// stray cross-origin form post should be able to trigger. A custom header
/// cannot be set by one, which is what makes requiring it worth anything.
const TERMINAL_CONTROL_HEADER: &str = "x-nomoreide-terminal-control";

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        // Exact paths, so a wrong method reaches the shell rather than a 405 —
        // the reference registers these two with a method and nothing else.
        .route("/api/terminal/capabilities", get(capabilities))
        .route("/api/terminal/events", get(events))
        .route("/api/terminal/socket", get(socket))
        .route("/api/terminal/transcripts", get(transcripts))
        .route(
            "/api/terminal/sessions",
            get(list_sessions).post(create_session),
        )
        // The rest mirror *pattern* routes, whose handlers check the method
        // themselves and answer 405 in the JSON envelope.
        .route(
            "/api/terminal/sessions/:id",
            patch(rename).delete(close).fallback(method_not_allowed),
        )
        .route(
            "/api/terminal/sessions/:id/open-system-terminal",
            post(open_system_terminal).fallback(method_not_allowed),
        )
        .route(
            "/api/terminal/sessions/:id/reclaim-dock",
            post(reclaim_dock).fallback(method_not_allowed),
        )
        .route(
            "/api/terminal/sessions/:id/insert-prompt",
            post(insert_prompt)
                .fallback(method_not_allowed)
                // The handler answers its own 413 with the reference's wording,
                // so an over-sized body has to reach it rather than being cut
                // off by the extractor's default limit.
                .layer(DefaultBodyLimit::max(MAX_INSERT_PROMPT_BODY_BYTES + 4_096)),
        )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    external_terminal: bool,
}

async fn capabilities() -> Response {
    Json(Capabilities {
        external_terminal: cfg!(target_os = "macos"),
    })
    .into_response()
}

/// The live session feed.
///
/// Its framing is the terminal's own — `: connected`, `: keepalive`, a charset,
/// and `x-accel-buffering` — not the one every other stream uses.
///
/// The manager already emits `terminal-session-changed` into the event sink on
/// every state change, so this subscribes to that rather than reaching into the
/// manager: opening, closing and moving a session to Terminal.app all arrive
/// here without any of them knowing about a stream.
async fn events(State(state): State<AppState>) -> Response {
    let replay: Vec<TerminalSessionInfo> = state
        .terminal
        .list_sessions()
        .into_iter()
        .map(wire)
        .collect();
    sse::stream(
        sse::CONNECTED_AND_KEEPALIVE,
        replay
            .into_iter()
            .map(|session| sse::named("session", session))
            .collect(),
        state.event_stream.clone(),
        |event| {
            if event.name != TERMINAL_SESSION_CHANGED {
                return None;
            }
            serde_json::from_value::<TerminalSession>(event.payload)
                .ok()
                .map(|session| sse::named("session", wire(session)))
        },
    )
}

/// The event name the terminal manager emits under.
const TERMINAL_SESSION_CHANGED: &str = "terminal-session-changed";

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum SocketCommand {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
    Repair { cols: u16, rows: u16 },
    Restart { cols: u16, rows: u16 },
    Stop,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum SocketMessage {
    State {
        state: String,
        cwd: String,
        shell: String,
        error: Option<String>,
        cols: u16,
        rows: u16,
    },
    Output {
        data: String,
    },
    Error {
        error: String,
    },
}

async fn socket(State(state): State<AppState>, uri: Uri, upgrade: WebSocketUpgrade) -> Response {
    let Some(id) = query_value(&uri, "id").filter(|id| is_existing_id(id)) else {
        return error(StatusCode::BAD_REQUEST, "Invalid terminal session id.");
    };
    if !state
        .terminal
        .list_sessions()
        .iter()
        .any(|session| session.id == id)
    {
        return error(
            StatusCode::NOT_FOUND,
            &format!("Unknown terminal session: {id}"),
        );
    }
    upgrade
        .protocols(["nomoreide"])
        .on_upgrade(move |socket| serve_socket(socket, state, id))
}

async fn serve_socket(mut socket: WebSocket, state: AppState, id: String) {
    let mut events = state.event_stream.subscribe();
    let Some(session) = state
        .terminal
        .list_sessions()
        .into_iter()
        .find(|session| session.id == id)
    else {
        let _ = send_socket_message(
            &mut socket,
            &SocketMessage::Error {
                error: format!("Unknown terminal session: {id}"),
            },
        )
        .await;
        return;
    };
    if send_socket_message(&mut socket, &socket_state(&session))
        .await
        .is_err()
    {
        return;
    }
    if let Some(pending) = state.terminal.take_pending_output(&id) {
        if !pending.is_empty()
            && send_socket_message(
                &mut socket,
                &SocketMessage::Output {
                    data: String::from_utf8_lossy(&pending).into_owned(),
                },
            )
            .await
            .is_err()
        {
            return;
        }
    }

    loop {
        tokio::select! {
            incoming = socket.next() => {
                let Some(Ok(message)) = incoming else { return; };
                let Message::Text(text) = message else {
                    if matches!(message, Message::Close(_)) { return; }
                    continue;
                };
                let command = match serde_json::from_str::<SocketCommand>(&text) {
                    Ok(command) => command,
                    Err(_) => {
                        if send_socket_message(&mut socket, &SocketMessage::Error {
                            error: "Invalid terminal socket message.".to_string(),
                        }).await.is_err() { return; }
                        continue;
                    }
                };
                match run_socket_command(&state, &id, command).await {
                    Ok(Some(message)) => {
                        if send_socket_message(&mut socket, &message).await.is_err() { return; }
                    }
                    Ok(None) => {}
                    Err(message) => {
                        if send_socket_message(&mut socket, &SocketMessage::Error { error: message })
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                }
            }
            event = events.recv() => {
                let event = match event {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                };
                let message = if event.name == format!("terminal-output-{id}") {
                    event.payload.as_str().map(|data| SocketMessage::Output { data: data.to_string() })
                } else if event.name == TERMINAL_SESSION_CHANGED {
                    serde_json::from_value::<TerminalSession>(event.payload)
                        .ok()
                        .filter(|session| session.id == id)
                        .map(|session| socket_state(&session))
                } else {
                    None
                };
                if let Some(message) = message {
                    if send_socket_message(&mut socket, &message).await.is_err() { return; }
                }
            }
        }
    }
}

async fn run_socket_command(
    state: &AppState,
    id: &str,
    command: SocketCommand,
) -> Result<Option<SocketMessage>, String> {
    match command {
        SocketCommand::Input { data } => {
            state.terminal.write_input(id, data.as_bytes())?;
            Ok(None)
        }
        SocketCommand::Resize { cols, rows } => {
            state.terminal.resize(id, cols, rows)?;
            Ok(None)
        }
        SocketCommand::Repair { cols, rows } | SocketCommand::Restart { cols, rows } => {
            let manager = state.terminal.clone();
            let sink = state.events.clone();
            let id = id.to_string();
            let session =
                tokio::task::spawn_blocking(move || manager.restart_session(sink, &id, cols, rows))
                    .await
                    .map_err(|error| error.to_string())??;
            Ok(Some(socket_state(&session)))
        }
        SocketCommand::Stop => {
            let mut session = state
                .terminal
                .list_sessions()
                .into_iter()
                .find(|session| session.id == id)
                .ok_or_else(|| format!("Unknown terminal session: {id}"))?;
            let manager = state.terminal.clone();
            let id = id.to_string();
            tokio::task::spawn_blocking(move || manager.close_session(&id))
                .await
                .map_err(|error| error.to_string())??;
            session.state = "exited".to_string();
            session.exit = None;
            Ok(Some(socket_state(&session)))
        }
    }
}

fn socket_state(session: &TerminalSession) -> SocketMessage {
    SocketMessage::State {
        state: session.state.clone(),
        cwd: session.cwd.clone(),
        shell: session.shell.clone(),
        error: session.error.clone(),
        cols: session.cols,
        rows: session.rows,
    }
}

async fn send_socket_message(
    socket: &mut WebSocket,
    message: &SocketMessage,
) -> Result<(), axum::Error> {
    socket
        .send(Message::Text(
            serde_json::to_string(message).expect("terminal socket messages serialize"),
        ))
        .await
}

async fn list_sessions(State(state): State<AppState>) -> Response {
    Json(TerminalSessionsEnvelope {
        ok: true,
        sessions: state
            .terminal
            .list_sessions()
            .into_iter()
            .map(wire)
            .collect(),
    })
    .into_response()
}

async fn open_system_terminal(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let id = match action_id(&headers, &uri) {
        Ok(id) => id,
        Err((status, message)) => return error(status, message),
    };
    let manager = state.terminal.clone();
    let sink = state.events.clone();
    let opened = tokio::task::spawn_blocking(move || manager.open_in_terminal(sink, &id)).await;
    match opened {
        Ok(Ok(session)) => session_response(session),
        Ok(Err(message)) => session_failure(message),
        Err(join) => error(StatusCode::INTERNAL_SERVER_ERROR, &join.to_string()),
    }
}

async fn reclaim_dock(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    let id = match action_id(&headers, &uri) {
        Ok(id) => id,
        Err((status, message)) => return error(status, message),
    };
    match state.terminal.reclaim_to_dock(state.events.as_ref(), &id) {
        Ok(session) => session_response(session),
        Err(message) => session_failure(message),
    }
}

/// A status and the wording that goes with it. Small on purpose: a `Response`
/// in an error position is large enough for clippy to object, and every refusal
/// here is one of a handful of fixed strings.
type Refusal = (StatusCode, &'static str);

/// The id one of the three control actions names.
///
/// The header is checked **first**. Checking the id first would tell an
/// unauthorised caller whether a session exists.
fn action_id(headers: &HeaderMap, uri: &Uri) -> Result<String, Refusal> {
    if headers
        .get(TERMINAL_CONTROL_HEADER)
        .and_then(|value| value.to_str().ok())
        != Some("1")
    {
        return Err((
            StatusCode::FORBIDDEN,
            "Terminal control header is required.",
        ));
    }
    session_id(uri)
        .filter(|id| is_action_id(id))
        .ok_or((StatusCode::BAD_REQUEST, "Invalid terminal session id."))
}

/// The id a rename or a close names.
///
/// No header: renaming a tab and closing one are what the dashboard does all
/// day, and neither drives a running agent from somewhere else. That is the
/// reference's split and it is the reason the two id rules differ.
fn existing_id(uri: &Uri) -> Result<String, Refusal> {
    session_id(uri)
        .filter(|id| is_existing_id(id))
        .ok_or((StatusCode::BAD_REQUEST, "Invalid terminal session id."))
}

/// The id segment, decoded the way the reference decodes it.
///
/// `decodeURIComponent` **throws** on a malformed escape, and the route turns
/// that into the same 400 an invalid id gets — it never passes the raw text
/// through. `Path<String>` is lossier than that, so the segment is taken raw
/// from the uri and decoded here.
fn session_id(uri: &Uri) -> Option<String> {
    let raw = uri.path().split('/').nth(4)?;
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
    // A percent-escape that decodes to invalid UTF-8 throws there too.
    String::from_utf8(decoded).ok()
}

/// The ids the control actions accept. A path separator would let an id reach a
/// different route, and a control character would let it forge a line in
/// anything that logs it.
fn is_action_id(id: &str) -> bool {
    !id.is_empty()
        && utf16_len(id) <= 200
        && !id.contains('/')
        && !id.contains('\\')
        && !has_control_characters(id)
}

/// The laxer rule the rename and close route uses. An id that names a session
/// that already exists can only match one the manager handed out, so the only
/// thing worth refusing is a character that would forge a log line.
fn is_existing_id(id: &str) -> bool {
    !id.is_empty() && utf16_len(id) <= 1_000 && !has_control_characters(id)
}

fn has_control_characters(value: &str) -> bool {
    value.chars().any(|character| {
        let code = character as u32;
        code <= 31 || code == 127
    })
}

/// Zod counts a string's length in UTF-16 code units, because that is what a
/// JavaScript string's `.length` is. An astral character is two of them and one
/// `char` here, so counting `chars()` would accept an id the reference refuses.
fn utf16_len(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

/// The body cap an inserted prompt is read under.
///
/// Six times the prompt cap plus a kilobyte, because a multi-byte character
/// JSON-escapes to several bytes and the body is measured before it is parsed.
/// A prompt can therefore be over the *prompt* cap while its body is well under
/// this one: both answer 413, from different checks.
const MAX_INSERT_PROMPT_BODY_BYTES: usize = MAX_AGENT_PROMPT_BYTES * 6 + 1_024;

/// Paste a prompt into a running agent session without submitting it.
///
/// A prompt is measured three times on the way in, and the order is the
/// reference's: the body, then the prompt in UTF-8 bytes, then whether it can
/// be encoded as a paste at all. The last of those is what refuses a prompt
/// carrying a submit character, and it is a 400 rather than a 413 because
/// nothing about it is too large.
async fn insert_prompt(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let id = match action_id(&headers, &uri) {
        Ok(id) => id,
        Err((status, message)) => return error(status, message),
    };
    // The extractor's limit sits above the reference's, so anything it refuses
    // was already past the cap the reference reads under.
    let Ok(body) = body else {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "Agent prompt is too large.");
    };
    if body.len() > MAX_INSERT_PROMPT_BODY_BYTES {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "Agent prompt is too large.");
    }
    let Some(prompt) = insert_prompt_body(&parsed_body(&body)) else {
        return error(
            StatusCode::BAD_REQUEST,
            "A non-empty agent prompt is required.",
        );
    };
    if prompt.len() > MAX_AGENT_PROMPT_BYTES {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "Agent prompt is too large.");
    }
    // The manager runs this check too, but the route runs it first so a prompt
    // that could never be pasted is refused for what it is rather than for
    // whatever state the session happens to be in.
    if let Err(reason) = encode_agent_prompt_paste(&prompt) {
        return error(StatusCode::BAD_REQUEST, &reason);
    }
    let manager = state.terminal.clone();
    match tokio::task::spawn_blocking(move || manager.insert_agent_prompt(&id, &prompt)).await {
        Ok(Ok(session)) => session_response(session),
        Ok(Err(message)) => session_failure(message),
        Err(join) => error(StatusCode::INTERNAL_SERVER_ERROR, &join.to_string()),
    }
}

async fn rename(State(state): State<AppState>, uri: Uri, body: Bytes) -> Response {
    let id = match existing_id(&uri) {
        Ok(id) => id,
        Err((status, message)) => return error(status, message),
    };
    let Some(label) = rename_label(&parsed_body(&body)) else {
        return error(
            StatusCode::BAD_REQUEST,
            "Terminal session label must be 1\u{2013}60 characters.",
        );
    };
    match state.terminal.rename_session(&id, label) {
        Ok(session) => session_response(session),
        // The reference's manager cannot fail any other way — its rename is a
        // map lookup and a setter, with no shutdown or closing guard. Anything
        // else here is this manager being stricter, reported the way the
        // control actions report a refusal.
        Err(message) => session_failure(message),
    }
}

/// Close a tab, and answer with what is left.
///
/// Always a 200: `ok` reports whether there *was* a session to close, which is
/// not a failure, and the listing that comes back is what the dashboard redraws
/// from either way.
async fn close(State(state): State<AppState>, uri: Uri) -> Response {
    let id = match existing_id(&uri) {
        Ok(id) => id,
        Err((status, message)) => return error(status, message),
    };
    // This manager treats closing a session it does not know as a no-op success,
    // where the reference's answers `false`. The lookup that tells them apart
    // therefore has to happen here rather than being read off the result.
    let manager = state.terminal.clone();
    let known = manager
        .list_sessions()
        .iter()
        .any(|session| session.id == id);
    // Closing signals a process group and waits for it to be reaped, which is
    // not work for the runtime's own thread.
    let closed = known && {
        let closing = manager.clone();
        matches!(
            tokio::task::spawn_blocking(move || closing.close_session(&id)).await,
            Ok(Ok(()))
        )
    };
    Json(TerminalSessionsEnvelope {
        ok: closed,
        sessions: manager.list_sessions().into_iter().map(wire).collect(),
    })
    .into_response()
}

/// `readJson` without a schema: an empty body, an unparseable one, and a scalar
/// all arrive as an empty object, so a malformed body is a schema failure rather
/// than a refusal of its own.
fn parsed_body(body: &[u8]) -> Value {
    serde_json::from_slice::<Value>(body).unwrap_or(Value::Null)
}

/// `z.object({ prompt: z.string().min(1) }).strict()`.
fn insert_prompt_body(payload: &Value) -> Option<String> {
    let object = payload.as_object()?;
    if object.keys().any(|key| key != "prompt") {
        return None;
    }
    let prompt = object.get("prompt")?.as_str()?;
    (!prompt.is_empty()).then(|| prompt.to_string())
}

/// `z.object({ label: z.string().trim().min(1).max(60) }).strict()`.
///
/// The trim is a **transform**, not a check: it runs before the bounds, and the
/// trimmed label is what gets stored. So a 60-character label arriving with
/// spaces around it is accepted rather than refused as 62.
fn rename_label(payload: &Value) -> Option<String> {
    let object = payload.as_object()?;
    if object.keys().any(|key| key != "label") {
        return None;
    }
    let label = object.get("label")?.as_str()?.trim();
    (!label.is_empty() && utf16_len(label) <= 60).then(|| label.to_string())
}

#[derive(Serialize)]
struct TranscriptsEnvelope {
    ok: bool,
    transcripts: Vec<AgentTranscript>,
}

/// Prior Claude and Codex sessions, for the selected repository or for every
/// project when the caller asks for `scope=all`.
///
/// The repository path here is **not** the workspace cwd the rest of this
/// module uses. `selected_git_cwd` confirms that `activeWorktreePath` really is
/// a worktree and falls back to the repository's own path when it is not; this
/// route reads the recorded path directly, as the reference does. A worktree
/// that has since been removed therefore scopes the listing to a directory no
/// session ever ran in, and the answer is empty. That is the behaviour, not an
/// oversight to quietly improve on — the picker showing nothing is how the
/// dashboard surfaces a stale selection.
async fn transcripts(State(state): State<AppState>, uri: Uri) -> Response {
    let repo_path = if query_value(&uri, "scope").as_deref() == Some("all") {
        None
    } else {
        Some(transcripts_repo_path(&state).await)
    };
    let (home, codex_home) = default_transcript_homes();
    // Every candidate transcript is opened and read, so this does not belong on
    // the runtime's thread.
    let listed = tokio::task::spawn_blocking(move || {
        list_agent_transcripts(
            &home,
            &codex_home,
            repo_path.as_deref(),
            DEFAULT_TRANSCRIPT_LIMIT,
        )
    })
    .await;
    match listed {
        Ok(transcripts) => Json(TranscriptsEnvelope {
            ok: true,
            transcripts,
        })
        .into_response(),
        Err(join) => error(StatusCode::INTERNAL_SERVER_ERROR, &join.to_string()),
    }
}

async fn transcripts_repo_path(state: &AppState) -> String {
    let fallback = std::env::current_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    let Ok(config) = state.config_store.load().await else {
        return fallback;
    };
    match nomoreide_core::config::selected_git_repository(&config) {
        Some(repository) => repository
            .active_worktree_path
            .clone()
            .unwrap_or_else(|| repository.path.clone()),
        None => fallback,
    }
}

/// A session the manager knows nothing about is a 404; a session it refuses to
/// move is a 409. Both carry the manager's own wording, which is what the tool
/// hands back to the caller.
fn session_failure(message: String) -> Response {
    let status = if message.starts_with("Unknown terminal session:") {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::CONFLICT
    };
    error(status, &message)
}

fn session_response(session: TerminalSession) -> Response {
    Json(TerminalSessionEnvelope {
        ok: true,
        session: wire(session),
    })
    .into_response()
}

/// What the client may ask for. A session is described, never commanded: the
/// caller names a registered service or an agent provider, and the daemon
/// derives the program. Nothing here can name one.
///
/// The body arrives as a raw value rather than a typed struct because the
/// branch is decided by **whether an `agent` key is present at all**, not by
/// whether it parses. `{"agent": "codex"}` is an agent request that fails its
/// schema — a 400 — where a typed struct would fail to deserialize, fall back
/// to a default, and quietly open a plain shell instead.
async fn create_session(State(state): State<AppState>, body: Bytes) -> Response {
    let payload = parsed_body(&body);
    let workspace = state.workspace_cwd().await;

    // `Object.hasOwn`, which is true for an explicit `null` too.
    if let Some(agent) = payload.as_object().and_then(|object| object.get("agent")) {
        return create_agent_session(&state, agent, workspace).await;
    }

    let Some(service_name) = payload
        .get("serviceName")
        .and_then(Value::as_str)
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
    else {
        // No service named: the `+` tab, a plain shell in the workspace.
        let id = state.next_session_id();
        return spawn(&state, TerminalSpawnSpec::shell(id, workspace));
    };

    let config = match state.config_store.load().await {
        Ok(config) => config,
        Err(failure) => {
            return error(StatusCode::INTERNAL_SERVER_ERROR, &failure.to_string());
        }
    };
    let Some(service) = config
        .services
        .iter()
        .find(|service| service.name == service_name)
    else {
        return error(
            StatusCode::NOT_FOUND,
            &format!("Unknown service: {service_name}"),
        );
    };

    // A stable id per service, so reopening the tab reattaches to the same
    // shell instead of spawning a duplicate beside it.
    match resolve_service_terminal(service, format!("svc:{service_name}"), &workspace) {
        ServiceTerminal::Unreachable(reason) => error(StatusCode::BAD_REQUEST, &reason),
        ServiceTerminal::Spawn(spec) => spawn(&state, *spec),
    }
}

/// Which field of an agent request failed.
///
/// Zod reports the **first** issue, and the route picks its wording from that
/// issue's first path element — so what matters is not how many fields are
/// wrong but which of them the schema declares earliest. The declaration order
/// is `provider, prompt, label, oneTimeSkill, resumeId, model, context`, and
/// only two of those get wording of their own.
enum AgentField {
    Provider,
    ResumeId,
    Other,
}

struct AgentSession {
    provider: String,
    prompt: String,
    label: Option<String>,
    one_time_skill: Option<OneTimeSkillSelection>,
    resume_id: Option<String>,
    model: Option<String>,
    context: Option<ContextAttachment>,
}

async fn create_agent_session(state: &AppState, agent: &Value, workspace: String) -> Response {
    let request = match agent_session(agent) {
        Ok(request) => request,
        Err(field) => {
            return error(
                StatusCode::BAD_REQUEST,
                match field {
                    AgentField::Provider => "Agent provider must be codex or claude.",
                    AgentField::ResumeId => "Agent resume id is invalid.",
                    AgentField::Other => "Invalid agent session request.",
                },
            )
        }
    };
    if request.resume_id.is_some() && request.one_time_skill.is_some() {
        return error(
            StatusCode::BAD_REQUEST,
            "A temporary skill cannot be attached to a resumed session.",
        );
    }

    let mut prompt = request.prompt;
    // **A validated context attachment is not yet assembled into the prompt.**
    // `assemble_prompt` needs the library's full item list — notes *and* the
    // items derived from config and the error inbox — and that listing does not
    // exist natively yet; it is the context-library slice's work. Validating it
    // here is not premature: the refusals are what this endpoint answers, and
    // they have to match today. What an accepted attachment does to the prompt
    // is invisible from this endpoint either way, since the response describes
    // the session and never the argv.
    let _ = &request.context;

    if let Some(skill) = &request.one_time_skill {
        // Everything that goes wrong loading a temporary skill is a 422, the
        // network included — it is the one part of opening a session that
        // reaches off the machine.
        prompt = match resolve_one_time_skill(skill).await {
            Ok(skill_prompt) => match compose_one_time_skill_prompt(&skill_prompt, &prompt) {
                Ok(composed) => composed,
                Err(message) => return error(StatusCode::UNPROCESSABLE_ENTITY, &message),
            },
            Err(message) => return error(StatusCode::UNPROCESSABLE_ENTITY, &message),
        };
    }

    // An explicit per-session model wins; otherwise the provider's saved pin
    // applies, and with neither the CLI picks for itself.
    let pinned = match state.config_store.load().await {
        Ok(config) => config.chat_models.as_ref().and_then(|models| {
            if request.provider == "codex" {
                models.codex.clone()
            } else {
                models.claude.clone()
            }
        }),
        Err(_) => None,
    };
    let model = request.model.or(pinned);

    let invocation = match derive_agent_invocation(
        &request.provider,
        &prompt,
        request.resume_id.as_deref(),
        model.as_deref(),
        &agent_binary("NOMOREIDE_CLAUDE_BIN", "claude"),
        &agent_binary("NOMOREIDE_CODEX_BIN", "codex"),
    ) {
        Ok(invocation) => invocation,
        Err(message) => return error(StatusCode::BAD_REQUEST, &message),
    };

    spawn(
        state,
        TerminalSpawnSpec {
            id: state.next_session_id(),
            service_name: None,
            cwd: workspace,
            shell: OsString::from(invocation.executable),
            args: invocation.args,
            env: Vec::new(),
            label: Some(normalize_agent_label(
                &request.provider,
                request.label.as_deref(),
            )),
            kind: Some("agent".to_string()),
            provider: Some(request.provider),
        },
    )
}

/// The reference's `agentSessionSchema`, checked in its declaration order.
///
/// Not `.strict()` at the top level, so an unknown key is *stripped* rather
/// than refused — but every nested object is strict, and every optional field
/// distinguishes absent from `null`: `undefined` takes the default or stays
/// absent, `null` is a type error.
fn agent_session(value: &Value) -> Result<AgentSession, AgentField> {
    let object = value.as_object().ok_or(AgentField::Other)?;
    let provider = object
        .get("provider")
        .and_then(Value::as_str)
        .filter(|provider| matches!(*provider, "codex" | "claude"))
        .ok_or(AgentField::Provider)?
        .to_string();
    // `z.string().default("")`: the default covers an absent key, not a null.
    let prompt = match object.get("prompt") {
        None => String::new(),
        Some(value) => value.as_str().ok_or(AgentField::Other)?.to_string(),
    };
    let label = match object.get("label") {
        None => None,
        Some(value) => Some(value.as_str().ok_or(AgentField::Other)?.to_string()),
    };
    let one_time_skill = match object.get("oneTimeSkill") {
        None => None,
        Some(value) => Some(one_time_skill(value).map_err(|()| AgentField::Other)?),
    };
    let resume_id = match object.get("resumeId") {
        None => None,
        Some(value) => Some(
            value
                .as_str()
                .filter(|id| is_resume_id(id))
                .ok_or(AgentField::ResumeId)?
                .to_string(),
        ),
    };
    let model = match object.get("model") {
        None => None,
        Some(value) => Some(bounded(value, 1, 64).map_err(|()| AgentField::Other)?),
    };
    let context = match object.get("context") {
        None => None,
        Some(value) => Some(attachment(value).map_err(|()| AgentField::Other)?),
    };
    Ok(AgentSession {
        provider,
        prompt,
        label,
        one_time_skill,
        resume_id,
        model,
        context,
    })
}

fn one_time_skill(value: &Value) -> Result<OneTimeSkillSelection, ()> {
    let object = value.as_object().ok_or(())?;
    if object.keys().any(|key| key != "name" && key != "source") {
        return Err(());
    }
    Ok(OneTimeSkillSelection {
        name: bounded(object.get("name").ok_or(())?, 1, 200)?,
        source: bounded(object.get("source").ok_or(())?, 3, 400)?,
    })
}

fn attachment(value: &Value) -> Result<ContextAttachment, ()> {
    let object = value.as_object().ok_or(())?;
    if object
        .keys()
        .any(|key| key != "refs" && key != "includePinned")
    {
        return Err(());
    }
    let refs = object.get("refs").ok_or(())?.as_array().ok_or(())?;
    if refs.len() > 200 {
        return Err(());
    }
    Ok(ContextAttachment {
        refs: refs
            .iter()
            .map(context_ref)
            .collect::<Result<Vec<_>, ()>>()?,
        include_pinned: object.get("includePinned").ok_or(())?.as_bool().ok_or(())?,
    })
}

fn context_ref(value: &Value) -> Result<ContextRef, ()> {
    let object = value.as_object().ok_or(())?;
    if object.keys().any(|key| key != "kind" && key != "id") {
        return Err(());
    }
    let kind = object.get("kind").ok_or(())?.as_str().ok_or(())?;
    if !CONTEXT_KINDS.contains(&kind) {
        return Err(());
    }
    Ok(ContextRef {
        kind: kind.to_string(),
        id: bounded(object.get("id").ok_or(())?, 1, 1_000)?,
    })
}

/// `z.string().trim().min(a).max(b)`. The trim is a transform, so it runs first
/// and the bounds are on what survives it — and the trimmed text is what is
/// kept, not the original.
fn bounded(value: &Value, min: usize, max: usize) -> Result<String, ()> {
    let text = value.as_str().ok_or(())?.trim();
    let length = utf16_len(text);
    if length < min || length > max {
        return Err(());
    }
    Ok(text.to_string())
}

/// The reference's `z.string().regex(/^[0-9a-fA-F-]{8,64}$/)`.
fn is_resume_id(id: &str) -> bool {
    (8..=64).contains(&id.len())
        && id
            .chars()
            .all(|character| character.is_ascii_hexdigit() || character == '-')
}

pub(super) fn spawn(state: &AppState, spec: TerminalSpawnSpec) -> Response {
    match state.terminal.create(state.events.clone(), spec) {
        Ok(session) => (
            StatusCode::CREATED,
            Json(TerminalSessionEnvelope {
                ok: true,
                session: wire(session),
            }),
        )
            .into_response(),
        Err(message) => error(StatusCode::INTERNAL_SERVER_ERROR, &message),
    }
}

/// Core's session as the wire's. `serviceName` is dropped: the reference does
/// not carry it, and a caller that wants it reads `label`.
fn wire(session: TerminalSession) -> TerminalSessionInfo {
    TerminalSessionInfo {
        id: session.id,
        cols: session.cols,
        cwd: session.cwd,
        error: session.error,
        exit: session.exit.map(|exit| TerminalExitInfo {
            exit_code: exit.exit_code,
            signal: exit.signal,
        }),
        kind: session.kind,
        label: session.label,
        provider: session.provider,
        rows: session.rows,
        shell: session.shell,
        state: session.state,
        presentation: match session.presentation {
            nomoreide_core::terminal::TerminalPresentation::Dock => "dock",
            nomoreide_core::terminal::TerminalPresentation::TerminalLaunching => {
                "terminalLaunching"
            }
            nomoreide_core::terminal::TerminalPresentation::Terminal => "terminal",
        }
        .to_string(),
    }
}
