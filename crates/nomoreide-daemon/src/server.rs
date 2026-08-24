//! Booting the loopback daemon: take ownership, bind, publish, serve, drain.
//! What it serves lives in [`routes`].

mod app;
mod body;
mod errors;
mod routes;
mod static_assets;

use crate::runtime::DaemonRuntime;
use crate::DaemonOwnership;
use anyhow::{Context, Result};
use app::AppState;
use chrono::Utc;
use nomoreide_core::approval_broker::ApprovalBroker;
use nomoreide_core::config::ConfigStore;
use nomoreide_core::error_inbox::ErrorInbox;
use nomoreide_core::log_store::LogStore;
use nomoreide_core::process_manager::ProcessManager;
use nomoreide_core::runtime_registry::RuntimeRegistry;
use nomoreide_core::terminal::TerminalManager;
use nomoreide_core::timeline::TimelineStore;
use nomoreide_daemon_client::{DaemonState, RuntimePaths};
use std::future::Future;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};

#[derive(Debug, Clone)]
pub struct DaemonOptions {
    pub port: u16,
    pub runtime_paths: RuntimePaths,
    pub config_path: PathBuf,
}

impl Default for DaemonOptions {
    fn default() -> Self {
        Self {
            port: nomoreide_daemon_client::DEFAULT_DAEMON_PORT,
            runtime_paths: RuntimePaths::default(),
            config_path: ConfigStore::default_path(),
        }
    }
}

pub async fn run(options: DaemonOptions) -> Result<()> {
    let (shutdown_tx, shutdown_rx) = mpsc::channel(1);
    tokio::spawn(forward_shutdown_signals(shutdown_tx.clone()));
    serve_with_shutdown_requests(options, shutdown_tx, shutdown_rx).await
}

pub async fn serve_until<F>(options: DaemonOptions, shutdown: F) -> Result<()>
where
    F: Future<Output = ()> + Send + 'static,
{
    let (shutdown_tx, shutdown_rx) = mpsc::channel(1);
    let signalled = shutdown_tx.clone();
    tokio::spawn(async move {
        shutdown.await;
        let _ = signalled.send(()).await;
    });
    serve_with_shutdown_requests(options, shutdown_tx, shutdown_rx).await
}

/// `shutdown_requests` is handed in as both ends: the receiver drains the
/// runtime, and the sender is what `POST /api/daemon/shutdown` pulls on, so a
/// request and a signal reach the same drain rather than two separate exits.
pub async fn serve_with_shutdown_requests(
    options: DaemonOptions,
    shutdown_sender: mpsc::Sender<()>,
    shutdown_requests: mpsc::Receiver<()>,
) -> Result<()> {
    let ownership = DaemonOwnership::acquire(options.runtime_paths.clone())
        .context("failed to acquire daemon ownership")?;
    let config_store = ConfigStore::new(options.config_path);
    // One timeline, shared by the two things that write to it: the log store
    // raises an event for a line that classified as notable, and the process
    // manager raises one for each lifecycle moment.
    let timeline = TimelineStore::new(options.runtime_paths.state_dir.join("timeline.log"));
    let log_store =
        LogStore::new(options.runtime_paths.state_dir.join("logs")).with_timeline(timeline.clone());
    let registry = RuntimeRegistry::new(
        options
            .runtime_paths
            .state_dir
            .join("native")
            .join("runtime-v1.json"),
    );
    // The inbox reads the same lines the log store keeps, so it is built over
    // that store and told to watch before any service can produce one.
    let errors = ErrorInbox::new(log_store.clone());
    errors.watch();
    let runtime = Arc::new(DaemonRuntime::new(
        config_store.clone(),
        ProcessManager::with_runtime_registry(log_store, registry).with_timeline(timeline),
    ));
    // Whatever a crashed owner left behind is reclaimed before this one binds a
    // port or publishes a credential, so nothing can reach a half-owned runtime.
    runtime
        .reconcile_runtime()
        .await
        .context("failed to reconcile the native runtime registry")?;

    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, options.port)))
        .await
        .context("failed to bind the daemon loopback listener")?;
    let address = listener
        .local_addr()
        .context("failed to inspect the daemon listener")?;
    let state = DaemonState {
        pid: std::process::id(),
        owner_id: ownership.owner_id().to_string(),
        url: format!("http://127.0.0.1:{}", address.port()),
        port: address.port(),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        started_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    };
    ownership
        .publish(&state)
        .context("failed to publish daemon state")?;

    let app = routes::router(AppState {
        credential: ownership.credential().to_string(),
        owner_id: ownership.owner_id().to_string(),
        config_store,
        runtime: runtime.clone(),
        errors,
        shutdown: shutdown_sender,
        terminal: TerminalManager::new(),
        events: Arc::new(app::DiscardingEventSink),
        session_counter: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        approvals: ApprovalBroker::new(),
    });

    let (http_shutdown_tx, http_shutdown_rx) = oneshot::channel();
    let shutdown_coordinator = tokio::spawn(drain_before_shutdown(
        runtime.clone(),
        shutdown_requests,
        http_shutdown_tx,
    ));

    let server_result = axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = http_shutdown_rx.await;
        })
        .await;
    shutdown_coordinator.abort();
    server_result.context("daemon HTTP server failed")?;
    drop(ownership);
    Ok(())
}

/// Stop serving only once the services are actually down. A cleanup failure
/// refuses the shutdown rather than completing it, so the next request still
/// reaches a daemon that knows it has processes it could not account for.
async fn drain_before_shutdown(
    runtime: Arc<DaemonRuntime>,
    mut requests: mpsc::Receiver<()>,
    http_shutdown: oneshot::Sender<()>,
) {
    let mut http_shutdown = Some(http_shutdown);
    loop {
        match requests.recv().await {
            Some(()) => match runtime.shutdown().await {
                Ok(()) => {
                    if let Some(sender) = http_shutdown.take() {
                        let _ = sender.send(());
                    }
                    return;
                }
                Err(error) => {
                    eprintln!("nomoreide: daemon cleanup failed; shutdown refused: {error}");
                }
            },
            None => std::future::pending::<()>().await,
        }
    }
}

async fn forward_shutdown_signals(sender: mpsc::Sender<()>) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let Ok(mut terminate) = signal(SignalKind::terminate()) else {
            return;
        };
        let Ok(mut interrupt) = signal(SignalKind::interrupt()) else {
            return;
        };
        loop {
            tokio::select! {
                _ = terminate.recv() => {}
                _ = interrupt.recv() => {}
            }
            if sender.send(()).await.is_err() {
                return;
            }
        }
    }
    #[cfg(not(unix))]
    loop {
        if tokio::signal::ctrl_c().await.is_err() || sender.send(()).await.is_err() {
            return;
        }
    }
}
