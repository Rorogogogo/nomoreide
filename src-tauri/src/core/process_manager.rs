use super::config::ServiceDef;
use super::log_store::{LogEntry, LogStore};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::time::{sleep, Duration};

/// A macOS app launched from Finder/Dock inherits only a minimal PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`), so Homebrew/nvm/pnpm tools like `npm` and
/// `node` aren't found and services silently fail to spawn — even though they
/// work when the app is started from a terminal (which has the full shell PATH).
/// Resolve a usable PATH once: the user's login-shell PATH plus common dev bin
/// dirs as a safety net. Cached for the process lifetime.
pub(crate) fn service_path() -> String {
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ServiceState {
    Stopped,
    Starting,
    Running,
    Stopping,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    pub name: String,
    pub state: ServiceState,
    pub pid: Option<u32>,
    pub pgid: Option<u32>,
    pub exit_code: Option<i32>,
    pub url: Option<String>,
}

struct ManagedProcess {
    child: Child,
    pgid: Option<u32>,
    state: ServiceState,
    exit_code: Option<i32>,
    url: Option<String>,
}

pub struct ProcessManager {
    processes: Arc<Mutex<HashMap<String, ManagedProcess>>>,
    log_store: LogStore,
}

impl ProcessManager {
    pub fn new(log_store: LogStore) -> Self {
        ProcessManager {
            processes: Arc::new(Mutex::new(HashMap::new())),
            log_store,
        }
    }

    pub fn status(&self) -> Vec<ServiceStatus> {
        let procs = self.processes.lock().unwrap();
        procs
            .iter()
            .map(|(name, p)| ServiceStatus {
                name: name.clone(),
                state: p.state.clone(),
                pid: p.child.id(),
                pgid: p.pgid,
                exit_code: p.exit_code,
                url: p.url.clone(),
            })
            .collect()
    }

    pub fn service_status(&self, name: &str) -> Option<ServiceStatus> {
        let procs = self.processes.lock().unwrap();
        procs.get(name).map(|p| ServiceStatus {
            name: name.to_string(),
            state: p.state.clone(),
            pid: p.child.id(),
            pgid: p.pgid,
            exit_code: p.exit_code,
            url: p.url.clone(),
        })
    }

    pub fn service_process_ids(&self, name: &str) -> Option<(Option<u32>, Option<u32>)> {
        let procs = self.processes.lock().unwrap();
        procs.get(name).map(|p| (p.child.id(), p.pgid))
    }

    pub async fn start_service(&self, def: &ServiceDef) -> Result<()> {
        // Check if already running
        {
            let procs = self.processes.lock().unwrap();
            if let Some(p) = procs.get(&def.name) {
                if p.state == ServiceState::Running || p.state == ServiceState::Starting {
                    return Ok(());
                }
            }
        }

        match def.kind.as_str() {
            "docker-compose" => self.start_docker_compose(def).await,
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

        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg(command)
            .current_dir(cwd)
            .env("PATH", service_path())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false);
        configure_managed_process(&mut cmd);

        if let Some(env) = &def.env {
            for (k, v) in env {
                cmd.env(k, v);
            }
        }

        let mut child = cmd.spawn()?;
        let pgid = child.id();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        {
            // Mark Running immediately on a successful spawn, matching the Node
            // ProcessManager. The previous "Starting until first stdout line"
            // scheme left quiet services (no early output) stuck on Starting
            // forever, so the UI never showed them as running. URL detection
            // below still upgrades the status with a detected URL when one prints.
            let mut procs = self.processes.lock().unwrap();
            procs.insert(
                def.name.clone(),
                ManagedProcess {
                    child,
                    pgid,
                    state: ServiceState::Running,
                    exit_code: None,
                    url: None,
                },
            );
        }

        // Stream stdout
        if let Some(out) = stdout {
            let store = self.log_store.clone();
            let name = def.name.clone();
            let procs = self.processes.clone();
            let port = def.port;
            tokio::spawn(async move {
                let mut lines = BufReader::new(out).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    // Detect readiness URL from common patterns and attach it.
                    if let Some(url) = detect_url(&line, port) {
                        let mut p = procs.lock().unwrap();
                        if let Some(proc) = p.get_mut(&name) {
                            proc.url = Some(url);
                        }
                    }
                    store.append(LogEntry::new(&name, "stdout", &line));
                }
            });
        }

        // Stream stderr
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

        Ok(())
    }

    async fn start_docker_compose(&self, def: &ServiceDef) -> Result<()> {
        let cwd = def
            .cwd
            .as_deref()
            .ok_or_else(|| anyhow!("Docker service missing cwd"))?;
        let svc = def
            .compose_service
            .as_deref()
            .ok_or_else(|| anyhow!("Missing composeService"))?;

        let args = vec!["up", "--no-build", svc];
        let mut cmd = Command::new("docker-compose");
        cmd.args(&args)
            .current_dir(cwd)
            .env("PATH", service_path())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_managed_process(&mut cmd);
        let child = cmd.spawn()?;
        let pgid = child.id();

        let mut procs = self.processes.lock().unwrap();
        procs.insert(
            def.name.clone(),
            ManagedProcess {
                child,
                pgid,
                state: ServiceState::Running,
                exit_code: None,
                url: None,
            },
        );
        Ok(())
    }

    async fn start_ssh(&self, def: &ServiceDef) -> Result<()> {
        let host = def
            .host
            .as_deref()
            .ok_or_else(|| anyhow!("SSH service missing host"))?;
        let command = def
            .command
            .as_deref()
            .ok_or_else(|| anyhow!("SSH service missing command"))?;
        let cwd = def.cwd.as_deref().unwrap_or("~");

        let remote_cmd = format!("cd {cwd} && {command}");
        let mut cmd = Command::new("ssh");
        cmd.args([host, &remote_cmd])
            .env("PATH", service_path())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_managed_process(&mut cmd);
        let child = cmd.spawn()?;
        let pgid = child.id();

        let mut procs = self.processes.lock().unwrap();
        procs.insert(
            def.name.clone(),
            ManagedProcess {
                child,
                pgid,
                state: ServiceState::Running,
                exit_code: None,
                url: None,
            },
        );
        Ok(())
    }

    pub async fn stop_service(&self, name: &str) -> Result<()> {
        let mut procs = self.processes.lock().unwrap();
        if let Some(proc) = procs.get_mut(name) {
            proc.state = ServiceState::Stopping;
            // Send SIGTERM first
            #[cfg(unix)]
            if let Some(pgid) = proc.pgid.or_else(|| proc.child.id()) {
                unsafe { libc::kill(-(pgid as i32), libc::SIGTERM) };
            }
            #[cfg(not(unix))]
            proc.child.start_kill().ok();
        }
        drop(procs);

        // Wait up to 3s for graceful shutdown, then force kill
        let procs = self.processes.clone();
        let name = name.to_string();
        tokio::spawn(async move {
            sleep(Duration::from_secs(3)).await;
            let mut p = procs.lock().unwrap();
            if let Some(proc) = p.get_mut(&name) {
                if proc.state == ServiceState::Stopping {
                    #[cfg(unix)]
                    if let Some(pgid) = proc.pgid.or_else(|| proc.child.id()) {
                        unsafe { libc::kill(-(pgid as i32), libc::SIGKILL) };
                    }
                    #[cfg(not(unix))]
                    proc.child.start_kill().ok();
                    proc.state = ServiceState::Stopped;
                }
            }
        });

        Ok(())
    }

    pub async fn restart_service(&self, def: &ServiceDef) -> Result<()> {
        self.stop_service(&def.name).await?;
        sleep(Duration::from_millis(500)).await;
        self.start_service(def).await
    }

    pub fn kill_all(&self) {
        let mut procs = self.processes.lock().unwrap();
        for (_, proc) in procs.iter_mut() {
            #[cfg(unix)]
            if let Some(pgid) = proc.pgid.or_else(|| proc.child.id()) {
                unsafe { libc::kill(-(pgid as i32), libc::SIGTERM) };
            }
            #[cfg(not(unix))]
            proc.child.start_kill().ok();
            proc.state = ServiceState::Stopped;
        }
    }
}

#[cfg(unix)]
fn configure_managed_process(cmd: &mut Command) {
    cmd.process_group(0);
}

#[cfg(not(unix))]
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
