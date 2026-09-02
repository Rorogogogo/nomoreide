//! The frozen v1 wire protocol between a local NoMoreIDE daemon and the hosted
//! remote-control relay.
//!
//! Nothing here talks to a socket, a service or an agent. It is the shape of
//! what may be said and the rules for refusing everything else.
//!
//! **Why this is its own package.** Two independently deployed programs speak
//! this protocol — the daemon on a developer's machine and the platform's API
//! container, which live in different repositories and different Cargo
//! workspaces. Writing it twice would make it two implementations of one
//! meaning, which is the mistake the desktop app already made and is still
//! paying 150 duplicated commands for. So it is one implementation, in a
//! package light enough for both: `serde`, `serde_json`, `chrono`, and nothing
//! else. The daemon reaches it through `nomoreide_core::remote::protocol`.
//!
//! The daemon always dials **out** over TLS. Nothing in this protocol opens a
//! port, asks for a port forward, or accepts an inbound connection — a machine
//! running NoMoreIDE is not reachable from the internet because of this
//! feature, and that is the property the whole design is arranged around.
//!
//! Where to look:
//!
//! - [`envelope`] — the invariant frame, and the order a frame is checked in.
//! - [`device_bound`] — every command the platform may send. This union *is*
//!   the remote attack surface.
//! - [`platform_bound`] — every event a daemon may send.
//! - [`snapshot`] and [`agent_event`] — the sanitized shapes those carry.
//! - [`limits`] — every number either side is allowed to assume.
//! - [`errors`] — the refusal codes, and which of them may ever be retried.
//! - [`version`] — negotiation, capabilities, and what a phone does against a
//!   machine that has not been updated.
//! - [`idempotency`] — why a mutation is never automatically re-sent.
//! - [`fixtures`] — one sample of every frame, and the golden files an
//!   independent implementation checks itself against.
//!
//! Three properties hold across all of it, and each has a test that fails if it
//! stops holding:
//!
//! 1. **Unknown is refused, not ignored.** A `type` outside the union is
//!    [`errors::ErrorCode::UnknownCommand`] in either direction, whatever its
//!    payload looks like.
//! 2. **No frame can carry what the allowlist excludes.** There is no variant
//!    for a shell command, a path, an environment, a terminal, a database
//!    query, a git mutation or a process id — so no payload can smuggle one.
//! 3. **Ambiguity never retries.** A mutation whose outcome is unknown is a
//!    question for a human, not a frame to send again.
//!
//! The contract in prose, including the threat model, is
//! `docs/remote-protocol-v1.md` in the repository.

pub mod agent_event;
pub mod device_bound;
pub mod envelope;
pub mod errors;
pub mod fixtures;
pub mod idempotency;
pub mod limits;
pub mod platform_bound;
pub mod snapshot;
pub mod terminal_bytes;
pub mod version;

pub use device_bound::DeviceBound;
pub use envelope::Envelope;
pub use errors::{ErrorCode, ProtocolError};
pub use platform_bound::PlatformBound;
pub use terminal_bytes::TerminalBytes;
pub use version::{Capability, CapabilitySet, SessionMode, PROTOCOL_VERSION};

#[cfg(test)]
mod tests;
