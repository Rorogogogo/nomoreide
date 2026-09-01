//! The frozen limits. Every number a v1 peer is allowed to assume about the
//! other side lives here, and nowhere else.
//!
//! They are constants rather than configuration on purpose. A limit either side
//! can tune is not a limit — it is a negotiation, and the frame that arrives
//! while the two ends disagree is the one that gets through. Changing any of
//! these is a protocol change: it needs a new major version, because a phone
//! built against the old number will send a frame the daemon now refuses.
//!
//! The byte counts are all measured over **UTF-8 bytes**, not characters. A
//! limit counted in `char`s is a limit an attacker picks the units of.

use std::time::Duration;

/// The largest frame either side will read off the socket.
///
/// Read *before* parsing: a 4 MiB frame that would have failed validation still
/// costs the memory to parse it, so the size check is the first thing that
/// happens and the socket closes rather than answering.
pub const MAX_FRAME_BYTES: usize = 256 * 1024;

/// The largest prompt one agent turn may carry.
///
/// Small relative to the frame budget because a prompt is the one field a
/// remote caller fully controls, and the daemon forwards it to a process.
pub const MAX_AGENT_PROMPT_BYTES: usize = 16 * 1024;

/// Where a single log line is cut. A service that writes a megabyte without a
/// newline must not be able to fill the frame budget by itself.
pub const MAX_LOG_LINE_BYTES: usize = 8 * 1024;

/// The most log lines one response may carry, whatever was asked for.
pub const MAX_LOG_LINES: usize = 200;

/// The ceiling on a whole log response, applied after per-line truncation —
/// 200 lines of 8 KiB would otherwise be 1.6 MiB.
pub const MAX_LOG_RESPONSE_BYTES: usize = 256 * 1024;

/// How many requests one device may have in flight.
///
/// The bound is per device rather than per user: it is the daemon's memory that
/// a flood consumes, and a user with two machines should not be able to starve
/// one by hammering the other.
pub const MAX_PENDING_COMMANDS: usize = 32;

/// How long a service action may take before the relay stops waiting.
///
/// A timeout is *not* a failure of the action — the daemon may well finish it.
/// That is why a timed-out mutation is never retried automatically; see
/// [`super::idempotency`].
pub const SERVICE_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

/// How often a connected daemon announces it is still there.
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(25);

/// How long the platform waits before calling a device offline.
///
/// Three heartbeat intervals, so a single dropped frame on a slow phone network
/// does not flap the device between states. Reaching it suspends command
/// routing rather than queueing — presence fails closed.
pub const PRESENCE_TIMEOUT: Duration = Duration::from_secs(75);

/// The ceiling on the daemon's reconnect backoff. Jittered by the connector, so
/// a platform restart does not bring every daemon back in the same second.
pub const RECONNECT_BACKOFF_CAP: Duration = Duration::from_secs(30);

/// How far in the past a frame's `sentAt` may be before it is refused.
///
/// The point is not clock accuracy, it is intent: a command that spent two
/// minutes in a queue is one whose sender has already given up and whose user
/// has moved on. Executing it then is a surprise, and for a mutation it is a
/// dangerous one.
pub const MAX_REQUEST_AGE: Duration = Duration::from_secs(60);

/// How far *ahead* of the receiver a frame's `sentAt` may be.
///
/// Phones have wrong clocks. Refusing everything from a device three minutes
/// fast would make it permanently unusable, so the window is generous in this
/// direction and the staleness rule above is what carries the security weight.
pub const MAX_CLOCK_SKEW_AHEAD: Duration = Duration::from_secs(300);

/// How long a request id is remembered for duplicate detection.
///
/// Longer than [`MAX_REQUEST_AGE`] so that the two rules cannot disagree: a
/// frame young enough to execute is always young enough to have been seen.
pub const REQUEST_ID_DEDUP_WINDOW: Duration = Duration::from_secs(600);

/// How long a remote approval waits for a human before it denies itself.
pub const APPROVAL_EXPIRY: Duration = Duration::from_secs(120);

/// How far back a reconnecting client may resume an agent run's events.
pub const AGENT_EVENT_REPLAY_WINDOW: Duration = Duration::from_secs(300);

/// A prompt that could fill a frame on its own would leave no room for the
/// envelope around it. Checked at compile time rather than in a test, because
/// it is a relationship between two constants and nothing should be able to
/// build with it broken.
const _: () = assert!(MAX_AGENT_PROMPT_BYTES * 2 < MAX_FRAME_BYTES);

/// The most events one run keeps for replay. A run that emits faster than the
/// window can hold drops the oldest; a client that asks for a sequence older
/// than the buffer is told to restart from the snapshot rather than handed a
/// gap it cannot see.
pub const AGENT_EVENT_REPLAY_EVENTS: usize = 2048;

#[cfg(test)]
mod tests {
    use super::*;

    /// The numbers are frozen. This test exists to make changing one a
    /// deliberate act with a protocol-version conversation attached, rather
    /// than a one-character diff nobody reviews.
    #[test]
    fn v1_limits_are_frozen() {
        assert_eq!(MAX_FRAME_BYTES, 262_144);
        assert_eq!(MAX_AGENT_PROMPT_BYTES, 16_384);
        assert_eq!(MAX_LOG_LINE_BYTES, 8_192);
        assert_eq!(MAX_LOG_LINES, 200);
        assert_eq!(MAX_LOG_RESPONSE_BYTES, 262_144);
        assert_eq!(MAX_PENDING_COMMANDS, 32);
        assert_eq!(SERVICE_COMMAND_TIMEOUT.as_secs(), 30);
        assert_eq!(HEARTBEAT_INTERVAL.as_secs(), 25);
        assert_eq!(PRESENCE_TIMEOUT.as_secs(), 75);
        assert_eq!(RECONNECT_BACKOFF_CAP.as_secs(), 30);
        assert_eq!(APPROVAL_EXPIRY.as_secs(), 120);
    }

    /// A dedup window shorter than the staleness window would let a frame be
    /// young enough to execute but old enough to have been forgotten — which is
    /// exactly the replay the request id is there to stop.
    #[test]
    fn dedup_window_outlasts_request_staleness() {
        assert!(REQUEST_ID_DEDUP_WINDOW > MAX_REQUEST_AGE);
    }

    /// Offline has to mean "missed several", not "missed one".
    #[test]
    fn presence_timeout_tolerates_lost_heartbeats() {
        assert!(PRESENCE_TIMEOUT >= HEARTBEAT_INTERVAL * 3);
    }
}
