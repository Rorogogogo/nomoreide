//! Starting the relay connection, and saying whether it is up.
//!
//! **Why this exists.** The connector used to be started once, during daemon
//! startup, from whatever credential was on disk at that moment. A machine
//! paired *after* its daemon started therefore sat there doing nothing, with
//! `nomoreide remote status` reporting a perfectly healthy pairing and the
//! phone showing it offline — and nothing on either screen explaining that a
//! restart was the missing step. That is the first thing every new user meets,
//! and it was met by silence.
//!
//! So the supervisor can be started at any time: at boot, if a credential is
//! already there, and on request from `nomoreide remote pair` the moment one is
//! written. Starting twice **as the same device** is a no-op rather than a
//! second socket, because the relay keeps only the newest connection and a
//! duplicate would silently evict its own predecessor.
//!
//! **Starting as a different device is not a no-op**, and treating it as one
//! was a bug worth describing. `started` was a one-way latch: once a connector
//! existed, every later call answered `AlreadyRunning` without looking at what
//! was on disk. Unpair and pair again and the credential changed underneath a
//! connector that kept the old one — so the machine stayed connected as the
//! device it used to be, the device it had just become never dialled at all,
//! and the phone showed the new machine offline while the daemon insisted the
//! relay was up. A scan then waited forever for a machine that was never
//! coming. The latch is now a comparison against the credential on disk, and
//! the old connector is stopped before a new one takes its place.
//!
//! The router arrives after the state does — the dispatcher calls the daemon's
//! own routes, and those routes need this handle — so it is attached once the
//! router exists rather than passed in at construction.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use nomoreide_core::remote::connector::{CommandSink, ConnectorConfig, RelaySnapshot, RelayStatus};
use nomoreide_core::remote::credentials::RemoteCredentials;

/// What a request to connect did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StartOutcome {
    /// A connector was spawned.
    Started,
    /// One was already running. Not an error — pairing twice, or a retried
    /// request, should be quiet.
    AlreadyRunning,
    /// No credential on disk. The caller has not paired.
    NotPaired,
    /// Remote control is switched off on this machine.
    Disabled,
}

/// One live relay connection, and the device it belongs to.
struct Connection {
    /// The device this socket authenticated as. Compared against the
    /// credential on disk to decide whether a connection is still the right
    /// one, which a boolean could not do.
    device_id: String,
    status: RelayStatus,
    task: tokio::task::AbortHandle,
}

/// Owns the relay connection for this daemon.
#[derive(Clone)]
pub(crate) struct RelaySupervisor {
    state_dir: PathBuf,
    credential: String,
    terminal: nomoreide_core::terminal::TerminalManager,
    router: Arc<OnceLock<axum::Router>>,
    /// The connection that is up, and which device it belongs to.
    ///
    /// Held together because they are one fact: a live connector is always a
    /// connector for some particular credential, and the bug this replaced came
    /// from tracking "is something running" without tracking "as whom".
    running: Arc<Mutex<Option<Connection>>>,
    /// A way onto the live socket for the one frame that is not an answer:
    /// this machine retiring itself. See [`Self::retire`].
    outbound: nomoreide_core::remote::connector::RelayOutbound,
}

impl RelaySupervisor {
    pub(crate) fn new(
        state_dir: PathBuf,
        credential: String,
        terminal: nomoreide_core::terminal::TerminalManager,
    ) -> Self {
        Self {
            state_dir,
            credential,
            terminal,
            router: Arc::new(OnceLock::new()),
            running: Arc::new(Mutex::new(None)),
            outbound: nomoreide_core::remote::connector::RelayOutbound::new(),
        }
    }

    /// Hand over the router once it exists. Called once, from startup.
    pub(crate) fn attach_router(&self, router: axum::Router) {
        let _ = self.router.set(router);
    }

    /// Connect as whoever the credential on disk says this machine is.
    ///
    /// Idempotent for the *same* device and a restart for a different one. The
    /// comparison is against the credential rather than a flag, because the
    /// credential is the thing that changes when somebody pairs again and a
    /// flag cannot tell the two cases apart.
    pub(crate) fn ensure_started(&self) -> StartOutcome {
        if super::disabled_by_environment() {
            return StartOutcome::Disabled;
        }
        let credentials = RemoteCredentials::new(&self.state_dir);
        let Some(stored) = credentials.load() else {
            return StartOutcome::NotPaired;
        };
        let Some(router) = self.router.get() else {
            // Only reachable before startup finishes attaching the router, and
            // startup calls this again afterwards.
            return StartOutcome::NotPaired;
        };

        // One lock across the check and the spawn, so two requests racing
        // cannot both start a connector — the reason the old code used an
        // atomic swap, kept for the same reason.
        let mut running = match self.running.lock() {
            Ok(running) => running,
            // A poisoned lock means a previous holder panicked. Reporting the
            // connection as already up would be a lie in the one state where
            // nobody can see what is true.
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(connection) = running.as_ref() {
            if connection.device_id == stored.device_id {
                return StartOutcome::AlreadyRunning;
            }
            // A different machine now. The old socket is still authenticated as
            // the device this one replaced, and leaving it up means the
            // platform holds a connection for a device nobody is looking at
            // while the one they are looking at never arrives.
            connection.task.abort();
            self.outbound.disarm_now();
        }

        let mut config = ConnectorConfig::from_credential(&stored);
        config.capabilities = super::dispatcher::served_capabilities();
        let status = RelayStatus::new(&config, &stored.device_name);

        let device_id = stored.device_id.clone();
        let sink: Arc<dyn CommandSink> = Arc::new(super::dispatcher::RouterDispatcher::new(
            router.clone(),
            self.credential.clone(),
            stored.device_id,
            stored.device_name.clone(),
            self.terminal.clone(),
        ));
        let task = tokio::spawn(nomoreide_core::remote::connector::run_forever(
            config,
            sink,
            status.clone(),
            self.outbound.clone(),
        ));
        *running = Some(Connection {
            device_id,
            status,
            task: task.abort_handle(),
        });
        StartOutcome::Started
    }

    /// Put the relay down, because this machine is no longer that device.
    ///
    /// Called when unpairing. Without it the connector keeps a socket open on a
    /// credential that has just been deleted locally — which the platform is
    /// entitled to keep honouring until it is revoked, so the machine would go
    /// on answering commands for a pairing its owner believes they have ended.
    pub(crate) fn stop(&self) {
        let mut running = match self.running.lock() {
            Ok(running) => running,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(connection) = running.take() {
            connection.task.abort();
        }
        self.outbound.disarm_now();
    }

    /// What the connection is doing, or `None` when nothing has been started.
    pub(crate) fn snapshot(&self) -> Option<RelaySnapshot> {
        let running = match self.running.lock() {
            Ok(running) => running,
            Err(poisoned) => poisoned.into_inner(),
        };
        running
            .as_ref()
            .map(|connection| connection.status.snapshot())
    }

    /// Tell the platform this machine is unpairing, if there is a socket to
    /// tell it on.
    ///
    /// Returns whether the frame was queued, which is **not** whether the
    /// device was retired: the platform decides that, and this end never learns
    /// the outcome. Unpairing does not wait for it and does not fail without
    /// it, because the thing a person pressed Unpair for — this machine losing
    /// its credential — is local and must happen whether the platform is
    /// reachable, older than this frame, or gone.
    pub(crate) fn retire(&self) -> bool {
        use nomoreide_core::remote::protocol::platform_bound::{
            DeviceRetire, PlatformBound, RetireReason,
        };
        self.outbound
            .try_send(PlatformBound::DeviceRetire(DeviceRetire {
                reason: RetireReason::Unpaired,
            }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nomoreide-supervisor-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("scratch");
        dir
    }

    #[test]
    fn an_unpaired_machine_does_not_connect() {
        let supervisor = RelaySupervisor::new(
            scratch("unpaired"),
            "cred".into(),
            nomoreide_core::terminal::TerminalManager::new(),
        );
        supervisor.attach_router(axum::Router::new());

        assert_eq!(supervisor.ensure_started(), StartOutcome::NotPaired);
        assert_eq!(supervisor.snapshot(), None);
    }

    /// Before the router is attached there is nothing to dispatch through, so
    /// starting is deferred rather than half-done.
    #[test]
    fn nothing_starts_before_the_router_exists() {
        let dir = scratch("no-router");
        write_credential(&dir);
        let supervisor = RelaySupervisor::new(
            dir,
            "cred".into(),
            nomoreide_core::terminal::TerminalManager::new(),
        );

        assert_eq!(supervisor.ensure_started(), StartOutcome::NotPaired);
    }

    /// The property that makes it safe for `remote pair` to call this without
    /// knowing whether startup already did: a second call is quiet, and does
    /// not open a second socket that would evict the first.
    #[tokio::test]
    async fn starting_twice_starts_once() {
        let dir = scratch("twice");
        write_credential(&dir);
        let supervisor = RelaySupervisor::new(
            dir,
            "cred".into(),
            nomoreide_core::terminal::TerminalManager::new(),
        );
        supervisor.attach_router(axum::Router::new());

        assert_eq!(supervisor.ensure_started(), StartOutcome::Started);
        assert_eq!(supervisor.ensure_started(), StartOutcome::AlreadyRunning);
        assert_eq!(supervisor.ensure_started(), StartOutcome::AlreadyRunning);
    }

    /// Paired and started is still not connected. Conflating the two is the
    /// bug this module exists to fix.
    #[tokio::test]
    async fn a_started_connector_reports_itself_before_it_is_connected() {
        let dir = scratch("status");
        write_credential(&dir);
        let supervisor = RelaySupervisor::new(
            dir,
            "cred".into(),
            nomoreide_core::terminal::TerminalManager::new(),
        );
        supervisor.attach_router(axum::Router::new());
        supervisor.ensure_started();

        let snapshot = supervisor.snapshot().expect("a status once started");
        assert_eq!(snapshot.device_name, "Test Machine");
        // It has had no chance to reach anything; saying "connected" here would
        // be the same lie the old code told.
        assert!(!snapshot.connected);
    }

    /// The bug this module's comment describes, as a test.
    ///
    /// Unpair and pair again and the credential names a different device. The
    /// old code answered `AlreadyRunning` and kept the socket it had, so the
    /// machine stayed connected as the device it used to be and the one it had
    /// just become never dialled — which reads, on the phone, as a machine that
    /// paired successfully and is permanently offline.
    #[tokio::test]
    async fn pairing_again_reconnects_as_the_new_device() {
        let dir = scratch("repair");
        write_credential(&dir);
        let supervisor = RelaySupervisor::new(
            dir.clone(),
            "cred".into(),
            nomoreide_core::terminal::TerminalManager::new(),
        );
        supervisor.attach_router(axum::Router::new());
        assert_eq!(supervisor.ensure_started(), StartOutcome::Started);
        assert_eq!(
            supervisor.snapshot().expect("a status").device_name,
            "Test Machine"
        );

        write_credential_named(&dir, "99999999-8888-7777-6666-555555555555", "Mac");

        assert_eq!(
            supervisor.ensure_started(),
            StartOutcome::Started,
            "a different device on disk must start a connector, not report the old one"
        );
        assert_eq!(
            supervisor.snapshot().expect("a status").device_name,
            "Mac",
            "the reported machine must be the one that is actually connecting"
        );
    }

    /// Unpairing takes the socket down. Leaving it up would keep answering
    /// commands on a credential the platform has not revoked yet.
    #[tokio::test]
    async fn unpairing_stops_the_connection() {
        let dir = scratch("stop");
        write_credential(&dir);
        let supervisor = RelaySupervisor::new(
            dir,
            "cred".into(),
            nomoreide_core::terminal::TerminalManager::new(),
        );
        supervisor.attach_router(axum::Router::new());
        supervisor.ensure_started();

        supervisor.stop();

        assert_eq!(supervisor.snapshot(), None);
        assert!(
            !supervisor.retire(),
            "a stopped connection has nowhere to send"
        );
    }

    fn write_credential(dir: &std::path::Path) {
        write_credential_named(dir, "11111111-2222-3333-4444-555555555555", "Test Machine");
    }

    fn write_credential_named(dir: &std::path::Path, device_id: &str, device_name: &str) {
        RemoteCredentials::new(dir)
            .store(&nomoreide_core::remote::credentials::StoredCredential {
                device_id: device_id.into(),
                device_name: device_name.into(),
                credential: "c".repeat(64),
                // Unreachable on purpose: these tests are about the supervisor's
                // bookkeeping, not about dialling anything.
                platform_base_url: "http://127.0.0.1:1".into(),
                web_base_url: String::new(),
                paired_at: "2026-09-02T00:00:00Z".into(),
            })
            .expect("store");
    }
}
