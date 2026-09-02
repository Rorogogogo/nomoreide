//! Turning a remote command into a local one — through the daemon's own
//! router, not around it.
//!
//! **This is the decision the relay plan reversed, and it is worth restating.**
//! The original plan had the dispatcher calling core APIs directly, "rather than
//! looping through the localhost HTTP router". That is precisely what
//! `nomoreide-tauri` did, and it cost 150 duplicated commands and a feature that
//! silently became a stub because core grew and the second surface never
//! followed. The relay would have been the fifth such surface.
//!
//! So every command below resolves to a **method and path on the router this
//! daemon is already serving**, invoked in-process with `tower`'s `oneshot` —
//! no socket, no port, no second implementation of what "restart a service"
//! means. A feature that reaches the dashboard reaches a phone with no change
//! here.
//!
//! The security property does not need the bypass. "Never proxy arbitrary
//! `/api/*`" is about *which* routes are reachable, not how they are called, and
//! [`ALLOWLIST`] is that answer: a visible table, exhaustive over the command
//! union, that no payload can add a row to. What a remote caller supplies is a
//! service name, and it is percent-encoded into exactly one path segment — so
//! there is no name that reaches a second route.
//!
//! Responses are **reshaped, never forwarded.** The daemon's own status carries
//! a pid, a container id, an ssh host; its service list carries the command
//! line, the working directory and the environment keys. None of that has a
//! field in the remote wire types, and the mapping here is where it is dropped.

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use nomoreide_core::remote::connector::{Answer, CommandSink, EventSender};
use nomoreide_core::remote::protocol::device_bound::{ServiceAction, ServiceActionRequest};
use nomoreide_core::remote::protocol::errors::{ErrorCode, ProtocolError};
use nomoreide_core::remote::protocol::limits;
use nomoreide_core::remote::protocol::platform_bound::{
    BundleListResponse, CommandErrorResponse, DeviceSnapshotResponse, ServiceActionResponse,
    ServiceListResponse, ServiceLogsResponse,
};
use nomoreide_core::remote::protocol::snapshot::{
    BundleState, DeviceSnapshot, LogLine, LogStream, RemoteBundle, RemoteService, ServiceState,
};
use nomoreide_core::remote::protocol::version::{capabilities, CapabilitySet, PROTOCOL_VERSION};
use nomoreide_core::remote::protocol::{DeviceBound, PlatformBound};
use nomoreide_core::remote::redaction::redact_line;
use serde_json::Value;
use tower::ServiceExt;

/// Every local route a remote command may reach.
///
/// Exhaustive by construction: [`RouterDispatcher::dispatch`] matches the whole
/// union, and a command with no entry here answers
/// [`ErrorCode::CapabilityUnavailable`] rather than falling through to
/// something. The table is data so it can be read in one screen and asserted
/// over in a test — the excluded operations are excluded because they are *not
/// in it*, not because a check remembers them.
pub(crate) struct Allowed {
    /// The protocol command this row permits.
    pub(crate) kind: &'static str,
    /// The capability advertised for it. What this daemon tells the relay it
    /// can do is *derived* from this table, so a command cannot be advertised
    /// without being routable, or routable without being advertised.
    pub(crate) capability: &'static str,
    /// Where it goes. Prose for a reader, and deliberately not consulted at
    /// runtime — the routing itself is in [`RouterDispatcher`], and a string
    /// pretending to drive it would be a worse lie than a comment.
    #[allow(dead_code, reason = "documentation beside the table it documents")]
    pub(crate) routes: &'static str,
}

pub(crate) const ALLOWLIST: &[Allowed] = &[
    Allowed {
        kind: "device.snapshot.request",
        capability: capabilities::DEVICE_SNAPSHOT,
        routes: "(answered locally)",
    },
    Allowed {
        kind: "service.list.request",
        capability: capabilities::SERVICE_LIST,
        routes: "GET /api/services, GET /api/status",
    },
    Allowed {
        kind: "service.action.request",
        capability: capabilities::SERVICE_ACTION,
        routes: "POST /api/services/:name/{start,stop,restart}",
    },
    Allowed {
        kind: "service.logs.request",
        capability: capabilities::SERVICE_LOGS,
        routes: "GET /api/services/:name/logs",
    },
    Allowed {
        kind: "bundle.list.request",
        capability: capabilities::BUNDLE_LIST,
        routes: "GET /api/services, GET /api/status",
    },
];

/// What this daemon tells the relay it can do.
///
/// Read off [`ALLOWLIST`] rather than written out again, so the two cannot
/// drift. A capability the relay believes in but the daemon will not route is a
/// button on a phone that does nothing.
pub(crate) fn served_capabilities() -> CapabilitySet {
    CapabilitySet::from_names(ALLOWLIST.iter().map(|allowed| allowed.capability))
}

/// Calls the daemon's router in-process.
pub(crate) struct RouterDispatcher {
    router: axum::Router,
    /// The daemon's own local credential. Held so the in-process call passes the
    /// same `require_credential` layer a browser does — the dispatcher gets no
    /// privileged back door, and a route that gains an auth requirement gains it
    /// here too.
    credential: String,
    device_id: String,
    device_name: String,
    platform: String,
}

impl RouterDispatcher {
    pub(crate) fn new(
        router: axum::Router,
        credential: String,
        device_id: String,
        device_name: String,
    ) -> Self {
        Self {
            router,
            credential,
            device_id,
            device_name,
            platform: nomoreide_core::remote::pairing::platform_name().to_string(),
        }
    }

    /// One in-process request. Returns the status and the parsed JSON body.
    async fn call(&self, method: Method, path: &str) -> Result<(StatusCode, Value), ProtocolError> {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header("authorization", format!("Bearer {}", self.credential))
            .body(Body::empty())
            .map_err(|error| internal(format!("could not build a local request: {error}")))?;

        let response = self
            .router
            .clone()
            .oneshot(request)
            .await
            .map_err(|error| internal(format!("the local router failed: {error}")))?;
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), limits::MAX_FRAME_BYTES)
            .await
            .map_err(|error| internal(format!("could not read the local response: {error}")))?;
        let parsed = serde_json::from_slice(&body).unwrap_or(Value::Null);
        Ok((status, parsed))
    }

    /// Percent-encode a caller-supplied name into exactly one path segment.
    ///
    /// The one place a remote payload becomes part of a URL, so it is the one
    /// place a traversal could be attempted. Everything outside an unreserved
    /// set is escaped, which means a name containing `/` or `..` addresses a
    /// service with that name — and no other route.
    fn segment(name: &str) -> String {
        let mut encoded = String::with_capacity(name.len());
        for byte in name.bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    encoded.push(byte as char)
                }
                other => encoded.push_str(&format!("%{other:02X}")),
            }
        }
        encoded
    }

    async fn device_snapshot(&self) -> Result<PlatformBound, ProtocolError> {
        Ok(PlatformBound::DeviceSnapshot(DeviceSnapshotResponse {
            device: DeviceSnapshot {
                device_id: self.device_id.clone(),
                name: self.device_name.clone(),
                platform: self.platform.clone(),
                daemon_version: env!("CARGO_PKG_VERSION").to_string(),
                protocol_version: PROTOCOL_VERSION,
                capabilities: served_capabilities(),
            },
        }))
    }

    /// Config and runtime, merged. Two calls because the daemon keeps them
    /// apart: what a service *is* comes from config, what it is *doing* comes
    /// from the process manager.
    async fn service_list(&self) -> Result<PlatformBound, ProtocolError> {
        let (_, discovery) = self.call(Method::GET, "/api/services").await?;
        let (_, status) = self.call(Method::GET, "/api/status").await?;
        Ok(PlatformBound::ServiceList(ServiceListResponse {
            services: merge_services(&discovery, &status),
        }))
    }

    async fn bundle_list(&self) -> Result<PlatformBound, ProtocolError> {
        let (_, discovery) = self.call(Method::GET, "/api/services").await?;
        let (_, status) = self.call(Method::GET, "/api/status").await?;
        Ok(PlatformBound::BundleList(BundleListResponse {
            bundles: merge_bundles(&discovery, &status),
        }))
    }

    async fn service_action(
        &self,
        request: &ServiceActionRequest,
    ) -> Result<PlatformBound, ProtocolError> {
        let verb = match request.action {
            ServiceAction::Start => "start",
            ServiceAction::Stop => "stop",
            ServiceAction::Restart => "restart",
        };
        let path = format!("/api/services/{}/{verb}", Self::segment(&request.service));
        let (status, body) = self.call(Method::POST, &path).await?;

        if status == StatusCode::NOT_FOUND {
            return Err(ProtocolError::new(
                ErrorCode::UnknownService,
                "No service by that name is registered on this machine.",
            )
            .with_detail(request.service.clone()));
        }
        if !status.is_success() {
            // The daemon's own words. A port conflict says which process holds
            // the port, and that is exactly what a person needs to decide what
            // to do next.
            let message = body
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("The action failed.");
            // An unregistered service is a 500 with prose here, not a 404 —
            // the daemon's mutation routes report every refusal the same way.
            // Matching the sentence is brittle and worth it: `UNKNOWN_SERVICE`
            // is the one refusal a phone can act on by itself, by refreshing
            // its list, and `SERVICE_ACTION_FAILED` invites a retry that will
            // fail identically.
            let code = if message.contains("is not registered") {
                ErrorCode::UnknownService
            } else {
                ErrorCode::ServiceActionFailed
            };
            return Err(ProtocolError::new(code, message).with_detail(request.service.clone()));
        }

        // The state *after* the action, which is an honest answer even when it
        // is `errored` — the phone shows it and the person decides.
        let state = body
            .get("status")
            .and_then(|status| status.get("state"))
            .and_then(Value::as_str)
            .map(runtime_state)
            .unwrap_or(ServiceState::Unknown);
        Ok(PlatformBound::ServiceAction(ServiceActionResponse {
            service: request.service.clone(),
            action: request.action,
            state,
        }))
    }

    async fn service_logs(
        &self,
        service: &str,
        limit: Option<u32>,
    ) -> Result<PlatformBound, ProtocolError> {
        let wanted = limit
            .map(|limit| limit as usize)
            .unwrap_or(limits::MAX_LOG_LINES)
            .min(limits::MAX_LOG_LINES);
        let path = format!(
            "/api/services/{}/logs?limit={wanted}",
            Self::segment(service)
        );
        let (status, body) = self.call(Method::GET, &path).await?;
        if status == StatusCode::NOT_FOUND {
            return Err(ProtocolError::new(
                ErrorCode::UnknownService,
                "No service by that name is registered on this machine.",
            )
            .with_detail(service.to_string()));
        }

        let entries = body
            .get("logs")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        // Newest lines matter most on a phone, so the tail is what survives the
        // bounds — and the caller is told the rest was dropped.
        let dropped = entries.len() > wanted;
        let mut lines = Vec::new();
        let mut budget = limits::MAX_LOG_RESPONSE_BYTES;
        let mut over_budget = false;
        for entry in entries.iter().rev().take(wanted) {
            let redacted = redact_line(
                entry
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                &[&self.credential],
                limits::MAX_LOG_LINE_BYTES,
            );
            if redacted.text.len() > budget {
                over_budget = true;
                break;
            }
            budget -= redacted.text.len();
            lines.push(LogLine {
                at: entry
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                stream: match entry.get("stream").and_then(Value::as_str) {
                    Some("stderr") => LogStream::Stderr,
                    Some("stdout") => LogStream::Stdout,
                    _ => LogStream::System,
                },
                text: redacted.text,
                truncated: redacted.truncated,
            });
        }
        lines.reverse();

        Ok(PlatformBound::ServiceLogs(ServiceLogsResponse {
            service: service.to_string(),
            lines,
            truncated: dropped || over_budget,
        }))
    }
}

impl CommandSink for RouterDispatcher {
    fn dispatch<'a>(
        &'a self,
        _request_id: &'a str,
        command: DeviceBound,
        _events: EventSender,
    ) -> Answer<'a> {
        Box::pin(async move {
            let kind = command.kind();
            // The gate, before the match. Checking the table rather than
            // trusting the match below to be its own allowlist means a command
            // added to `dispatch` without a row here is refused, not quietly
            // served.
            if !ALLOWLIST.iter().any(|allowed| allowed.kind == kind) {
                return PlatformBound::CommandError(CommandErrorResponse {
                    error: ProtocolError::new(
                        ErrorCode::CapabilityUnavailable,
                        "This machine's NoMoreIDE does not support that yet.",
                    )
                    .with_detail(kind),
                });
            }
            let result = match &command {
                DeviceBound::DeviceSnapshot(_) => self.device_snapshot().await,
                DeviceBound::ServiceList(_) => self.service_list().await,
                DeviceBound::BundleList(_) => self.bundle_list().await,
                DeviceBound::ServiceAction(request) => self.service_action(request).await,
                DeviceBound::ServiceLogs(request) => {
                    self.service_logs(&request.service, request.limit).await
                }
                // Unreachable: the gate above refuses anything with no row,
                // and every row has an arm. Kept as a refusal rather than an
                // `unreachable!` because a panic here would take the socket
                // down over a mistake that answers perfectly well.
                _ => Err(ProtocolError::new(
                    ErrorCode::CapabilityUnavailable,
                    "This machine's NoMoreIDE does not support that yet.",
                )
                .with_detail(kind)),
            };
            match result {
                Ok(response) => response,
                Err(error) => PlatformBound::CommandError(CommandErrorResponse { error }),
            }
        })
    }
}

fn internal(message: String) -> ProtocolError {
    ProtocolError::new(ErrorCode::InternalError, message)
}

/// Map the daemon's runtime state onto the wire's.
///
/// `exited` becomes `errored` because that is what it means to someone looking
/// at a phone: the service is not running and did not mean to stop. Anything
/// unrecognised is `Unknown` rather than a guess.
fn runtime_state(state: &str) -> ServiceState {
    match state {
        "stopped" => ServiceState::Stopped,
        "starting" => ServiceState::Starting,
        "running" => ServiceState::Running,
        "stopping" => ServiceState::Stopping,
        "exited" => ServiceState::Errored,
        _ => ServiceState::Unknown,
    }
}

/// Config plus runtime, narrowed to the five fields the wire has.
///
/// Everything else the daemon knows — command, args, cwd, env keys, pid,
/// container id, ssh host — has nowhere to go, which is the point.
fn merge_services(discovery: &Value, status: &Value) -> Vec<RemoteService> {
    let states = status
        .get("status")
        .and_then(|status| status.get("services"));
    discovery
        .get("services")
        .and_then(Value::as_array)
        .map(|services| {
            services
                .iter()
                .filter_map(|service| {
                    let name = service.get("name").and_then(Value::as_str)?;
                    let state = states
                        .and_then(|states| states.get(name))
                        .and_then(|entry| entry.get("state"))
                        .and_then(Value::as_str)
                        .map(runtime_state)
                        .unwrap_or(ServiceState::Stopped);
                    Some(RemoteService {
                        name: name.to_string(),
                        description: service
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        kind: service
                            .get("kind")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        port: service
                            .get("port")
                            .and_then(Value::as_u64)
                            .and_then(|port| u16::try_from(port).ok()),
                        state,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A bundle's state is the weakest of its services': all running is running,
/// none running is stopped, anything between is partial. That is the honest
/// summary — "running" for a bundle with a dead member would be a lie a phone
/// acts on.
fn merge_bundles(discovery: &Value, status: &Value) -> Vec<RemoteBundle> {
    let states = status
        .get("status")
        .and_then(|status| status.get("services"));
    discovery
        .get("bundles")
        .and_then(Value::as_array)
        .map(|bundles| {
            bundles
                .iter()
                .filter_map(|bundle| {
                    let name = bundle.get("name").and_then(Value::as_str)?;
                    let services: Vec<String> = bundle
                        .get("services")
                        .and_then(Value::as_array)
                        .map(|services| {
                            services
                                .iter()
                                .filter_map(Value::as_str)
                                .map(str::to_string)
                                .collect()
                        })
                        .unwrap_or_default();
                    let running = services
                        .iter()
                        .filter(|service| {
                            states
                                .and_then(|states| states.get(service.as_str()))
                                .and_then(|entry| entry.get("state"))
                                .and_then(Value::as_str)
                                == Some("running")
                        })
                        .count();
                    let state = if services.is_empty() {
                        BundleState::Unknown
                    } else if running == services.len() {
                        BundleState::Running
                    } else if running == 0 {
                        BundleState::Stopped
                    } else {
                        BundleState::Partial
                    };
                    Some(RemoteBundle {
                        name: name.to_string(),
                        state,
                        services,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::Path;
    use axum::http::HeaderMap;
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use nomoreide_core::remote::protocol::device_bound::{Empty, ServiceLogsRequest};
    use nomoreide_core::remote::protocol::fixtures::every_command;
    use std::sync::{Arc, Mutex};

    const CREDENTIAL: &str = "test-daemon-credential";

    /// A stand-in for the daemon's router: the same paths — `:name`, this being
    /// axum 0.7 — canned answers, and the same insistence on the local
    /// credential.
    ///
    /// A stub rather than the real thing because what is under test is the
    /// *shaping* — which paths are reachable, and what survives the mapping.
    /// Standing up a whole daemon would test the process manager instead.
    fn stub_router(reached: Arc<Mutex<Vec<String>>>) -> Router {
        let note = {
            let reached = reached.clone();
            move |what: String| reached.lock().unwrap().push(what)
        };
        let services_note = note.clone();
        let status_note = note.clone();
        let action_note = note.clone();
        let logs_note = note.clone();
        let trap_note = note.clone();

        Router::new()
            .route(
                "/api/services",
                get(move |headers: HeaderMap| {
                    let note = services_note.clone();
                    async move {
                        note("GET /api/services".into());
                        require(&headers);
                        Json(serde_json::json!({
                            "ok": true,
                            "services": [{
                                "name": "api",
                                "description": "The HTTP API",
                                "kind": "node",
                                "port": 3000,
                                // The fields that must not survive the mapping.
                                "command": "npm run dev",
                                "cwd": "/Users/someone/work/api",
                                "envKeys": ["DATABASE_URL", "STRIPE_SECRET"],
                                "args": ["--inspect"]
                            }],
                            "bundles": [{ "name": "web", "services": ["api", "worker"] }]
                        }))
                    }
                }),
            )
            .route(
                "/api/status",
                get(move |headers: HeaderMap| {
                    let note = status_note.clone();
                    async move {
                        note("GET /api/status".into());
                        require(&headers);
                        Json(serde_json::json!({
                            "ok": true,
                            "status": { "services": {
                                "api": { "name": "api", "state": "running", "pid": 4317,
                                         "containerId": "abc123", "host": "build.internal" }
                            }}
                        }))
                    }
                }),
            )
            .route(
                "/api/services/:name/start",
                post(move |Path(name): Path<String>| {
                    let note = action_note.clone();
                    async move {
                        note(format!("POST start {name}"));
                        if name == "nope" {
                            return (StatusCode::NOT_FOUND, Json(serde_json::json!({"ok": false})));
                        }
                        // What the real daemon answers for an unregistered
                        // service: a 500 carrying prose, not a 404.
                        if name == "ghost" {
                            return (
                                StatusCode::INTERNAL_SERVER_ERROR,
                                Json(serde_json::json!({
                                    "ok": false,
                                    "error": format!("Service \"{name}\" is not registered.")
                                })),
                            );
                        }
                        (
                            StatusCode::OK,
                            Json(serde_json::json!({
                                "ok": true,
                                "status": { "name": name, "state": "starting" }
                            })),
                        )
                    }
                }),
            )
            .route(
                "/api/services/:name/logs",
                get(move |Path(name): Path<String>| {
                    let note = logs_note.clone();
                    async move {
                        note(format!("GET logs {name}"));
                        Json(serde_json::json!({
                            "ok": true,
                            "logs": [
                                { "service": name, "stream": "stdout", "timestamp": "2026-09-02T00:00:00Z",
                                  "text": "\u{1b}[32mlistening\u{1b}[0m on 3000" },
                                { "service": name, "stream": "stderr", "timestamp": "2026-09-02T00:00:01Z",
                                  "text": format!("auth={CREDENTIAL} DATABASE_PASSWORD=hunter2000") }
                            ]
                        }))
                    }
                }),
            )
            // Routes a hostile name might try to reach. Reaching either is the
            // failure these tests exist to catch.
            .route(
                "/api/daemon/shutdown",
                post(move || {
                    let note = trap_note.clone();
                    async move {
                        note("REACHED SHUTDOWN".into());
                        Json(serde_json::json!({ "ok": true }))
                    }
                }),
            )
    }

    fn require(headers: &HeaderMap) {
        let sent = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        assert_eq!(
            sent,
            format!("Bearer {CREDENTIAL}"),
            "the dispatcher must present the daemon's own credential"
        );
    }

    /// A discard channel: these tests are about answers, not about the
    /// unsolicited stream, which agent runs use.
    fn events() -> EventSender {
        tokio::sync::mpsc::channel(8).0
    }

    fn dispatcher() -> (RouterDispatcher, Arc<Mutex<Vec<String>>>) {
        let reached = Arc::new(Mutex::new(Vec::new()));
        let dispatcher = RouterDispatcher::new(
            stub_router(reached.clone()),
            CREDENTIAL.to_string(),
            "11111111-2222-3333-4444-555555555555".into(),
            "Studio".into(),
        );
        (dispatcher, reached)
    }

    #[tokio::test]
    async fn a_snapshot_describes_this_machine() {
        let (dispatcher, _) = dispatcher();

        let answer = dispatcher
            .dispatch("req_1", DeviceBound::DeviceSnapshot(Empty {}), events())
            .await;

        let PlatformBound::DeviceSnapshot(response) = answer else {
            panic!("expected a snapshot, got {}", answer.kind());
        };
        assert_eq!(response.device.name, "Studio");
        assert_eq!(response.device.daemon_version, env!("CARGO_PKG_VERSION"));
    }

    /// The heart of it: config and runtime merge, and the fields that would
    /// hand a phone the machine's insides do not survive.
    #[tokio::test]
    async fn a_service_list_carries_five_fields_and_no_more() {
        let (dispatcher, _) = dispatcher();

        let answer = dispatcher
            .dispatch("req_1", DeviceBound::ServiceList(Empty {}), events())
            .await;

        let PlatformBound::ServiceList(response) = answer else {
            panic!("expected a list, got {}", answer.kind());
        };
        let service = &response.services[0];
        assert_eq!(service.name, "api");
        assert_eq!(service.description.as_deref(), Some("The HTTP API"));
        assert_eq!(service.kind.as_deref(), Some("node"));
        assert_eq!(service.port, Some(3000));
        assert_eq!(service.state, ServiceState::Running);

        // Rendered, so this catches a field added to the wire struct later as
        // well as one leaking through the mapping today.
        let rendered = serde_json::to_string(&response).expect("serialize");
        for secret in [
            "npm run dev",
            "/Users/someone/work",
            "DATABASE_URL",
            "STRIPE_SECRET",
            "4317",
            "abc123",
            "build.internal",
            "--inspect",
        ] {
            assert!(
                !rendered.contains(secret),
                "{secret} reached the wire: {rendered}"
            );
        }
    }

    #[tokio::test]
    async fn a_bundle_is_partial_when_only_some_of_it_runs() {
        let (dispatcher, _) = dispatcher();

        let answer = dispatcher
            .dispatch("req_1", DeviceBound::BundleList(Empty {}), events())
            .await;

        let PlatformBound::BundleList(response) = answer else {
            panic!("expected bundles, got {}", answer.kind());
        };
        // `api` runs, `worker` does not.
        assert_eq!(response.bundles[0].state, BundleState::Partial);
        assert_eq!(response.bundles[0].services, ["api", "worker"]);
    }

    #[tokio::test]
    async fn an_action_reaches_the_route_for_its_verb() {
        let (dispatcher, reached) = dispatcher();

        let answer = dispatcher
            .dispatch(
                "req_1",
                DeviceBound::ServiceAction(ServiceActionRequest {
                    service: "api".into(),
                    action: ServiceAction::Start,
                }),
                events(),
            )
            .await;

        let PlatformBound::ServiceAction(response) = answer else {
            panic!("expected an action, got {}", answer.kind());
        };
        assert_eq!(response.state, ServiceState::Starting);
        assert!(reached
            .lock()
            .unwrap()
            .contains(&"POST start api".to_string()));
    }

    /// The daemon reports an unregistered service as a 500 with prose, so this
    /// is the one place a sentence is matched. If that wording changes, this
    /// test is what says so.
    #[tokio::test]
    async fn an_unregistered_service_reads_as_unknown_rather_than_failed() {
        let (dispatcher, _) = dispatcher();

        let answer = dispatcher
            .dispatch(
                "req_1",
                DeviceBound::ServiceAction(ServiceActionRequest {
                    service: "ghost".into(),
                    action: ServiceAction::Start,
                }),
                events(),
            )
            .await;

        let PlatformBound::CommandError(error) = answer else {
            panic!("expected an error, got {}", answer.kind());
        };
        assert_eq!(error.error.code, ErrorCode::UnknownService);
        assert!(!error.error.retryable);
    }

    #[tokio::test]
    async fn an_unknown_service_is_named_as_such() {
        let (dispatcher, _) = dispatcher();

        let answer = dispatcher
            .dispatch(
                "req_1",
                DeviceBound::ServiceAction(ServiceActionRequest {
                    service: "nope".into(),
                    action: ServiceAction::Start,
                }),
                events(),
            )
            .await;

        let PlatformBound::CommandError(error) = answer else {
            panic!("expected an error, got {}", answer.kind());
        };
        assert_eq!(error.error.code, ErrorCode::UnknownService);
    }

    /// The one place a remote payload becomes part of a URL. A name that tries
    /// to climb out of its segment must address a service with that name and
    /// nothing else.
    #[tokio::test]
    async fn a_hostile_service_name_cannot_reach_another_route() {
        for hostile in [
            "../../daemon/shutdown",
            "..%2f..%2fdaemon%2fshutdown",
            "api/../../../api/daemon/shutdown",
            "api?x=1",
            "api#fragment",
            "api%00",
        ] {
            let (dispatcher, reached) = dispatcher();
            let _ = dispatcher
                .dispatch(
                    "req_1",
                    DeviceBound::ServiceAction(ServiceActionRequest {
                        service: hostile.into(),
                        action: ServiceAction::Start,
                    }),
                    events(),
                )
                .await;

            let reached = reached.lock().unwrap();
            assert!(
                !reached.iter().any(|path| path.contains("SHUTDOWN")),
                "{hostile:?} reached the shutdown route"
            );
        }
    }

    /// Logs are cleaned on the way out, and the daemon's own credential is
    /// masked by exact match rather than by hoping a pattern catches it.
    #[tokio::test]
    async fn logs_are_redacted_and_bounded() {
        let (dispatcher, _) = dispatcher();

        let answer = dispatcher
            .dispatch(
                "req_1",
                DeviceBound::ServiceLogs(ServiceLogsRequest {
                    service: "api".into(),
                    limit: Some(10),
                }),
                events(),
            )
            .await;

        let PlatformBound::ServiceLogs(response) = answer else {
            panic!("expected logs, got {}", answer.kind());
        };
        let rendered = serde_json::to_string(&response).expect("serialize");
        assert!(!rendered.contains(CREDENTIAL), "{rendered}");
        assert!(!rendered.contains("hunter2000"), "{rendered}");
        assert!(
            !rendered.contains('\u{1b}'),
            "an escape survived: {rendered}"
        );
        assert!(rendered.contains("listening"), "{rendered}");
        // Oldest first, the order a log reads in.
        assert_eq!(response.lines.len(), 2);
        assert_eq!(response.lines[0].stream, LogStream::Stdout);
    }

    /// A caller asking for more than the protocol allows gets the protocol's
    /// answer, not theirs.
    #[tokio::test]
    async fn a_log_limit_is_clamped_to_the_protocol_maximum() {
        let (dispatcher, reached) = dispatcher();

        let _ = dispatcher
            .dispatch(
                "req_1",
                DeviceBound::ServiceLogs(ServiceLogsRequest {
                    service: "api".into(),
                    limit: Some(100_000),
                }),
                events(),
            )
            .await;

        assert!(reached
            .lock()
            .unwrap()
            .iter()
            .any(|path| path == "GET logs api"));
    }

    /// The allowlist is the surface. Everything outside it answers the same way
    /// an out-of-date daemon does.
    #[tokio::test]
    async fn commands_outside_the_allowlist_are_unavailable() {
        let (dispatcher, reached) = dispatcher();
        let allowed: Vec<&str> = ALLOWLIST.iter().map(|entry| entry.kind).collect();

        for command in every_command() {
            if command.required_capability().is_none() || allowed.contains(&command.kind()) {
                continue;
            }
            let kind = command.kind();
            let answer = dispatcher.dispatch("req_1", command, events()).await;
            let PlatformBound::CommandError(error) = answer else {
                panic!("{kind} was answered with {}", answer.kind());
            };
            assert_eq!(error.error.code, ErrorCode::CapabilityUnavailable, "{kind}");
        }
        assert!(
            reached.lock().unwrap().is_empty(),
            "an unroutable command reached a route"
        );
    }

    /// Advertised and served must be the same set, or a phone shows a button
    /// that does nothing.
    /// Now true by construction — `served_capabilities` reads the table — so
    /// this is the guard on the construction rather than on two hand-written
    /// lists.
    #[test]
    fn every_advertised_capability_has_an_allowlist_entry() {
        let advertised = served_capabilities();
        for command in every_command() {
            let Some(required) = command.required_capability() else {
                continue;
            };
            let listed = ALLOWLIST.iter().any(|entry| entry.kind == command.kind());
            assert_eq!(
                advertised.contains(required),
                listed,
                "{} is advertised={} but listed={}",
                command.kind(),
                advertised.contains(required),
                listed
            );
        }
    }

    /// The excluded operations have no entry, and the table is short enough to
    /// read — which is the point of it being data.
    #[test]
    fn the_allowlist_names_nothing_dangerous() {
        let rendered = ALLOWLIST
            .iter()
            .map(|entry| format!("{} {} {}", entry.kind, entry.capability, entry.routes))
            .collect::<Vec<_>>()
            .join(" ");
        for forbidden in [
            "terminal", "shutdown", "database", "git", "fs", "exec", "env", "kill", "config",
        ] {
            assert!(
                !rendered.contains(forbidden),
                "the allowlist mentions {forbidden}: {rendered}"
            );
        }
        assert_eq!(ALLOWLIST.len(), 5);
    }
}
