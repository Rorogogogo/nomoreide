//! The refusals, tested at the envelope rather than at a type.
//!
//! Each `#[derive(Deserialize)]` in this module's siblings is checked where it
//! lives. What is checked here is the thing no single type can promise: that a
//! frame arriving off a socket is refused for the right reason, in the right
//! order, and that the union as a whole has no door into the operations the
//! allowlist excludes.

use super::device_bound::DeviceBound;
use super::envelope::{encode_device_bound, parse_device_bound, parse_platform_bound, Envelope};
use super::errors::ErrorCode;
use super::fixtures::{every_command, FIXTURE_DEVICE_ID, FIXTURE_SENT_AT};
use super::limits;
use super::platform_bound::PlatformBound;
use chrono::{DateTime, Duration as ChronoDuration, Utc};

fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(FIXTURE_SENT_AT)
        .expect("fixture clock")
        .with_timezone(&Utc)
}

/// A well-formed command, as bytes, ready to be spoilt one field at a time.
fn a_command() -> serde_json::Value {
    let frame = Envelope::new(
        "req_1",
        FIXTURE_DEVICE_ID,
        now(),
        DeviceBound::ServiceList(super::device_bound::Empty {}),
    );
    encode_device_bound(&frame)
}

fn refuse(frame: &serde_json::Value) -> ErrorCode {
    let bytes = serde_json::to_vec(frame).expect("encode");
    parse_device_bound(&bytes, now())
        .expect_err("frame should have been refused")
        .code
}

#[test]
fn a_well_formed_command_parses() {
    let bytes = serde_json::to_vec(&a_command()).expect("encode");
    assert!(parse_device_bound(&bytes, now()).is_ok());
}

/// The size check happens before the parser sees a byte, so an oversized frame
/// is refused even when it is valid in every other way.
#[test]
fn an_oversized_frame_is_refused_before_it_is_parsed() {
    let mut frame = a_command();
    frame["type"] = serde_json::Value::String("service.logs.request".into());
    frame["payload"] = serde_json::json!({
        "service": "a".repeat(limits::MAX_FRAME_BYTES),
    });
    assert_eq!(refuse(&frame), ErrorCode::FrameTooLarge);
}

/// Every name outside the union, including plausible ones and the exact
/// operations the MVP excludes.
///
/// **`terminal.input` left this list in v2, and that was the point of v2.** It
/// is now a real command, so what stops a phone reaching a *shell* is no longer
/// the absence of a frame — it is the daemon refusing to attach to any session
/// that is not an agent session. That rule cannot be asserted here, because
/// this crate has no sessions; it is enforced and tested in the dispatcher.
/// `terminal.spawn.request` later joined it, and that is not the loosening it
/// looks like: it starts an *agent*, in the daemon's own workspace, with no
/// argv and no path — the same thing `agent.turn.start` has always been allowed
/// to do, through the door that gives you a real session instead of a headless
/// one. `terminal.open` and `terminal.exec` stay excluded, because those would
/// be a shell.
#[test]
fn every_excluded_operation_is_an_unknown_command() {
    for kind in [
        "terminal.open",
        "terminal.close",
        "terminal.exec",
        "shell.exec",
        "fs.read",
        "fs.write",
        "git.push",
        "git.reset",
        "db.query",
        "db.unlock",
        "service.register",
        "config.write",
        "env.read",
        "provider.deploy",
        "daemon.shutdown",
        "port.killHolder",
        "http.forward",
        // Near-misses of real commands, which a typo or a hostile relay would
        // produce and which must not fall through to anything.
        "service.action",
        "service.action.Request",
        "SERVICE.ACTION.REQUEST",
        "service.action.request ",
        "",
    ] {
        let mut frame = a_command();
        frame["type"] = serde_json::Value::String(kind.into());
        assert_eq!(
            refuse(&frame),
            ErrorCode::UnknownCommand,
            "{kind:?} was not refused as an unknown command"
        );
    }
}

/// An event type arriving at the daemon is an unknown *command*, not a
/// malformed frame: the name exists, in the other direction.
#[test]
fn a_response_type_is_not_a_command() {
    for kind in PlatformBound::KINDS {
        let mut frame = a_command();
        frame["type"] = serde_json::Value::String((*kind).into());
        assert_eq!(refuse(&frame), ErrorCode::UnknownCommand, "{kind}");
    }
}

/// And the mirror: a command arriving at the platform is refused there too.
#[test]
fn a_command_type_is_not_an_event() {
    for kind in DeviceBound::KINDS {
        let mut frame = a_command();
        frame["type"] = serde_json::Value::String((*kind).into());
        let bytes = serde_json::to_vec(&frame).expect("encode");
        let error = parse_platform_bound(&bytes, now()).expect_err("should be refused");
        assert_eq!(error.code, ErrorCode::UnknownCommand, "{kind}");
    }
}

#[test]
fn a_frame_from_another_major_version_is_refused() {
    for version in [0, super::version::PROTOCOL_VERSION + 1, 99] {
        let mut frame = a_command();
        frame["v"] = serde_json::Value::from(version);
        assert_eq!(refuse(&frame), ErrorCode::UnsupportedProtocolVersion);
    }
}

/// The version check comes before the type check, so an old peer sending a
/// command this build removed is told the truth — its protocol is old — rather
/// than that its command does not exist.
#[test]
fn the_version_is_checked_before_the_command_name() {
    let mut frame = a_command();
    // Derived, not written out: the last bump made every hardcoded `2` in this
    // file mean the opposite of what it was written to mean.
    frame["v"] = serde_json::Value::from(super::version::PROTOCOL_VERSION + 1);
    frame["type"] = serde_json::Value::String("something.invented".into());
    assert_eq!(refuse(&frame), ErrorCode::UnsupportedProtocolVersion);
}

/// And staleness comes last, so a peer with a permanent bug is never told it
/// has a transient one.
#[test]
fn a_stale_frame_with_an_unknown_command_reports_the_command() {
    let mut frame = a_command();
    frame["type"] = serde_json::Value::String("shell.exec".into());
    frame["sentAt"] = serde_json::Value::String("2020-01-01T00:00:00.000Z".into());
    assert_eq!(refuse(&frame), ErrorCode::UnknownCommand);
}

#[test]
fn a_frame_older_than_the_window_is_stale() {
    let bytes = serde_json::to_vec(&a_command()).expect("encode");
    let late = now()
        + ChronoDuration::from_std(limits::MAX_REQUEST_AGE).expect("in range")
        + ChronoDuration::seconds(1);
    let error = parse_device_bound(&bytes, late).expect_err("should be stale");
    assert_eq!(error.code, ErrorCode::StaleRequest);
}

/// Phones have wrong clocks. A device a few minutes fast must still work, or
/// the feature is unusable for the people it is for.
#[test]
fn a_frame_from_a_slightly_fast_clock_is_accepted() {
    let bytes = serde_json::to_vec(&a_command()).expect("encode");
    let early = now() - ChronoDuration::seconds(120);
    assert!(parse_device_bound(&bytes, early).is_ok());
}

#[test]
fn a_frame_from_an_absurdly_fast_clock_is_refused() {
    let bytes = serde_json::to_vec(&a_command()).expect("encode");
    let early = now()
        - ChronoDuration::from_std(limits::MAX_CLOCK_SKEW_AHEAD).expect("in range")
        - ChronoDuration::seconds(1);
    let error = parse_device_bound(&bytes, early).expect_err("should be refused");
    assert_eq!(error.code, ErrorCode::StaleRequest);
}

#[test]
fn a_field_nobody_defined_cannot_ride_along() {
    let mut frame = a_command();
    frame["shell"] = serde_json::Value::String("rm -rf /".into());
    assert_eq!(refuse(&frame), ErrorCode::MalformedFrame);
}

#[test]
fn a_payload_field_nobody_defined_cannot_ride_along() {
    let mut frame = a_command();
    frame["type"] = serde_json::Value::String("service.action.request".into());
    frame["payload"] = serde_json::json!({
        "service": "api",
        "action": "restart",
        "env": { "TOKEN": "x" },
    });
    assert_eq!(refuse(&frame), ErrorCode::MalformedFrame);
}

#[test]
fn an_identifier_may_not_be_empty_oversized_or_strange() {
    for (field, value) in [
        ("id", String::new()),
        ("deviceId", String::new()),
        ("id", "x".repeat(super::envelope::MAX_IDENTIFIER_BYTES + 1)),
        ("id", "has space".to_string()),
        ("id", "has\nnewline".to_string()),
        ("deviceId", "../../etc/passwd\0".to_string()),
    ] {
        let mut frame = a_command();
        frame[field] = serde_json::Value::String(value.clone());
        assert_eq!(
            refuse(&frame),
            ErrorCode::MalformedFrame,
            "{field}={value:?} was accepted"
        );
    }
}

/// A command answers nothing. One that claims to is a relay that has confused
/// its two directions, and the frame after it should not be trusted either.
#[test]
fn a_command_may_not_claim_to_be_a_reply() {
    let mut frame = a_command();
    frame["replyTo"] = serde_json::Value::String("req_0".into());
    assert_eq!(refuse(&frame), ErrorCode::MalformedFrame);
}

/// The mirror rule, both ways round: an answer must correlate, and an
/// unsolicited event must not pretend to.
#[test]
fn an_events_reply_to_must_match_what_its_type_requires() {
    let base = |kind: &str, payload: serde_json::Value, reply_to: Option<&str>| {
        serde_json::json!({
            "v": super::version::PROTOCOL_VERSION,
            "id": "evt_1",
            "type": kind,
            "deviceId": FIXTURE_DEVICE_ID,
            "sentAt": FIXTURE_SENT_AT,
            "replyTo": reply_to,
            "payload": payload,
        })
    };
    let missing = base(
        "service.list.response",
        serde_json::json!({"services": []}),
        None,
    );
    let bytes = serde_json::to_vec(&missing).expect("encode");
    assert_eq!(
        parse_platform_bound(&bytes, now())
            .expect_err("should refuse")
            .code,
        ErrorCode::MalformedFrame
    );

    let spurious = base("session.heartbeat", serde_json::json!({}), Some("req_1"));
    let bytes = serde_json::to_vec(&spurious).expect("encode");
    assert_eq!(
        parse_platform_bound(&bytes, now())
            .expect_err("should refuse")
            .code,
        ErrorCode::MalformedFrame
    );
}

/// Bytes that are not JSON at all.
#[test]
fn junk_is_a_malformed_frame() {
    for junk in [b"".as_slice(), b"not json", b"[1,2,3]", b"\"hello\"", b"{"] {
        let error = parse_device_bound(junk, now()).expect_err("should refuse");
        assert_eq!(error.code, ErrorCode::MalformedFrame);
    }
}

/// The classification every later phase depends on. Written out by hand rather
/// than derived, so that changing a command's mutating-ness has to be done
/// twice and noticed once.
#[test]
fn the_mutating_half_of_the_union_is_exactly_these_six() {
    let mutating: Vec<&str> = every_command()
        .iter()
        .filter(|command| command.mutating())
        .map(|command| command.kind())
        .collect();
    assert_eq!(
        mutating,
        [
            "service.action.request",
            "agent.turn.start",
            "agent.turn.cancel",
            "agent.approval.resolve",
            "terminal.spawn.request",
            "terminal.input",
        ]
    );
}

/// Control frames aside, every command names the capability that gates it.
/// A command with no capability would be one an older daemon could not refuse.
#[test]
fn every_non_control_command_is_gated_by_a_capability() {
    for command in every_command() {
        let control = matches!(
            command,
            DeviceBound::SessionWelcome(_) | DeviceBound::SessionRevoke(_)
        );
        assert_eq!(
            command.required_capability().is_none(),
            control,
            "{} is gated wrongly",
            command.kind()
        );
    }
}

/// A v2 build must still be able to *read* a v1 peer's frames.
///
/// This is the compatibility the version list promises, and it was briefly not
/// true: the envelope parser compared against the newest version rather than
/// the supported set, so bumping to 2 would have made every 0.4.0 daemon
/// unreadable the moment the platform shipped.
#[test]
fn an_older_but_supported_version_still_parses() {
    for version in super::version::SUPPORTED_VERSIONS {
        let mut frame = a_command();
        frame["v"] = serde_json::Value::from(*version);
        let bytes = serde_json::to_vec(&frame).expect("encode");
        assert!(
            parse_device_bound(&bytes, now()).is_ok(),
            "v{version} is advertised as supported and must parse"
        );
    }
}
