use super::compose::{Compose, ComposeTarget};
use super::config::ServiceDef;
use super::log_store::{LogEntry, LogStore};
use super::port_utils::{
    get_port_holder, is_port_available, terminate_port_holder, ManagedProcessRoot, PortHolder,
    PortHolderExpectation,
};
#[cfg(unix)]
use super::port_utils::{inspect_process_identity, process_start_token};
use super::runtime_registry::{RuntimeRecord, RuntimeRegistry};
use super::timeline::{
    NewTimelineEvent, TimelineEvent, TimelineEventKind, TimelineSeverity, TimelineStore,
};
use anyhow::{anyhow, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
use tokio::time::{sleep, Duration, Instant};

/// A macOS app launched from Finder/Dock inherits only a minimal PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`), so Homebrew/nvm/pnpm tools like `npm` and
/// `node` aren't found and services silently fail to spawn — even though they
/// work when the app is started from a terminal (which has the full shell PATH).
/// Resolve a usable PATH once: the user's login-shell PATH plus common dev bin
/// dirs as a safety net. Cached for the process lifetime.
pub fn service_path() -> String {
    use std::sync::OnceLock;
    static CACHED: OnceLock<String> = OnceLock::new();
    CACHED
        .get_or_init(|| {
            let mut dirs: Vec<String> = Vec::new();

            // 1. The user's login-shell PATH — the faithful source of truth.
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            if let Ok(out) = std::process::Command::new(&shell)
                .args(["-lc", "printf %s \"$PATH\""])
                .output()
            {
                if out.status.success() {
                    let p = String::from_utf8_lossy(&out.stdout);
                    dirs.extend(
                        p.trim()
                            .split(':')
                            .filter(|s| !s.is_empty())
                            .map(String::from),
                    );
                }
            }

            // 2. Common dev locations as a safety net (covers Homebrew/cargo/pnpm).
            if let Ok(home) = std::env::var("HOME") {
                dirs.push(format!("{home}/.local/bin"));
                dirs.push(format!("{home}/.cargo/bin"));
                dirs.push(format!("{home}/Library/pnpm"));
            }
            for d in [
                "/opt/homebrew/bin",
                "/opt/homebrew/sbin",
                "/usr/local/bin",
                "/usr/bin",
                "/bin",
                "/usr/sbin",
                "/sbin",
            ] {
                dirs.push(d.to_string());
            }

            // 3. Whatever PATH we already have, last.
            if let Ok(p) = std::env::var("PATH") {
                dirs.extend(p.split(':').filter(|s| !s.is_empty()).map(String::from));
            }

            // Dedup, preserving first-seen order.
            let mut seen = std::collections::HashSet::new();
            dirs.into_iter()
                .filter(|d| seen.insert(d.clone()))
                .collect::<Vec<_>>()
                .join(":")
        })
        .clone()
}

/// The native runtime journal exists so that a crashed owner's orphaned process
/// groups can be reclaimed by whoever owns the runtime next. Windows gets that
/// guarantee from the kernel instead: every child is assigned to a job object
/// with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so the OS tears the whole tree
/// down the moment the owner's last handle closes — a crash included. There is
/// nothing to journal there and nothing a later owner could reclaim, so the
/// journal (and the exact process identity it depends on) stays Unix-only.
#[cfg(unix)]
const RUNTIME_JOURNAL_SUPPORTED: bool = true;
#[cfg(not(unix))]
const RUNTIME_JOURNAL_SUPPORTED: bool = false;

/// How long a freshly forked child has to announce itself before this owner
/// abandons the launch.
#[cfg(unix)]
const LAUNCH_ANNOUNCE_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(unix)]
const LAUNCH_ANNOUNCE_POLL: Duration = Duration::from_millis(2);
/// Exit status of a child abandoned before it executed the service.
#[cfg(unix)]
const LAUNCH_ABANDONED_EXIT_CODE: libc::c_int = 126;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ServiceState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Exited,
}

impl ServiceState {
    /// The wire spelling, which is also the one a person reads in a repro
    /// bundle — so it comes from here rather than from a second table that
    /// could drift from the serde one.
    pub fn as_str(&self) -> &'static str {
        match self {
            ServiceState::Stopped => "stopped",
            ServiceState::Starting => "starting",
            ServiceState::Running => "running",
            ServiceState::Stopping => "stopping",
            ServiceState::Exited => "exited",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    pub name: String,
    pub state: ServiceState,
    /// The kind this generation was launched as, stamped at launch rather than
    /// joined from config at read time: a service dropped from config after it
    /// started is still running, and still ran as something.
    pub kind: String,
    /// The host a remote service was launched against. Only an `ssh` service
    /// has one; for every other kind the question does not arise.
    pub host: Option<String>,
    /// The container behind a compose service. It stands where a pid stands
    /// for every other kind: the identity of the thing that is running.
    pub container_id: Option<String>,
    pub pid: Option<u32>,
    pub pgid: Option<u32>,
    pub exit_code: Option<i32>,
    pub url: Option<String>,
    /// When this generation of the process was launched. It survives the exit
    /// it belongs to — a health check reads it to tell the output of the run
    /// that just failed apart from whatever an earlier run left behind, and
    /// clearing it on exit would take that answer away exactly when it is
    /// wanted. `None` means this manager has never launched the service.
    pub started_at: Option<DateTime<Utc>>,
    /// When this generation terminated. `Some` is the one honest answer to
    /// "has it ended?" — `exit_code` and `signal` are each absent on their own
    /// for a process killed the other way.
    pub exited_at: Option<DateTime<Utc>>,
    /// The name of the signal that killed the process ("SIGTERM"), not its
    /// number: the name is what the reference reports and what a reader knows.
    pub signal: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct StartServiceOptions {
    pub terminate_holder: Option<PortHolderExpectation>,
}

#[derive(Debug)]
pub struct PortConflictError {
    pub service: String,
    pub port: u16,
    pub holder: Option<PortHolder>,
}

impl std::fmt::Display for PortConflictError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(holder) = &self.holder {
            write!(
                formatter,
                "Port {} is already in use for {} (held by pid {} — {}).",
                self.port, self.service, holder.pid, holder.command
            )
        } else {
            write!(
                formatter,
                "Port {} is already in use for {}.",
                self.port, self.service
            )
        }
    }
}

impl std::error::Error for PortConflictError {}

struct ManagedProcess {
    generation: u64,
    kind: String,
    host: Option<String>,
    /// The container a compose service left running, for the status, and the
    /// project to act on to take it down again. Both are recorded at launch so
    /// a stop needs no config: a definition that drifts afterwards must not
    /// strand a container nobody can reach.
    container_id: Option<String>,
    compose: Option<ComposeTarget>,
    pid: Option<u32>,
    pgid: Option<u32>,
    state: ServiceState,
    exit_code: Option<i32>,
    signal: Option<String>,
    url: Option<String>,
    started_at: Option<DateTime<Utc>>,
    exited_at: Option<DateTime<Utc>>,
    cleanup_confirmed: bool,
    controller: Option<mpsc::Sender<SupervisorCommand>>,
}

/// One place turns a tracked process into the status readers see, so the
/// whole-runtime read and the single-service read cannot drift apart.
fn status_of(name: &str, process: &ManagedProcess) -> ServiceStatus {
    ServiceStatus {
        name: name.to_string(),
        state: process.state.clone(),
        kind: process.kind.clone(),
        host: process.host.clone(),
        container_id: process.container_id.clone(),
        pid: process.pid,
        pgid: process.pgid,
        exit_code: process.exit_code,
        url: process.url.clone(),
        started_at: process.started_at,
        exited_at: process.exited_at,
        signal: process.signal.clone(),
    }
}

enum SupervisorCommand {
    Stop {
        reply: oneshot::Sender<std::result::Result<(), String>>,
    },
}

impl SupervisorContext {
    /// Record how a generation ended.
    ///
    /// A service that was asked to stop is not news however it died, so only an
    /// *unrequested* exit with a non-zero code is an error — the reference draws
    /// the line in the same place. Emitted once, where the runtime settles the
    /// terminal state, rather than at every caller that can cause one.
    fn record_termination(&self, state: ServiceState, termination: Termination) {
        let Some(timeline) = &self.timeline else {
            return;
        };
        let exited = state == ServiceState::Exited;
        let severity = if exited && termination.exit_code.is_some_and(|code| code != 0) {
            TimelineSeverity::Error
        } else {
            TimelineSeverity::Info
        };
        let outcome = if exited { "exited" } else { "stopped" };
        timeline.append(
            NewTimelineEvent::new(
                TimelineEventKind::ServiceLifecycle,
                severity,
                format!("{} {outcome}", self.name),
            )
            .service(self.name.clone())
            .data(json!({
                "exitCode": termination.exit_code,
                "signal": termination.signal_name(),
            })),
        );
    }
}

struct SupervisorContext {
    name: String,
    generation: u64,
    pgid: Option<u32>,
    process_tree: ProcessTreeGuard,
    processes: Arc<Mutex<HashMap<String, ManagedProcess>>>,
    runtime_registry: Option<RuntimeRegistry>,
    timeline: Option<TimelineStore>,
    policy: StopPolicy,
}

#[cfg(not(windows))]
struct ProcessTreeGuard;

#[cfg(not(windows))]
impl ProcessTreeGuard {
    fn attach(_child: &Child) -> Result<Self> {
        Ok(Self)
    }

    fn resume(&self, _pid: u32) -> Result<()> {
        Ok(())
    }
}

#[cfg(windows)]
struct ProcessTreeGuard(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for ProcessTreeGuard {}

#[cfg(windows)]
unsafe impl Sync for ProcessTreeGuard {}

#[cfg(windows)]
impl ProcessTreeGuard {
    fn attach(child: &Child) -> Result<Self> {
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        let guard = Self(handle);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        };
        if configured == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let process_handle = child
            .raw_handle()
            .ok_or_else(|| anyhow!("Spawned service has no Windows process handle"))?;
        if unsafe { AssignProcessToJobObject(handle, process_handle.cast()) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(guard)
    }

    fn terminate(&self) -> Result<()> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        if unsafe { TerminateJobObject(self.0, 1) } == 0 {
            Err(std::io::Error::last_os_error().into())
        } else {
            Ok(())
        }
    }

    fn resume(&self, pid: u32) -> Result<()> {
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        };
        use windows_sys::Win32::System::Threading::{
            OpenThread, ResumeThread, THREAD_SUSPEND_RESUME,
        };

        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut found = unsafe { Thread32First(snapshot, &raw mut entry) } != 0;
        while found {
            if entry.th32OwnerProcessID == pid {
                let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                if thread.is_null() {
                    unsafe { CloseHandle(snapshot) };
                    return Err(std::io::Error::last_os_error().into());
                }
                let resumed = unsafe { ResumeThread(thread) };
                unsafe {
                    CloseHandle(thread);
                    CloseHandle(snapshot);
                }
                if resumed == u32::MAX {
                    return Err(std::io::Error::last_os_error().into());
                }
                return Ok(());
            }
            found = unsafe { Thread32Next(snapshot, &raw mut entry) } != 0;
        }
        unsafe { CloseHandle(snapshot) };
        Err(anyhow!(
            "Could not locate the suspended primary thread for process {pid}"
        ))
    }

    fn is_empty(&self) -> Result<bool> {
        use windows_sys::Win32::System::JobObjects::{
            JobObjectBasicAccountingInformation, QueryInformationJobObject,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        };
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let queried = unsafe {
            QueryInformationJobObject(
                self.0,
                JobObjectBasicAccountingInformation,
                (&raw mut accounting).cast(),
                std::mem::size_of_val(&accounting) as u32,
                std::ptr::null_mut(),
            )
        };
        if queried == 0 {
            Err(std::io::Error::last_os_error().into())
        } else {
            Ok(accounting.ActiveProcesses == 0)
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessTreeGuard {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[derive(Clone, Copy)]
struct StopPolicy {
    term_grace: Duration,
    kill_grace: Duration,
    poll_interval: Duration,
}

impl Default for StopPolicy {
    fn default() -> Self {
        Self {
            term_grace: Duration::from_secs(3),
            kill_grace: Duration::from_secs(2),
            poll_interval: Duration::from_millis(10),
        }
    }
}

pub struct ProcessManager {
    processes: Arc<Mutex<HashMap<String, ManagedProcess>>>,
    operation_locks: AsyncMutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    next_generation: AtomicU64,
    log_store: LogStore,
    timeline: Option<TimelineStore>,
    stop_policy: StopPolicy,
    runtime_registry: Option<RuntimeRegistry>,
    compose: Compose,
    reconciled: AsyncMutex<bool>,
    /// Only one launch handshake may be in flight at a time: a second `fork`
    /// inside the window would inherit the first child's release pipe and keep
    /// its abandonment signal open.
    #[cfg(unix)]
    launch_gate: AsyncMutex<()>,
}

impl ProcessManager {
    pub fn new(log_store: LogStore) -> Self {
        ProcessManager {
            processes: Arc::new(Mutex::new(HashMap::new())),
            operation_locks: AsyncMutex::new(HashMap::new()),
            next_generation: AtomicU64::new(1),
            log_store,
            timeline: None,
            stop_policy: StopPolicy::default(),
            runtime_registry: None,
            compose: Compose::new(),
            reconciled: AsyncMutex::new(false),
            #[cfg(unix)]
            launch_gate: AsyncMutex::new(()),
        }
    }

    pub fn with_runtime_registry(log_store: LogStore, runtime_registry: RuntimeRegistry) -> Self {
        Self {
            runtime_registry: Some(runtime_registry),
            ..Self::new(log_store)
        }
    }

    /// Run compose verbs through something other than the Docker CLI. Only a
    /// test has any reason to: it is how the compose paths are exercised on a
    /// machine that has no Docker installed.
    #[cfg(test)]
    fn with_compose_program(mut self, program: impl Into<String>) -> Self {
        self.compose = Compose::with_program(program);
        self
    }

    /// Record lifecycle moments on a timeline. Optional because only the daemon
    /// keeps one; Tauri runs services without it.
    pub fn with_timeline(mut self, timeline: TimelineStore) -> Self {
        self.timeline = Some(timeline);
        self
    }

    /// The most recent timeline events, oldest first. Empty when this manager
    /// keeps no timeline.
    pub fn timeline(&self, limit: usize) -> Vec<TimelineEvent> {
        self.timeline
            .as_ref()
            .map(|timeline| timeline.read(limit))
            .unwrap_or_default()
    }

    fn record(&self, event: NewTimelineEvent) {
        if let Some(timeline) = &self.timeline {
            timeline.append(event);
        }
    }

    #[cfg(test)]
    fn with_stop_policy(log_store: LogStore, stop_policy: StopPolicy) -> Self {
        Self {
            stop_policy,
            ..Self::new(log_store)
        }
    }

    pub fn status(&self) -> Vec<ServiceStatus> {
        let procs = self.processes.lock().unwrap();
        procs.iter().map(|(name, p)| status_of(name, p)).collect()
    }

    pub fn service_status(&self, name: &str) -> Option<ServiceStatus> {
        let procs = self.processes.lock().unwrap();
        procs.get(name).map(|p| status_of(name, p))
    }

    /// The tail of a service's buffered output. Reading goes through the
    /// manager that writes it, so there is one owner of a service's log stream
    /// rather than two handles that can drift apart.
    pub fn logs(&self, service: &str, limit: usize) -> Vec<LogEntry> {
        self.log_store.read(service, limit)
    }

    pub fn service_process_ids(&self, name: &str) -> Option<(Option<u32>, Option<u32>)> {
        let procs = self.processes.lock().unwrap();
        procs.get(name).and_then(|process| {
            matches!(
                process.state,
                ServiceState::Starting | ServiceState::Running | ServiceState::Stopping
            )
            .then_some((process.pid, process.pgid))
        })
    }

    pub async fn start_service(&self, def: &ServiceDef) -> Result<()> {
        self.start_service_with_options(def, StartServiceOptions::default())
            .await
    }

    /// Reconcile the private native runtime registry before this owner accepts
    /// process mutations. Mutation methods call the same idempotent gate as a
    /// defense in depth, but daemon startup should invoke this explicitly
    /// before publishing readiness.
    pub async fn reconcile_runtime(&self) -> Result<()> {
        self.ensure_reconciled().await
    }

    pub async fn start_service_with_options(
        &self,
        def: &ServiceDef,
        options: StartServiceOptions,
    ) -> Result<()> {
        let operation = self.operation_lock(&def.name).await;
        let _guard = operation.lock().await;
        self.ensure_reconciled().await?;
        let started = self.start_service_locked(def, &options).await;
        // Recorded here rather than deeper in, so every reason a start can fail
        // — an occupied port, a definition that will not spawn, an unfinished
        // prior generation — reaches the timeline through one place.
        if let Err(error) = &started {
            self.record(
                NewTimelineEvent::new(
                    TimelineEventKind::ServiceLifecycle,
                    TimelineSeverity::Error,
                    format!("{} failed", def.name),
                )
                .service(def.name.clone())
                .detail(error.to_string()),
            );
        }
        started
    }

    async fn start_service_locked(
        &self,
        def: &ServiceDef,
        options: &StartServiceOptions,
    ) -> Result<()> {
        if let Some(process) = self.processes.lock().unwrap().get(&def.name) {
            match process.state {
                ServiceState::Running | ServiceState::Starting => return Ok(()),
                ServiceState::Stopping => {
                    return Err(anyhow!("Service '{}' is still stopping", def.name))
                }
                ServiceState::Stopped | ServiceState::Exited if !process.cleanup_confirmed => {
                    return Err(anyhow!(
                        "Service '{}' cannot start until its prior process group is cleaned up",
                        def.name
                    ))
                }
                ServiceState::Stopped | ServiceState::Exited => {}
            }
        }

        // Ahead of the port check on purpose, as in the reference: a compose
        // service's port is published by the Docker daemon, so a local
        // listener on it is that same service already up rather than a
        // conflict to refuse.
        if def.effective_kind() == "docker-compose" {
            return self.start_docker_compose(def).await;
        }

        if let Some(port) = def.port {
            if !is_port_available("127.0.0.1", port) {
                let holder = get_port_holder(port)?;
                if let Some(expected) = &options.terminate_holder {
                    terminate_port_holder(
                        port,
                        expected,
                        &self.managed_roots(),
                        self.stop_policy.term_grace,
                        self.stop_policy.kill_grace,
                    )
                    .await?;
                }
                if !is_port_available("127.0.0.1", port) {
                    return Err(PortConflictError {
                        service: def.name.clone(),
                        port,
                        holder,
                    }
                    .into());
                }
            }
        }

        match def.effective_kind() {
            "ssh" => self.start_ssh(def).await,
            _ => self.start_local(def).await,
        }
    }

    async fn start_local(&self, def: &ServiceDef) -> Result<()> {
        let command = def
            .command
            .as_deref()
            .ok_or_else(|| anyhow!("Local service missing command"))?;
        let cwd = def
            .cwd
            .as_deref()
            .ok_or_else(|| anyhow!("Local service missing cwd"))?;

        let mut cmd = if let Some(args) = &def.args {
            let mut direct = Command::new(command);
            direct.args(args);
            direct
        } else {
            let mut shell = Command::new("sh");
            shell.arg("-c").arg(command);
            shell
        };
        cmd.current_dir(cwd)
            .env("PATH", service_path())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false);
        configure_managed_process(&mut cmd);

        for (key, value) in read_dotenv(cwd).await? {
            cmd.env(key, value);
        }

        if let Some(env) = &def.env {
            for (k, v) in env {
                cmd.env(k, v);
            }
        }

        self.spawn_and_register(def, cmd).await
    }

    /// Bring a compose service up and track the container it left behind.
    ///
    /// `docker compose up -d` returns once the container is started, so unlike
    /// every other kind there is no child to supervise afterwards — what runs
    /// belongs to the Docker daemon. The entry recorded here therefore has no
    /// pid, no process group, and no supervisor, and nothing is journaled: a
    /// crash of this daemon leaves the container running and nothing to
    /// reconcile, which is what the reference does too.
    async fn start_docker_compose(&self, def: &ServiceDef) -> Result<()> {
        let target = ComposeTarget::of(def)?;
        let container = self.compose.start(&target).await?;

        self.processes.lock().unwrap().insert(
            def.name.clone(),
            ManagedProcess {
                generation: self.next_generation.fetch_add(1, Ordering::Relaxed),
                kind: def.effective_kind().to_string(),
                host: None,
                container_id: container.container_id.clone(),
                compose: Some(target.clone()),
                pid: None,
                pgid: None,
                state: ServiceState::Running,
                exit_code: None,
                signal: None,
                url: None,
                started_at: Some(Utc::now()),
                exited_at: None,
                // Nothing was spawned, so there is nothing left to confirm.
                cleanup_confirmed: true,
                controller: None,
            },
        );

        self.record(
            NewTimelineEvent::new(
                TimelineEventKind::ServiceLifecycle,
                TimelineSeverity::Info,
                format!("{} started", def.name),
            )
            .service(def.name.clone())
            .data(json!({ "containerId": container.container_id })),
        );
        Ok(())
    }

    /// Take a compose service down. The container is the only thing that was
    /// ever running, so this is the whole of the stop — there is no process
    /// group to confirm and no journal entry to remove.
    async fn stop_docker_compose(&self, name: &str, target: &ComposeTarget) -> Result<()> {
        self.compose.stop(target).await?;
        {
            let mut processes = self.processes.lock().unwrap();
            if let Some(process) = processes.get_mut(name) {
                process.state = ServiceState::Stopped;
                process.exited_at = Some(Utc::now());
            }
        }
        self.record(
            NewTimelineEvent::new(
                TimelineEventKind::ServiceLifecycle,
                TimelineSeverity::Info,
                format!("{name} stopped"),
            )
            .service(name.to_string()),
        );
        Ok(())
    }

    /// A remote service is an ordinary local child: this runtime supervises the
    /// `ssh` client, and the process group it cleans up is the client's. The
    /// remote process lives and dies with that connection, exactly as it does
    /// in the reference.
    async fn start_ssh(&self, def: &ServiceDef) -> Result<()> {
        let (program, args) = ssh_command(def)?;
        let mut cmd = Command::new(program);
        cmd.args(args)
            .env("PATH", service_path())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_managed_process(&mut cmd);
        self.spawn_and_register(def, cmd).await
    }

    pub async fn stop_service(&self, name: &str) -> Result<()> {
        let operation = self.operation_lock(name).await;
        let _guard = operation.lock().await;
        self.ensure_reconciled().await?;
        self.stop_service_locked(name).await
    }

    pub async fn restart_service(&self, def: &ServiceDef) -> Result<()> {
        self.restart_service_with_options(def, StartServiceOptions::default())
            .await
    }

    pub async fn restart_service_with_options(
        &self,
        def: &ServiceDef,
        options: StartServiceOptions,
    ) -> Result<()> {
        let operation = self.operation_lock(&def.name).await;
        let _guard = operation.lock().await;
        self.ensure_reconciled().await?;
        self.stop_service_locked(&def.name).await?;
        self.start_service_locked(def, &options).await
    }

    pub async fn shutdown_all(&self) -> Result<()> {
        let names = self
            .processes
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let mut errors = Vec::new();
        for name in names {
            if let Err(error) = self.stop_service(&name).await {
                errors.push(format!("{name}: {error}"));
            }
        }
        if !errors.is_empty() {
            return Err(anyhow!(
                "Failed to stop all services: {}",
                errors.join("; ")
            ));
        }
        Ok(())
    }

    /// Emergency synchronous cleanup for host exit callbacks. Normal shutdown
    /// should use [`Self::shutdown_all`] so children are reaped and group exit
    /// is confirmed before the owner exits.
    pub fn kill_all(&self) {
        let mut procs = self.processes.lock().unwrap();
        for (_, proc) in procs.iter_mut() {
            #[cfg(unix)]
            if let Some(pgid) = proc.pgid.or(proc.pid) {
                let _ = signal_process_group(pgid, libc::SIGTERM);
            }
            #[cfg(windows)]
            if let Some(pid) = proc.pid {
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .status();
            }
            proc.state = ServiceState::Stopping;
        }
    }

    async fn operation_lock(&self, name: &str) -> Arc<AsyncMutex<()>> {
        let mut locks = self.operation_locks.lock().await;
        locks
            .entry(name.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    /// The ownership journal, but only where this platform recovers through it.
    fn journal(&self) -> Option<&RuntimeRegistry> {
        if RUNTIME_JOURNAL_SUPPORTED {
            self.runtime_registry.as_ref()
        } else {
            None
        }
    }

    fn managed_roots(&self) -> Vec<ManagedProcessRoot> {
        self.processes
            .lock()
            .unwrap()
            .values()
            .filter_map(|process| {
                process.pid.map(|pid| ManagedProcessRoot {
                    pid,
                    pgid: process.pgid,
                })
            })
            .collect()
    }

    /// Spawn a service, take ownership of its process tree, and hand it to a
    /// supervisor. On journaling platforms the child is held before `exec`
    /// until its ownership record is durable — see [`LaunchHandshake`].
    async fn spawn_and_register(&self, def: &ServiceDef, command: Command) -> Result<()> {
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        let launched = self.launch(def, generation, command).await?;
        self.register_child(def, generation, launched).await
    }

    #[cfg(unix)]
    async fn launch(
        &self,
        def: &ServiceDef,
        generation: u64,
        mut command: Command,
    ) -> Result<LaunchedProcess> {
        let Some(journal) = self.journal().cloned() else {
            return own_launched_process(def, command.spawn()?).await;
        };
        let _gate = self.launch_gate.lock().await;
        let mut handshake = LaunchHandshake::new()?;
        handshake.arm(&mut command);
        let mut spawning = tokio::task::spawn_blocking(move || command.spawn());

        // A child announces itself before it execs, so a spawn that finishes
        // first ended before this owner could journal anything. Only this step
        // races the spawn: once the child has announced itself it is parked and
        // cannot exit on its own, so the record below is written to completion.
        let announced = tokio::select! {
            spawned = &mut spawning => {
                drop(handshake);
                reap_abandoned(spawned_child(spawned)).await;
                return Err(anyhow!(
                    "Service '{}' ended before it could be journaled",
                    def.name
                ));
            }
            announced = handshake.announce(LAUNCH_ANNOUNCE_TIMEOUT) => announced,
        };

        let journaled = match announced {
            Ok((pid, pgid)) => {
                journal_launch(&journal, def, generation, &handshake, pid, pgid).await
            }
            Err(error) => Err(error),
        };
        // Closing the owner's release end is what abandons a launch: a child
        // that was never released is still parked before `exec` and leaves on
        // EOF. The announce ends stay open until the spawn resolves, so a child
        // that has not forked yet can never inherit a descriptor number this
        // owner already closed — and may already have reused.
        handshake.abandon();
        let spawned = spawning.await;
        drop(handshake);

        let context = || format!("Could not launch service '{}'", def.name);
        match journaled {
            Ok(pid) => match spawned {
                Ok(Ok(child)) if child.id().map_or(true, |spawned| spawned == pid) => {
                    match own_launched_process(def, child).await {
                        Ok(launched) => Ok(launched),
                        Err(error) => {
                            let _ = journal.remove_matching(&def.name, generation).await;
                            Err(error)
                        }
                    }
                }
                Ok(Ok(child)) => {
                    abandon_journaled_launch(&journal, def, generation, Some(child)).await;
                    Err(anyhow!(
                        "Spawned service '{}' is not the process it announced",
                        def.name
                    ))
                }
                Ok(Err(error)) => {
                    abandon_journaled_launch(&journal, def, generation, None).await;
                    Err(anyhow::Error::from(error).context(context()))
                }
                Err(error) => {
                    abandon_journaled_launch(&journal, def, generation, None).await;
                    Err(anyhow::Error::from(error).context(context()))
                }
            },
            Err(error) => {
                abandon_journaled_launch(&journal, def, generation, spawned_child(spawned)).await;
                Err(error.context(context()))
            }
        }
    }

    #[cfg(not(unix))]
    async fn launch(
        &self,
        def: &ServiceDef,
        _generation: u64,
        mut command: Command,
    ) -> Result<LaunchedProcess> {
        own_launched_process(def, command.spawn()?).await
    }

    async fn register_child(
        &self,
        def: &ServiceDef,
        generation: u64,
        launched: LaunchedProcess,
    ) -> Result<()> {
        let LaunchedProcess {
            mut child,
            pid,
            pgid,
            process_tree,
        } = launched;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let (controller, commands) = mpsc::channel(1);

        self.processes.lock().unwrap().insert(
            def.name.clone(),
            ManagedProcess {
                generation,
                kind: def.effective_kind().to_string(),
                host: launched_host(def),
                container_id: None,
                compose: None,
                pid: Some(pid),
                pgid,
                state: ServiceState::Running,
                exit_code: None,
                signal: None,
                url: None,
                started_at: Some(Utc::now()),
                exited_at: None,
                cleanup_confirmed: false,
                controller: Some(controller),
            },
        );

        self.record(
            NewTimelineEvent::new(
                TimelineEventKind::ServiceLifecycle,
                TimelineSeverity::Info,
                format!("{} started", def.name),
            )
            .service(def.name.clone())
            .data(json!({ "pid": pid })),
        );

        if let Some(out) = stdout {
            let store = self.log_store.clone();
            let name = def.name.clone();
            let processes = self.processes.clone();
            let port = def.port;
            let timeline = self.timeline.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(out).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(url) = detect_url(&line, port) {
                        let mut claimed = false;
                        {
                            let mut entries = processes.lock().unwrap();
                            if let Some(process) = entries.get_mut(&name) {
                                if process.generation == generation {
                                    process.url = Some(url.clone());
                                    claimed = true;
                                }
                            }
                        }
                        // Only the generation that owns the name announces its
                        // URL; a superseded one is talking about a service the
                        // runtime has already replaced.
                        if claimed {
                            if let Some(timeline) = &timeline {
                                timeline.append(
                                    NewTimelineEvent::new(
                                        TimelineEventKind::ServicePort,
                                        TimelineSeverity::Info,
                                        format!("{name} reported {url}"),
                                    )
                                    .service(name.clone())
                                    .detail(url),
                                );
                            }
                        }
                    }
                    store.append(LogEntry::new(&name, "stdout", &line));
                }
            });
        }

        if let Some(err) = stderr {
            let store = self.log_store.clone();
            let name = def.name.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(err).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    store.append(LogEntry::new(&name, "stderr", &line));
                }
            });
        }

        let name = def.name.clone();
        let processes = self.processes.clone();
        let policy = self.stop_policy;
        let registry = self.journal().cloned();
        let timeline = self.timeline.clone();
        tokio::spawn(async move {
            supervise_child(
                child,
                commands,
                SupervisorContext {
                    name,
                    generation,
                    pgid,
                    process_tree,
                    processes,
                    runtime_registry: registry,
                    timeline,
                    policy,
                },
            )
            .await;
        });
        Ok(())
    }

    async fn ensure_reconciled(&self) -> Result<()> {
        let Some(registry) = self.journal() else {
            return Ok(());
        };
        let mut reconciled = self.reconciled.lock().await;
        if *reconciled {
            return Ok(());
        }
        for record in registry.records().await? {
            reconcile_runtime_record(registry, &record, self.stop_policy).await?;
        }
        *reconciled = true;
        Ok(())
    }

    async fn stop_service_locked(&self, name: &str) -> Result<()> {
        // A container is not a process: it ends by asking compose to stop it,
        // and none of the process-group and journal machinery below applies.
        let compose_target = {
            let processes = self.processes.lock().unwrap();
            processes.get(name).and_then(|process| {
                (process.state != ServiceState::Stopped)
                    .then(|| process.compose.clone())
                    .flatten()
            })
        };
        if let Some(target) = compose_target {
            return self.stop_docker_compose(name, &target).await;
        }

        let target = {
            let mut processes = self.processes.lock().unwrap();
            let Some(process) = processes.get_mut(name) else {
                return Ok(());
            };
            // A stopped generation whose durable cleanup never landed is not
            // finished: fall through so the registry removal is retried.
            if process.state == ServiceState::Stopped && process.cleanup_confirmed {
                return Ok(());
            }
            if process.controller.is_none() {
                if process.cleanup_confirmed {
                    process.state = ServiceState::Stopped;
                    return Ok(());
                }
                (process.generation, None, process.pgid)
            } else {
                process.state = ServiceState::Stopping;
                (process.generation, process.controller.clone(), process.pgid)
            }
        };

        let Some(controller) = target.1 else {
            #[cfg(unix)]
            if target.2.is_some_and(process_group_exists) {
                return Err(anyhow!(
                    "Service '{name}' has no supervisor and its process-group cleanup is unconfirmed"
                ));
            }
            let Some(registry) = self.journal() else {
                return Err(anyhow!(
                    "Service '{name}' has no supervisor and cleanup is unconfirmed"
                ));
            };
            registry.remove_matching(name, target.0).await?;
            let mut processes = self.processes.lock().unwrap();
            if let Some(process) = processes.get_mut(name) {
                if process.generation == target.0 {
                    process.cleanup_confirmed = true;
                    process.state = ServiceState::Stopped;
                }
            }
            return Ok(());
        };

        let (reply, result) = oneshot::channel();
        if controller
            .send(SupervisorCommand::Stop { reply })
            .await
            .is_err()
        {
            let mut processes = self.processes.lock().unwrap();
            if let Some(process) = processes.get_mut(name) {
                if process.generation == target.0
                    && matches!(process.state, ServiceState::Exited | ServiceState::Stopped)
                    && process.cleanup_confirmed
                {
                    process.state = ServiceState::Stopped;
                    return Ok(());
                }
            }
            return Err(anyhow!("Service '{name}' supervisor stopped unexpectedly"));
        }
        match result.await {
            Ok(result) => result.map_err(|error| anyhow!(error)),
            Err(_) => {
                let mut processes = self.processes.lock().unwrap();
                if let Some(process) = processes.get_mut(name) {
                    if process.generation == target.0
                        && matches!(process.state, ServiceState::Exited | ServiceState::Stopped)
                        && process.cleanup_confirmed
                    {
                        process.state = ServiceState::Stopped;
                        return Ok(());
                    }
                }
                Err(anyhow!("Service '{name}' supervisor stopped unexpectedly"))
            }
        }
    }
}

async fn remove_runtime_record(
    registry: Option<&RuntimeRegistry>,
    name: &str,
    generation: u64,
) -> Result<()> {
    if let Some(registry) = registry {
        registry.remove_matching(name, generation).await?;
    }
    Ok(())
}

/// A spawned service whose process tree this owner has taken over.
struct LaunchedProcess {
    child: Child,
    pid: u32,
    pgid: Option<u32>,
    process_tree: ProcessTreeGuard,
}

#[cfg(unix)]
fn spawned_child(
    spawned: std::result::Result<std::io::Result<Child>, tokio::task::JoinError>,
) -> Option<Child> {
    match spawned {
        Ok(Ok(child)) => Some(child),
        _ => None,
    }
}

async fn own_launched_process(def: &ServiceDef, mut child: Child) -> Result<LaunchedProcess> {
    let Some(pid) = child.id() else {
        let _ = child.wait().await;
        return Err(anyhow!("Spawned service '{}' has no process id", def.name));
    };
    let process_tree = match ProcessTreeGuard::attach(&child) {
        Ok(process_tree) => process_tree,
        Err(error) => {
            force_kill_spawned(&mut child, pid).await;
            return Err(error.context(format!(
                "Could not establish process-tree ownership for service '{}'",
                def.name
            )));
        }
    };
    if let Err(error) = process_tree.resume(pid) {
        force_kill_spawned(&mut child, pid).await;
        return Err(error.context(format!(
            "Could not resume owned process tree for service '{}'",
            def.name
        )));
    }
    Ok(LaunchedProcess {
        child,
        pid,
        pgid: Some(pid),
        process_tree,
    })
}

/// Make the announced child's exact identity durable, and only then release it
/// to `exec`.
#[cfg(unix)]
async fn journal_launch(
    journal: &RuntimeRegistry,
    def: &ServiceDef,
    generation: u64,
    handshake: &LaunchHandshake,
    pid: u32,
    pgid: u32,
) -> Result<u32> {
    if pgid != pid {
        return Err(anyhow!(
            "Spawned service '{}' did not own its process group",
            def.name
        ));
    }
    let start_token = process_start_token(pid)?.ok_or_else(|| {
        anyhow!(
            "Spawned service '{}' vanished before it could be journaled",
            def.name
        )
    })?;
    let owner_pid = std::process::id();
    let owner_start_token = process_start_token(owner_pid)?
        .ok_or_else(|| anyhow!("Could not capture runtime owner identity"))?;
    abort_at_launch_stage("announced");
    journal
        .record(RuntimeRecord {
            name: def.name.clone(),
            generation,
            pid,
            pgid,
            uid: Some(unsafe { libc::geteuid() }),
            command: launch_description(def),
            start_token,
            owner_pid,
            owner_start_token,
        })
        .await?;
    abort_at_launch_stage("journaled");
    handshake.release()?;
    Ok(pid)
}

/// Undo a launch this owner could not complete: kill whatever was spawned and
/// drop the record, so the name is startable again.
#[cfg(unix)]
async fn abandon_journaled_launch(
    journal: &RuntimeRegistry,
    def: &ServiceDef,
    generation: u64,
    child: Option<Child>,
) {
    reap_abandoned(child).await;
    let _ = journal.remove_matching(&def.name, generation).await;
}

#[cfg(unix)]
async fn reap_abandoned(child: Option<Child>) {
    let Some(mut child) = child else {
        return;
    };
    match child.id() {
        Some(pid) => force_kill_spawned(&mut child, pid).await,
        None => {
            let _ = child.wait().await;
        }
    }
}

/// Human-readable label for the journal. Identity is the pid plus the kernel
/// start token and never this string, so it carries no environment values.
#[cfg(unix)]
fn launch_description(def: &ServiceDef) -> String {
    let mut parts = vec![def.effective_kind().to_string()];
    parts.extend(def.command.clone());
    if let Some(args) = &def.args {
        parts.extend(args.iter().cloned());
    }
    parts.join(" ")
}

/// Deliberate abort points inside the launch window. Inert unless the
/// environment names the exact stage; the crash-recovery test uses it to kill
/// an owner *inside* the window instead of guessing at its timing from outside.
#[cfg(unix)]
fn abort_at_launch_stage(stage: &str) {
    if std::env::var_os("NOMOREIDE_UNSAFE_TEST_ABORT_AT_LAUNCH_STAGE")
        .is_some_and(|requested| requested == stage)
    {
        std::process::abort();
    }
}

/// A launch the child cannot escape until this owner has journaled it.
///
/// `std`'s spawn blocks its caller until the child execs, so inspecting the
/// child after `spawn()` returns is already too late — the service is running
/// by then. Instead the child announces its own pid over one pipe and parks on
/// a second one while a different task records it, so the ownership record is
/// durable *before* any service code runs. If this owner dies anywhere inside
/// that window its pipe ends close, the child reads EOF and exits without ever
/// executing the service: a crash cannot leave a live unjournaled process
/// group behind.
#[cfg(unix)]
struct LaunchHandshake {
    announce_read: OwnedFd,
    announce_write: OwnedFd,
    release_read: OwnedFd,
    /// Taken by [`LaunchHandshake::abandon`]; a launch is abandoned by closing
    /// this end and nothing else.
    release_write: Option<OwnedFd>,
}

#[cfg(unix)]
impl LaunchHandshake {
    fn new() -> Result<Self> {
        let (announce_read, announce_write) = close_on_exec_pipe()?;
        let (release_read, release_write) = close_on_exec_pipe()?;
        set_non_blocking(&announce_read)?;
        Ok(Self {
            announce_read,
            announce_write,
            release_read,
            release_write: Some(release_write),
        })
    }

    /// Install the child half. Everything it runs sits between `fork` and
    /// `exec`, so only async-signal-safe calls are allowed there.
    fn arm(&self, command: &mut Command) {
        let announce_read = self.announce_read.as_raw_fd();
        let announce_write = self.announce_write.as_raw_fd();
        let release_read = self.release_read.as_raw_fd();
        // Always armed before anything can abandon the launch.
        let release_write = self
            .release_write
            .as_ref()
            .map_or(-1, |descriptor| descriptor.as_raw_fd());
        unsafe {
            command.pre_exec(move || {
                // Drop the owner's ends: a child holding its own abandonment
                // signal open would never see EOF.
                libc::close(announce_read);
                libc::close(release_write);

                let mut announcement = [0u8; 8];
                announcement[..4].copy_from_slice(&(libc::getpid() as u32).to_ne_bytes());
                announcement[4..].copy_from_slice(&(libc::getpgrp() as u32).to_ne_bytes());
                write_all_raw(announce_write, &announcement)?;
                libc::close(announce_write);

                let mut release = [0u8; 1];
                loop {
                    match libc::read(release_read, release.as_mut_ptr().cast(), 1) {
                        1 => break,
                        // The owner died before it could journal this launch.
                        0 => libc::_exit(LAUNCH_ABANDONED_EXIT_CODE),
                        _ => {
                            let error = std::io::Error::last_os_error();
                            if error.raw_os_error() != Some(libc::EINTR) {
                                return Err(error);
                            }
                        }
                    }
                }
                libc::close(release_read);
                Ok(())
            });
        }
    }

    /// Wait for the parked child to report the identity it forked with.
    async fn announce(&self, timeout: Duration) -> Result<(u32, u32)> {
        let fd = self.announce_read.as_raw_fd();
        let deadline = Instant::now() + timeout;
        let mut announcement = [0u8; 8];
        let mut filled = 0;
        while filled < announcement.len() {
            let read = unsafe {
                libc::read(
                    fd,
                    announcement[filled..].as_mut_ptr().cast(),
                    announcement.len() - filled,
                )
            };
            if read > 0 {
                filled += read as usize;
                continue;
            }
            if read == 0 {
                return Err(anyhow!("the launch ended before it announced itself"));
            }
            let error = std::io::Error::last_os_error();
            if !matches!(error.raw_os_error(), Some(libc::EAGAIN) | Some(libc::EINTR)) {
                return Err(error.into());
            }
            if Instant::now() >= deadline {
                return Err(anyhow!("the launch did not announce itself in time"));
            }
            sleep(LAUNCH_ANNOUNCE_POLL).await;
        }
        let mut pid = [0u8; 4];
        let mut pgid = [0u8; 4];
        pid.copy_from_slice(&announcement[..4]);
        pgid.copy_from_slice(&announcement[4..]);
        Ok((u32::from_ne_bytes(pid), u32::from_ne_bytes(pgid)))
    }

    /// Let the journaled child proceed to `exec`.
    fn release(&self) -> Result<()> {
        let release_write = self
            .release_write
            .as_ref()
            .ok_or_else(|| anyhow!("the launch was already abandoned"))?;
        write_all_raw(release_write.as_raw_fd(), &[1u8])?;
        Ok(())
    }

    /// Abandon whatever this launch produced. A child already parked before
    /// `exec` reads EOF and leaves; a child that has not forked yet inherits no
    /// write end at all and leaves the same way.
    fn abandon(&mut self) {
        self.release_write.take();
    }
}

#[cfg(unix)]
fn close_on_exec_pipe() -> Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0 as libc::c_int; 2];
    #[cfg(target_os = "linux")]
    let created = unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) };
    #[cfg(not(target_os = "linux"))]
    let created = unsafe { libc::pipe(fds.as_mut_ptr()) };
    if created == -1 {
        return Err(std::io::Error::last_os_error().into());
    }
    let read = unsafe { OwnedFd::from_raw_fd(fds[0]) };
    let write = unsafe { OwnedFd::from_raw_fd(fds[1]) };
    #[cfg(not(target_os = "linux"))]
    {
        // Only Linux can create the pipe close-on-exec atomically. Elsewhere a
        // `fork` between `pipe` and this `fcntl` hands that child copies whose
        // close-on-exec flag was taken before it was set, so they survive its
        // `exec` and hold the abandonment signal open for as long as that
        // process lives. An abandoned child then stays parked instead of
        // leaving on EOF — it still never executes the service, and the next
        // owner reclaims its journaled process group.
        set_descriptor_flag(&read, libc::FD_CLOEXEC)?;
        set_descriptor_flag(&write, libc::FD_CLOEXEC)?;
    }
    Ok((read, write))
}

#[cfg(all(unix, not(target_os = "linux")))]
fn set_descriptor_flag(descriptor: &OwnedFd, flag: libc::c_int) -> Result<()> {
    let fd = descriptor.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags == -1 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | flag) } == -1 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

#[cfg(unix)]
fn set_non_blocking(descriptor: &OwnedFd) -> Result<()> {
    let fd = descriptor.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags == -1 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

/// `write` that survives short writes and interruptions. Called between `fork`
/// and `exec`, so it must stay allocation-free and async-signal-safe.
#[cfg(unix)]
fn write_all_raw(fd: libc::c_int, buffer: &[u8]) -> std::io::Result<()> {
    let mut written = 0;
    while written < buffer.len() {
        let result = unsafe {
            libc::write(
                fd,
                buffer[written..].as_ptr().cast(),
                buffer.len() - written,
            )
        };
        if result > 0 {
            written += result as usize;
            continue;
        }
        if result == 0 {
            return Err(std::io::Error::from_raw_os_error(libc::EIO));
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EINTR) {
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(unix)]
async fn force_kill_spawned(child: &mut Child, pid: u32) {
    let _ = signal_process_group(pid, libc::SIGKILL);
    let _ = child.wait().await;
}

#[cfg(windows)]
async fn force_kill_spawned(child: &mut Child, pid: u32) {
    if taskkill_process_tree(pid, true).await.is_err() {
        let _ = child.kill().await;
    }
    let _ = child.wait().await;
}

#[cfg(all(not(unix), not(windows)))]
async fn force_kill_spawned(child: &mut Child, _pid: u32) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}

#[cfg(unix)]
async fn reconcile_runtime_record(
    registry: &RuntimeRegistry,
    record: &RuntimeRecord,
    policy: StopPolicy,
) -> Result<()> {
    if let Some(owner) = inspect_process_identity(record.owner_pid)? {
        if owner.start_token == record.owner_start_token {
            return Err(anyhow!(
                "Runtime owner {} is still alive for service '{}'",
                record.owner_pid,
                record.name
            ));
        }
    }

    let Some(identity) = inspect_process_identity(record.pid)? else {
        if process_group_exists(record.pgid) {
            return Err(anyhow!(
                "Runtime leader is gone but process group {} remains for service '{}'",
                record.pgid,
                record.name
            ));
        }
        registry
            .remove_matching(&record.name, record.generation)
            .await?;
        return Ok(());
    };
    // `pid` plus the kernel start token is the exact identity of one process
    // instance — pid reuse yields a different token. The recorded command is a
    // human-readable label captured before `exec`, so it is deliberately not
    // part of this check.
    let identity_matches = identity.pid == record.pid
        && identity.pgid == Some(record.pgid)
        && identity.uid == record.uid
        && identity.start_token == record.start_token;
    if !identity_matches || identity.uid != Some(unsafe { libc::geteuid() }) {
        return Err(anyhow!(
            "Refusing to clean unverified runtime record for service '{}'",
            record.name
        ));
    }

    signal_process_group(record.pgid, libc::SIGTERM)?;
    if !wait_for_process_group_exit(record.pgid, policy.term_grace, policy.poll_interval).await {
        let current = inspect_process_identity(record.pid)?;
        let still_matches = current.as_ref().is_some_and(|current| {
            current.pgid == Some(record.pgid) && current.start_token == record.start_token
        });
        if !still_matches {
            return Err(anyhow!(
                "Runtime process identity changed before escalation for service '{}'",
                record.name
            ));
        }
        signal_process_group(record.pgid, libc::SIGKILL)?;
        if !wait_for_process_group_exit(record.pgid, policy.kill_grace, policy.poll_interval).await
        {
            return Err(anyhow!(
                "Orphan cleanup was not confirmed for service '{}'",
                record.name
            ));
        }
    }
    registry
        .remove_matching(&record.name, record.generation)
        .await?;
    Ok(())
}

#[cfg(not(unix))]
async fn reconcile_runtime_record(
    _registry: &RuntimeRegistry,
    record: &RuntimeRecord,
    _policy: StopPolicy,
) -> Result<()> {
    Err(anyhow!(
        "Runtime crash recovery is not supported for service '{}' on this platform",
        record.name
    ))
}

#[cfg(unix)]
async fn wait_for_process_group_exit(
    pgid: u32,
    timeout: Duration,
    poll_interval: Duration,
) -> bool {
    let deadline = Instant::now() + timeout;
    while process_group_exists(pgid) {
        if Instant::now() >= deadline {
            return false;
        }
        sleep(poll_interval).await;
    }
    true
}

async fn supervise_child(
    mut child: Child,
    mut commands: mpsc::Receiver<SupervisorCommand>,
    context: SupervisorContext,
) {
    let mut stop_requested = false;
    loop {
        tokio::select! {
            status = child.wait() => {
                let termination = status.map(Termination::of).unwrap_or_default();
                let group_cleanup = cleanup_after_natural_exit(
                    context.pgid,
                    context.policy,
                    &context.process_tree,
                )
                .await;
                if !group_cleanup {
                    mark_generation_cleanup_failed(
                        &context.processes,
                        &context.name,
                        context.generation,
                        if stop_requested { ServiceState::Stopping } else { ServiceState::Exited },
                    );
                    await_reaped_child_cleanup(
                        &mut commands,
                        &context,
                        termination,
                    ).await;
                    return;
                }
                let registry_cleanup = remove_runtime_record(
                    context.runtime_registry.as_ref(),
                    &context.name,
                    context.generation,
                ).await.is_ok();
                let state = if stop_requested { ServiceState::Stopped } else { ServiceState::Exited };
                finish_generation(
                    &context.processes,
                    &context.name,
                    context.generation,
                    state.clone(),
                    termination,
                    group_cleanup && registry_cleanup,
                );
                context.record_termination(state, termination);
                return;
            }
            Some(SupervisorCommand::Stop { reply }) = commands.recv() => {
                stop_requested = true;
                let outcome = stop_child_and_group(
                    &mut child,
                    context.pgid,
                    context.policy,
                    &context.process_tree,
                )
                .await;
                match outcome {
                    Ok(termination) => {
                        let registry_result = remove_runtime_record(
                            context.runtime_registry.as_ref(),
                            &context.name,
                            context.generation,
                        ).await;
                        let registry_cleanup = registry_result.is_ok();
                        finish_generation(
                            &context.processes,
                            &context.name,
                            context.generation,
                            ServiceState::Stopped,
                            termination,
                            registry_cleanup,
                        );
                        context.record_termination(ServiceState::Stopped, termination);
                        let result = registry_result
                            .map_err(|error| format!("Failed to update runtime registry: {error}"));
                        let _ = reply.send(result);
                        return;
                    }
                    Err(error) => {
                        mark_generation_cleanup_failed(
                            &context.processes,
                            &context.name,
                            context.generation,
                            ServiceState::Stopping,
                        );
                        let _ = reply.send(Err(error.to_string()));
                        if child.id().is_none() {
                            await_reaped_child_cleanup(
                                &mut commands,
                                &context,
                                Termination::default(),
                            )
                            .await;
                            return;
                        }
                    }
                }
            }
        }
    }
}

async fn await_reaped_child_cleanup(
    commands: &mut mpsc::Receiver<SupervisorCommand>,
    context: &SupervisorContext,
    termination: Termination,
) {
    while let Some(SupervisorCommand::Stop { reply }) = commands.recv().await {
        if !cleanup_after_natural_exit(context.pgid, context.policy, &context.process_tree).await {
            let _ = reply.send(Err(
                "process-tree cleanup cannot be confirmed after the root exited".into(),
            ));
            continue;
        }
        let registry_result = remove_runtime_record(
            context.runtime_registry.as_ref(),
            &context.name,
            context.generation,
        )
        .await;
        let registry_cleanup = registry_result.is_ok();
        finish_generation(
            &context.processes,
            &context.name,
            context.generation,
            ServiceState::Stopped,
            termination,
            registry_cleanup,
        );
        context.record_termination(ServiceState::Stopped, termination);
        let result =
            registry_result.map_err(|error| format!("Failed to update runtime registry: {error}"));
        let _ = reply.send(result);
        return;
    }
}

fn mark_generation_cleanup_failed(
    processes: &Arc<Mutex<HashMap<String, ManagedProcess>>>,
    name: &str,
    generation: u64,
    state: ServiceState,
) {
    let mut entries = processes.lock().unwrap();
    if let Some(process) = entries.get_mut(name) {
        if process.generation == generation {
            process.state = state;
            process.cleanup_confirmed = false;
        }
    }
}

/// The one place a generation's terminal state settles. Everything a reader
/// needs to describe the end of a run — when, and how — is stamped here
/// together, because a caller that recorded only half of it would leave a
/// status that cannot say whether the process ended at all. The timestamp is
/// when this runtime settled the ending, which for a process tree whose
/// cleanup had to be retried is later than the root's own exit.
fn finish_generation(
    processes: &Arc<Mutex<HashMap<String, ManagedProcess>>>,
    name: &str,
    generation: u64,
    state: ServiceState,
    termination: Termination,
    cleanup_confirmed: bool,
) {
    let mut entries = processes.lock().unwrap();
    if let Some(process) = entries.get_mut(name) {
        if process.generation == generation {
            process.state = state;
            process.exit_code = termination.exit_code;
            process.signal = termination.signal_name();
            process.exited_at = Some(Utc::now());
            process.cleanup_confirmed = cleanup_confirmed;
            process.controller = None;
        }
    }
}

/// How a child ended. A process killed by a signal has no exit code, so
/// reporting only the code says nothing at all about the most interesting way
/// for a service to die.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Termination {
    exit_code: Option<i32>,
    signal: Option<i32>,
}

impl Termination {
    fn of(status: std::process::ExitStatus) -> Self {
        Self {
            exit_code: status.code(),
            signal: exit_signal(&status),
        }
    }

    /// Signals are reported by name, the way every reader of a status or a
    /// timeline entry already thinks of them. An unrecognised number — nothing
    /// in the table below, so a real-time signal no service is plausibly killed
    /// with — reports as no signal rather than as an invented name.
    fn signal_name(&self) -> Option<String> {
        self.signal.and_then(signal_name).map(str::to_string)
    }
}

/// Signal numbers are platform-specific (`SIGUSR1` is 10 on Linux and 30 on
/// macOS), so the table is built from the target's own constants rather than
/// from numbers written out here. A lookup rather than a `match` because
/// several names share a number on some targets.
#[cfg(unix)]
pub(crate) fn signal_name(signal: i32) -> Option<&'static str> {
    const NAMES: &[(libc::c_int, &str)] = &[
        (libc::SIGHUP, "SIGHUP"),
        (libc::SIGINT, "SIGINT"),
        (libc::SIGQUIT, "SIGQUIT"),
        (libc::SIGILL, "SIGILL"),
        (libc::SIGTRAP, "SIGTRAP"),
        (libc::SIGABRT, "SIGABRT"),
        (libc::SIGBUS, "SIGBUS"),
        (libc::SIGFPE, "SIGFPE"),
        (libc::SIGKILL, "SIGKILL"),
        (libc::SIGUSR1, "SIGUSR1"),
        (libc::SIGSEGV, "SIGSEGV"),
        (libc::SIGUSR2, "SIGUSR2"),
        (libc::SIGPIPE, "SIGPIPE"),
        (libc::SIGALRM, "SIGALRM"),
        (libc::SIGTERM, "SIGTERM"),
        (libc::SIGCHLD, "SIGCHLD"),
        (libc::SIGCONT, "SIGCONT"),
        (libc::SIGSTOP, "SIGSTOP"),
        (libc::SIGTSTP, "SIGTSTP"),
        (libc::SIGTTIN, "SIGTTIN"),
        (libc::SIGTTOU, "SIGTTOU"),
        (libc::SIGURG, "SIGURG"),
        (libc::SIGXCPU, "SIGXCPU"),
        (libc::SIGXFSZ, "SIGXFSZ"),
        (libc::SIGVTALRM, "SIGVTALRM"),
        (libc::SIGPROF, "SIGPROF"),
        (libc::SIGWINCH, "SIGWINCH"),
        (libc::SIGIO, "SIGIO"),
        (libc::SIGSYS, "SIGSYS"),
    ];
    NAMES
        .iter()
        .find(|(number, _)| *number == signal)
        .map(|(_, name)| *name)
}

#[cfg(not(unix))]
pub(crate) fn signal_name(_signal: i32) -> Option<&'static str> {
    None
}

#[cfg(unix)]
fn exit_signal(status: &std::process::ExitStatus) -> Option<i32> {
    std::os::unix::process::ExitStatusExt::signal(status)
}

#[cfg(not(unix))]
fn exit_signal(_status: &std::process::ExitStatus) -> Option<i32> {
    None
}

async fn stop_child_and_group(
    child: &mut Child,
    pgid: Option<u32>,
    policy: StopPolicy,
    process_tree: &ProcessTreeGuard,
) -> Result<Termination> {
    #[cfg(unix)]
    if let Some(group) = pgid {
        signal_process_group(group, libc::SIGTERM)?;
    }
    #[cfg(windows)]
    let graceful_error = taskkill_process_tree(
        child
            .id()
            .ok_or_else(|| anyhow!("process exited before its tree could be terminated"))?,
        false,
    )
    .await
    .err();
    #[cfg(all(not(unix), not(windows)))]
    child.start_kill()?;

    let mut termination = Termination::default();
    #[cfg(windows)]
    let should_wait_for_graceful_exit = graceful_error.is_none();
    #[cfg(not(windows))]
    let should_wait_for_graceful_exit = true;
    if should_wait_for_graceful_exit
        && wait_for_child_and_group(
            child,
            pgid,
            policy.term_grace,
            policy.poll_interval,
            &mut termination,
            process_tree,
        )
        .await?
    {
        return Ok(termination);
    }

    #[cfg(unix)]
    if let Some(group) = pgid {
        signal_process_group(group, libc::SIGKILL)?;
    }
    #[cfg(windows)]
    if let Err(force_error) = process_tree.terminate() {
        return Err(match graceful_error {
            Some(graceful_error) => anyhow!(
                "graceful Windows tree termination failed ({graceful_error}); forced termination failed ({force_error})"
            ),
            None => force_error,
        });
    }
    #[cfg(all(not(unix), not(windows)))]
    child.start_kill()?;

    if wait_for_child_and_group(
        child,
        pgid,
        policy.kill_grace,
        policy.poll_interval,
        &mut termination,
        process_tree,
    )
    .await?
    {
        Ok(termination)
    } else {
        Err(anyhow!("process-group termination was not confirmed"))
    }
}

#[cfg(windows)]
async fn taskkill_process_tree(pid: u32, force: bool) -> Result<()> {
    let pid = pid.to_string();
    let mut command = Command::new("taskkill");
    command.args(["/PID", &pid, "/T"]);
    if force {
        command.arg("/F");
    }
    let output = command.output().await?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(anyhow!(
        "Windows process-tree termination failed for pid {pid}: {detail}"
    ))
}

async fn wait_for_child_and_group(
    child: &mut Child,
    pgid: Option<u32>,
    timeout: Duration,
    poll_interval: Duration,
    termination: &mut Termination,
    process_tree: &ProcessTreeGuard,
) -> Result<bool> {
    #[cfg(not(windows))]
    let _ = process_tree;
    #[cfg(windows)]
    let _ = pgid;
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            *termination = Termination::of(status);
        }
        let child_reaped = child.id().is_none();
        #[cfg(unix)]
        let group_gone = pgid.map_or(true, |group| !process_group_exists(group));
        #[cfg(windows)]
        let group_gone = process_tree.is_empty()?;
        #[cfg(all(not(unix), not(windows)))]
        let group_gone = true;
        if child_reaped && group_gone {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        sleep(poll_interval).await;
    }
}

async fn cleanup_after_natural_exit(
    pgid: Option<u32>,
    policy: StopPolicy,
    process_tree: &ProcessTreeGuard,
) -> bool {
    #[cfg(not(windows))]
    let _ = process_tree;
    #[cfg(unix)]
    {
        let Some(group) = pgid else {
            return true;
        };
        if !process_group_exists(group) {
            return true;
        }
        if signal_process_group(group, libc::SIGKILL).is_err() {
            return false;
        }
        let deadline = Instant::now() + policy.kill_grace;
        while process_group_exists(group) {
            if Instant::now() >= deadline {
                return false;
            }
            sleep(policy.poll_interval).await;
        }
        true
    }
    #[cfg(windows)]
    {
        let _ = pgid;
        if process_tree.terminate().is_err() {
            return false;
        }
        let deadline = Instant::now() + policy.kill_grace;
        loop {
            match process_tree.is_empty() {
                Ok(true) => return true,
                Ok(false) => {}
                Err(_) => return false,
            }
            if Instant::now() >= deadline {
                return false;
            }
            sleep(policy.poll_interval).await;
        }
    }
    #[cfg(all(not(unix), not(windows)))]
    {
        let _ = (pgid, policy, process_tree);
        true
    }
}

#[cfg(unix)]
fn signal_process_group(pgid: u32, signal: libc::c_int) -> std::io::Result<()> {
    let pgid = libc::pid_t::try_from(pgid)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid pgid"))?;
    let result = unsafe { libc::kill(-pgid, signal) };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

#[cfg(unix)]
fn process_group_exists(pgid: u32) -> bool {
    let Ok(pgid) = libc::pid_t::try_from(pgid) else {
        return false;
    };
    let result = unsafe { libc::kill(-pgid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

async fn read_dotenv(cwd: &str) -> Result<HashMap<String, String>> {
    let path = std::path::Path::new(cwd).join(".env");
    let content = match tokio::fs::read_to_string(path).await {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => return Err(error.into()),
    };
    Ok(parse_dotenv(&content))
}

fn parse_dotenv(content: &str) -> HashMap<String, String> {
    content
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim_start();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                return None;
            }
            let (key, raw_value) = line.split_once('=')?;
            if !is_env_key(key) {
                return None;
            }
            let value = if raw_value.len() >= 2
                && ((raw_value.starts_with('"') && raw_value.ends_with('"'))
                    || (raw_value.starts_with('\'') && raw_value.ends_with('\'')))
            {
                let inner = &raw_value[1..raw_value.len() - 1];
                if raw_value.starts_with('"') {
                    inner.replace("\\\"", "\"").replace("\\n", "\n")
                } else {
                    inner.to_string()
                }
            } else {
                raw_value.to_string()
            };
            Some((key.to_string(), value))
        })
        .collect()
}

/// The host a launch is answerable to. Only a remote service has one, so the
/// field is absent rather than empty for everything else — the reference draws
/// the same line.
fn launched_host(def: &ServiceDef) -> Option<String> {
    (def.effective_kind() == "ssh")
        .then(|| def.host.clone())
        .flatten()
}

/// The argv that runs a registered service on its host, built the way the
/// reference builds it: one `ssh <host> <remote>` invocation whose remote
/// string is `cd <cwd> && <env> exec <command>`. Nothing is passed through a
/// local shell, so the escaping here is the remote shell's, not this one's.
///
/// Every value is rejected rather than defaulted. A remote service with no
/// `cwd` would otherwise run in the login directory, which is a different
/// service from the one that was registered.
fn ssh_command(def: &ServiceDef) -> Result<(String, Vec<String>)> {
    let missing = || {
        anyhow!(
            "Service \"{}\" is missing ssh host, cwd, or command.",
            def.name
        )
    };
    let host = def
        .host
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(missing)?;
    let cwd = def
        .cwd
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(missing)?;
    let command = def
        .command
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(missing)?;
    if command.contains('\0') {
        return Err(anyhow!("SSH command contains invalid null byte."));
    }

    let remote = format!(
        "cd {} && {}exec {command}",
        shell_escape(cwd),
        ssh_env_prefix(def.env.as_ref())?
    );
    Ok(("ssh".to_string(), vec![host.to_string(), remote]))
}

/// Assignments that prefix the remote command. Sorted by name because the
/// config parses `env` into a `HashMap`, which has no insertion order left to
/// preserve — the reference emits them in the order the file listed them. The
/// remote environment is identical either way; only the argv text differs.
///
/// The name rule here is stricter than [`is_env_key`] on purpose: these names
/// are pasted into a remote shell as assignments, where a dot is not a legal
/// identifier, while a `.env` file may legitimately carry a dotted key.
fn ssh_env_prefix(env: Option<&HashMap<String, String>>) -> Result<String> {
    let Some(env) = env.filter(|env| !env.is_empty()) else {
        return Ok(String::new());
    };
    let mut entries = env.iter().collect::<Vec<_>>();
    entries.sort_by_key(|(key, _)| *key);
    let assignments = entries
        .into_iter()
        .map(|(key, value)| {
            if !is_shell_assignable(key) {
                return Err(anyhow!("Invalid environment variable name: {key}"));
            }
            Ok(format!("{key}={}", shell_escape(value)))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(format!("{} ", assignments.join(" ")))
}

/// `^[A-Za-z_][A-Za-z0-9_]*$` — a name a shell will accept on the left of an
/// assignment.
fn is_shell_assignable(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some('_') | Some('a'..='z') | Some('A'..='Z'))
        && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn is_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some('_') | Some('a'..='z') | Some('A'..='Z'))
        && chars.all(|ch| ch == '_' || ch == '.' || ch.is_ascii_alphanumeric())
}

fn shell_escape(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(unix)]
fn configure_managed_process(cmd: &mut Command) {
    cmd.process_group(0);
}

#[cfg(windows)]
fn configure_managed_process(cmd: &mut Command) {
    cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_SUSPENDED);
}

#[cfg(all(not(unix), not(windows)))]
fn configure_managed_process(_cmd: &mut Command) {}

fn detect_url(line: &str, port: Option<u16>) -> Option<String> {
    // Match "http://localhost:3000" or "Local: http://localhost:3000"
    let re = regex::Regex::new(r"https?://[^\s]+").ok()?;
    if let Some(m) = re.find(line) {
        return Some(
            m.as_str()
                .trim_end_matches([',', '.', ';', ')'])
                .to_string(),
        );
    }
    // Try to build from port if mentioned
    if let Some(p) = port {
        if line.contains(&p.to_string()) {
            return Some(format!("http://localhost:{p}"));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[cfg(unix)]
    use std::path::PathBuf;
    #[cfg(unix)]
    use std::time::Instant;

    #[test]
    fn dotenv_parser_matches_service_precedence_inputs() {
        assert_eq!(
            parse_dotenv(
                "# comment\nPLAIN=value\nQUOTED=\"hello world\"\nSINGLE='kept literal'\nDOTTED.KEY=accepted\nBAD-NAME=nope\n"
            ),
            HashMap::from([
                ("PLAIN".into(), "value".into()),
                ("QUOTED".into(), "hello world".into()),
                ("SINGLE".into(), "kept literal".into()),
                ("DOTTED.KEY".into(), "accepted".into()),
            ])
        );
    }

    #[test]
    fn shell_escape_protects_ssh_env_and_cwd_values() {
        assert_eq!(shell_escape("app's value"), "'app'\\''s value'");
        assert!(is_env_key("NODE_ENV"));
        assert!(is_env_key("NODE.ENV"));
        assert!(!is_env_key("NODE-ENV"));
    }

    fn ssh_service(value: serde_json::Value) -> ServiceDef {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn ssh_argv_is_the_remote_command_the_reference_builds() {
        let (program, args) = ssh_command(&ssh_service(json!({
            "name": "remote",
            "kind": "ssh",
            "host": "dev-box",
            "cwd": "/srv/app",
            "command": "npm start",
        })))
        .unwrap();

        assert_eq!(program, "ssh");
        assert_eq!(args, vec!["dev-box", "cd '/srv/app' && exec npm start"]);
    }

    #[test]
    fn ssh_env_is_assigned_on_the_remote_side_and_escaped_for_it() {
        let (_, args) = ssh_command(&ssh_service(json!({
            "name": "remote",
            "kind": "ssh",
            "host": "dev-box",
            "cwd": "/srv/app",
            "command": "npm start",
            "env": { "TOKEN": "it's secret", "MODE": "prod" },
        })))
        .unwrap();

        // Sorted, because the config parses `env` into a map with no insertion
        // order left to read back.
        assert_eq!(
            args[1],
            "cd '/srv/app' && MODE='prod' TOKEN='it'\\''s secret' exec npm start"
        );
    }

    #[test]
    fn ssh_refuses_what_it_cannot_run_rather_than_defaulting_it() {
        // A missing cwd would otherwise run the service in the login
        // directory, which is a different service than the registered one.
        for missing in ["host", "cwd", "command"] {
            let mut fields = serde_json::Map::new();
            fields.insert("name".into(), json!("remote"));
            fields.insert("kind".into(), json!("ssh"));
            for (key, value) in [
                ("host", "dev-box"),
                ("cwd", "/srv"),
                ("command", "npm start"),
            ] {
                if key != missing {
                    fields.insert(key.into(), json!(value));
                }
            }
            let error = ssh_command(&ssh_service(serde_json::Value::Object(fields.clone())))
                .unwrap_err()
                .to_string();
            assert_eq!(
                error,
                "Service \"remote\" is missing ssh host, cwd, or command."
            );

            // Present but blank is the same refusal, not an empty argument.
            fields.insert(missing.into(), json!("   "));
            assert!(ssh_command(&ssh_service(serde_json::Value::Object(fields))).is_err());
        }
    }

    #[test]
    fn ssh_rejects_names_a_remote_shell_cannot_assign() {
        let dotted = ssh_command(&ssh_service(json!({
            "name": "remote",
            "kind": "ssh",
            "host": "dev-box",
            "cwd": "/srv",
            "command": "npm start",
            "env": { "NODE.ENV": "prod" },
        })));
        // A dotted key is legal in a `.env` file and illegal as a shell
        // assignment, which is why the two rules are not the same rule.
        assert!(is_env_key("NODE.ENV"));
        assert!(!is_shell_assignable("NODE.ENV"));
        assert_eq!(
            dotted.unwrap_err().to_string(),
            "Invalid environment variable name: NODE.ENV"
        );

        let null_byte = ssh_command(&ssh_service(json!({
            "name": "remote",
            "kind": "ssh",
            "host": "dev-box",
            "cwd": "/srv",
            "command": "npm start\u{0}rm -rf /",
        })));
        assert_eq!(
            null_byte.unwrap_err().to_string(),
            "SSH command contains invalid null byte."
        );
    }

    #[test]
    fn only_a_remote_service_is_answerable_to_a_host() {
        assert_eq!(
            launched_host(&ssh_service(json!({
                "name": "remote",
                "kind": "ssh",
                "host": "dev-box",
                "cwd": "/srv",
                "command": "npm start",
            }))),
            Some("dev-box".to_string())
        );
        // A local service with a stray host field is still not remote.
        assert_eq!(
            launched_host(&ssh_service(json!({
                "name": "local",
                "command": "npm run dev",
                "cwd": "/repo",
                "host": "dev-box",
            }))),
            None
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn natural_exit_is_reaped_and_reported() {
        let test_dir = test_dir("natural-exit");
        tokio::fs::create_dir_all(&test_dir).await.unwrap();
        let manager = ProcessManager::with_stop_policy(
            LogStore::new(test_dir.join("logs")),
            StopPolicy {
                term_grace: Duration::from_millis(50),
                kill_grace: Duration::from_secs(2),
                poll_interval: Duration::from_millis(10),
            },
        );
        let service = test_service("crasher", &test_dir, "exit 7");

        manager.start_service(&service).await.unwrap();
        let pid = manager.service_status("crasher").unwrap().pid.unwrap();

        wait_until(Duration::from_secs(2), || {
            manager
                .service_status("crasher")
                .is_some_and(|status| serde_json::to_value(status.state).unwrap() == "exited")
        })
        .await;

        let status = manager.service_status("crasher").unwrap();
        assert_eq!(status.exit_code, Some(7));
        // A run that ended of its own accord says so, and says when — the
        // launch it belongs to is still readable afterwards.
        assert_eq!(status.kind, "local");
        assert_eq!(status.signal, None);
        assert!(status.started_at.unwrap() <= status.exited_at.unwrap());
        let mut wait_status = 0;
        assert_eq!(
            unsafe { libc::waitpid(pid as libc::pid_t, &mut wait_status, libc::WNOHANG) },
            -1,
            "the supervisor must already have reaped the child"
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD)
        );
        let _ = tokio::fs::remove_dir_all(test_dir).await;
    }

    /// A stand-in for the Docker CLI: it records the argv it was called with
    /// and answers `ps` with one container line, so the compose paths can be
    /// driven on a machine that has no Docker on it.
    #[cfg(unix)]
    async fn fake_docker(dir: &std::path::Path) -> PathBuf {
        let script = dir.join("fake-docker");
        let log = dir.join("calls.log");
        tokio::fs::write(
            &script,
            format!(
                "#!/bin/sh\necho \"$@\" >> {}\ncase \"$*\" in\n  *\" ps \"*) echo '{{\"ID\":\"container-1\",\"State\":\"running\"}}' ;;\nesac\nexit 0\n",
                log.display()
            ),
        )
        .await
        .unwrap();
        let mut permissions = tokio::fs::metadata(&script).await.unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, 0o755);
        tokio::fs::set_permissions(&script, permissions)
            .await
            .unwrap();
        script
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_compose_service_is_tracked_by_its_container_not_by_a_process() {
        let test_dir = test_dir("compose-lifecycle");
        tokio::fs::create_dir_all(&test_dir).await.unwrap();
        let docker = fake_docker(&test_dir).await;
        let manager = ProcessManager::new(LogStore::new(test_dir.join("logs")))
            .with_compose_program(docker.to_string_lossy().to_string());
        let service: ServiceDef = serde_json::from_value(json!({
            "name": "web",
            "kind": "docker-compose",
            "cwd": test_dir,
            "composeFile": "compose.yml",
            "composeService": "web",
            // A port a compose service publishes is the Docker daemon's to
            // hold, so it must not be checked for a conflict here.
            "port": 3000,
        }))
        .unwrap();

        manager.start_service(&service).await.unwrap();

        let running = manager.service_status("web").unwrap();
        assert_eq!(running.kind, "docker-compose");
        assert_eq!(running.container_id.as_deref(), Some("container-1"));
        // Nothing was spawned, so there is no process to report.
        assert_eq!(running.pid, None);
        assert_eq!(running.pgid, None);
        assert!(matches!(running.state, ServiceState::Running));
        assert!(running.started_at.is_some());

        manager.stop_service("web").await.unwrap();

        let stopped = manager.service_status("web").unwrap();
        assert!(matches!(stopped.state, ServiceState::Stopped));
        assert!(stopped.exited_at.is_some());
        // A container has no exit code and was killed by no signal.
        assert_eq!(stopped.exit_code, None);
        assert_eq!(stopped.signal, None);
        // The container it was is still what identifies the run.
        assert_eq!(stopped.container_id.as_deref(), Some("container-1"));

        let calls = tokio::fs::read_to_string(test_dir.join("calls.log"))
            .await
            .unwrap();
        assert_eq!(
            calls.lines().collect::<Vec<_>>(),
            vec![
                "compose -f compose.yml up -d web",
                "compose -f compose.yml ps --format json web",
                "compose -f compose.yml stop web",
            ]
        );
        let _ = tokio::fs::remove_dir_all(test_dir).await;
    }

    /// Nothing was journaled, so a compose service does not go through the
    /// process-group and registry machinery a child does — including on the
    /// path where a stop finds no supervisor.
    #[cfg(unix)]
    #[tokio::test]
    async fn stopping_a_compose_service_never_touches_the_launch_journal() {
        let test_dir = test_dir("compose-journal");
        tokio::fs::create_dir_all(&test_dir).await.unwrap();
        let docker = fake_docker(&test_dir).await;
        let journal = test_dir.join("native-runtime-v1.json");
        let manager = ProcessManager::with_runtime_registry(
            LogStore::new(test_dir.join("logs")),
            RuntimeRegistry::new(journal.clone()),
        )
        .with_compose_program(docker.to_string_lossy().to_string());
        let service: ServiceDef = serde_json::from_value(json!({
            "name": "web",
            "kind": "docker-compose",
            "cwd": test_dir,
            "composeService": "web",
        }))
        .unwrap();

        manager.start_service(&service).await.unwrap();
        manager.stop_service("web").await.unwrap();

        assert!(matches!(
            manager.service_status("web").unwrap().state,
            ServiceState::Stopped
        ));
        // A container outlives this process on purpose, so there is nothing
        // for a later run to reconcile — and nothing was written to say there
        // was.
        assert!(!journal.exists());
        let _ = tokio::fs::remove_dir_all(test_dir).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_stopped_run_reports_the_signal_that_ended_it_by_name() {
        let test_dir = test_dir("stop-signal");
        tokio::fs::create_dir_all(&test_dir).await.unwrap();
        let manager = ProcessManager::new(LogStore::new(test_dir.join("logs")));
        let service = test_service("sleeper", &test_dir, "exec sleep 30");

        manager.start_service(&service).await.unwrap();
        let running = manager.service_status("sleeper").unwrap();
        assert_eq!(running.kind, "local");
        assert!(running.started_at.is_some());
        // Nothing has ended, so nothing describes an ending.
        assert_eq!(running.exited_at, None);
        assert_eq!(running.signal, None);

        manager.stop_service("sleeper").await.unwrap();

        let stopped = manager.service_status("sleeper").unwrap();
        // A process killed by a signal has no exit code at all, so the signal
        // is the only account of how it died — and it reads as its name.
        assert_eq!(stopped.exit_code, None);
        assert_eq!(stopped.signal.as_deref(), Some("SIGTERM"));
        assert!(stopped.exited_at.unwrap() >= stopped.started_at.unwrap());
        let _ = tokio::fs::remove_dir_all(test_dir).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn crashed_service_can_start_a_fresh_generation() {
        let test_dir = test_dir("crash-restart");
        tokio::fs::create_dir_all(&test_dir).await.unwrap();
        let manager = ProcessManager::new(LogStore::new(test_dir.join("logs")));
        let service = test_service("recoverable", &test_dir, "exit 9");

        manager.start_service(&service).await.unwrap();
        let first_pid = manager.service_status("recoverable").unwrap().pid.unwrap();
        wait_until(Duration::from_secs(2), || !process_exists(first_pid)).await;

        manager.start_service(&service).await.unwrap();
        let second_pid = manager.service_status("recoverable").unwrap().pid.unwrap();

        assert_ne!(second_pid, first_pid);
        let _ = tokio::fs::remove_dir_all(test_dir).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_waits_for_term_resistant_process_group_cleanup() {
        let test_dir = test_dir("tree-cleanup");
        tokio::fs::create_dir_all(&test_dir).await.unwrap();
        let descendant_file = test_dir.join("descendant.pid");
        let manager = ProcessManager::with_stop_policy(
            LogStore::new(test_dir.join("logs")),
            StopPolicy {
                term_grace: Duration::from_millis(50),
                kill_grace: Duration::from_secs(2),
                poll_interval: Duration::from_millis(10),
            },
        );
        let script = format!(
            "trap '' TERM; /bin/sh -c 'trap \"\" TERM; echo $$ > {}; exec sleep 30' & wait",
            shell_escape(&descendant_file.to_string_lossy())
        );
        let service = test_service("tree", &test_dir, &script);

        manager.start_service(&service).await.unwrap();
        let parent_pid = manager.service_status("tree").unwrap().pid.unwrap();
        let guard = ProcessGroupGuard(parent_pid);
        let descendant_pid = wait_for_pid_file(&descendant_file).await;
        assert!(process_exists(parent_pid));
        assert!(process_exists(descendant_pid));

        manager.stop_service("tree").await.unwrap();

        assert!(!process_exists(parent_pid));
        assert!(!process_exists(descendant_pid));
        assert!(!process_group_exists(parent_pid));
        std::mem::forget(guard);
        let _ = tokio::fs::remove_dir_all(test_dir).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn restart_waits_for_old_generation_before_spawning_replacement() {
        let test_dir = test_dir("generation-restart");
        tokio::fs::create_dir_all(&test_dir).await.unwrap();
        let manager = ProcessManager::with_stop_policy(
            LogStore::new(test_dir.join("logs")),
            StopPolicy {
                term_grace: Duration::from_millis(50),
                kill_grace: Duration::from_secs(2),
                poll_interval: Duration::from_millis(10),
            },
        );
        let service = test_service(
            "restartable",
            &test_dir,
            "trap '' TERM; while :; do sleep 1; done",
        );

        manager.start_service(&service).await.unwrap();
        let first_pid = manager.service_status("restartable").unwrap().pid.unwrap();
        let first_guard = ProcessGroupGuard(first_pid);

        manager.restart_service(&service).await.unwrap();
        let second_pid = manager.service_status("restartable").unwrap().pid.unwrap();
        let second_guard = ProcessGroupGuard(second_pid);

        assert_ne!(second_pid, first_pid);
        assert!(!process_group_exists(first_pid));
        sleep(Duration::from_millis(100)).await;
        assert!(process_exists(second_pid));
        std::mem::forget(first_guard);
        manager.stop_service("restartable").await.unwrap();
        assert!(!process_group_exists(second_pid));
        std::mem::forget(second_guard);
        let _ = tokio::fs::remove_dir_all(test_dir).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn replacement_manager_cleans_verified_orphan_before_mutating() {
        let test_dir = test_dir("orphan-recovery");
        tokio::fs::create_dir_all(&test_dir).await.unwrap();
        let registry = RuntimeRegistry::new(test_dir.join("runtime.json"));
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "exec sleep 30"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_managed_process(&mut command);
        let mut orphan = command.spawn().unwrap();
        let orphan_pid = orphan.id().unwrap();
        let orphan_guard = ProcessGroupGuard(orphan_pid);
        let identity = inspect_process_identity(orphan_pid).unwrap().unwrap();
        let mut dead_owner = Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        let dead_owner_pid = dead_owner.id().unwrap();
        dead_owner.wait().await.unwrap();
        registry
            .record(RuntimeRecord {
                name: "orphan".into(),
                generation: 41,
                pid: orphan_pid,
                pgid: orphan_pid,
                uid: identity.uid,
                command: identity.command,
                start_token: identity.start_token,
                owner_pid: dead_owner_pid,
                owner_start_token: "dead-owner".into(),
            })
            .await
            .unwrap();
        let waiter = tokio::spawn(async move { orphan.wait().await });
        let manager = ProcessManager::with_runtime_registry(
            LogStore::new(test_dir.join("logs")),
            registry.clone(),
        );

        manager.stop_service("not-running").await.unwrap();

        waiter.await.unwrap().unwrap();
        assert!(!process_group_exists(orphan_pid));
        assert!(registry.records().await.unwrap().is_empty());
        std::mem::forget(orphan_guard);
        let _ = tokio::fs::remove_dir_all(test_dir).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn occupied_port_is_non_destructive_and_structured_by_default() {
        let test_dir = test_dir("port-conflict");
        tokio::fs::create_dir_all(&test_dir).await.unwrap();
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let manager = ProcessManager::new(LogStore::new(test_dir.join("logs")));
        let mut service = test_service("conflict", &test_dir, "exec sleep 30");
        service.port = Some(port);

        let error = manager.start_service(&service).await.unwrap_err();
        let conflict = error.downcast_ref::<PortConflictError>().unwrap();

        assert_eq!(conflict.service, "conflict");
        assert_eq!(conflict.port, port);
        assert!(!is_port_available("127.0.0.1", port));
        drop(listener);
        let _ = tokio::fs::remove_dir_all(test_dir).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn concurrent_starts_publish_only_one_generation() {
        let test_dir = test_dir("concurrent-start");
        tokio::fs::create_dir_all(&test_dir).await.unwrap();
        let manager = Arc::new(ProcessManager::with_stop_policy(
            LogStore::new(test_dir.join("logs")),
            StopPolicy {
                term_grace: Duration::from_millis(50),
                kill_grace: Duration::from_secs(2),
                poll_interval: Duration::from_millis(10),
            },
        ));
        let service = Arc::new(test_service(
            "single-generation",
            &test_dir,
            "exec sleep 30",
        ));
        let first = {
            let manager = manager.clone();
            let service = service.clone();
            tokio::spawn(async move { manager.start_service(&service).await })
        };
        let second = {
            let manager = manager.clone();
            let service = service.clone();
            tokio::spawn(async move { manager.start_service(&service).await })
        };

        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();
        let status = manager.service_status("single-generation").unwrap();
        let pid = status.pid.unwrap();
        let guard = ProcessGroupGuard(pid);

        assert_eq!(status.state, ServiceState::Running);
        assert_eq!(manager.status().len(), 1);
        manager.stop_service("single-generation").await.unwrap();
        std::mem::forget(guard);
        let _ = tokio::fs::remove_dir_all(test_dir).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn recovery_retains_record_when_leader_is_dead_but_group_survives() {
        let test_dir = test_dir("dead-leader-live-group");
        tokio::fs::create_dir_all(&test_dir).await.unwrap();
        let descendant_file = test_dir.join("descendant.pid");
        let registry = RuntimeRegistry::new(test_dir.join("native-runtime-v1.json"));
        let script = format!(
            "trap '' TERM; sleep 30 & echo $! > {}; exit 0",
            shell_escape(&descendant_file.to_string_lossy())
        );
        let mut command = Command::new("/bin/sh");
        command.args(["-c", &script]);
        configure_managed_process(&mut command);
        let mut leader = command.spawn().unwrap();
        let leader_pid = leader.id().unwrap();
        let group_guard = ProcessGroupGuard(leader_pid);
        let descendant_pid = wait_for_pid_file(&descendant_file).await;
        leader.wait().await.unwrap();
        assert!(!process_exists(leader_pid));
        assert!(process_exists(descendant_pid));
        assert!(process_group_exists(leader_pid));
        registry
            .record(RuntimeRecord {
                name: "orphan-tree".into(),
                generation: 7,
                pid: leader_pid,
                pgid: leader_pid,
                uid: Some(unsafe { libc::geteuid() }),
                command: "departed leader".into(),
                start_token: "departed-start".into(),
                owner_pid: u32::MAX - 1,
                owner_start_token: "dead-owner".into(),
            })
            .await
            .unwrap();
        let manager = ProcessManager::with_runtime_registry(
            LogStore::new(test_dir.join("logs")),
            registry.clone(),
        );

        let error = manager.stop_service("not-running").await.unwrap_err();

        assert!(error.to_string().contains("leader is gone"));
        assert!(process_exists(descendant_pid));
        assert_eq!(registry.records().await.unwrap().len(), 1);
        drop(group_guard);
        wait_until(Duration::from_secs(2), || !process_exists(descendant_pid)).await;
        let _ = tokio::fs::remove_dir_all(test_dir).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn journaled_launch_is_durable_before_the_service_executes() {
        let test_dir = test_dir("journaled-launch");
        tokio::fs::create_dir_all(&test_dir).await.unwrap();
        let marker = test_dir.join("executed.pid");
        let registry = RuntimeRegistry::new(test_dir.join("native-runtime-v1.json"));
        let manager = ProcessManager::with_runtime_registry(
            LogStore::new(test_dir.join("logs")),
            registry.clone(),
        );
        let script = format!(
            "echo $$ > {}; exec sleep 30",
            shell_escape(&marker.to_string_lossy())
        );
        let service = test_service("journaled", &test_dir, &script);

        manager.start_service(&service).await.unwrap();
        let pid = manager.service_status("journaled").unwrap().pid.unwrap();
        let guard = ProcessGroupGuard(pid);

        // The child only reached `exec` after its record was durable, so the
        // marker it writes can never precede the journal entry.
        assert_eq!(wait_for_pid_file(&marker).await, pid);
        let records = registry.records().await.unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].pid, pid);
        assert_eq!(records[0].pgid, pid);
        assert_eq!(records[0].owner_pid, std::process::id());
        assert_eq!(records[0].uid, Some(unsafe { libc::geteuid() }));
        assert!(!records[0].start_token.is_empty());
        assert_eq!(records[0].command, format!("local /bin/sh -c {script}"));

        manager.stop_service("journaled").await.unwrap();
        assert!(registry.records().await.unwrap().is_empty());
        std::mem::forget(guard);
        let _ = tokio::fs::remove_dir_all(test_dir).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_launch_that_cannot_be_journaled_never_executes_the_service() {
        use std::os::unix::fs::PermissionsExt;

        let test_dir = test_dir("unjournalable-launch");
        let journal_dir = test_dir.join("native");
        tokio::fs::create_dir_all(&journal_dir).await.unwrap();
        let marker = test_dir.join("executed.pid");
        let registry = RuntimeRegistry::new(journal_dir.join("runtime-v1.json"));
        let manager = ProcessManager::with_runtime_registry(
            LogStore::new(test_dir.join("logs")),
            registry.clone(),
        );
        let service = test_service(
            "unjournalable",
            &test_dir,
            &format!(
                "echo $$ > {}; exec sleep 30",
                shell_escape(&marker.to_string_lossy())
            ),
        );
        std::fs::set_permissions(&journal_dir, std::fs::Permissions::from_mode(0o500)).unwrap();

        let error = manager.start_service(&service).await.unwrap_err();

        assert!(error.to_string().contains("Could not launch"));
        // The child is released only once its record is durable, so a journal
        // this owner cannot write means the service never ran at all.
        sleep(Duration::from_millis(200)).await;
        assert!(!marker.exists());
        assert!(manager.service_status("unjournalable").is_none());
        std::fs::set_permissions(&journal_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(registry.records().await.unwrap().is_empty());
        let _ = tokio::fs::remove_dir_all(test_dir).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_command_that_cannot_execute_reports_its_error_and_leaves_no_record() {
        let test_dir = test_dir("unexecutable-command");
        tokio::fs::create_dir_all(&test_dir).await.unwrap();
        let registry = RuntimeRegistry::new(test_dir.join("native-runtime-v1.json"));
        let manager = ProcessManager::with_runtime_registry(
            LogStore::new(test_dir.join("logs")),
            registry.clone(),
        );
        let mut service = test_service("missing-binary", &test_dir, "unused");
        service.command = Some(test_dir.join("does-not-exist").display().to_string());

        let error = manager.start_service(&service).await.unwrap_err();

        assert!(format!("{error:#}").contains("No such file or directory"));
        assert!(registry.records().await.unwrap().is_empty());
        assert!(manager.service_status("missing-binary").is_none());
        let _ = tokio::fs::remove_dir_all(test_dir).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unconfirmed_registry_cleanup_is_retried_until_it_succeeds() {
        use std::os::unix::fs::PermissionsExt;

        let test_dir = test_dir("registry-cleanup-retry");
        let journal_dir = test_dir.join("native");
        tokio::fs::create_dir_all(&journal_dir).await.unwrap();
        let registry = RuntimeRegistry::new(journal_dir.join("runtime-v1.json"));
        let manager = ProcessManager::with_runtime_registry(
            LogStore::new(test_dir.join("logs")),
            registry.clone(),
        );
        let service = test_service("durable", &test_dir, "exec sleep 30");
        manager.start_service(&service).await.unwrap();
        let pid = manager.service_status("durable").unwrap().pid.unwrap();
        let guard = ProcessGroupGuard(pid);

        // The process group dies, but its ownership record cannot be removed.
        std::fs::set_permissions(&journal_dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        let stop = manager.stop_service("durable").await.unwrap_err();
        assert!(stop.to_string().contains("runtime registry"));
        assert!(!process_group_exists(pid));
        assert_eq!(registry.records().await.unwrap().len(), 1);

        // Retrying must not report success while the record is still there,
        // and the unconfirmed generation blocks both a restart and shutdown.
        let retry = manager.stop_service("durable").await.unwrap_err();
        assert!(retry.to_string().contains("Permission denied"));
        let blocked = manager.start_service(&service).await.unwrap_err();
        assert!(blocked.to_string().contains("cleaned up"));
        assert!(manager.shutdown_all().await.is_err());

        std::fs::set_permissions(&journal_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        manager.stop_service("durable").await.unwrap();

        assert!(registry.records().await.unwrap().is_empty());
        assert!(manager.shutdown_all().await.is_ok());
        manager.start_service(&service).await.unwrap();
        let restarted = manager.service_status("durable").unwrap().pid.unwrap();
        assert_ne!(restarted, pid);
        manager.stop_service("durable").await.unwrap();
        std::mem::forget(guard);
        let _ = tokio::fs::remove_dir_all(test_dir).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_fails_closed_without_a_supervisor_for_a_live_group() {
        let test_dir = test_dir("missing-supervisor-live-group");
        tokio::fs::create_dir_all(&test_dir).await.unwrap();
        let registry = RuntimeRegistry::new(test_dir.join("native-runtime-v1.json"));
        let manager =
            ProcessManager::with_runtime_registry(LogStore::new(test_dir.join("logs")), registry);
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "exec sleep 30"]);
        configure_managed_process(&mut command);
        let mut child = command.spawn().unwrap();
        let pid = child.id().unwrap();
        manager.processes.lock().unwrap().insert(
            "unconfirmed".into(),
            ManagedProcess {
                generation: 1,
                kind: "local".into(),
                host: None,
                container_id: None,
                compose: None,
                pid: Some(pid),
                pgid: Some(pid),
                state: ServiceState::Stopping,
                exit_code: None,
                signal: None,
                url: None,
                started_at: Some(Utc::now()),
                exited_at: None,
                cleanup_confirmed: false,
                controller: None,
            },
        );

        let error = manager.stop_service("unconfirmed").await.unwrap_err();

        assert!(error.to_string().contains("process-group cleanup"));
        assert!(process_group_exists(pid));
        unsafe {
            libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
        }
        child.wait().await.unwrap();
        let _ = tokio::fs::remove_dir_all(test_dir).await;
    }

    #[cfg(unix)]
    fn test_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "nomoreide-process-{label}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    #[cfg(unix)]
    fn test_service(name: &str, cwd: &std::path::Path, script: &str) -> ServiceDef {
        serde_json::from_value(json!({
            "name": name,
            "command": "/bin/sh",
            "args": ["-c", script],
            "cwd": cwd,
        }))
        .unwrap()
    }

    #[cfg(unix)]
    async fn wait_until(timeout: Duration, mut predicate: impl FnMut() -> bool) {
        let deadline = Instant::now() + timeout;
        while !predicate() {
            assert!(Instant::now() < deadline, "condition did not become true");
            sleep(Duration::from_millis(10)).await;
        }
    }

    #[cfg(unix)]
    async fn wait_for_pid_file(path: &std::path::Path) -> u32 {
        let mut value = None;
        wait_until(Duration::from_secs(2), || {
            value = std::fs::read_to_string(path)
                .ok()
                .and_then(|text| text.trim().parse().ok());
            value.is_some()
        })
        .await;
        value.unwrap()
    }

    #[cfg(unix)]
    fn process_exists(pid: u32) -> bool {
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }

    #[cfg(unix)]
    fn process_group_exists(pid: u32) -> bool {
        let result = unsafe { libc::kill(-(pid as libc::pid_t), 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }

    #[cfg(unix)]
    struct ProcessGroupGuard(u32);

    #[cfg(unix)]
    impl Drop for ProcessGroupGuard {
        fn drop(&mut self) {
            unsafe {
                libc::kill(-(self.0 as libc::pid_t), libc::SIGKILL);
            }
        }
    }
}
