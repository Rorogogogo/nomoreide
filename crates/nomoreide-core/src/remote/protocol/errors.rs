//! The frozen error codes, and the one thing a caller is allowed to conclude
//! from each: whether retrying is safe.
//!
//! Codes are `SCREAMING_SNAKE_CASE` strings on the wire rather than integers,
//! because the first reader of a relay error is a person looking at a log line
//! and the second is a phone deciding whether to offer a retry button. Neither
//! is helped by `4007`.
//!
//! **`retryable` is a property of the code, not of the situation.** A caller
//! must never decide for itself that a refusal looks safe to repeat: the whole
//! danger of remote machine control is the mutation that ran, answered nothing,
//! and gets sent again. So the table below is the only authority, and it is
//! deliberately pessimistic — anything that *might* have executed is not
//! retryable, even when it usually did not.

use serde::{Deserialize, Serialize};

/// Why a frame was refused, or why the operation behind it did not happen.
///
/// Non-exhaustive is deliberate on the *reading* side only: a peer that meets a
/// code it does not know treats it as [`ErrorCode::InternalError`] rather than
/// failing to parse, so adding a code in a later minor revision cannot break an
/// older client. The serde representation below is what makes that work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    /// The frame named a major version this peer cannot speak at all.
    UnsupportedProtocolVersion,
    /// The bytes were not a valid envelope: bad JSON, missing field, unknown
    /// field, wrong type.
    MalformedFrame,
    /// The envelope parsed, but `type` is not a name this peer accepts **in
    /// this direction**. A response type arriving at the daemon is this, not
    /// [`ErrorCode::MalformedFrame`].
    UnknownCommand,
    /// The frame was larger than [`super::limits::MAX_FRAME_BYTES`]. Answered
    /// only when the frame was small enough to identify; past that the socket
    /// simply closes.
    FrameTooLarge,
    /// A field inside a well-formed frame exceeded its own limit — a prompt
    /// over 16 KiB, say.
    PayloadTooLarge,
    /// `sentAt` is outside the window in [`super::limits`]. The sender has
    /// almost certainly stopped waiting.
    StaleRequest,
    /// This request id was already seen inside the dedup window and the
    /// operation is not one that may run twice.
    DuplicateRequest,
    /// The device already has [`super::limits::MAX_PENDING_COMMANDS`] requests
    /// in flight.
    TooManyPending,
    /// The credential is revoked, belongs to another device, or the caller does
    /// not own this device.
    NotAuthorized,
    /// No daemon socket is currently attached to this device. Never queued —
    /// presence fails closed.
    DeviceOffline,
    /// No service by that exact name is registered. The remote surface never
    /// takes a pattern, so this is always an exact-name miss.
    UnknownService,
    /// The daemon tried the action and it failed. The only code here that
    /// carries a message written by the local runtime rather than the protocol.
    ServiceActionFailed,
    /// No agent run by that id, or one that has already finished.
    UnknownRun,
    /// No pending approval by that id on that run.
    UnknownApproval,
    /// The approval was answered by its own expiry before the human answered
    /// it. Always a deny, never a silent drop.
    ApprovalExpired,
    /// The operation was still running when its deadline passed. **Not**
    /// retryable: the daemon may yet finish it.
    Timeout,
    /// A per-IP, per-user or per-device rate limit refused the frame.
    RateLimited,
    /// The peer speaks this protocol version but not this capability — an older
    /// daemon meeting a feature that shipped after it. Rendered to a user as
    /// "your machine needs updating", never as a failure.
    CapabilityUnavailable,
    /// Anything else, and anything a peer does not recognise.
    #[serde(other)]
    InternalError,
}

impl ErrorCode {
    /// Whether the *same request id* may be sent again by an automatic retry.
    ///
    /// True only where the operation provably did not start. Everything
    /// ambiguous — a timeout above all — is false, and is a decision for a
    /// human looking at the machine's real state.
    pub const fn retryable(self) -> bool {
        match self {
            // Refused before anything ran.
            Self::TooManyPending | Self::RateLimited | Self::DeviceOffline => true,
            // Either the frame is wrong, the caller is wrong, or the outcome is
            // unknown. None of those get better by sending it again.
            Self::UnsupportedProtocolVersion
            | Self::MalformedFrame
            | Self::UnknownCommand
            | Self::FrameTooLarge
            | Self::PayloadTooLarge
            | Self::StaleRequest
            | Self::DuplicateRequest
            | Self::NotAuthorized
            | Self::UnknownService
            | Self::ServiceActionFailed
            | Self::UnknownRun
            | Self::UnknownApproval
            | Self::ApprovalExpired
            | Self::Timeout
            | Self::CapabilityUnavailable
            | Self::InternalError => false,
        }
    }

    /// Whether meeting this code should close the device socket.
    ///
    /// A daemon that cannot be trusted to frame correctly is not a daemon whose
    /// next frame should be believed.
    pub const fn fatal_to_session(self) -> bool {
        matches!(
            self,
            Self::UnsupportedProtocolVersion
                | Self::MalformedFrame
                | Self::FrameTooLarge
                | Self::NotAuthorized
        )
    }

    /// The wire spelling. Kept as a method as well as a serde attribute so the
    /// fixture tests can assert the exact string without a round trip.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UnsupportedProtocolVersion => "UNSUPPORTED_PROTOCOL_VERSION",
            Self::MalformedFrame => "MALFORMED_FRAME",
            Self::UnknownCommand => "UNKNOWN_COMMAND",
            Self::FrameTooLarge => "FRAME_TOO_LARGE",
            Self::PayloadTooLarge => "PAYLOAD_TOO_LARGE",
            Self::StaleRequest => "STALE_REQUEST",
            Self::DuplicateRequest => "DUPLICATE_REQUEST",
            Self::TooManyPending => "TOO_MANY_PENDING",
            Self::NotAuthorized => "NOT_AUTHORIZED",
            Self::DeviceOffline => "DEVICE_OFFLINE",
            Self::UnknownService => "UNKNOWN_SERVICE",
            Self::ServiceActionFailed => "SERVICE_ACTION_FAILED",
            Self::UnknownRun => "UNKNOWN_RUN",
            Self::UnknownApproval => "UNKNOWN_APPROVAL",
            Self::ApprovalExpired => "APPROVAL_EXPIRED",
            Self::Timeout => "TIMEOUT",
            Self::RateLimited => "RATE_LIMITED",
            Self::CapabilityUnavailable => "CAPABILITY_UNAVAILABLE",
            Self::InternalError => "INTERNAL_ERROR",
        }
    }

    /// Every code, in wire order. The exhaustiveness tests and the generated
    /// documentation both read this, so a new variant that is not listed here
    /// fails the build's own tests rather than shipping undocumented.
    pub const ALL: &'static [Self] = &[
        Self::UnsupportedProtocolVersion,
        Self::MalformedFrame,
        Self::UnknownCommand,
        Self::FrameTooLarge,
        Self::PayloadTooLarge,
        Self::StaleRequest,
        Self::DuplicateRequest,
        Self::TooManyPending,
        Self::NotAuthorized,
        Self::DeviceOffline,
        Self::UnknownService,
        Self::ServiceActionFailed,
        Self::UnknownRun,
        Self::UnknownApproval,
        Self::ApprovalExpired,
        Self::Timeout,
        Self::RateLimited,
        Self::CapabilityUnavailable,
        Self::InternalError,
    ];
}

/// A refusal on the wire.
///
/// `message` is prose for a human and is never parsed. `detail` carries the one
/// machine-readable hint a caller legitimately needs — which service was
/// unknown, which limit was exceeded — and is deliberately a flat string rather
/// than an open object, so an error can never become a second payload channel
/// carrying local state off the machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtocolError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Repeated from [`ErrorCode::retryable`] so a peer that does not know the
    /// code still knows what to do with it. A peer that *does* know the code
    /// must trust its own table over this field — otherwise a hostile relay
    /// could mark a timeout retryable and drive a double mutation.
    pub retryable: bool,
}

impl ProtocolError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            detail: None,
            retryable: code.retryable(),
        }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_serialises_to_its_documented_spelling() {
        for code in ErrorCode::ALL {
            let json = serde_json::to_string(code).expect("serialise");
            assert_eq!(json, format!("\"{}\"", code.as_str()));
        }
    }

    /// `ALL` is what the tests and the spec iterate. A variant missing from it
    /// would be invisible to both.
    #[test]
    fn all_lists_every_variant_once() {
        let mut seen = std::collections::HashSet::new();
        for code in ErrorCode::ALL {
            assert!(seen.insert(code.as_str()), "duplicated {}", code.as_str());
        }
        // Bump this deliberately alongside the spec document.
        assert_eq!(seen.len(), 19);
    }

    /// An unknown code from a newer peer must degrade, not explode. This is the
    /// difference between an old phone meeting a new relay and an old phone
    /// meeting a brick wall.
    #[test]
    fn an_unknown_code_reads_as_internal_error() {
        let parsed: ErrorCode =
            serde_json::from_str("\"SOMETHING_INVENTED_LATER\"").expect("parse");
        assert_eq!(parsed, ErrorCode::InternalError);
    }

    /// The pessimistic half of the table is the one that matters. If any of
    /// these ever becomes retryable it is a double-mutation bug.
    #[test]
    fn ambiguous_outcomes_are_never_retryable() {
        for code in [
            ErrorCode::Timeout,
            ErrorCode::ServiceActionFailed,
            ErrorCode::DuplicateRequest,
            ErrorCode::InternalError,
        ] {
            assert!(!code.retryable(), "{} must not be retryable", code.as_str());
        }
    }

    #[test]
    fn retryable_is_derived_not_supplied() {
        let error = ProtocolError::new(ErrorCode::Timeout, "took too long");
        assert!(!error.retryable);
        let error = ProtocolError::new(ErrorCode::RateLimited, "slow down");
        assert!(error.retryable);
    }

    #[test]
    fn an_error_rejects_fields_it_does_not_define() {
        let refused = serde_json::from_str::<ProtocolError>(
            r#"{"code":"TIMEOUT","message":"x","retryable":false,"stack":"..."}"#,
        );
        assert!(refused.is_err());
    }
}
