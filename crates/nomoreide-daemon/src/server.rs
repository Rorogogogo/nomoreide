//! Booting the loopback daemon: take ownership, bind, publish, serve, drain.
//! What it serves lives in [`routes`].

mod app;
mod body;
mod errors;
mod query;
mod routes;
mod sse;
mod static_assets;

use crate::runtime::DaemonRuntime;
use crate::server::routes::deploy_providers::oauth::ProviderLogins;
use crate::DaemonOwnership;
use anyhow::{Context, Result};
use app::AppState;
use chrono::Utc;
use nomoreide_core::agent_profiles::auth::AuthStates;
use nomoreide_core::approval_broker::ApprovalBroker;
use nomoreide_core::config::ConfigStore;
use nomoreide_core::error_inbox::ErrorInbox;
use nomoreide_core::log_store::LogStore;
use nomoreide_core::metrics_store::MetricsStore;
use nomoreide_core::process_manager::ProcessManager;
use nomoreide_core::runtime_registry::RuntimeRegistry;
use nomoreide_core::terminal::TerminalManager;
use nomoreide_core::test_runner::TestRunner;
use nomoreide_core::timeline::TimelineStore;
use nomoreide_core::tool_call_store::ToolCallStore;
use nomoreide_core::usage_history::UsageHistory;
use nomoreide_daemon_client::{DaemonState, RuntimePaths};
use std::future::Future;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
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

/// Run the daemon on a listener the caller has already bound.
///
/// The desktop app uses this to reserve its private ephemeral port before its
/// webview exists, removing the gap where another process could claim the port
/// between discovery and the HTTP server binding it.
pub async fn run_with_listener(options: DaemonOptions, listener: TcpListener) -> Result<()> {
    let (shutdown_tx, shutdown_rx) = mpsc::channel(1);
    tokio::spawn(forward_shutdown_signals(shutdown_tx.clone()));
    serve_on_listener(
        options,
        listener,
        RuntimePublication::Files,
        shutdown_tx,
        shutdown_rx,
    )
    .await
}

/// Run an app-private daemon whose connection details never reach disk.
///
/// The caller owns both the listener and credential, so it can hand the latter
/// directly to its webview before loading the dashboard. Runtime logs and the
/// crash-recovery registry still live under `runtime_paths`; only discovery
/// state and the bearer credential remain in memory.
pub async fn run_embedded(
    options: DaemonOptions,
    listener: TcpListener,
    credential: String,
) -> Result<()> {
    let (shutdown_tx, shutdown_rx) = mpsc::channel(1);
    run_embedded_with_shutdown_requests(options, listener, credential, shutdown_tx, shutdown_rx)
        .await
}

/// Run an app-private daemon with a shutdown channel owned by its host.
///
/// The desktop app uses the retained sender to drain every managed service
/// before its process exits. HTTP shutdown requests use the same channel, so
/// both paths have identical cleanup semantics.
pub async fn run_embedded_with_shutdown_requests(
    options: DaemonOptions,
    listener: TcpListener,
    credential: String,
    shutdown_sender: mpsc::Sender<ShutdownRequest>,
    shutdown_requests: mpsc::Receiver<ShutdownRequest>,
) -> Result<()> {
    anyhow::ensure!(
        !credential.is_empty(),
        "embedded daemon credential is empty"
    );
    serve_on_listener(
        options,
        listener,
        RuntimePublication::Memory(credential),
        shutdown_sender,
        shutdown_requests,
    )
    .await
}

pub async fn serve_until<F>(options: DaemonOptions, shutdown: F) -> Result<()>
where
    F: Future<Output = ()> + Send + 'static,
{
    let (shutdown_tx, shutdown_rx) = mpsc::channel(1);
    let signalled = shutdown_tx.clone();
    tokio::spawn(async move {
        shutdown.await;
        let _ = signalled.send(ShutdownRequest::Signalled).await;
    });
    serve_with_shutdown_requests(options, shutdown_tx, shutdown_rx).await
}

/// `shutdown_requests` is handed in as both ends: the receiver drains the
/// runtime, and the sender is what `POST /api/daemon/shutdown` pulls on, so a
/// request and a signal reach the same drain rather than two separate exits.
pub async fn serve_with_shutdown_requests(
    options: DaemonOptions,
    shutdown_sender: mpsc::Sender<ShutdownRequest>,
    shutdown_requests: mpsc::Receiver<ShutdownRequest>,
) -> Result<()> {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, options.port)))
        .await
        .context("failed to bind the daemon loopback listener")?;
    serve_on_listener(
        options,
        listener,
        RuntimePublication::Files,
        shutdown_sender,
        shutdown_requests,
    )
    .await
}

/// Why a shutdown was asked for.
///
/// **The distinction is the whole point.** Cleanup failing used to refuse the
/// shutdown whatever asked for it, and that is right for one of these two and
/// catastrophic for the other: a daemon whose cleanup can *never* succeed —
/// because its state directory has been deleted out from under it, which is
/// what happens to a parity gate's temp fixture — becomes immortal. Four of
/// them were found alive on this machine, up to ten days old, ignoring
/// `SIGTERM` and holding a listening socket on a directory that no longer
/// existed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShutdownRequest {
    /// `POST /api/daemon/shutdown`. A caller asked and is waiting for an
    /// answer, so a cleanup failure is worth reporting *and* worth staying up
    /// for — the next request reaches a daemon that knows it has processes it
    /// could not account for.
    Requested,
    /// `SIGTERM`, `SIGINT`, or the future handed to [`serve_until`].
    ///
    /// Not a request that may be declined. Cleanup is still attempted and its
    /// failure still reported, but the process exits either way: a service this
    /// daemon could not stop is a leaked service, while refusing to exit leaks
    /// the service *and* the daemon, forever, with nothing left that can ask it
    /// again.
    Signalled,
}

enum RuntimePublication {
    Files,
    Memory(String),
}

async fn serve_on_listener(
    options: DaemonOptions,
    listener: TcpListener,
    publication: RuntimePublication,
    shutdown_sender: mpsc::Sender<ShutdownRequest>,
    shutdown_requests: mpsc::Receiver<ShutdownRequest>,
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
    // Built over the same store, so a failing run's output reaches the inbox
    // the way a service's does — that is what turns a failed test into an
    // incident with no extra wiring.
    let tests = TestRunner::new(log_store.clone());
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
    let (credential, embedded) = match publication {
        RuntimePublication::Files => {
            ownership
                .publish(&state)
                .context("failed to publish daemon state")?;
            (ownership.credential().to_string(), false)
        }
        RuntimePublication::Memory(credential) => (credential, true),
    };

    // Token and cost history, beside the logs and the timeline in the same
    // state directory. The reference derives this path from its log directory
    // for the same reason: one place per machine, not one per project.
    // Anchored to the daemon's own working directory, which is the filesystem
    // whose free space the dashboard reports.
    let metrics = MetricsStore::new(crate::server::routes::daemon_cwd());
    // One sample before anything is served, so the first request to reach a
    // freshly started daemon draws a point rather than an empty pane. The
    // reference has the same property by starting its sampler before it binds.
    metrics.sample_once(&[]).await;
    tokio::spawn(sample_metrics(metrics.clone(), runtime.clone()));

    let usage_history = Arc::new(UsageHistory::new(
        options.runtime_paths.state_dir.join("usage-history.jsonl"),
    ));
    tokio::spawn(sample_usage(usage_history.clone()));

    // Exit if this daemon's runtime home is deleted out from under it. See
    // `watch_runtime_home` — this is what stops an orphaned gate daemon living
    // for ten days rather than merely making it killable.
    tokio::spawn(watch_runtime_home(
        options.runtime_paths.clone(),
        ownership.owner_id().to_string(),
        shutdown_sender.clone(),
    ));

    // One channel behind the sink every manager already emits into, so the
    // terminal stream is a subscriber rather than a change to the manager.
    let event_stream = tokio::sync::broadcast::Sender::<app::RuntimeEvent>::new(app::EVENT_BACKLOG);
    // The dispatcher calls this router in-process and has to present the same
    // credential a browser does, so it gets its own copy before the state takes
    // ownership. It is not a second, more privileged way in — it is the same
    // door.
    // Hoisted out of the state literal below so the relay mirrors *these*
    // sessions. Two managers would each own their own PTYs, and a phone would
    // be shown a terminal list the dashboard has never heard of.
    let terminal = TerminalManager::new();
    let events: nomoreide_core::event_sink::SharedEventSink =
        Arc::new(app::BroadcastEventSink::new(event_stream.clone()));
    #[cfg(unix)]
    let _attach_server = nomoreide_core::terminal::attach::serve(
        &options.runtime_paths.state_dir,
        terminal.clone(),
        events.clone(),
    )
    .map_err(anyhow::Error::msg)
    .context("failed to start local terminal attachment")?;
    let relay = crate::remote::supervisor::RelaySupervisor::new(
        options.runtime_paths.state_dir.clone(),
        credential.clone(),
        terminal.clone(),
    );
    let app = routes::router(AppState {
        credential,
        owner_id: ownership.owner_id().to_string(),
        config_store,
        runtime: runtime.clone(),
        errors,
        shutdown: shutdown_sender,
        terminal,
        events,
        event_stream,
        session_counter: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        metrics: metrics.clone(),
        tool_calls: ToolCallStore::new(),
        tests,
        usage_history,
        approvals: ApprovalBroker::new(),
        registry_auth: AuthStates::new(),
        provider_logins: ProviderLogins::new(),
        relay: relay.clone(),
        pending_pairing: Default::default(),
    });
    let app = if embedded {
        app.layer(axum::middleware::from_fn(routes::allow_desktop_origin))
    } else {
        app
    };

    // Only the machine-global daemon dials the relay. The desktop app runs its
    // own in-process, and two daemons sharing one credential would leave a
    // phone talking to whichever restarted last — see `crate::remote`.
    if !embedded {
        // The router exists now, so the dispatcher has something to call. A
        // machine already paired connects here; one paired later connects when
        // `nomoreide remote pair` asks, without a restart.
        relay.attach_router(app.clone());
        relay.ensure_started();
    }

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

/// Stop serving only once the services are actually down — unless the ask was a
/// signal, which is not a thing to decline.
///
/// A [`ShutdownRequest::Requested`] that cannot clean up stays up and says so,
/// so the next request reaches a daemon that knows it has processes it could
/// not account for. A [`ShutdownRequest::Signalled`] that cannot clean up
/// exits anyway — see the type for the four immortal daemons that behaviour
/// cost.
async fn drain_before_shutdown(
    runtime: Arc<DaemonRuntime>,
    mut requests: mpsc::Receiver<ShutdownRequest>,
    http_shutdown: oneshot::Sender<()>,
) {
    let mut http_shutdown = Some(http_shutdown);
    loop {
        let Some(request) = requests.recv().await else {
            std::future::pending::<()>().await;
            continue;
        };
        match runtime.shutdown().await {
            Ok(()) => {
                if let Some(sender) = http_shutdown.take() {
                    let _ = sender.send(());
                }
                return;
            }
            Err(error) => {
                eprintln!("nomoreide: daemon cleanup failed: {error}");
                if stops_anyway(request) {
                    eprintln!("nomoreide: exiting anyway; a signal is not a request to decline.");
                    if let Some(sender) = http_shutdown.take() {
                        let _ = sender.send(());
                    }
                    return;
                }
                eprintln!("nomoreide: shutdown refused; send SIGTERM to stop regardless.");
            }
        }
    }
}

/// How often the daemon checks that it still has a runtime home.
const RUNTIME_HOME_POLL: Duration = Duration::from_secs(30);
/// Consecutive misses before exiting. Two, so a transient stat failure — a
/// filesystem briefly unavailable, a home on a network mount — does not end a
/// healthy daemon.
const RUNTIME_HOME_MISSES: u8 = 2;

/// Stop when this daemon's runtime home has been deleted out from under it.
///
/// **This is what makes orphan cleanup automatic** rather than something a
/// person notices weeks later in `ps`. A parity gate spawns a daemon inside a
/// temp fixture; when the gate is interrupted the fixture is removed and the
/// daemon is left serving a directory that no longer exists. Nothing ever told
/// it to stop, so it did not — four such daemons were found on one machine, up
/// to ten days old.
///
/// **The check is the lock file, deliberately not the parent process.** The
/// obvious test — "am I an orphan, is my `ppid` 1?" — is exactly wrong here:
/// the real daemon is *detached on purpose* and legitimately has `ppid` 1 from
/// the moment it starts. A parent-death check would kill the one daemon that is
/// supposed to be running. What actually separates the two is that
/// `~/.nomoreide/daemon.lock` persists while a temp fixture does not.
///
/// An owner id that no longer matches counts as gone too: the file being
/// replaced means this process is no longer the owner it published itself as,
/// and serving on a credential nobody can look up is not serving.
async fn watch_runtime_home(
    paths: RuntimePaths,
    owner_id: String,
    shutdown: mpsc::Sender<ShutdownRequest>,
) {
    let mut misses = 0u8;
    loop {
        tokio::time::sleep(RUNTIME_HOME_POLL).await;
        if runtime_home_is_ours(&paths, &owner_id) {
            misses = 0;
            continue;
        }
        misses += 1;
        if misses < RUNTIME_HOME_MISSES {
            continue;
        }
        eprintln!(
            "nomoreide: runtime home {} is gone; stopping.",
            paths.state_dir.display()
        );
        // `Signalled`, not `Requested`: nobody is waiting for an answer, and
        // this must not be declinable — a daemon whose home has been deleted is
        // precisely the one whose cleanup cannot succeed.
        let _ = shutdown.send(ShutdownRequest::Signalled).await;
        return;
    }
}

/// Whether the lock file still exists and still names this owner.
fn runtime_home_is_ours(paths: &RuntimePaths, owner_id: &str) -> bool {
    let Ok(raw) = std::fs::read(&paths.lock) else {
        return false;
    };
    // A lock file that cannot be parsed is not evidence of anything; treat it
    // as present rather than reading a truncated write as a reason to exit.
    match serde_json::from_slice::<crate::LockRecord>(&raw) {
        Ok(record) => record.owner_id == owner_id,
        Err(_) => true,
    }
}

/// Whether a shutdown proceeds even though cleanup failed.
///
/// The one line the immortal-daemon bug turned on, pulled out of the loop so a
/// test holds it rather than a comment.
fn stops_anyway(request: ShutdownRequest) -> bool {
    matches!(request, ShutdownRequest::Signalled)
}

async fn forward_shutdown_signals(sender: mpsc::Sender<ShutdownRequest>) {
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
            if sender.send(ShutdownRequest::Signalled).await.is_err() {
                return;
            }
        }
    }
    #[cfg(not(unix))]
    loop {
        if tokio::signal::ctrl_c().await.is_err()
            || sender.send(ShutdownRequest::Signalled).await.is_err()
        {
            return;
        }
    }
}

/// Record the current reading shortly after boot, and every thirty seconds
/// after that.
///
/// Always on, rather than driven by the Usage tab: history that only accrues
/// while someone is watching is not history. The store de-dupes, so an idle
/// agent costs one read of three files a tick and writes nothing, and a failure
/// is dropped rather than logged — a sample is not worth a line in the daemon's
/// stderr every thirty seconds when a home has gone read-only.
async fn sample_usage(history: Arc<UsageHistory>) {
    let cwd = crate::server::routes::daemon_cwd();
    // Deferred, so a daemon that starts and stops immediately leaves no file
    // behind at all.
    tokio::time::sleep(Duration::from_secs(5)).await;
    loop {
        let usage = nomoreide_core::usage_info::build_usage_info(&cwd).await;
        history.record(&usage).await;
        tokio::time::sleep(Duration::from_secs(30)).await;
    }
}

/// Sample host and per-service activity on a timer.
///
/// The first tick is immediate rather than deferred: a dashboard opened at the
/// same moment as the daemon should draw a point, not an empty pane, and one
/// `ps` at startup costs nothing anybody notices.
async fn sample_metrics(metrics: MetricsStore, runtime: Arc<DaemonRuntime>) {
    let interval = Duration::from_millis(metrics.interval_ms());
    loop {
        // Sleep first. The startup sample has already been taken, and taking a
        // second one straight away would give the host a CPU percentage before
        // an interval had passed -- a ratio over no elapsed time.
        tokio::time::sleep(interval).await;
        let running: Vec<nomoreide_core::metrics_store::RunningService> = runtime
            .status()
            .into_iter()
            .filter(|status| {
                serde_json::to_value(status.state)
                    .ok()
                    .and_then(|value| value.as_str().map(str::to_string))
                    .as_deref()
                    == Some("running")
            })
            .map(|status| nomoreide_core::metrics_store::RunningService {
                name: status.name,
                pid: status.pid.map(i64::from),
                started_at: status.started_at,
            })
            .collect();
        metrics.sample_once(&running).await;
    }
}

#[cfg(test)]
mod tests {
    use super::{runtime_home_is_ours, stops_anyway, RuntimePaths, ShutdownRequest};

    /// The regression, stated as the rule it broke.
    ///
    /// Cleanup failing used to refuse the shutdown whatever asked for it. For a
    /// signal that is not a refusal anybody can act on — there is nothing left
    /// to ask again — so the daemon lived forever. Four were found on one
    /// machine, up to ten days old, holding sockets on deleted directories.
    #[test]
    fn a_signal_stops_the_daemon_even_when_cleanup_fails() {
        assert!(stops_anyway(ShutdownRequest::Signalled));
    }

    /// A deleted runtime home is what an orphaned gate daemon is left serving.
    #[test]
    fn a_missing_lock_file_means_the_runtime_home_is_gone() {
        let dir = std::env::temp_dir().join(format!("nmi-home-{}", uuid::Uuid::new_v4()));
        let paths = RuntimePaths::new(dir.clone());
        assert!(!runtime_home_is_ours(&paths, "owner-a"));
    }

    #[test]
    fn a_lock_naming_another_owner_means_this_daemon_is_not_it() {
        let dir = std::env::temp_dir().join(format!("nmi-home-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let paths = RuntimePaths::new(dir.clone());
        std::fs::write(&paths.lock, br#"{"pid":1,"ownerId":"owner-b"}"#).unwrap();
        assert!(!runtime_home_is_ours(&paths, "owner-a"));
        assert!(runtime_home_is_ours(&paths, "owner-b"));
        // A half-written file is not evidence of anything, so it is kept.
        std::fs::write(&paths.lock, b"{not json").unwrap();
        assert!(runtime_home_is_ours(&paths, "owner-a"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// ...and the half that was right stays right: an HTTP caller is waiting
    /// for an answer and can retry, so a daemon that could not account for its
    /// services stays up and says so.
    #[test]
    fn an_http_request_still_refuses_when_cleanup_fails() {
        assert!(!stops_anyway(ShutdownRequest::Requested));
    }
}
