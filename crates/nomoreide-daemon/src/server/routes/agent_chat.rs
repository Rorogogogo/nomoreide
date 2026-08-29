//! The in-dock agent chat, and the two endpoints either side of a
//! tool-permission decision.
//!
//! **`chat` answers 200 before the turn has happened.** It is Server-Sent
//! Events: the only failure that can be an HTTP status is a provider that is
//! not installed, which is decided before the stream opens. Everything after
//! that — a CLI that will not start, one that exits non-zero, a line nothing
//! can parse — is an `error` event inside a 200.
//!
//! **The body reader here is not the one below.** These four routes use the
//! reference's `readJsonBody`, which *throws* on malformed JSON and answers
//! 400 with the parser's own words; the approval routes use a reader that
//! treats the same body as a deny. Two readers in one file because the
//! reference has two, and the difference is observable.
//!
//! `approval` is called by the agent CLI's hook, which is a child of the
//! spawned agent and *blocks* on the answer. `approve` is called by whoever is
//! watching the run once a human has decided. Between them sits
//! [`ApprovalBroker`], which parks the first until the second arrives.
//!
//! Neither endpoint uses the `Json` extractor. The reference reads the body,
//! trims it, and treats an empty one as `{}` — then reaches for fields without
//! checking it got an object at all. A typed extractor would refuse bodies the
//! reference happily answers (`[1,2,3]`, `"hello"`), and would answer them in a
//! different shape, so the body is parsed by hand to keep the refusals
//! identical.

use crate::server::app::AppState;
use crate::server::sse;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use nomoreide_core::agent_info::detected_agent_name;
use nomoreide_core::agent_runtime::{
    self, is_agent_available, permission_mode, provider_by_id, public_provider_info,
    resolve_chat_provider, AgentChatProvider, AgentStreamEvent, Approval, RunOptions,
};
use nomoreide_core::approval_broker::{ApprovalDecision, Decision};
use serde::Serialize;
use serde_json::{json, Value};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/agent/chat", post(chat))
        .route("/api/agent/chat/status", get(status))
        .route("/api/agent/chat/model", post(set_model))
        .route("/api/agent/chat/provider", post(set_provider))
        .route("/api/agent/chat/approval", post(approval))
        .route("/api/agent/chat/approve", post(approve))
}

/// The reference's `readJsonBody`: trim, treat empty as `{}`, and *throw* on
/// anything that is not JSON.
///
/// The prose of that throw is V8's, and it names a byte offset — see
/// [`PARSE_FAILURE`].
// The refusal is a whole `Response`, which is large; there is one of them per
// request and boxing it would only move the allocation.
#[allow(clippy::result_large_err)]
fn read_or_refuse(raw: &Bytes) -> Result<Value, Response> {
    let text = String::from_utf8_lossy(raw);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    serde_json::from_str::<Value>(trimmed)
        .map_err(|_| refuse(StatusCode::BAD_REQUEST, PARSE_FAILURE))
}

/// What a body that is not JSON is reported as.
///
/// The reference surfaces V8's own message, which names the offending token and
/// a byte offset — prose no other parser reproduces. The status, the shape and
/// the fact that a parse failure is *reported* are what the gate holds; the
/// wording is a documented divergence, masked on both sides there.
const PARSE_FAILURE: &str = "Request body is not valid JSON.";

fn refuse(status: StatusCode, message: &str) -> Response {
    (
        status,
        Json(Failure {
            ok: false,
            error: message.to_string(),
        }),
    )
        .into_response()
}

/// The provider a turn or a setting is about.
///
/// Reads exactly the reference's `providerById(typeof x === "string" ? x : undefined)`:
/// a non-string is not a wrong provider, it is no provider, and both answer the
/// same way.
fn named_provider(body: &Value) -> Option<AgentChatProvider> {
    provider_by_id(string_field(body, "provider"))
}

/// Which provider is in force: the saved choice, else what launched this
/// daemon, else Claude.
async fn selected_provider(
    state: &AppState,
    override_id: Option<&str>,
) -> (AgentChatProvider, Value) {
    let config = state.config_store.load().await.unwrap_or_default();
    let preferred = override_id
        .map(str::to_string)
        .or_else(|| config.chat_provider.clone());
    let provider = resolve_chat_provider(&detected_agent_name().await, preferred.as_deref());
    let models =
        serde_json::to_value(config.chat_models.unwrap_or_default()).unwrap_or_else(|_| json!({}));
    (provider, models)
}

/// What is installed, what is selected, and what each one spawns with.
///
/// **Every** provider is probed, not just the selected one: the dashboard uses
/// this to offer a switch, and a switch to something that is not installed is
/// not worth offering.
async fn status(State(state): State<AppState>) -> Response {
    let (provider, models) = selected_provider(&state, None).await;
    let mode = permission_mode();
    let mut providers = Vec::new();
    for candidate in agent_runtime::chat_providers() {
        let mut info = public_provider_info(&candidate);
        if let Some(object) = info.as_object_mut() {
            object.insert(
                "configured".into(),
                json!(is_agent_available(&candidate).await),
            );
        }
        providers.push(info);
    }
    Json(json!({
        "ok": true,
        "configured": is_agent_available(&provider).await,
        "approvals": agent_runtime::approvals_enabled(&provider, &mode),
        "provider": public_provider_info(&provider),
        "providers": providers,
        "models": models,
    }))
    .into_response()
}

/// Pin the model a provider's new sessions spawn with.
async fn set_model(State(state): State<AppState>, raw: Bytes) -> Response {
    let body = match read_or_refuse(&raw) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let Some(provider) = named_provider(&body) else {
        return refuse(StatusCode::BAD_REQUEST, "Unknown chat provider.");
    };
    // Absent and null both mean "clear it"; anything else that is not a string
    // is a mistake worth naming.
    let model = match body.get("model") {
        None | Some(Value::Null) => None,
        Some(Value::String(model)) => Some(model.clone()),
        Some(_) => return refuse(StatusCode::BAD_REQUEST, "Model must be a string."),
    };
    let requested = model.unwrap_or_default();
    let trimmed = requested.trim();
    // Counted in characters, not bytes: the reference measures a JavaScript
    // string, where a multi-byte name is still one character per letter.
    if trimmed.chars().count() > 64 {
        return refuse(StatusCode::BAD_REQUEST, "Model name is too long.");
    }
    match state
        .config_store
        .set_chat_model(provider.id.as_str(), Some(trimmed))
        .await
    {
        Ok(config) => Json(json!({
            "ok": true,
            "models": serde_json::to_value(config.chat_models.unwrap_or_default())
                .unwrap_or_else(|_| json!({})),
        }))
        .into_response(),
        Err(reason) => refuse(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()),
    }
}

/// Remember which provider the dock talks to, across CLI, web and desktop.
async fn set_provider(State(state): State<AppState>, raw: Bytes) -> Response {
    let body = match read_or_refuse(&raw) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let Some(provider) = named_provider(&body) else {
        return refuse(StatusCode::BAD_REQUEST, "Unknown chat provider.");
    };
    match state
        .config_store
        .set_chat_provider(provider.id.as_str().to_string())
        .await
    {
        Ok(_) => {
            Json(json!({ "ok": true, "provider": public_provider_info(&provider) })).into_response()
        }
        Err(reason) => refuse(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()),
    }
}

/// One turn, streamed.
///
/// The approval URL names *this* daemon by the `Host` the caller reached it on,
/// because the thing that calls it back is a hook script running as a
/// grandchild of this process — it has to be able to find its way home.
async fn chat(State(state): State<AppState>, headers: HeaderMap, raw: Bytes) -> Response {
    let body = match read_or_refuse(&raw) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let message = match string_field(&body, "message") {
        Some(message) if !message.trim().is_empty() => message.to_string(),
        _ => {
            return refuse(
                StatusCode::BAD_REQUEST,
                "Request must include a non-empty `message` string.",
            )
        }
    };
    let resume = string_field(&body, "resumeSessionId").map(str::to_string);
    let auto_approve = body.get("autoApprove") == Some(&Value::Bool(true));

    // An unknown provider on a turn is not a refusal — it falls back the same
    // way an absent one does.
    let (provider, _) = selected_provider(&state, string_field(&body, "provider")).await;
    if !is_agent_available(&provider).await {
        return refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            &format!(
                "{} (`{}`) is not installed or not on PATH.",
                provider.label, provider.command_name
            ),
        );
    }

    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("127.0.0.1:4317")
        .to_string();
    let cwd = state.workspace_cwd().await;
    let approvals = state.approvals.clone();

    sse::driven(sse::CHAT_TURN, move |sink| async move {
        let (events, mut received) = tokio::sync::mpsc::unbounded_channel::<AgentStreamEvent>();
        let run = tokio::spawn(async move {
            agent_runtime::run(
                &cwd,
                &provider,
                RunOptions {
                    message: &message,
                    resume_session_id: resume.as_deref(),
                    permission_mode: &permission_mode(),
                    codex_approval_policy: &agent_runtime::codex_approval_policy(),
                    approval: Some(Approval {
                        broker: approvals,
                        url: format!("http://{host}/api/agent/chat/approval"),
                        auto_approve,
                    }),
                },
                events,
            )
            .await;
        });
        while let Some(event) = received.recv().await {
            if !sink.send(sse::unnamed(event)).await {
                break;
            }
        }
        let _ = run.await;
    })
}

/// What a JSON body turned out to be.
enum Body {
    /// A value the reference would read fields off without throwing. Objects
    /// and non-objects alike: reading `.requestId` off an array or a string is
    /// simply `undefined`, which is a *missing field*, not an error.
    Value(Value),
    /// Literal `null`. The reference throws on this and answers 500 — see
    /// [`null_body_failure`].
    Null,
    /// Not JSON at all.
    Malformed,
}

/// Mirror the reference's own body reader: trim, treat empty as `{}`, parse.
fn read_body(raw: &Bytes) -> Body {
    let text = String::from_utf8_lossy(raw);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Body::Value(Value::Object(Default::default()));
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(Value::Null) => Body::Null,
        Ok(value) => Body::Value(value),
        Err(_) => Body::Malformed,
    }
}

/// Read a string field the way the reference's `typeof x === "string"` does:
/// anything else, including a number or `null`, is absent.
fn string_field<'a>(body: &'a Value, key: &str) -> Option<&'a str> {
    body.get(key).and_then(Value::as_str)
}

/// Which tool the decision is about, as it will be shown to whoever decides.
///
/// A hook that names no tool still has to be describable, so the reference
/// substitutes a placeholder rather than emitting an empty label. Pulled out of
/// the handler because a live run is the only place the value is observable,
/// and a gate cannot open one.
fn tool_name_of(body: &Value) -> &str {
    string_field(body, "toolName").unwrap_or("tool")
}

/// How a decision field becomes a verdict.
///
/// Only the exact string `allow` allows. Everything else — a typo, a different
/// case, a missing field, a non-string — denies, so a garbled decision fails
/// closed rather than granting the tool call. Pulled out for the same reason as
/// [`tool_name_of`]: without an open run this mapping never reaches an
/// observable answer, so it is tested directly.
fn decision_of(body: &Value) -> Decision {
    if string_field(body, "decision") == Some("allow") {
        Decision::Allow
    } else {
        Decision::Deny
    }
}

#[derive(Serialize)]
struct Failure {
    ok: bool,
    error: String,
}

/// The reference's answer to a JSON `null` body.
///
/// **This mirrors a defect on purpose.** `readJsonBody` hands `null` straight
/// back, and the handler then reads a field off it, so V8 throws a TypeError
/// and the server's wrapper renders it as a 500. Nothing about that is
/// deliberate, but a hook that sends `null` gets a 500 today, and a runtime
/// that answered it any other way would be the one that changed. Reproduced
/// verbatim, message included, so the gate compares it exactly rather than
/// papering over it — and so this is impossible to read as intended behaviour.
/// Worth fixing on both sides in one change; it is not fixable in Rust alone
/// without breaking parity.
fn null_body_failure(field: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(Failure {
            ok: false,
            error: format!("Cannot read properties of null (reading '{field}')"),
        }),
    )
        .into_response()
}

/// Called by the tool-permission hook, and held open until a decision lands.
///
/// Every refusal here is a `200` carrying a deny, not an HTTP error: the caller
/// is an agent CLI waiting for a verdict, and a non-2xx would read to it as a
/// broken hook rather than as "not allowed".
async fn approval(State(state): State<AppState>, raw: Bytes) -> Response {
    let body = match read_body(&raw) {
        Body::Value(value) => value,
        Body::Null => return null_body_failure("requestId"),
        Body::Malformed => {
            return Json(ApprovalDecision::deny("Malformed approval request.")).into_response()
        }
    };

    let Some(request_id) = string_field(&body, "requestId") else {
        return Json(ApprovalDecision::deny("Missing request id.")).into_response();
    };
    let name = tool_name_of(&body);
    let input = body.get("toolInput").cloned().unwrap_or(Value::Null);

    let decision = state
        .approvals
        .request_approval(string_field(&body, "sessionId"), request_id, name, input)
        .await;
    Json(decision).into_response()
}

/// Called once a human has decided. Answers whether the request was still
/// there to decide: `ok: false` is a stale or already-answered request, not a
/// failure of this call.
async fn approve(State(state): State<AppState>, raw: Bytes) -> Response {
    let body = match read_body(&raw) {
        Body::Value(value) => value,
        Body::Null => return null_body_failure("sessionId"),
        Body::Malformed => {
            // The reference surfaces its JSON engine's own parse error here,
            // which names a byte offset and cannot be reproduced word for word
            // by a different parser. The status and the shape are what the gate
            // holds; the prose is an accepted divergence.
            return (
                StatusCode::BAD_REQUEST,
                Json(Failure {
                    ok: false,
                    error: "Unexpected token in JSON".to_string(),
                }),
            )
                .into_response();
        }
    };

    let (Some(session_id), Some(request_id)) = (
        string_field(&body, "sessionId"),
        string_field(&body, "requestId"),
    ) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(Failure {
                ok: false,
                error: "sessionId and requestId are required.".to_string(),
            }),
        )
            .into_response();
    };

    let decision = decision_of(&body);
    let resolved = state.approvals.resolve(
        session_id,
        request_id,
        ApprovalDecision {
            decision,
            reason: string_field(&body, "reason").map(str::to_string),
        },
    );
    Json(Resolved { ok: resolved }).into_response()
}

#[derive(Serialize)]
struct Resolved {
    ok: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_body_reads_as_an_empty_object() {
        assert!(
            matches!(read_body(&Bytes::from_static(b"")), Body::Value(Value::Object(map)) if map.is_empty())
        );
        assert!(
            matches!(read_body(&Bytes::from_static(b"  \n ")), Body::Value(Value::Object(map)) if map.is_empty())
        );
    }

    #[test]
    fn a_null_body_is_its_own_case() {
        assert!(matches!(
            read_body(&Bytes::from_static(b"null")),
            Body::Null
        ));
    }

    #[test]
    fn a_non_object_body_is_read_rather_than_refused() {
        // The reference reads `.requestId` off these and finds nothing, which
        // is a missing field — not a malformed body.
        assert!(matches!(
            read_body(&Bytes::from_static(b"[1,2,3]")),
            Body::Value(_)
        ));
        assert!(matches!(
            read_body(&Bytes::from_static(b"\"hello\"")),
            Body::Value(_)
        ));
        assert_eq!(
            string_field(&serde_json::json!([1, 2, 3]), "requestId"),
            None
        );
        assert_eq!(string_field(&serde_json::json!("hello"), "requestId"), None);
    }

    #[test]
    fn a_non_string_field_counts_as_absent() {
        let body = serde_json::json!({ "requestId": 7, "sessionId": null, "other": "x" });
        assert_eq!(string_field(&body, "requestId"), None);
        assert_eq!(string_field(&body, "sessionId"), None);
        assert_eq!(string_field(&body, "other"), Some("x"));
    }

    /// The seeded sweep proved this is invisible to the parity gate: without an
    /// open run the verdict never reaches an answer, so an implementation that
    /// failed *open* passed every gate case. Held here instead.
    #[test]
    fn only_the_exact_string_allow_allows() {
        assert_eq!(
            decision_of(&serde_json::json!({ "decision": "allow" })),
            Decision::Allow
        );
        for denied in [
            serde_json::json!({ "decision": "deny" }),
            serde_json::json!({ "decision": "Allow" }),
            serde_json::json!({ "decision": "ALLOW" }),
            serde_json::json!({ "decision": " allow" }),
            serde_json::json!({ "decision": "allowed" }),
            serde_json::json!({ "decision": "maybe" }),
            serde_json::json!({ "decision": true }),
            serde_json::json!({ "decision": null }),
            serde_json::json!({}),
        ] {
            assert_eq!(decision_of(&denied), Decision::Deny, "{denied} must deny");
        }
    }

    /// Also invisible to the gate, for the same reason.
    #[test]
    fn an_unnamed_tool_gets_a_placeholder_label() {
        assert_eq!(
            tool_name_of(&serde_json::json!({ "toolName": "Bash" })),
            "Bash"
        );
        assert_eq!(tool_name_of(&serde_json::json!({})), "tool");
        assert_eq!(tool_name_of(&serde_json::json!({ "toolName": 7 })), "tool");
        assert_eq!(
            tool_name_of(&serde_json::json!({ "toolName": null })),
            "tool"
        );
    }

    #[test]
    fn malformed_json_is_distinguished_from_an_empty_body() {
        assert!(matches!(
            read_body(&Bytes::from_static(b"{not json")),
            Body::Malformed
        ));
    }
}
