//! Remote control: driving this machine's registered services and agents from a
//! phone, through the hosted relay.
//!
//! The wire format itself is [`nomoreide_remote_protocol`], a separate package
//! — because the hosted platform speaks the same protocol from a different
//! repository, and a protocol written twice is two implementations of one
//! meaning. It is re-exported here as [`protocol`] so callers in this workspace
//! read `remote::protocol::…` whichever side of the split a type lives on.
//!
//! The protocol, the local credential, the pairing client and the outbound
//! connector exist so far. The rest of the plan —
//! `docs/plans/2026-08-20-remote-control-relay-after-rust.md` — adds the
//! dispatcher. The wire format came first
//! because both repositories depend on it and neither could be tested against
//! the other until it was frozen.
//!
//! The one design decision worth carrying forward into those modules: the
//! dispatcher routes through the daemon's **own router**, in-process, against
//! an explicit allowlist. It does not call core APIs directly. The desktop app
//! took the other road and paid 150 duplicated commands for it, one of which
//! silently became a stub — the relay would be the fifth such surface.

pub mod agent_runs;
pub mod connector;
pub mod credentials;
pub mod pairing;
pub mod redaction;

pub use nomoreide_remote_protocol as protocol;
