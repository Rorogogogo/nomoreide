//! Remote control: driving this machine's registered services and agents from a
//! phone, through the hosted relay.
//!
//! The daemon always dials **out** over TLS. Nothing here opens a port, asks
//! for a port forward, or accepts an inbound connection — a machine running
//! NoMoreIDE is not reachable from the internet because of this feature, and
//! that is the property the whole design is arranged around.
//!
//! Only the protocol exists so far. The rest of the plan —
//! `docs/plans/2026-08-20-remote-control-relay-after-rust.md` — adds
//! credentials, pairing, the outbound connector and the dispatcher, in that
//! order. The wire format comes first because both repositories depend on it
//! and neither can be tested against the other until it is frozen.
//!
//! The one design decision worth carrying forward into those modules: the
//! dispatcher routes through the daemon's **own router**, in-process, against
//! an explicit allowlist. It does not call core APIs directly. The desktop app
//! took the other road and paid 150 duplicated commands for it, one of which
//! silently became a stub — the relay would be the fifth such surface.

pub mod protocol;
