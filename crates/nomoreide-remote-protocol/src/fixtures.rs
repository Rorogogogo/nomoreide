//! One sample of every frame the protocol defines, and the golden files
//! generated from them.
//!
//! Two jobs, and they are the same job seen from either end.
//!
//! [`every_command`] and [`every_event`] are the exhaustive sample sets. They
//! are `pub` rather than test-only because exhaustiveness is a property other
//! code needs to assert — the dispatcher's allowlist, the platform's router —
//! and a list that only tests can see is a list that drifts from the union.
//! They are held to the unions by [`golden::the_samples_cover_every_kind`]: a
//! new variant has to reach `KINDS` before it can be parsed at all, and the
//! moment it does, the missing sample fails the suite.
//!
//! The golden files under `fixtures/` are those samples serialised, plus
//! hand-written invalid frames that each name the error code they must produce.
//! Both ends of the wire share this crate's parser, so their job is not to hold
//! two implementations together — it is to make a change to the *shape* of a
//! frame visible. A field renamed, a payload nested differently, an optional
//! that starts serialising as `null`: none of those fail a type-level test, and
//! all of them break a peer that has not been rebuilt. Here they are a diff.
//!
//! They are also the source for any mirror written in another language — the
//! hosted frontend will eventually render run events, and its TypeScript types
//! should be checked against these bytes rather than against a reading of the
//! spec.
//!
//! Regenerate the valid half with `UPDATE_REMOTE_FIXTURES=1 cargo test -p
//! nomoreide-remote-protocol fixtures`. Doing so is a protocol change: the diff
//! is the review.

use super::agent_event::{
    AgentEvent, AgentEventBody, ApprovalDecider, ApprovalRequestEvent, ApprovalSettledEvent,
    ErrorEvent, NoData, TextEvent, ToolResultEvent, ToolUseEvent,
};
use super::device_bound::{
    AgentApprovalResolve, AgentTurnCancel, AgentTurnStart, ApprovalVerdict, DeviceBound, Empty,
    ServiceAction, ServiceActionRequest, ServiceLogsRequest, SessionRevoke, SessionWelcome,
    TerminalAttachRequest, TerminalDetach, TerminalInput, TerminalResize,
};
use super::errors::{ErrorCode, ProtocolError};
use super::platform_bound::{
    AgentProvidersResponse, AgentTurnAccepted, BundleListResponse, CommandErrorResponse,
    DeviceSnapshotResponse, PlatformBound, ServiceActionResponse, ServiceListResponse,
    ServiceLogsResponse, SessionHello, TerminalAck, TerminalAttachAccepted, TerminalCloseReason,
    TerminalClosed, TerminalOutput, TerminalSessionsResponse,
};
use super::snapshot::{
    BundleState, DeviceSnapshot, LogLine, LogStream, RemoteAgentProvider, RemoteBundle,
    RemoteService, RemoteTerminalSession, ServiceState,
};
use super::terminal_bytes::TerminalBytes;
use super::version::{CapabilitySet, SessionMode, SUPPORTED_VERSIONS};

/// The `sentAt` every golden fixture carries, so a recording is never a picture
/// of the clock that made it.
pub const FIXTURE_SENT_AT: &str = "2026-09-01T00:00:00.000Z";
/// The device id every golden fixture carries.
pub const FIXTURE_DEVICE_ID: &str = "11111111-2222-3333-4444-555555555555";

/// One sample of every command the platform may send.
pub fn every_command() -> Vec<DeviceBound> {
    vec![
        DeviceBound::SessionWelcome(SessionWelcome {
            version: 1,
            mode: SessionMode::Full,
            device_id: FIXTURE_DEVICE_ID.to_string(),
            server_version: "0.3.3".to_string(),
        }),
        DeviceBound::SessionRevoke(SessionRevoke {
            reason: "Revoked from your account.".to_string(),
        }),
        DeviceBound::DeviceSnapshot(Empty {}),
        DeviceBound::ServiceList(Empty {}),
        DeviceBound::ServiceAction(ServiceActionRequest {
            service: "api".to_string(),
            action: ServiceAction::Restart,
        }),
        DeviceBound::ServiceLogs(ServiceLogsRequest {
            service: "api".to_string(),
            limit: Some(50),
        }),
        DeviceBound::BundleList(Empty {}),
        DeviceBound::AgentProviders(Empty {}),
        DeviceBound::AgentTurnStart(AgentTurnStart {
            run_id: None,
            provider: Some("claude".to_string()),
            prompt: "Why did the api service exit?".to_string(),
        }),
        DeviceBound::AgentTurnCancel(AgentTurnCancel {
            run_id: "run_1".to_string(),
        }),
        DeviceBound::AgentApprovalResolve(AgentApprovalResolve {
            run_id: "run_1".to_string(),
            approval_id: "ap_1".to_string(),
            verdict: ApprovalVerdict::Deny,
        }),
        DeviceBound::TerminalSessions(Empty {}),
        DeviceBound::TerminalAttach(TerminalAttachRequest {
            session_id: "term_1".to_string(),
            cols: 80,
            rows: 24,
        }),
        DeviceBound::TerminalInput(TerminalInput {
            // A carriage return, which is what answering a TUI prompt is.
            data: TerminalBytes::new(b"\r".to_vec()),
            stream_id: "stream_1".to_string(),
        }),
        DeviceBound::TerminalResize(TerminalResize {
            stream_id: "stream_1".to_string(),
            cols: 100,
            rows: 40,
        }),
        DeviceBound::TerminalDetach(TerminalDetach {
            stream_id: "stream_1".to_string(),
        }),
    ]
}

/// One sample of every event a daemon may send.
pub fn every_event() -> Vec<PlatformBound> {
    let mut events = vec![
        PlatformBound::SessionHello(SessionHello {
            supported_versions: SUPPORTED_VERSIONS.to_vec(),
            daemon_version: "0.3.3".to_string(),
            platform: "macos".to_string(),
            capabilities: CapabilitySet::current(),
        }),
        PlatformBound::SessionHeartbeat(Empty {}),
        PlatformBound::DeviceSnapshot(DeviceSnapshotResponse {
            device: DeviceSnapshot {
                device_id: FIXTURE_DEVICE_ID.to_string(),
                name: "Studio".to_string(),
                platform: "macos".to_string(),
                daemon_version: "0.3.3".to_string(),
                protocol_version: 1,
                capabilities: CapabilitySet::current(),
            },
        }),
        PlatformBound::ServiceList(ServiceListResponse {
            services: vec![RemoteService {
                name: "api".to_string(),
                description: Some("The HTTP API".to_string()),
                kind: Some("node".to_string()),
                port: Some(3000),
                state: ServiceState::Running,
            }],
        }),
        PlatformBound::ServiceAction(ServiceActionResponse {
            service: "api".to_string(),
            action: ServiceAction::Restart,
            state: ServiceState::Starting,
        }),
        PlatformBound::ServiceLogs(ServiceLogsResponse {
            service: "api".to_string(),
            lines: vec![LogLine {
                at: FIXTURE_SENT_AT.to_string(),
                stream: LogStream::Stdout,
                text: "listening on 3000".to_string(),
                truncated: false,
            }],
            truncated: true,
        }),
        PlatformBound::BundleList(BundleListResponse {
            bundles: vec![RemoteBundle {
                name: "web".to_string(),
                state: BundleState::Partial,
                services: vec!["api".to_string(), "worker".to_string()],
            }],
        }),
        PlatformBound::AgentProviders(AgentProvidersResponse {
            providers: vec![RemoteAgentProvider {
                id: "claude".to_string(),
                name: "Claude Code".to_string(),
                available: true,
                remote_writes: true,
            }],
        }),
        PlatformBound::AgentTurnAccepted(AgentTurnAccepted {
            run_id: "run_1".to_string(),
            next_seq: 0,
        }),
        PlatformBound::CommandError(CommandErrorResponse {
            error: ProtocolError::new(ErrorCode::UnknownService, "No such registered service.")
                .with_detail("api"),
        }),
        PlatformBound::TerminalSessions(TerminalSessionsResponse {
            sessions: vec![RemoteTerminalSession {
                id: "term_1".to_string(),
                label: Some("Hey".to_string()),
                provider: Some("claude".to_string()),
                workspace: Some("nomoreide".to_string()),
                running: true,
            }],
        }),
        PlatformBound::TerminalAttachAccepted(TerminalAttachAccepted {
            stream_id: "stream_1".to_string(),
            session_id: "term_1".to_string(),
            cols: 80,
            rows: 24,
        }),
        PlatformBound::TerminalOutput(TerminalOutput {
            stream_id: "stream_1".to_string(),
            seq: 0,
            // An escape sequence, because that is what a terminal actually
            // sends and what a UTF-8 string type would have mangled.
            data: TerminalBytes::new(b"\x1b[2J$ ".to_vec()),
        }),
        PlatformBound::TerminalAck(TerminalAck {
            stream_id: "stream_1".to_string(),
        }),
        PlatformBound::TerminalClosed(TerminalClosed {
            stream_id: "stream_1".to_string(),
            reason: TerminalCloseReason::Exited,
        }),
    ];
    // One frame per run-event kind, because `agent.turn.event` is a union in
    // its own right and a single sample of it would leave seven kinds untested.
    for (seq, body) in every_agent_event_body().into_iter().enumerate() {
        events.push(PlatformBound::AgentTurnEvent(AgentEvent {
            run_id: "run_1".to_string(),
            seq: seq as u64,
            event: body,
        }));
    }
    events
}

/// One sample of every event body a run may emit.
pub fn every_agent_event_body() -> Vec<AgentEventBody> {
    vec![
        AgentEventBody::Text(TextEvent {
            text: "Looking at the logs.".to_string(),
        }),
        AgentEventBody::ToolUse(ToolUseEvent {
            tool_use_id: "tu_1".to_string(),
            name: "Read".to_string(),
            input: serde_json::json!({ "path": "server.js" }),
        }),
        AgentEventBody::ToolResult(ToolResultEvent {
            tool_use_id: "tu_1".to_string(),
            ok: true,
            summary: "read 120 lines".to_string(),
        }),
        AgentEventBody::ApprovalRequest(ApprovalRequestEvent {
            approval_id: "ap_1".to_string(),
            provider: "claude".to_string(),
            tool_name: "Bash".to_string(),
            input: serde_json::json!({ "command": "npm run build" }),
            workspace: "/workspace/project".to_string(),
            expires_at: "2026-09-01T00:02:00.000Z".to_string(),
        }),
        AgentEventBody::ApprovalSettled(ApprovalSettledEvent {
            approval_id: "ap_1".to_string(),
            verdict: ApprovalVerdict::Allow,
            decided_by: ApprovalDecider::User,
        }),
        AgentEventBody::Completed(NoData {}),
        AgentEventBody::Cancelled(NoData {}),
        AgentEventBody::Error(ErrorEvent {
            message: "The provider exited before answering.".to_string(),
        }),
    ]
}

#[cfg(test)]
pub(crate) mod golden {
    //! The committed frames, and the assertions that keep them honest.
    //!
    //! An invalid fixture is self-describing — it names the direction it
    //! travels and the error code it must produce — so there is no manifest to
    //! fall out of step with the directory. Everything in `invalid/` is
    //! exercised because the test walks the directory rather than a list.

    use super::super::device_bound::DeviceBound;
    use super::super::envelope::{
        encode_device_bound, encode_platform_bound, parse_device_bound, parse_platform_bound,
        Envelope,
    };
    use super::super::errors::ErrorCode;
    use super::super::platform_bound::PlatformBound;
    use super::*;
    use chrono::{DateTime, Utc};
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};

    fn root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src/fixtures")
    }

    fn fixture_now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(FIXTURE_SENT_AT)
            .expect("fixture clock")
            .with_timezone(&Utc)
    }

    /// `service.action.request` → `service-action-request.json`. A dot is legal
    /// in a filename but reads as an extension, and these are read by two
    /// languages' tooling.
    fn file_name(kind: &str) -> String {
        format!("{}.json", kind.replace('.', "-"))
    }

    /// Frames are pretty-printed with a trailing newline: they are reviewed in
    /// diffs, and a one-line frame makes a field change look like a rewrite.
    fn render(value: &serde_json::Value) -> String {
        format!("{}\n", serde_json::to_string_pretty(value).expect("render"))
    }

    fn updating() -> bool {
        std::env::var("UPDATE_REMOTE_FIXTURES").is_ok()
    }

    fn check_or_write(path: &Path, contents: &str) {
        if updating() {
            std::fs::create_dir_all(path.parent().expect("parent")).expect("create fixture dir");
            std::fs::write(path, contents).expect("write fixture");
            return;
        }
        let found = std::fs::read_to_string(path).unwrap_or_else(|error| {
            panic!(
                "missing golden fixture {} ({error}).\n\
                 Regenerate with UPDATE_REMOTE_FIXTURES=1 cargo test -p nomoreide-remote-protocol",
                path.display()
            )
        });
        assert_eq!(
            found,
            contents,
            "golden fixture {} no longer matches the protocol types.\n\
             If the change is deliberate it is a protocol change: regenerate with \
             UPDATE_REMOTE_FIXTURES=1 and review the diff.",
            path.display()
        );
    }

    fn command_frames() -> Vec<(String, Envelope<DeviceBound>)> {
        every_command()
            .into_iter()
            .map(|body| {
                let name = file_name(body.kind());
                let frame = Envelope::new(
                    format!("req_{}", body.kind().replace('.', "_")),
                    FIXTURE_DEVICE_ID,
                    fixture_now(),
                    body,
                );
                (name, frame)
            })
            .collect()
    }

    fn event_frames() -> Vec<(String, Envelope<PlatformBound>)> {
        every_event()
            .into_iter()
            .map(|body| {
                let base = body.kind();
                // Every run event shares one `type`, so the kind inside it is
                // what separates the files.
                let name = match &body {
                    PlatformBound::AgentTurnEvent(event) => {
                        file_name(&format!("{base}.{}", event.event.kind()))
                    }
                    _ => file_name(base),
                };
                let mut frame = Envelope::new(
                    format!("evt_{}", name.trim_end_matches(".json").replace('-', "_")),
                    FIXTURE_DEVICE_ID,
                    fixture_now(),
                    body,
                );
                if frame.body.requires_reply_to() {
                    frame = frame.in_reply_to("req_1");
                }
                (name, frame)
            })
            .collect()
    }

    #[test]
    fn every_command_has_a_golden_frame_that_round_trips() {
        for (name, frame) in command_frames() {
            let encoded = encode_device_bound(&frame);
            let path = root().join("valid/device-bound").join(&name);
            check_or_write(&path, &render(&encoded));

            let bytes = std::fs::read(&path).expect("read fixture");
            let parsed = parse_device_bound(&bytes, fixture_now())
                .unwrap_or_else(|error| panic!("{name} did not parse: {error:?}"));
            assert_eq!(parsed, frame, "{name} did not round trip");
        }
    }

    #[test]
    fn every_event_has_a_golden_frame_that_round_trips() {
        for (name, frame) in event_frames() {
            let encoded = encode_platform_bound(&frame);
            let path = root().join("valid/platform-bound").join(&name);
            check_or_write(&path, &render(&encoded));

            let bytes = std::fs::read(&path).expect("read fixture");
            let parsed = parse_platform_bound(&bytes, fixture_now())
                .unwrap_or_else(|error| panic!("{name} did not parse: {error:?}"));
            assert_eq!(parsed, frame, "{name} did not round trip");
        }
    }

    /// The exhaustiveness link. A variant added to a union reaches `KINDS`
    /// before it can be parsed; this is what then demands a sample for it.
    #[test]
    fn the_samples_cover_every_kind() {
        let commands: BTreeSet<&str> = every_command().iter().map(DeviceBound::kind).collect();
        let declared: BTreeSet<&str> = DeviceBound::KINDS.iter().copied().collect();
        assert_eq!(commands, declared, "command samples do not cover the union");

        let events: BTreeSet<&str> = every_event().iter().map(PlatformBound::kind).collect();
        let declared: BTreeSet<&str> = PlatformBound::KINDS.iter().copied().collect();
        assert_eq!(events, declared, "event samples do not cover the union");

        let bodies: BTreeSet<&str> = every_agent_event_body()
            .iter()
            .map(super::AgentEventBody::kind)
            .collect();
        let declared: BTreeSet<&str> = super::AgentEventBody::KINDS.iter().copied().collect();
        assert_eq!(bodies, declared, "run-event samples do not cover the union");
    }

    /// A committed frame nobody generates is a frame nobody checks. Catches a
    /// renamed command leaving its old file behind.
    #[test]
    fn no_golden_frame_is_left_behind() {
        if updating() {
            return;
        }
        for (dir, expected) in [
            (
                "valid/device-bound",
                command_frames()
                    .into_iter()
                    .map(|(name, _)| name)
                    .collect::<BTreeSet<_>>(),
            ),
            (
                "valid/platform-bound",
                event_frames()
                    .into_iter()
                    .map(|(name, _)| name)
                    .collect::<BTreeSet<_>>(),
            ),
        ] {
            let found: BTreeSet<String> = std::fs::read_dir(root().join(dir))
                .expect("read fixture dir")
                .map(|entry| {
                    entry
                        .expect("entry")
                        .file_name()
                        .to_string_lossy()
                        .into_owned()
                })
                .collect();
            assert_eq!(found, expected, "stale or missing files in {dir}");
        }
    }

    /// How an invalid fixture describes itself.
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct InvalidFixture {
        /// Why this frame is refused. Prose, for whoever reads the diff.
        #[allow(dead_code)]
        note: String,
        direction: Direction,
        expect: ErrorCode,
        /// The frame, when it is valid JSON.
        #[serde(default)]
        frame: Option<serde_json::Value>,
        /// The frame as raw text, for the cases that are not valid JSON at all.
        #[serde(default)]
        frame_text: Option<String>,
    }

    #[derive(serde::Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    enum Direction {
        DeviceBound,
        PlatformBound,
    }

    fn invalid_fixtures() -> Vec<(String, InvalidFixture)> {
        let mut found: Vec<(String, InvalidFixture)> = std::fs::read_dir(root().join("invalid"))
            .expect("read invalid fixtures")
            .map(|entry| {
                let entry = entry.expect("entry");
                let name = entry.file_name().to_string_lossy().into_owned();
                let text = std::fs::read_to_string(entry.path()).expect("read fixture");
                let fixture = serde_json::from_str(&text)
                    .unwrap_or_else(|error| panic!("{name} is not a fixture: {error}"));
                (name, fixture)
            })
            .collect();
        found.sort_by(|left, right| left.0.cmp(&right.0));
        assert!(!found.is_empty(), "no invalid fixtures found");
        found
    }

    #[test]
    fn every_invalid_frame_is_refused_with_the_code_it_names() {
        for (name, fixture) in invalid_fixtures() {
            let bytes = match (&fixture.frame, &fixture.frame_text) {
                (Some(frame), None) => serde_json::to_vec(frame).expect("encode"),
                (None, Some(text)) => text.clone().into_bytes(),
                _ => panic!("{name} must carry exactly one of `frame` or `frameText`"),
            };
            let error = match fixture.direction {
                Direction::DeviceBound => parse_device_bound(&bytes, fixture_now()).err(),
                Direction::PlatformBound => parse_platform_bound(&bytes, fixture_now()).err(),
            };
            let error = error.unwrap_or_else(|| panic!("{name} was accepted, and must not be"));
            assert_eq!(error.code, fixture.expect, "{name} produced the wrong code");
            assert_eq!(
                error.retryable,
                fixture.expect.retryable(),
                "{name} disagrees with the retry table"
            );
        }
    }

    /// The refusals the parser is responsible for all have a committed example.
    /// The rest are the dispatcher's and the relay's, and are tested where they
    /// are decided.
    #[test]
    fn the_invalid_fixtures_cover_every_parse_time_refusal() {
        let covered: BTreeSet<ErrorCode> = invalid_fixtures()
            .into_iter()
            .map(|(_, fixture)| fixture.expect)
            .collect();
        let expected: BTreeSet<ErrorCode> = [
            ErrorCode::MalformedFrame,
            ErrorCode::UnknownCommand,
            ErrorCode::UnsupportedProtocolVersion,
            ErrorCode::StaleRequest,
        ]
        .into_iter()
        .collect();
        assert!(
            expected.is_subset(&covered),
            "missing invalid fixtures for {:?}",
            expected.difference(&covered).collect::<Vec<_>>()
        );
    }
}
