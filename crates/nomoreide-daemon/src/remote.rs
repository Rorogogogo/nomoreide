//! Attaching this daemon to the relay, if the machine has been paired.
//!
//! The connector lives in `nomoreide-core`; what lives here is the decision to
//! start one, and what it does with a command when it arrives.
//!
//! **Only the machine-global daemon connects.** The desktop app runs its own
//! daemon in-process on a private port, and if both dialled in with the same
//! credential the relay would keep whichever connected last — so a phone would
//! be talking to whichever of the user's two daemons had most recently
//! restarted, which is nobody's idea of a machine. The one that owns the
//! runtime lock is the one that speaks for the machine.

pub(crate) mod dispatcher;

use std::sync::Arc;

use nomoreide_core::remote::connector::{CommandSink, ConnectorConfig};
use nomoreide_core::remote::credentials::RemoteCredentials;

/// Start the relay connection, if this machine is paired.
///
/// Returns `false` when there is nothing to do — not paired, which is the
/// normal state for most installs and not worth a log line on every start.
pub(crate) fn spawn_if_paired(
    state_dir: &std::path::Path,
    router: axum::Router,
    credential: String,
) -> bool {
    let credentials = RemoteCredentials::new(state_dir);
    let Some(stored) = credentials.load() else {
        return false;
    };

    let mut config = ConnectorConfig::from_credential(&stored);
    config.capabilities = dispatcher::served_capabilities();
    let device_name = stored.device_name.clone();
    let sink: Arc<dyn CommandSink> = Arc::new(dispatcher::RouterDispatcher::new(
        router,
        credential,
        stored.device_id,
        stored.device_name,
    ));

    eprintln!("nomoreide: remote control connecting as \"{device_name}\"");
    tokio::spawn(nomoreide_core::remote::connector::run_forever(config, sink));
    true
}
