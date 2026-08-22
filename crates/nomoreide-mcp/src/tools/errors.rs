//! `nomoreide_list_errors` and `nomoreide_error_prompt`.
//!
//! Both read the *daemon's* inbox. The daemon owns every spawned service, so
//! it is the only process that ever sees a service's log line — an inbox in
//! this adapter would be permanently empty.

use crate::tools::render;
use nomoreide_daemon_client::protocol::Incident;
use nomoreide_daemon_client::DaemonClient;

/// What a caller gets when they ask for no particular number of incidents.
pub(crate) const DEFAULT_INCIDENT_LIMIT: u32 = 50;

pub(crate) async fn list(client: &DaemonClient, limit: u32) -> Result<String, String> {
    let incidents: Vec<Incident> = client
        .list_errors(limit)
        .await
        .map_err(|error| error.to_string())?;
    render(&incidents)
}

/// The prompt itself, as prose rather than as a payload: it is written to be
/// handed to an agent, and wrapping it in JSON would only make it something to
/// unwrap first.
pub(crate) async fn prompt(client: &DaemonClient, id: u64) -> Result<String, String> {
    match client
        .error_prompt(id)
        .await
        .map_err(|error| error.to_string())?
    {
        Some(payload) => Ok(payload.prompt),
        None => Err(format!("Incident {id} not found")),
    }
}
