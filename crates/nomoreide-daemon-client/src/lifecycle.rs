//! Bringing the machine-global daemon up, and asking it to go down.
//!
//! Discovery answers what is running; this answers what to do about it. It
//! lives here rather than in a caller because every front end — MCP, CLI, the
//! desktop app — needs the same three outcomes, and a second implementation of
//! "spawn one if none is running" is a second way to end up with two daemons.

use crate::{
    discover_daemon, probe_daemon, DaemonClient, DaemonClientError, DaemonDiscovery,
    DaemonEndpoint, DaemonProbe, DiscoveryStatus, RuntimePaths,
};
use reqwest::Client;
use std::io;
use std::process::{Command, Stdio};
use std::time::Duration;

/// How long a freshly spawned daemon is given to answer its own health probe.
/// It has to bind a port, reclaim whatever a crashed owner left behind, and
/// publish its state before it can, so this is longer than a bind takes.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const STARTUP_POLL: Duration = Duration::from_millis(100);

/// What `ensure` had to do to get a daemon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnsureStatus {
    /// Nothing was running, so one was spawned.
    Started,
    /// The state file named a daemon and it answered.
    AlreadyRunning,
    /// The port answered without a state file naming it — someone else's
    /// daemon, or one whose state was removed underneath it.
    Adopted,
}

impl EnsureStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::AlreadyRunning => "already_running",
            Self::Adopted => "adopted",
        }
    }
}

#[derive(Debug, Clone)]
pub struct EnsuredDaemon {
    pub status: EnsureStatus,
    pub endpoint: DaemonEndpoint,
    pub pid: u32,
    pub version_warning: Option<String>,
}

/// Whether the daemon was told to stop, or was never up to be told.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopOutcome {
    Stopping,
    NotRunning,
}

#[derive(Debug, thiserror::Error)]
pub enum LifecycleError {
    #[error("failed to read daemon runtime state: {0}")]
    State(#[source] io::Error),
    /// Deliberately carries the port: the only useful thing a caller can say
    /// about a port it does not own is which one it is.
    #[error("Port {0} is held by a process that is not a NoMoreIDE daemon. Stop it or set NOMOREIDE_DAEMON_PORT to use a different port.")]
    Foreign(u16),
    #[error("failed to locate the nomoreide executable: {0}")]
    Executable(#[source] io::Error),
    #[error("failed to spawn the NoMoreIDE daemon: {0}")]
    Spawn(#[source] io::Error),
    #[error("The NoMoreIDE daemon did not become reachable on port {0}.")]
    Unreachable(u16),
    #[error(transparent)]
    Client(#[from] DaemonClientError),
}

/// Reuse a running daemon, adopt one on the configured port, or start one.
pub async fn ensure(
    paths: &RuntimePaths,
    configured_port: u16,
    client_version: &str,
) -> Result<EnsuredDaemon, LifecycleError> {
    let http = Client::new();
    match discover_daemon(paths, configured_port, client_version, &http)
        .await
        .map_err(LifecycleError::State)?
    {
        DaemonDiscovery::Running(daemon) => Ok(EnsuredDaemon {
            status: match daemon.status {
                DiscoveryStatus::Recorded => EnsureStatus::AlreadyRunning,
                DiscoveryStatus::Adopted => EnsureStatus::Adopted,
            },
            endpoint: daemon.endpoint,
            pid: daemon.pid,
            version_warning: daemon.version_warning,
        }),
        DaemonDiscovery::Foreign(endpoint) => Err(LifecycleError::Foreign(endpoint.port())),
        DaemonDiscovery::Down(endpoint) => start(endpoint, &http, client_version).await,
    }
}

/// Ask a running daemon to stop. A daemon that is not there needs no asking,
/// and one holding the port that is not ours is not ours to stop.
pub async fn stop(
    paths: &RuntimePaths,
    configured_port: u16,
    client_version: &str,
) -> Result<StopOutcome, LifecycleError> {
    let http = Client::new();
    let endpoint = match discover_daemon(paths, configured_port, client_version, &http)
        .await
        .map_err(LifecycleError::State)?
    {
        DaemonDiscovery::Running(daemon) => daemon.endpoint,
        DaemonDiscovery::Foreign(_) | DaemonDiscovery::Down(_) => {
            return Ok(StopOutcome::NotRunning)
        }
    };
    DaemonClient::connect(endpoint, paths)
        .await?
        .shutdown()
        .await?;
    Ok(StopOutcome::Stopping)
}

/// Spawn a detached daemon and wait for it to answer for itself.
///
/// Detached on purpose: the daemon outlives the session that started it, which
/// is the whole reason services survive a closed terminal. That also means a
/// failure to start is only visible as a port that never answers — the child's
/// output goes nowhere by design, so it lands in the daemon's own log instead.
async fn start(
    endpoint: DaemonEndpoint,
    http: &Client,
    client_version: &str,
) -> Result<EnsuredDaemon, LifecycleError> {
    let executable = std::env::current_exe().map_err(LifecycleError::Executable)?;
    let mut command = Command::new(executable);
    command
        .arg("daemon")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    detach(&mut command);
    let mut child = command.spawn().map_err(LifecycleError::Spawn)?;

    let deadline = std::time::Instant::now() + STARTUP_TIMEOUT;
    loop {
        if let DaemonProbe::NoMoreIde(health) = probe_daemon(&endpoint, http).await {
            // Reaped here rather than left as a zombie: the daemon reparents
            // itself, so the process this waits on is the short-lived shell of
            // the spawn, not the daemon.
            let _ = child.try_wait();
            return Ok(EnsuredDaemon {
                status: EnsureStatus::Started,
                pid: health.pid.unwrap_or(0),
                version_warning: crate::version_warning(client_version, &health),
                endpoint,
            });
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(LifecycleError::Unreachable(endpoint.port()));
        }
        tokio::time::sleep(STARTUP_POLL).await;
    }
}

#[cfg(unix)]
fn detach(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        command.pre_exec(|| {
            // Its own session, so a terminal closing does not signal it.
            libc::setsid();
            Ok(())
        });
    }
}

#[cfg(windows)]
fn detach(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    command.creation_flags(0x0000_0008 | 0x0000_0200);
}
