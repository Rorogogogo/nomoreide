//! Bringing the machine-global daemon up, and asking it to go down.
//!
//! Discovery answers what is running; this answers what to do about it. It
//! lives here rather than in a caller because every front end — MCP, CLI, the
//! desktop app — needs the same three outcomes, and a second implementation of
//! "spawn one if none is running" is a second way to end up with two daemons.

use crate::protocol::ServiceRuntimeState;
use crate::{
    discover_daemon, probe_daemon, DaemonClient, DaemonClientError, DaemonDiscovery,
    DaemonEndpoint, DaemonProbe, DiscoveredDaemon, DiscoveryStatus, RuntimePaths,
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
    /// An older daemon was running, nothing was running *in* it, so it was
    /// replaced with this build rather than left for a human to notice.
    Upgraded,
}

impl EnsureStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::AlreadyRunning => "already_running",
            Self::Adopted => "adopted",
            Self::Upgraded => "upgraded",
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
        DaemonDiscovery::Running(daemon) => {
            if daemon.version_warning.is_some() {
                if let Some(upgraded) = upgrade_if_idle(paths, &daemon, &http, client_version).await
                {
                    return Ok(upgraded);
                }
            }
            Ok(EnsuredDaemon {
                status: match daemon.status {
                    DiscoveryStatus::Recorded => EnsureStatus::AlreadyRunning,
                    DiscoveryStatus::Adopted => EnsureStatus::Adopted,
                },
                endpoint: daemon.endpoint,
                pid: daemon.pid,
                version_warning: daemon.version_warning,
            })
        }
        DaemonDiscovery::Foreign(endpoint) => Err(LifecycleError::Foreign(endpoint.port())),
        DaemonDiscovery::Down(endpoint) => start(endpoint, &http, client_version).await,
    }
}

/// Replace a daemon from an older build, but only while it is holding nothing.
///
/// **Why this is conditional rather than automatic.** Restarting the daemon
/// kills every service it manages, so upgrading on sight would mean an
/// installer — or an agent that happened to call a tool — silently taking down
/// somebody's dev servers. Warning instead put the work on a human, who then
/// had to read the warning: it reached the CLI and exactly one MCP tool, so an
/// agent calling anything else went on using the old daemon indefinitely, with
/// whatever the new build added simply missing and nothing saying why.
///
/// Idle is the case where both objections vanish. Nothing is running, so
/// nothing is lost, and the upgrade costs a second of startup nobody sees.
/// Anything running and this declines, leaving the warning to be shown — the
/// choice to stop work is a person's.
///
/// Returns `None` for every reason not to act: services running, a daemon that
/// will not answer, or a restart that does not come back. A failure here is
/// never fatal, because the daemon that is already running still works.
async fn upgrade_if_idle(
    paths: &RuntimePaths,
    daemon: &DiscoveredDaemon,
    http: &Client,
    client_version: &str,
) -> Option<EnsuredDaemon> {
    let client = DaemonClient::connect(daemon.endpoint.clone(), paths)
        .await
        .ok()?;
    let services = client.status().await.ok()?;
    if !is_idle(&services) {
        return None;
    }

    client.shutdown().await.ok()?;
    // The old daemon has to release the port before the new one can take it.
    // Its own shutdown is what we are waiting on, not a fixed delay.
    let deadline = std::time::Instant::now() + SHUTDOWN_TIMEOUT;
    while std::time::Instant::now() < deadline {
        if !crate::is_pid_alive(daemon.pid) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let started = start(daemon.endpoint.clone(), http, client_version)
        .await
        .ok()?;
    Some(EnsuredDaemon {
        status: EnsureStatus::Upgraded,
        ..started
    })
}

/// Whether replacing this daemon would cost anybody anything.
///
/// `Starting` counts as busy: a service partway through coming up is one
/// somebody asked for a moment ago, and killing it would look exactly like it
/// failed to start. `Stopping` does not — it is already on its way out, and
/// waiting for it would mean declining the upgrade for a service that is about
/// to be gone anyway.
fn is_idle(services: &[crate::protocol::ServiceRuntimeStatus]) -> bool {
    !services.iter().any(|service| {
        matches!(
            service.state,
            ServiceRuntimeState::Running | ServiceRuntimeState::Starting
        )
    })
}

/// How long the old daemon is given to let go of its port.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{ServiceRuntimeState, ServiceRuntimeStatus};

    fn service(state: ServiceRuntimeState) -> ServiceRuntimeStatus {
        ServiceRuntimeStatus {
            name: "api".to_string(),
            state,
            kind: None,
            host: None,
            container_id: None,
            pid: None,
            url: None,
            exit_code: None,
            exited_at: None,
            started_at: None,
            signal: None,
            inspector: None,
        }
    }

    /// The whole point of the gate: a machine doing work is never interrupted
    /// for a version number. An installer must not be able to take down
    /// somebody's dev server, and nor must an agent that happened to call a
    /// tool.
    #[test]
    fn a_daemon_with_work_in_it_is_never_replaced() {
        for state in [ServiceRuntimeState::Running, ServiceRuntimeState::Starting] {
            assert!(!is_idle(&[service(state)]), "{state:?} must count as busy");
        }
    }

    /// And the case that makes the feature worth having: nothing is running, so
    /// the upgrade costs a second of startup nobody sees.
    #[test]
    fn a_daemon_holding_nothing_is_replaceable() {
        assert!(is_idle(&[]));
        for state in [
            ServiceRuntimeState::Stopped,
            ServiceRuntimeState::Exited,
            ServiceRuntimeState::Stopping,
        ] {
            assert!(
                is_idle(&[service(state)]),
                "{state:?} holds nothing worth keeping a stale daemon for"
            );
        }
    }

    /// One running service among many stopped ones still protects the daemon.
    #[test]
    fn one_running_service_is_enough_to_decline() {
        let services = [
            service(ServiceRuntimeState::Stopped),
            service(ServiceRuntimeState::Exited),
            service(ServiceRuntimeState::Running),
            service(ServiceRuntimeState::Stopped),
        ];
        assert!(!is_idle(&services));
    }
}
