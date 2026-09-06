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

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use futures_util::StreamExt;
use nomoreide_core::agent_runtime::AgentStreamEvent;
use nomoreide_core::remote::agent_runs::{self, AgentRuns};
use nomoreide_core::remote::connector::{Answer, CommandSink, EventSender};
use nomoreide_core::remote::protocol::agent_event::ApprovalRequestEvent;
use nomoreide_core::remote::protocol::device_bound::{
    AgentApprovalResolve, AgentTurnCancel, AgentTurnStart, ApprovalVerdict,
};
use nomoreide_core::remote::protocol::device_bound::{ServiceAction, ServiceActionRequest};
use nomoreide_core::remote::protocol::errors::{ErrorCode, ProtocolError};
use nomoreide_core::remote::protocol::limits;
use nomoreide_core::remote::protocol::platform_bound::{
    AgentProvidersResponse, AgentTurnAccepted, BundleListResponse, CommandErrorResponse,
    DeviceSnapshotResponse, ServiceActionResponse, ServiceListResponse, ServiceLogsResponse,
};
use nomoreide_core::remote::protocol::snapshot::{
    BundleState, DeviceSnapshot, LogLine, LogStream, RemoteAgentProvider, RemoteBundle,
    RemoteService, ServiceState,
};
use nomoreide_core::remote::protocol::version::{capabilities, CapabilitySet, PROTOCOL_VERSION};
use nomoreide_core::remote::protocol::{DeviceBound, PlatformBound};
use nomoreide_core::remote::redaction::redact_line;
use nomoreide_core::terminal::TerminalManager;
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
    Allowed {
        kind: "agent.providers.request",
        capability: capabilities::AGENT_PROVIDERS,
        routes: "GET /api/agent/chat/status",
    },
    Allowed {
        kind: "agent.turn.start",
        capability: capabilities::AGENT_TURNS,
        routes: "POST /api/agent/chat",
    },
    Allowed {
        kind: "agent.turn.cancel",
        capability: capabilities::AGENT_TURNS,
        routes: "(ends the run locally; the stream is dropped)",
    },
    Allowed {
        kind: "agent.approval.resolve",
        capability: capabilities::AGENT_APPROVALS,
        routes: "POST /api/agent/chat/approve",
    },
    Allowed {
        kind: "terminal.spawn.request",
        capability: capabilities::TERMINAL_SPAWN,
        routes: "POST /api/terminal/sessions (an agent, in the daemon's workspace)",
    },
    Allowed {
        kind: "terminal.shell.request",
        capability: capabilities::TERMINAL_SHELL,
        routes: "POST /api/terminal/sessions (a shell, in the daemon's workspace)",
    },
    Allowed {
        kind: "terminal.sessions.request",
        capability: capabilities::TERMINAL_SESSIONS,
        routes: "(the terminal manager; agent sessions only)",
    },
    Allowed {
        kind: "terminal.attach.request",
        capability: capabilities::TERMINAL_ATTACH,
        routes: "(the terminal manager; a PTY stream, not a route)",
    },
    Allowed {
        kind: "terminal.input",
        capability: capabilities::TERMINAL_ATTACH,
        routes: "(the terminal manager)",
    },
    Allowed {
        kind: "terminal.resize",
        capability: capabilities::TERMINAL_ATTACH,
        routes: "(the terminal manager)",
    },
    Allowed {
        kind: "terminal.detach",
        capability: capabilities::TERMINAL_ATTACH,
        routes: "(the terminal manager)",
    },
    Allowed {
        kind: "linear.request",
        capability: capabilities::LINEAR,
        routes: "POST /api/linear/request",
    },
    // The read-only inspection surface. Every row below routes to a GET, and
    // there is no re-run, cancel, merge or dismiss anywhere in it — the local
    // product has all four, and they stay where a person at the machine is the
    // one pressing them.
    Allowed {
        kind: "github.runs.request",
        capability: capabilities::GITHUB_ACTIONS,
        routes: "GET /api/github/runs",
    },
    Allowed {
        kind: "github.run.jobs.request",
        capability: capabilities::GITHUB_ACTIONS,
        routes: "GET /api/github/runs/:run_id/jobs",
    },
    Allowed {
        kind: "github.prs.request",
        capability: capabilities::GITHUB_PULLS,
        routes: "GET /api/github/prs",
    },
    Allowed {
        kind: "github.pr.request",
        capability: capabilities::GITHUB_PULLS,
        routes: "GET /api/github/prs/:number",
    },
    Allowed {
        kind: "agent.usage.request",
        capability: capabilities::AGENT_USAGE,
        routes: "GET /api/agent/usage",
    },
    Allowed {
        kind: "errors.request",
        capability: capabilities::DEVICE_ERRORS,
        routes: "GET /api/errors",
    },
    Allowed {
        kind: "timeline.request",
        capability: capabilities::DEVICE_TIMELINE,
        routes: "GET /api/timeline",
    },
];

/// What this daemon tells the relay it can do.
///
/// Read off [`ALLOWLIST`] rather than written out again, so the two cannot
/// drift. A capability the relay believes in but the daemon will not route is a
/// button on a phone that does nothing.
pub(crate) fn served_capabilities() -> CapabilitySet {
    let shells = super::shell_allowed();
    CapabilitySet::from_names(
        ALLOWLIST
            .iter()
            // A machine with shells switched off does not advertise them, so a
            // phone is never shown a button it would be refused for pressing.
            // The row stays in the table — what changes is what this machine
            // says it will do, not what the table permits.
            .filter(|allowed| shells || allowed.capability != capabilities::TERMINAL_SHELL)
            .map(|allowed| allowed.capability),
    )
}

/// Calls the daemon's router in-process.
pub(crate) struct RouterDispatcher {
    router: axum::Router,
    /// Agent turns in flight: sequence numbers, replay, and the approvals that
    /// deny themselves.
    runs: AgentRuns,
    /// The provider's own session id for each run, learned from the stream's
    /// first event. An approval is resolved against *that* id, not the run's —
    /// the daemon's approval broker is keyed by the agent CLI's session.
    sessions: Arc<Mutex<HashMap<String, String>>>,
    /// The daemon's own local credential. Held so the in-process call passes the
    /// same `require_credential` layer a browser does — the dispatcher gets no
    /// privileged back door, and a route that gains an auth requirement gains it
    /// here too.
    credential: String,
    device_id: String,
    device_name: String,
    platform: String,
    /// Held directly rather than reached through the router. A PTY mirror is a
    /// websocket upgrade, which `oneshot` cannot perform — see
    /// [`super::terminal`], which is where that exception is argued.
    terminal: TerminalManager,
    mirrors: super::terminal::Mirrors,
}

impl RouterDispatcher {
    pub(crate) fn new(
        router: axum::Router,
        credential: String,
        device_id: String,
        device_name: String,
        terminal: TerminalManager,
    ) -> Self {
        Self {
            router,
            runs: AgentRuns::new(),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            credential,
            device_id,
            device_name,
            platform: nomoreide_core::remote::pairing::platform_name().to_string(),
            terminal,
            mirrors: super::terminal::Mirrors::default(),
        }
    }

    /// One in-process request. Returns the status and the parsed JSON body.
    pub(super) async fn call(
        &self,
        method: Method,
        path: &str,
    ) -> Result<(StatusCode, Value), ProtocolError> {
        self.call_body(method, path, Body::empty()).await
    }

    async fn call_body(
        &self,
        method: Method,
        path: &str,
        body: Body,
    ) -> Result<(StatusCode, Value), ProtocolError> {
        let request = Request::builder()
            .header("content-type", "application/json")
            .method(method)
            .uri(path)
            .header("authorization", format!("Bearer {}", self.credential))
            .body(body)
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

    async fn linear(
        &self,
        request: &nomoreide_core::remote::protocol::linear::LinearRequest,
    ) -> Result<PlatformBound, ProtocolError> {
        request
            .validate()
            .map_err(|e| ProtocolError::new(ErrorCode::MalformedFrame, e))?;
        let body =
            serde_json::to_vec(&request).map_err(|_| internal("Invalid Linear request".into()))?;
        let (status, body) = self
            .call_body(Method::POST, "/api/linear/request", Body::from(body))
            .await?;
        if !status.is_success() {
            return Err(ProtocolError::new(
                ErrorCode::ServiceActionFailed,
                body["error"].as_str().unwrap_or("Linear request failed"),
            ));
        }
        Ok(PlatformBound::Linear(Box::new(
            nomoreide_core::remote::protocol::linear::LinearResponse {
                data: serde_json::from_value(body["data"].clone())
                    .map_err(|_| internal("Invalid Linear response".into()))?,
            },
        )))
    }

    /// Percent-encode a caller-supplied name into exactly one path segment.
    ///
    /// The one place a remote payload becomes part of a URL, so it is the one
    /// place a traversal could be attempted. Everything outside an unreserved
    /// set is escaped, which means a name containing `/` or `..` addresses a
    /// service with that name — and no other route.
    pub(super) fn segment(name: &str) -> String {
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

    /// Which agent providers this machine has, and which may be driven from a
    /// phone.
    async fn agent_providers(&self) -> Result<PlatformBound, ProtocolError> {
        let (_, body) = self.call(Method::GET, "/api/agent/chat/status").await?;
        let providers = body
            .get("providers")
            .and_then(Value::as_array)
            .map(|providers| {
                providers
                    .iter()
                    .filter_map(|provider| {
                        let id = provider.get("id").and_then(Value::as_str)?;
                        Some(RemoteAgentProvider {
                            id: id.to_string(),
                            name: provider
                                .get("label")
                                .or_else(|| provider.get("name"))
                                .and_then(Value::as_str)
                                .unwrap_or(id)
                                .to_string(),
                            available: provider
                                .get("configured")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                            remote_writes: remote_writes_allowed(id),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(PlatformBound::AgentProviders(AgentProvidersResponse {
            providers,
        }))
    }

    /// Start a turn.
    ///
    /// Answers immediately with the run id, then streams. The answer has to come
    /// first: a phone needs the run it is about to watch before the events for
    /// it arrive, and holding the reply until the turn finished would make every
    /// long turn look like a timeout.
    async fn agent_turn_start(
        &self,
        request: &AgentTurnStart,
        events: EventSender,
    ) -> Result<PlatformBound, ProtocolError> {
        if request.prompt.len() > limits::MAX_AGENT_PROMPT_BYTES {
            return Err(ProtocolError::new(
                ErrorCode::PayloadTooLarge,
                "That prompt is too long to send from a phone.",
            ));
        }
        if let Some(provider) = &request.provider {
            if !remote_writes_allowed(provider) {
                return Err(ProtocolError::new(
                    ErrorCode::CapabilityUnavailable,
                    "That agent cannot be driven remotely yet.",
                )
                .with_detail(provider.clone()));
            }
        }

        let run_id = request
            .run_id
            .clone()
            .unwrap_or_else(|| format!("run_{}", uuid::Uuid::new_v4()));
        let next_seq = self.runs.open(&run_id);

        let mut body = serde_json::json!({ "message": request.prompt });
        if let Some(provider) = &request.provider {
            body["provider"] = Value::String(provider.clone());
        }
        // Resuming a run resumes the provider's session, so the agent keeps its
        // context rather than starting over mid-conversation.
        if let Some(session) = self.sessions.lock().expect("sessions").get(&run_id) {
            body["resumeSessionId"] = Value::String(session.clone());
        }

        let request_builder = Request::builder()
            .method(Method::POST)
            .uri("/api/agent/chat")
            .header("authorization", format!("Bearer {}", self.credential))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .map_err(|error| internal(format!("could not build a local request: {error}")))?;
        let response = self
            .router
            .clone()
            .oneshot(request_builder)
            .await
            .map_err(|error| internal(format!("the local router failed: {error}")))?;

        if !response.status().is_success() {
            self.runs.close(&run_id);
            return Err(ProtocolError::new(
                ErrorCode::ServiceActionFailed,
                "That agent could not be started on this machine.",
            ));
        }

        let stream_runs = self.runs.clone();
        let sessions = self.sessions.clone();
        let router = self.router.clone();
        let credential = self.credential.clone();
        let streamed_run = run_id.clone();
        tokio::spawn(async move {
            pump(
                response,
                streamed_run,
                stream_runs,
                sessions,
                events,
                router,
                credential,
            )
            .await;
        });

        Ok(PlatformBound::AgentTurnAccepted(AgentTurnAccepted {
            run_id,
            next_seq,
        }))
    }

    /// End a turn. Closing the run denies anything parked on it, which is the
    /// third of the four routes to a denial.
    async fn agent_turn_cancel(
        &self,
        request: &AgentTurnCancel,
        events: EventSender,
    ) -> Result<PlatformBound, ProtocolError> {
        if !self.runs.is_running(&request.run_id) {
            return Err(ProtocolError::new(
                ErrorCode::UnknownRun,
                "That agent turn is not running.",
            )
            .with_detail(request.run_id.clone()));
        }
        for event in self.runs.close(&request.run_id) {
            let _ = events.send(PlatformBound::AgentTurnEvent(event)).await;
        }
        Ok(PlatformBound::AgentTurnAccepted(AgentTurnAccepted {
            run_id: request.run_id.clone(),
            next_seq: 0,
        }))
    }

    /// A human's verdict on one tool call.
    async fn agent_approval_resolve(
        &self,
        request: &AgentApprovalResolve,
        events: EventSender,
    ) -> Result<PlatformBound, ProtocolError> {
        let settled = self
            .runs
            .settle_approval(&request.run_id, &request.approval_id, request.verdict)
            .ok_or_else(|| {
                // Already settled — by the timer, by the run ending, or by a
                // second tap. Not an error the phone can act on, but it must
                // not read as success either.
                ProtocolError::new(
                    ErrorCode::UnknownApproval,
                    "That request has already been answered.",
                )
                .with_detail(request.approval_id.clone())
            })?;
        let run_id = settled.run_id.clone();
        let _ = events.send(PlatformBound::AgentTurnEvent(settled)).await;
        Ok(PlatformBound::AgentTurnAccepted(AgentTurnAccepted {
            run_id,
            next_seq: 0,
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
    fn disconnected(&self) {
        // Every mirror belonged to the socket that just closed. Reconnecting
        // re-attaches; nothing survives the gap, least of all after a
        // revocation.
        self.mirrors.close_all();
    }

    fn dispatch<'a>(
        &'a self,
        _request_id: &'a str,
        command: DeviceBound,
        events: EventSender,
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
                DeviceBound::AgentProviders(_) => self.agent_providers().await,
                DeviceBound::AgentTurnStart(request) => {
                    self.agent_turn_start(request, events.clone()).await
                }
                DeviceBound::AgentTurnCancel(request) => {
                    self.agent_turn_cancel(request, events.clone()).await
                }
                DeviceBound::AgentApprovalResolve(request) => {
                    self.agent_approval_resolve(request, events.clone()).await
                }
                DeviceBound::TerminalSpawn(request) => self.terminal_spawn(request).await,
                DeviceBound::TerminalShell(_) => self.terminal_shell().await,
                DeviceBound::TerminalSessions(_) => Ok(super::terminal::sessions(&self.terminal)),
                DeviceBound::TerminalAttach(request) => {
                    self.mirrors.attach(&self.terminal, request, events.clone())
                }
                DeviceBound::TerminalInput(request) => self.mirrors.input(&self.terminal, request),
                DeviceBound::TerminalResize(request) => {
                    self.mirrors.resize(&self.terminal, request)
                }
                DeviceBound::TerminalDetach(request) => self.mirrors.detach(request),
                DeviceBound::Linear(request) => self.linear(request).await,
                DeviceBound::GithubRuns(request) => {
                    super::inspection::workflow_runs(self, request).await
                }
                DeviceBound::GithubRunJobs(request) => {
                    super::inspection::workflow_run_jobs(self, request).await
                }
                DeviceBound::GithubPulls(request) => {
                    super::inspection::pull_requests(self, request).await
                }
                DeviceBound::GithubPull(request) => {
                    super::inspection::pull_request_detail(self, request).await
                }
                DeviceBound::AgentUsage(_) => super::inspection::agent_usage(self).await,
                DeviceBound::Errors(request) => super::inspection::errors(self, request).await,
                DeviceBound::Timeline(request) => super::inspection::timeline(self, request).await,
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

impl RouterDispatcher {
    /// Which agent this machine reaches for when nobody says.
    ///
    /// Read from the same status route the dashboard uses, so "the default" is
    /// one fact rather than two that can disagree.
    async fn selected_agent_provider(&self) -> Result<String, ProtocolError> {
        let (status, body) = self.call(Method::GET, "/api/agent/chat/status").await?;
        if !status.is_success() {
            return Err(ProtocolError::new(
                ErrorCode::ServiceActionFailed,
                "This machine could not say which agent it would use.",
            ));
        }
        body.get("provider")
            .and_then(|provider| provider.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| {
                ProtocolError::new(
                    ErrorCode::CapabilityUnavailable,
                    "No agent is installed on this machine.",
                )
            })
    }

    /// Start a plain shell, through the same route.
    ///
    /// No body beyond an empty object: the route opens the machine's own shell
    /// in the workspace it already has. There is nothing here for a caller to
    /// name, which is the difference between this and `terminal.exec` — the
    /// widening is "a shell exists", not "a phone chooses what runs".
    async fn terminal_shell(&self) -> Result<PlatformBound, ProtocolError> {
        if !super::shell_allowed() {
            return Err(ProtocolError::new(
                ErrorCode::CapabilityUnavailable,
                "This machine does not offer a shell to a phone.",
            ));
        }
        let session = self.create_terminal(serde_json::json!({})).await?;
        Ok(super::terminal::spawned(session))
    }

    /// POST a terminal-creation body and read back the session it made.
    async fn create_terminal(
        &self,
        body: Value,
    ) -> Result<nomoreide_core::terminal::TerminalSession, ProtocolError> {
        let built = Request::builder()
            .method(Method::POST)
            .uri("/api/terminal/sessions")
            .header("authorization", format!("Bearer {}", self.credential))
            .header("content-type", "application/json")
            // The route requires this against cross-origin form posts. The
            // dispatcher is not a browser, but it goes through the same door as
            // one, so it presents what a browser does.
            .header("x-nomoreide-terminal-control", "1")
            .body(Body::from(body.to_string()))
            .map_err(|error| internal(format!("could not build a local request: {error}")))?;
        let response = self
            .router
            .clone()
            .oneshot(built)
            .await
            .map_err(|error| internal(format!("the local router failed: {error}")))?;
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), limits::MAX_FRAME_BYTES)
            .await
            .map_err(|error| internal(format!("could not read the local response: {error}")))?;
        let parsed: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);

        if !status.is_success() {
            let detail = parsed
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("that terminal could not be started");
            return Err(ProtocolError::new(
                ErrorCode::ServiceActionFailed,
                "That terminal could not be started on this machine.",
            )
            .with_detail(detail.to_string()));
        }
        serde_json::from_value(parsed.get("session").cloned().unwrap_or(Value::Null))
            .map_err(|error| internal(format!("the local response was not a session: {error}")))
    }

    /// Start an agent terminal, through the daemon's own route.
    ///
    /// **Through the router, unlike the mirror.** Spawning is a request and an
    /// answer, so it needs none of the exception `super::terminal` argues for —
    /// and going through the route means the working directory is the one the
    /// daemon already selected rather than anything a caller could name. The
    /// wire type has no field for a path, and this is why it needs none.
    async fn terminal_spawn(
        &self,
        request: &nomoreide_core::remote::protocol::device_bound::TerminalSpawnRequest,
    ) -> Result<PlatformBound, ProtocolError> {
        super::terminal::check_prompt(request)?;

        // The route this lands on *requires* a provider, while the wire type
        // says an absent one means the machine's own selection. Resolving it
        // here is what makes that true — it was documented and not implemented,
        // and the phone, which sends no provider, met "Agent provider must be
        // codex or claude" and had no idea why.
        let provider = match &request.provider {
            Some(provider) => provider.clone(),
            None => self.selected_agent_provider().await?,
        };
        let body = serde_json::json!({
            "agent": { "prompt": request.prompt, "provider": provider }
        });

        let built = Request::builder()
            .method(Method::POST)
            .uri("/api/terminal/sessions")
            .header("authorization", format!("Bearer {}", self.credential))
            .header("content-type", "application/json")
            // The route requires this header against cross-origin form posts.
            // The dispatcher is not a browser, but it goes through the same
            // door as one, so it presents the same thing a browser does.
            .header("x-nomoreide-terminal-control", "1")
            .body(Body::from(body.to_string()))
            .map_err(|error| internal(format!("could not build a local request: {error}")))?;
        let response = self
            .router
            .clone()
            .oneshot(built)
            .await
            .map_err(|error| internal(format!("the local router failed: {error}")))?;
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), limits::MAX_FRAME_BYTES)
            .await
            .map_err(|error| internal(format!("could not read the local response: {error}")))?;
        let parsed: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);

        if !status.is_success() {
            let detail = parsed
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("that agent could not be started");
            return Err(ProtocolError::new(
                ErrorCode::ServiceActionFailed,
                "That agent could not be started on this machine.",
            )
            .with_detail(detail.to_string()));
        }

        let session: nomoreide_core::terminal::TerminalSession = serde_json::from_value(
            parsed.get("session").cloned().unwrap_or(Value::Null),
        )
        .map_err(|error| internal(format!("the local response was not a session: {error}")))?;
        Ok(super::terminal::spawned(session))
    }
}

/// Whether a provider may be *driven* from a phone, as opposed to merely
/// listed.
///
/// Claude only, for now, and deliberately: the relay plan makes write-capable
/// remote turns conditional on the provider's native adapter giving the same
/// approval guarantees, and only one does. A provider that cannot promise every
/// mutating call reaches a human is one that must not be handed a prompt from a
/// pocket. Listing the others with `remote_writes: false` is better than hiding
/// them — a missing provider reads as a bug, a labelled one reads as a decision.
fn remote_writes_allowed(provider_id: &str) -> bool {
    provider_id == "claude"
}

/// Read one turn's stream to its end, numbering everything on the way out.
///
/// Runs as its own task because the command that started it was answered long
/// ago. It owns the run from here: every path out of this function ends the run,
/// so a stream that dies mid-turn denies its approvals rather than leaving them
/// parked forever.
#[allow(clippy::too_many_arguments)]
async fn pump(
    response: axum::response::Response,
    run_id: String,
    runs: AgentRuns,
    sessions: Arc<Mutex<HashMap<String, String>>>,
    events: EventSender,
    router: axum::Router,
    credential: String,
) {
    let mut stream = response.into_body().into_data_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else { break };
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        // SSE frames end with a blank line; anything after the last one is a
        // partial frame and waits for more bytes.
        while let Some(split) = buffer.find("\n\n") {
            let frame: String = buffer.drain(..split + 2).collect();
            let Some(data) = frame.lines().find_map(|line| line.strip_prefix("data: ")) else {
                continue;
            };
            let Ok(event) = serde_json::from_str::<AgentStreamEvent>(data) else {
                continue;
            };
            if !handle_stream_event(
                event,
                &run_id,
                &runs,
                &sessions,
                &events,
                &router,
                &credential,
            )
            .await
            {
                return;
            }
        }
    }

    // The stream ended without saying so. Closing denies whatever is parked.
    for event in runs.close(&run_id) {
        let _ = events.send(PlatformBound::AgentTurnEvent(event)).await;
    }
}

/// Handle one stream event. `false` means the run is over.
async fn handle_stream_event(
    event: AgentStreamEvent,
    run_id: &str,
    runs: &AgentRuns,
    sessions: &Arc<Mutex<HashMap<String, String>>>,
    events: &EventSender,
    router: &axum::Router,
    credential: &str,
) -> bool {
    match event {
        // The provider's own session id. Not sent onward — it names something
        // on this machine — but kept, because an approval is resolved against
        // it and a resumed turn needs it.
        AgentStreamEvent::Session { session_id } => {
            sessions
                .lock()
                .expect("sessions")
                .insert(run_id.to_string(), session_id);
            true
        }
        AgentStreamEvent::ApprovalRequest {
            request_id,
            name,
            input,
        } => {
            let expires_at = (chrono::Utc::now()
                + chrono::Duration::from_std(limits::APPROVAL_EXPIRY).expect("in range"))
            .to_rfc3339();
            let workspace = std::env::current_dir()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default();
            let Some((opened, wait)) = runs.open_approval(
                run_id,
                ApprovalRequestEvent {
                    approval_id: request_id.clone(),
                    provider: "claude".to_string(),
                    tool_name: name,
                    // The **full** input. A summary is what lets a hostile
                    // prompt get a destructive call approved by looking boring.
                    input,
                    workspace,
                    expires_at,
                },
            ) else {
                return true;
            };
            let _ = events.send(PlatformBound::AgentTurnEvent(opened)).await;

            // One task per approval, and exactly one POST per approval however
            // the verdict was reached — a human, the timer, the run ending, or
            // the daemon stopping all arrive here.
            let session_id = sessions
                .lock()
                .expect("sessions")
                .get(run_id)
                .cloned()
                .unwrap_or_default();
            let router = router.clone();
            let credential = credential.to_string();
            tokio::spawn(async move {
                let verdict = wait.await.unwrap_or(ApprovalVerdict::Deny);
                let decision = match verdict {
                    ApprovalVerdict::Allow => "allow",
                    ApprovalVerdict::Deny => "deny",
                };
                let body = serde_json::json!({
                    "sessionId": session_id,
                    "requestId": request_id,
                    "decision": decision,
                });
                let Ok(request) = Request::builder()
                    .method(Method::POST)
                    .uri("/api/agent/chat/approve")
                    .header("authorization", format!("Bearer {credential}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                else {
                    return;
                };
                let _ = router.oneshot(request).await;
            });
            true
        }
        other => {
            let Some(body) = agent_runs::from_stream_event(&other) else {
                return true;
            };
            let terminal = body.terminal();
            if let Some(numbered) = runs.emit(run_id, body) {
                let _ = events.send(PlatformBound::AgentTurnEvent(numbered)).await;
            }
            if terminal {
                // A finished run has nothing parked: `emit` marked it done, and
                // `close` would only add a spurious `cancelled`.
                return false;
            }
            true
        }
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
        let agent_status_note = note.clone();

        Router::new()
            .route("/api/linear/request", post(|headers: HeaderMap, Json(request): Json<nomoreide_core::remote::protocol::linear::LinearRequest>| async move {
                require(&headers);
                assert!(matches!(request, nomoreide_core::remote::protocol::linear::LinearRequest::Metadata {}));
                Json(serde_json::json!({"ok": true, "data": {"teams": {"nodes": []}, "token": "never-relay-this"}}))
            }))
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
            // What the daemon answers when asked which agent it would use.
            // Present here because a spawn with no provider has to resolve one,
            // and a stub that 404s would make that look like "no agent".
            .route(
                "/api/agent/chat/status",
                get(move |headers: HeaderMap| {
                    let note = agent_status_note.clone();
                    async move {
                        note("GET /api/agent/chat/status".into());
                        require(&headers);
                        Json(serde_json::json!({
                            "ok": true,
                            "configured": true,
                            "provider": { "id": "claude", "label": "Claude Code" },
                            "providers": [
                                { "id": "claude", "label": "Claude Code", "configured": true },
                                { "id": "codex", "label": "Codex", "configured": true }
                            ]
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
            TerminalManager::new(),
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
    async fn linear_uses_the_authenticated_route_and_projects_the_response() {
        let (dispatcher, _) = dispatcher();
        let answer = dispatcher
            .dispatch(
                "linear-1",
                DeviceBound::Linear(
                    nomoreide_core::remote::protocol::linear::LinearRequest::Metadata {},
                ),
                events(),
            )
            .await;
        assert!(matches!(answer, PlatformBound::Linear(_)));
        assert!(!serde_json::to_string(&answer)
            .unwrap()
            .contains("never-relay-this"));
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
    ///
    /// **`terminal` left this list in v2, and that is the one loosening.** It
    /// is no longer true that nothing here reaches a PTY; what is true is that
    /// only an *agent* PTY can be reached, and that rule is asserted directly
    /// below rather than inferred from a word not appearing in a string.
    ///
    /// **`git` had to stop being a bare substring, and it is worth saying why
    /// rather than quietly loosening it.** `/api/github/runs` contains the
    /// letters, and the rule this test was written to hold was never about
    /// letters — it was "the git manager and the guarded write surface are not
    /// reachable". So the check is now the routes those actually live on. The
    /// GitHub rows are a proxy of somebody else's read-only API; they cannot
    /// commit, push, merge or rewrite anything, and
    /// [`the_inspection_surface_only_reads`] is what holds that.
    #[test]
    fn the_allowlist_names_nothing_dangerous() {
        let rendered = ALLOWLIST
            .iter()
            .map(|entry| format!("{} {} {}", entry.kind, entry.capability, entry.routes))
            .collect::<Vec<_>>()
            .join(" ");
        for forbidden in [
            "shutdown",
            "database",
            "/api/git/",
            "git.",
            "fs",
            "exec",
            "env",
            "kill",
            "config",
        ] {
            assert!(
                !rendered.contains(forbidden),
                "the allowlist mentions {forbidden}: {rendered}"
            );
        }
        // Twenty-four rows: one Linear, five service, four agent, seven terminal, seven
        // read-only inspection. Pinned so growing the remote surface is a
        // deliberate edit to a test rather than a quiet addition.
        assert_eq!(ALLOWLIST.len(), 24);
    }

    /// Everything added for CI, pull requests, usage, errors and the timeline
    /// reads and nothing more.
    ///
    /// Two independent halves, because either alone would be satisfiable by
    /// accident: the protocol must class every one of them as non-mutating, and
    /// the table must route every one of them at a `GET`. A row that grew a
    /// `POST` would pass the first; a command that grew a side effect would
    /// pass the second.
    #[test]
    fn the_inspection_surface_only_reads() {
        use nomoreide_core::remote::protocol::version::capabilities as capability;

        let read_only = [
            capability::GITHUB_ACTIONS,
            capability::GITHUB_PULLS,
            capability::AGENT_USAGE,
            capability::DEVICE_ERRORS,
            capability::DEVICE_TIMELINE,
        ];
        let rows: Vec<&Allowed> = ALLOWLIST
            .iter()
            .filter(|entry| read_only.contains(&entry.capability))
            .collect();
        assert_eq!(rows.len(), 7, "the inspection rows moved");

        for row in &rows {
            assert!(
                row.routes.starts_with("GET "),
                "{} does not route at a GET: {}",
                row.kind,
                row.routes
            );
        }
        for command in every_command() {
            let Some(required) = command.required_capability() else {
                continue;
            };
            if read_only.contains(&required) {
                assert!(
                    !command.mutating(),
                    "{} is on the read-only surface but says it mutates",
                    command.kind()
                );
            }
        }
    }

    /// What a phone may mirror, on both sides of the shell switch.
    ///
    /// Agents always. Shells only while this machine offers them — and the
    /// listing and the attach check share one predicate, so a session can never
    /// be offered that the attach would then refuse. A `service` session is
    /// neither: that is a process the daemon runs, not a terminal anybody sits
    /// in, and it is never mirrorable however the switch is set.
    #[tokio::test]
    async fn shells_are_mirrorable_exactly_when_this_machine_offers_them() {
        let terminal = TerminalManager::new();
        let shell = spawn_kind(&terminal, "switch-shell", "shell");
        let agent = spawn_kind(&terminal, "switch-agent", "agent");
        let service = spawn_kind(&terminal, "switch-service", "service");

        for shells in [true, false] {
            assert!(
                terminal.is_mirrorable(&agent, shells),
                "an agent is mirrorable whatever the shell switch says"
            );
            assert_eq!(
                terminal.is_mirrorable(&shell, shells),
                shells,
                "a shell follows the switch"
            );
            assert!(
                !terminal.is_mirrorable(&service, shells),
                "a service is never a terminal somebody is sitting in"
            );

            let offered: Vec<String> = terminal
                .mirrorable_sessions(shells)
                .into_iter()
                .map(|session| session.id)
                .collect();
            let expected: Vec<String> = if shells {
                vec![shell.clone(), agent.clone()]
            } else {
                vec![agent.clone()]
            };
            assert_eq!(
                offered, expected,
                "the listing and the attach check must agree (shells={shells})"
            );
        }

        for id in [&shell, &agent, &service] {
            terminal.close_session(id).unwrap();
        }
    }

    /// A machine with shells off does not advertise them, so a phone is never
    /// shown a button it would be refused for pressing.
    #[test]
    fn the_shell_capability_follows_the_switch() {
        let advertised = served_capabilities();
        assert_eq!(
            advertised.contains(capabilities::TERMINAL_SHELL),
            super::super::shell_allowed(),
            "what this machine says it will do must match what it will do"
        );
        // The row never leaves the table; only the advertisement moves.
        assert!(ALLOWLIST
            .iter()
            .any(|allowed| allowed.capability == capabilities::TERMINAL_SHELL));
    }

    /// A session that does not exist is refused the same way a shell is, so a
    /// guessed id is not a different answer from a forbidden one.
    #[test]
    fn an_unknown_session_is_not_mirrorable() {
        for shells in [true, false] {
            assert!(!TerminalManager::new().is_mirrorable("no-such-session", shells));
        }
    }

    fn spawn_kind(terminal: &TerminalManager, id: &str, kind: &str) -> String {
        terminal
            .create(
                std::sync::Arc::new(SilentSink),
                nomoreide_core::terminal::TerminalSpawnSpec {
                    id: id.to_string(),
                    service_name: None,
                    cwd: std::env::temp_dir().to_string_lossy().into_owned(),
                    shell: "/bin/sh".into(),
                    args: vec!["-c".to_string(), "sleep 30".to_string()],
                    env: Vec::new(),
                    label: None,
                    kind: Some(kind.to_string()),
                    provider: (kind == "agent").then(|| "claude".to_string()),
                },
            )
            .expect("spawn")
            .id
    }

    /// These tests are about which sessions may be mirrored, not about what a
    /// session emits, so the events go nowhere.
    struct SilentSink;

    impl nomoreide_core::event_sink::EventSink for SilentSink {
        fn emit(
            &self,
            _event: &str,
            _payload: serde_json::Value,
        ) -> Result<(), nomoreide_core::event_sink::EventSinkError> {
            Ok(())
        }
    }
}
