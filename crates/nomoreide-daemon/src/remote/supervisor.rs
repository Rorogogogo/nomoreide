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
//! written. Starting twice is a no-op rather than a second socket, because the
//! relay keeps only the newest connection and a duplicate would silently evict
//! its own predecessor.
//!
//! The router arrives after the state does — the dispatcher calls the daemon's
//! own routes, and those routes need this handle — so it is attached once the
//! router exists rather than passed in at construction.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

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

/// Owns the relay connection for this daemon.
#[derive(Clone)]
pub(crate) struct RelaySupervisor {
    state_dir: PathBuf,
    credential: String,
    terminal: nomoreide_core::terminal::TerminalManager,
    router: Arc<OnceLock<axum::Router>>,
    started: Arc<AtomicBool>,
    status: Arc<OnceLock<RelayStatus>>,
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
            started: Arc::new(AtomicBool::new(false)),
            status: Arc::new(OnceLock::new()),
        }
    }

    /// Hand over the router once it exists. Called once, from startup.
    pub(crate) fn attach_router(&self, router: axum::Router) {
        let _ = self.router.set(router);
    }

    /// Connect, unless already connected or unable to.
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
        // The gate. `swap` rather than load-then-store, so two requests racing
        // cannot both spawn.
        if self.started.swap(true, Ordering::SeqCst) {
            return StartOutcome::AlreadyRunning;
        }

        let mut config = ConnectorConfig::from_credential(&stored);
        config.capabilities = super::dispatcher::served_capabilities();
        let status = RelayStatus::new(&config, &stored.device_name);
        let _ = self.status.set(status.clone());

        let sink: Arc<dyn CommandSink> = Arc::new(super::dispatcher::RouterDispatcher::new(
            router.clone(),
            self.credential.clone(),
            stored.device_id,
            stored.device_name.clone(),
            self.terminal.clone(),
        ));
        tokio::spawn(nomoreide_core::remote::connector::run_forever(
            config, sink, status,
        ));
        StartOutcome::Started
    }

    /// What the connection is doing, or `None` when nothing has been started.
    pub(crate) fn snapshot(&self) -> Option<RelaySnapshot> {
        self.status.get().map(RelayStatus::snapshot)
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

    fn write_credential(dir: &std::path::Path) {
        RemoteCredentials::new(dir)
            .store(&nomoreide_core::remote::credentials::StoredCredential {
                device_id: "11111111-2222-3333-4444-555555555555".into(),
                device_name: "Test Machine".into(),
                credential: "c".repeat(64),
                // Unreachable on purpose: these tests are about the supervisor's
                // bookkeeping, not about dialling anything.
                platform_base_url: "http://127.0.0.1:1".into(),
                paired_at: "2026-09-02T00:00:00Z".into(),
            })
            .expect("store");
    }
}
