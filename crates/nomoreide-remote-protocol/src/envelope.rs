//! The frame every relay message travels in, and the order it is checked in.
//!
//! **The envelope is invariant.** `v`, `id`, `type`, `deviceId`, `sentAt`,
//! `replyTo` and `payload` are fixed for the life of the protocol; `v` versions
//! the *payload union*, not the frame. That is what lets two peers with no
//! version in common still exchange a hello, a rejection and a heartbeat rather
//! than staring at each other — see [`super::version`].
//!
//! Validation order is deliberate, and it is cheapest-first only up to a point:
//!
//! 1. the byte length, before anything is parsed;
//! 2. the envelope's own shape;
//! 3. the protocol version;
//! 4. whether the `type` is a name this direction accepts;
//! 5. the payload;
//! 6. the `replyTo` rule for that type;
//! 7. the `sentAt` window.
//!
//! Staleness is last on purpose. It is the one condition that goes away by
//! itself, and reporting it ahead of a wrong version or an unknown command
//! would tell a peer with a permanent bug that it had a transient one.

use super::device_bound::DeviceBound;
use super::errors::{ErrorCode, ProtocolError};
use super::limits;
use super::platform_bound::PlatformBound;
use super::version::{PROTOCOL_VERSION, SUPPORTED_VERSIONS};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};

/// The most bytes an `id` or `deviceId` may be.
///
/// Both become map keys and log fields, and an identifier is not a place to put
/// data. A UUID is 36 bytes; this leaves room for a prefixed or ULID form
/// without leaving room for a payload.
pub const MAX_IDENTIFIER_BYTES: usize = 128;

/// One decoded frame: the invariant header, and the typed body.
#[derive(Debug, Clone, PartialEq)]
pub struct Envelope<T> {
    pub v: u32,
    /// The request id. Doubles as the idempotency key — see
    /// [`super::idempotency`].
    pub id: String,
    pub device_id: String,
    pub sent_at: DateTime<Utc>,
    /// The `id` of the request this frame answers, or `None` for an unsolicited
    /// one.
    pub reply_to: Option<String>,
    pub body: T,
}

/// The envelope as it appears on the wire, before the body is understood.
///
/// `deny_unknown_fields` here is the outermost strictness in the protocol: a
/// field nobody defined cannot ride along, whatever it is called.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawEnvelope {
    v: u32,
    id: String,
    #[serde(rename = "type")]
    kind: String,
    device_id: String,
    sent_at: DateTime<Utc>,
    #[serde(default)]
    reply_to: Option<String>,
    payload: serde_json::Value,
}

impl<T> Envelope<T> {
    /// Build a frame to send. `sent_at` is taken from the caller rather than
    /// the clock so that tests and the golden fixtures are not time-dependent.
    /// A frame stamped with the newest version this build speaks.
    ///
    /// Right for a peer known to be current, and for tests. A connection that
    /// has negotiated down must use [`Self::at_version`] instead.
    pub fn new(
        id: impl Into<String>,
        device_id: impl Into<String>,
        sent_at: DateTime<Utc>,
        body: T,
    ) -> Self {
        Self::at_version(PROTOCOL_VERSION, id, device_id, sent_at, body)
    }

    /// A frame stamped with a specific version.
    ///
    /// **Why this is not just `new`.** Once two versions exist, the version a
    /// session speaks is the one it *negotiated*, not the one this build
    /// prefers. A v2 daemon that stamped 2 on every frame after agreeing to
    /// speak 1 would have every frame refused by the peer that asked it to
    /// downgrade — which is the entire population of already-deployed peers.
    pub fn at_version(
        version: u32,
        id: impl Into<String>,
        device_id: impl Into<String>,
        sent_at: DateTime<Utc>,
        body: T,
    ) -> Self {
        Self {
            v: version,
            id: id.into(),
            device_id: device_id.into(),
            sent_at,
            reply_to: None,
            body,
        }
    }

    pub fn in_reply_to(mut self, request_id: impl Into<String>) -> Self {
        self.reply_to = Some(request_id.into());
        self
    }
}

/// Turn a decoded frame back into wire JSON.
///
/// Written as a free function over the two body types rather than a trait,
/// because there are exactly two and a trait would be indirection for its own
/// sake.
macro_rules! encoder {
    ($body:ty, $name:ident) => {
        /// Serialise this frame. Key order matches the fixtures, which matters
        /// because `serde_json` here is built with `preserve_order`.
        pub fn $name(frame: &Envelope<$body>) -> serde_json::Value {
            serde_json::json!({
                "v": frame.v,
                "id": frame.id,
                "type": frame.body.kind(),
                "deviceId": frame.device_id,
                "sentAt": frame.sent_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                "replyTo": frame.reply_to,
                "payload": frame.body.payload(),
            })
        }
    };
}

encoder!(DeviceBound, encode_device_bound);
encoder!(PlatformBound, encode_platform_bound);

/// Parse a frame the daemon received from the platform.
pub fn parse_device_bound(
    raw: &[u8],
    now: DateTime<Utc>,
) -> Result<Envelope<DeviceBound>, ProtocolError> {
    let envelope = parse_header(raw)?;
    let body = DeviceBound::parse(&envelope.kind, envelope.payload.clone())?;
    // A command is a request. Answering one is the other direction's job, so a
    // command that claims to answer something is a relay confusing itself.
    if envelope.reply_to.is_some() {
        return Err(ProtocolError::new(
            ErrorCode::MalformedFrame,
            "A command must not name a request it replies to.",
        ));
    }
    finish(envelope, body, now)
}

/// Parse a frame the platform received from a daemon.
pub fn parse_platform_bound(
    raw: &[u8],
    now: DateTime<Utc>,
) -> Result<Envelope<PlatformBound>, ProtocolError> {
    let envelope = parse_header(raw)?;
    let body = PlatformBound::parse(&envelope.kind, envelope.payload.clone())?;
    if body.requires_reply_to() != envelope.reply_to.is_some() {
        return Err(ProtocolError::new(
            ErrorCode::MalformedFrame,
            "This event's `replyTo` does not match what its type requires.",
        )
        .with_detail(body.kind()));
    }
    finish(envelope, body, now)
}

/// Steps 1 to 3: length, shape, version.
fn parse_header(raw: &[u8]) -> Result<RawEnvelope, ProtocolError> {
    if raw.len() > limits::MAX_FRAME_BYTES {
        return Err(ProtocolError::new(
            ErrorCode::FrameTooLarge,
            "Frame exceeds the protocol's maximum size.",
        )
        .with_detail(raw.len().to_string()));
    }
    let envelope: RawEnvelope = serde_json::from_slice(raw).map_err(|error| {
        ProtocolError::new(ErrorCode::MalformedFrame, "Frame is not a valid envelope.")
            .with_detail(error.to_string())
    })?;
    // Any version this build serves, not merely the newest one it prefers.
    //
    // These were the same number while 1 was the only version, and the
    // difference only became visible when 2 arrived: an exact check would have
    // made a v2 build reject every frame from a v1 daemon outright, which is
    // precisely the peer that `SUPPORTED_VERSIONS`, `negotiate` and the whole
    // degraded-session design exist to keep talking. Which *payloads* a session
    // may use is settled by the version it negotiated; this is only about
    // whether the envelope can be read at all.
    if !SUPPORTED_VERSIONS.contains(&envelope.v) {
        return Err(ProtocolError::new(
            ErrorCode::UnsupportedProtocolVersion,
            "This build does not speak that protocol version.",
        )
        .with_detail(envelope.v.to_string()));
    }
    check_identifier("id", &envelope.id)?;
    check_identifier("deviceId", &envelope.device_id)?;
    if let Some(reply_to) = &envelope.reply_to {
        check_identifier("replyTo", reply_to)?;
    }
    Ok(envelope)
}

/// Step 7, then assembly.
fn finish<T>(
    envelope: RawEnvelope,
    body: T,
    now: DateTime<Utc>,
) -> Result<Envelope<T>, ProtocolError> {
    let age = now.signed_duration_since(envelope.sent_at);
    let max_age = ChronoDuration::from_std(limits::MAX_REQUEST_AGE).expect("in range");
    let max_ahead = ChronoDuration::from_std(limits::MAX_CLOCK_SKEW_AHEAD).expect("in range");
    if age > max_age || age < -max_ahead {
        return Err(ProtocolError::new(
            ErrorCode::StaleRequest,
            "Frame is outside the accepted time window.",
        )
        .with_detail(envelope.sent_at.to_rfc3339()));
    }
    Ok(Envelope {
        v: envelope.v,
        id: envelope.id,
        device_id: envelope.device_id,
        sent_at: envelope.sent_at,
        reply_to: envelope.reply_to,
        body,
    })
}

/// An identifier is a name, not a field. Empty ones become ambiguous map keys
/// and oversized ones become a payload channel that skips every payload check.
fn check_identifier(field: &str, value: &str) -> Result<(), ProtocolError> {
    if value.is_empty() {
        return Err(
            ProtocolError::new(ErrorCode::MalformedFrame, "Identifier is empty.")
                .with_detail(field.to_string()),
        );
    }
    if value.len() > MAX_IDENTIFIER_BYTES {
        return Err(
            ProtocolError::new(ErrorCode::MalformedFrame, "Identifier is too long.")
                .with_detail(field.to_string()),
        );
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_graphic() && byte != b'"')
    {
        return Err(ProtocolError::new(
            ErrorCode::MalformedFrame,
            "Identifier contains characters an identifier may not.",
        )
        .with_detail(field.to_string()));
    }
    Ok(())
}
