//! MCP protocol and tool-adapter boundary.

mod contract;
mod protocol;
mod stdio;
mod tools;

pub use stdio::{run_stdio, serve};
