//! The provider layer: how NoMoreIDE reaches a deploy platform, and in what
//! shape it reports back.
//!
//! The Rust half of `src/core/providers/`. Two providers live behind it today
//! (Vercel and Cloudflare) and the point of the layer is that adding a third
//! means adding its own module plus one line in `registry.rs` — not editing the
//! daemon's routes, the MCP tools, and the dashboard.
//!
//! The split that matters most here is the one between reading and writing:
//! everything reachable from this module is read-only. Redeploy, cancel,
//! promote, and rollback live in the actions modules, reached only from the
//! dashboard where a human clicked the button.

pub mod api_base;
pub mod deploy;
pub mod egress;
pub mod host;
pub mod project_resolution;
pub mod registry;
