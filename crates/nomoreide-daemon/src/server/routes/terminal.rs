//! Terminal sessions: listing the tabs the daemon owns, opening one, and moving
//! an agent session between the web dock and macOS Terminal.app.
//!
//! The PTY data stream is not here — it belongs on a socket, and the tools that
//! reach these endpoints only ever ask about a session, never read from it.

use crate::server::app::AppState;
use crate::server::errors::error;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use nomoreide_core::terminal::{
    agent_binary, derive_agent_invocation, normalize_agent_label, resolve_service_terminal,
    ServiceTerminal, TerminalSession, TerminalSpawnSpec,
};
use nomoreide_daemon_client::protocol::{
    TerminalExitInfo, TerminalSessionEnvelope, TerminalSessionInfo, TerminalSessionsEnvelope,
};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;

/// Moving a session between the dock and an external terminal is a real change
/// to where a running agent is being driven from, so it is not something a
/// stray cross-origin form post should be able to trigger. A custom header
/// cannot be set by one, which is what makes requiring it worth anything.
const TERMINAL_CONTROL_HEADER: &str = "x-nomoreide-terminal-control";

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/terminal/capabilities", get(capabilities))
        .route(
            "/api/terminal/sessions",
            get(list_sessions).post(create_session),
        )
        .route(
            "/api/terminal/sessions/:id/open-system-terminal",
            post(open_system_terminal),
        )
        .route(
            "/api/terminal/sessions/:id/reclaim-dock",
            post(reclaim_dock),
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
    Path(id): Path<String>,
) -> Response {
    if let Some(refusal) = control_refusal(&headers, &id) {
        return refusal;
    }
    let manager = state.terminal.clone();
    let sink = state.events.clone();
    let opened = tokio::task::spawn_blocking(move || manager.open_in_terminal(sink, &id)).await;
    match opened {
        Ok(Ok(session)) => session_response(session),
        Ok(Err(message)) => session_failure(message),
        Err(join) => error(StatusCode::INTERNAL_SERVER_ERROR, &join.to_string()),
    }
}

async fn reclaim_dock(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Some(refusal) = control_refusal(&headers, &id) {
        return refusal;
    }
    match state.terminal.reclaim_to_dock(state.events.as_ref(), &id) {
        Ok(session) => session_response(session),
        Err(message) => session_failure(message),
    }
}

/// Both control actions refuse the same two ways, in the same order: the header
/// first, then the id. Checking the id first would tell an unauthorised caller
/// whether a session exists.
fn control_refusal(headers: &HeaderMap, id: &str) -> Option<Response> {
    if headers
        .get(TERMINAL_CONTROL_HEADER)
        .and_then(|value| value.to_str().ok())
        != Some("1")
    {
        return Some(error(
            StatusCode::FORBIDDEN,
            "Terminal control header is required.",
        ));
    }
    if !is_session_id(id) {
        return Some(error(
            StatusCode::BAD_REQUEST,
            "Invalid terminal session id.",
        ));
    }
    None
}

/// The ids the control actions accept. A path separator would let an id reach a
/// different route, and a control character would let it forge a line in
/// anything that logs it.
fn is_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().count() <= 200
        && !id.contains('/')
        && !id.contains('\\')
        && !id.chars().any(|character| {
            let code = character as u32;
            code <= 31 || code == 127
        })
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
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionRequest {
    #[serde(default)]
    service_name: Option<String>,
    #[serde(default)]
    agent: Option<AgentRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRequest {
    #[serde(default)]
    provider: String,
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    resume_id: Option<String>,
    #[serde(default)]
    model: Option<String>,
}

async fn create_session(
    State(state): State<AppState>,
    body: Option<Json<CreateSessionRequest>>,
) -> Response {
    let request = body.map(|Json(request)| request).unwrap_or_default();
    let workspace = state.workspace_cwd().await;

    if let Some(agent) = request.agent {
        return create_agent_session(&state, agent, workspace).await;
    }

    let Some(service_name) = request
        .service_name
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

async fn create_agent_session(
    state: &AppState,
    agent: AgentRequest,
    workspace: String,
) -> Response {
    if !matches!(agent.provider.as_str(), "codex" | "claude") {
        return error(
            StatusCode::BAD_REQUEST,
            "Agent provider must be codex or claude.",
        );
    }
    if agent
        .resume_id
        .as_deref()
        .is_some_and(|id| !is_resume_id(id))
    {
        return error(StatusCode::BAD_REQUEST, "Agent resume id is invalid.");
    }

    // An explicit per-session model wins; otherwise the provider's saved pin
    // applies, and with neither the CLI picks for itself.
    let pinned = match state.config_store.load().await {
        Ok(config) => config.chat_models.as_ref().and_then(|models| {
            if agent.provider == "codex" {
                models.codex.clone()
            } else {
                models.claude.clone()
            }
        }),
        Err(_) => None,
    };
    let model = agent.model.or(pinned);

    let invocation = match derive_agent_invocation(
        &agent.provider,
        &agent.prompt,
        agent.resume_id.as_deref(),
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
                &agent.provider,
                agent.label.as_deref(),
            )),
            kind: Some("agent".to_string()),
            provider: Some(agent.provider),
        },
    )
}

/// The reference's `z.string().regex(/^[0-9a-fA-F-]{8,64}$/)`.
fn is_resume_id(id: &str) -> bool {
    (8..=64).contains(&id.len())
        && id
            .chars()
            .all(|character| character.is_ascii_hexdigit() || character == '-')
}

fn spawn(state: &AppState, spec: TerminalSpawnSpec) -> Response {
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
