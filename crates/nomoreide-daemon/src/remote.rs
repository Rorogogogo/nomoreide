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
    // A local kill switch, independent of the platform's. A user who wants
    // their machine to stop answering does not have to reach a web page to do
    // it, and an operator debugging a daemon can take the socket out of the
    // picture without unpairing — which would need a second pairing to undo.
    if disabled_by_environment() {
        eprintln!("nomoreide: remote control is disabled by NOMOREIDE_REMOTE_DISABLED");
        return false;
    }
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

/// Whether the environment says not to connect.
///
/// Any value except `0` and `false` counts as set, because the common mistake
/// is `NOMOREIDE_REMOTE_DISABLED=1` meaning "off" and the second-commonest is
/// `=true`. A switch whose safe position is hard to reach is not a switch.
fn disabled_by_environment() -> bool {
    std::env::var("NOMOREIDE_REMOTE_DISABLED")
        .map(|value| {
            !matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "" | "0" | "false"
            )
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    /// The parsing, tested directly rather than through the environment, which
    /// is process-global and would make these tests order-dependent.
    fn disabled(value: &str) -> bool {
        !matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "" | "0" | "false"
        )
    }

    #[test]
    fn the_switch_is_off_for_the_ways_people_write_off() {
        for value in ["0", "false", "FALSE", " false ", ""] {
            assert!(!disabled(value), "{value:?} should not disable");
        }
    }

    #[test]
    fn the_switch_is_on_for_the_ways_people_write_on() {
        for value in ["1", "true", "TRUE", "yes", "on"] {
            assert!(disabled(value), "{value:?} should disable");
        }
    }
}
