//! `nomoreide_open_ui` and `nomoreide_close_ui`.
//!
//! Two tools that speak about the daemon rather than through it. Everything
//! else in this crate needs a daemon already running; these are the pair that
//! decides whether there is one.

use crate::tools::render;
use nomoreide_daemon_client::{
    ensure_daemon, stop_daemon, LifecycleError, RuntimePaths, StopOutcome,
};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedUi {
    status: &'static str,
    url: String,
    port: u16,
    pid: u32,
    /// Only present when the daemon and this client disagree about the
    /// version. A caller reading a field that is usually absent is being told
    /// something, which is why it is not reported as null the rest of the time.
    #[serde(skip_serializing_if = "Option::is_none")]
    version_warning: Option<String>,
}

#[derive(Serialize)]
struct ClosedUi {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<&'static str>,
}

pub(crate) async fn open_ui(
    paths: &RuntimePaths,
    port: u16,
    client_version: &str,
) -> Result<String, String> {
    let daemon = ensure_daemon(paths, port, client_version)
        .await
        .map_err(message)?;
    render(&OpenedUi {
        status: daemon.status.as_str(),
        url: daemon.endpoint.as_str().trim_end_matches('/').to_string(),
        port: daemon.endpoint.port(),
        pid: daemon.pid,
        version_warning: daemon.version_warning,
    })
}

pub(crate) async fn close_ui(
    paths: &RuntimePaths,
    port: u16,
    client_version: &str,
) -> Result<String, String> {
    let outcome = stop_daemon(paths, port, client_version)
        .await
        .map_err(message)?;
    render(&match outcome {
        StopOutcome::Stopping => ClosedUi {
            status: "stopping",
            note: Some("Daemon is stopping all managed services and exiting."),
        },
        StopOutcome::NotRunning => ClosedUi {
            status: "not_running",
            note: None,
        },
    })
}

/// A held port and a daemon that never came up are the caller's problem to
/// read; the rest are this client's own failures and read as themselves.
fn message(error: LifecycleError) -> String {
    error.to_string()
}
