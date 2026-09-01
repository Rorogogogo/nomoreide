//! Version negotiation, capabilities, and what a phone does when the machine at
//! the other end is out of date.
//!
//! This answers the question the original relay plan left open. It matters more
//! than it looks: this project's own development machine ran a v0.1.103 daemon
//! against a v0.3.0 client for days, and the only signal was one warning line.
//! People do not upgrade daemons promptly, so "the versions differ" is the
//! normal case, not the exception, and it needs a designed answer rather than a
//! failure mode.
//!
//! Three rules, and they are deliberately different from each other:
//!
//! 1. **The envelope is invariant.** `v`, `id`, `type`, `deviceId`, `sentAt`,
//!    `replyTo`, `payload` are fixed for the life of the protocol. `v` versions
//!    the *payload union*, not the frame. That is what lets two peers with no
//!    version in common still exchange a hello, a rejection and a heartbeat
//!    instead of staring at each other.
//! 2. **An unknown command is an error.** Fail closed: a name this peer does
//!    not know is refused, never ignored. See [`super::device_bound`].
//! 3. **An unknown capability is an omission.** A feature the other end has not
//!    got is a thing to *say*, not a thing to fail on — the phone renders
//!    "your machine is running an older NoMoreIDE", and the rest of the session
//!    keeps working.
//!
//! Across a major gap the session still opens, in [`SessionMode::Degraded`]:
//! presence and read-only commands route, and every mutating command is refused
//! with [`super::errors::ErrorCode::UnsupportedProtocolVersion`]. Refusing the
//! whole session instead would leave the user a dead screen with no way to be
//! told what to do about it.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// The major version this build speaks.
pub const PROTOCOL_VERSION: u32 = 1;

/// The oldest major version worth talking to at all.
///
/// Below this the platform rejects the socket outright rather than degrading:
/// there is a point where "read-only and please upgrade" stops being reachable
/// because the frames themselves have changed. Equal to [`PROTOCOL_VERSION`]
/// today, and it stays there until a v2 exists to be lenient towards.
pub const MINIMUM_SPEAKABLE_VERSION: u32 = 1;

/// Every major version this build can serve, newest last.
pub const SUPPORTED_VERSIONS: &[u32] = &[1];

/// A floor above what this build speaks would reject every peer, including
/// itself. Checked at compile time, for the same reason the limits are.
const _: () = assert!(MINIMUM_SPEAKABLE_VERSION <= PROTOCOL_VERSION);

/// A named, additively-shipped feature.
///
/// Capabilities exist so that adding a remote feature does not need a version
/// bump — which in a world of stale daemons would mean every new feature
/// degrading every old machine. The daemon advertises what it has; the platform
/// asks for nothing it was not offered.
///
/// The name is the wire value. It is a plain string type rather than an enum
/// because the *reading* side must tolerate names invented after it was built:
/// an unrecognised capability is one this peer will simply never use.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Capability(pub String);

impl Capability {
    pub fn new(name: &str) -> Self {
        Self(name.to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The capabilities a v1 daemon advertises. One per allowlisted area, not one
/// per command — a phone needs to know whether agent turns are available, not
/// whether `agent.turn.cancel` specifically is.
pub mod capabilities {
    /// Sanitized device snapshot and presence. Always present; a daemon that
    /// cannot do this has nothing to offer.
    pub const DEVICE_SNAPSHOT: &str = "device.snapshot";
    /// Listing registered services with their runtime state.
    pub const SERVICE_LIST: &str = "service.list";
    /// `start`, `stop`, `restart` on an exact registered service.
    pub const SERVICE_ACTION: &str = "service.action";
    /// Bounded, redacted recent logs.
    pub const SERVICE_LOGS: &str = "service.logs";
    /// Listing registered bundles with their state. Read-only: the allowlist
    /// has no bundle mutation.
    pub const BUNDLE_LIST: &str = "bundle.list";
    /// Reporting which agent providers are installed.
    pub const AGENT_PROVIDERS: &str = "agent.providers";
    /// Starting, resuming and cancelling one agent turn.
    pub const AGENT_TURNS: &str = "agent.turns";
    /// Answering a pending mutating tool request.
    pub const AGENT_APPROVALS: &str = "agent.approvals";

    /// Everything a fully-featured v1 daemon offers.
    pub const V1: &[&str] = &[
        DEVICE_SNAPSHOT,
        SERVICE_LIST,
        SERVICE_ACTION,
        SERVICE_LOGS,
        BUNDLE_LIST,
        AGENT_PROVIDERS,
        AGENT_TURNS,
        AGENT_APPROVALS,
    ];
}

/// What a daemon advertises, and what the platform holds about it.
///
/// A `BTreeSet` rather than a `Vec` so two daemons advertising the same
/// capabilities in different orders compare equal, and so the JSON is stable
/// enough to be a golden fixture.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CapabilitySet(pub BTreeSet<Capability>);

impl CapabilitySet {
    /// Everything this build offers.
    pub fn current() -> Self {
        Self(
            capabilities::V1
                .iter()
                .map(|name| Capability::new(name))
                .collect(),
        )
    }

    pub fn contains(&self, name: &str) -> bool {
        self.0.iter().any(|capability| capability.as_str() == name)
    }

    pub fn from_names<'a>(names: impl IntoIterator<Item = &'a str>) -> Self {
        Self(names.into_iter().map(Capability::new).collect())
    }
}

/// How much of the protocol a negotiated session may use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionMode {
    /// Both ends agreed on a version this build serves. Everything the
    /// capability set allows is routable.
    Full,
    /// No shared version. Presence and read-only commands only; every mutation
    /// is refused, and the phone is told to update the machine.
    Degraded,
}

/// The outcome of comparing two peers' supported versions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Negotiation {
    /// Agreed. `version` is the highest both sides can speak.
    Agreed { version: u32, mode: SessionMode },
    /// The peer is too old to talk to at all — its highest version is below
    /// [`MINIMUM_SPEAKABLE_VERSION`], or it offered none.
    Rejected { reason: RejectReason },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RejectReason {
    /// The peer advertised no versions at all.
    NoVersionsOffered,
    /// Every version the peer offered is below the floor.
    BelowMinimumVersion,
}

/// Decide what a session between `ours` and `theirs` may do.
///
/// The rule is: take the highest version both sides list. If there is none, and
/// the peer is at or above the floor, run degraded at the peer's own highest —
/// that is the version whose frames it will actually understand, so it is the
/// one to speak while telling it to upgrade.
pub fn negotiate(ours: &[u32], theirs: &[u32]) -> Negotiation {
    let Some(their_best) = theirs.iter().copied().max() else {
        return Negotiation::Rejected {
            reason: RejectReason::NoVersionsOffered,
        };
    };
    if their_best < MINIMUM_SPEAKABLE_VERSION {
        return Negotiation::Rejected {
            reason: RejectReason::BelowMinimumVersion,
        };
    }
    let shared = ours
        .iter()
        .copied()
        .filter(|version| theirs.contains(version))
        .max();
    match shared {
        Some(version) => Negotiation::Agreed {
            version,
            mode: SessionMode::Full,
        },
        None => Negotiation::Agreed {
            version: their_best,
            mode: SessionMode::Degraded,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_peers_agree_on_full() {
        assert_eq!(
            negotiate(SUPPORTED_VERSIONS, SUPPORTED_VERSIONS),
            Negotiation::Agreed {
                version: 1,
                mode: SessionMode::Full,
            }
        );
    }

    /// A newer platform meeting an older daemon takes the highest they share,
    /// which is the whole point of listing versions rather than sending one.
    #[test]
    fn overlapping_peers_take_the_highest_shared_version() {
        assert_eq!(
            negotiate(&[1, 2, 3], &[1, 2]),
            Negotiation::Agreed {
                version: 2,
                mode: SessionMode::Full,
            }
        );
    }

    /// The case the revision asked to design for: no overlap, but the daemon is
    /// still above the floor. The session opens read-only rather than dying, so
    /// the phone can say why.
    #[test]
    fn a_major_gap_degrades_rather_than_refusing() {
        assert_eq!(
            negotiate(&[4, 5], &[1]),
            Negotiation::Agreed {
                version: 1,
                mode: SessionMode::Degraded,
            }
        );
    }

    #[test]
    fn a_peer_below_the_floor_is_refused_outright() {
        assert_eq!(
            negotiate(&[1], &[0]),
            Negotiation::Rejected {
                reason: RejectReason::BelowMinimumVersion,
            }
        );
    }

    #[test]
    fn a_peer_offering_nothing_is_refused() {
        assert_eq!(
            negotiate(&[1], &[]),
            Negotiation::Rejected {
                reason: RejectReason::NoVersionsOffered,
            }
        );
    }

    #[test]
    fn the_current_capability_set_covers_every_v1_area() {
        let current = CapabilitySet::current();
        for name in capabilities::V1 {
            assert!(current.contains(name), "missing {name}");
        }
    }

    /// A capability nobody has heard of must read cleanly. It is a feature this
    /// peer will not use, not a frame it cannot parse.
    #[test]
    fn an_unknown_capability_parses_and_is_simply_absent() {
        let set: CapabilitySet =
            serde_json::from_str(r#"["service.list","something.invented.later"]"#).expect("parse");
        assert!(set.contains("service.list"));
        assert!(set.contains("something.invented.later"));
        assert!(!set.contains(capabilities::AGENT_TURNS));
    }

    #[test]
    fn the_version_we_speak_is_one_we_support() {
        assert!(SUPPORTED_VERSIONS.contains(&PROTOCOL_VERSION));
    }
}
