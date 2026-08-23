//! `nomoreide_agents_status`, `nomoreide_agents_read_configs`, and
//! `nomoreide_agents_doctor`.
//!
//! All three read the machine the adapter is running on — PATH, the user's
//! home, the project directory asked about — so none of them needs the daemon.
//! Asking it would only put the answer one hop further from what the caller
//! actually wants to know.

use crate::tools::render;
use nomoreide_core::agent_env;
use std::path::Path;

pub(crate) fn status() -> Result<String, String> {
    render(&agent_env::status())
}

pub(crate) fn read_configs(cwd: Option<&str>) -> Result<String, String> {
    render(&agent_env::read_configs(cwd.map(Path::new)))
}

pub(crate) fn doctor(cwd: Option<&str>) -> Result<String, String> {
    render(&agent_env::doctor(cwd.map(Path::new)))
}
