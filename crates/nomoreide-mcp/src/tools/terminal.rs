//! `nomoreide_list_terminal_sessions`, `nomoreide_open_terminal`, and
//! `nomoreide_reclaim_terminal`.
//!
//! All three read or move sessions the *daemon* owns. A terminal is a live PTY
//! with a process attached, so it cannot exist in this short-lived adapter — the
//! adapter asks the process that is holding it.

use crate::tools::render;
use nomoreide_daemon_client::DaemonClient;

pub(crate) async fn list(client: &DaemonClient) -> Result<String, String> {
    let sessions = client
        .list_terminal_sessions()
        .await
        .map_err(|error| error.to_string())?;
    render(&sessions)
}

pub(crate) async fn open(client: &DaemonClient, id: &str) -> Result<String, String> {
    let session = client.open_terminal(id).await.map_err(terminal_message)?;
    render(&session)
}

pub(crate) async fn reclaim(client: &DaemonClient, id: &str) -> Result<String, String> {
    let session = client
        .reclaim_terminal(id)
        .await
        .map_err(terminal_message)?;
    render(&session)
}

/// A refusal from the manager is the answer, not a transport failure: "Unknown
/// terminal session: x" and "Only agent sessions can open in Terminal." are
/// both things the caller needs to read verbatim, so the daemon's own wording
/// is what comes back rather than a status line wrapped around it.
fn terminal_message(error: nomoreide_daemon_client::DaemonClientError) -> String {
    match error {
        nomoreide_daemon_client::DaemonClientError::Http { message, .. } => message,
        other => other.to_string(),
    }
}
