use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::time::{sleep, Duration};
use super::config::ServiceDef;
use super::log_store::{LogEntry, LogStore};

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
    pub exit_code: Option<i32>,
    pub url: Option<String>,
}

struct ManagedProcess {
    child: Child,
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
        procs.iter().map(|(name, p)| ServiceStatus {
            name: name.clone(),
            state: p.state.clone(),
            pid: p.child.id(),
            exit_code: p.exit_code,
            url: p.url.clone(),
        }).collect()
    }

    pub fn service_status(&self, name: &str) -> Option<ServiceStatus> {
        let procs = self.processes.lock().unwrap();
        procs.get(name).map(|p| ServiceStatus {
            name: name.to_string(),
            state: p.state.clone(),
            pid: p.child.id(),
            exit_code: p.exit_code,
            url: p.url.clone(),
        })
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
        let command = def.command.as_deref().ok_or_else(|| anyhow!("Local service missing command"))?;
        let cwd = def.cwd.as_deref().ok_or_else(|| anyhow!("Local service missing cwd"))?;

        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(command)
            .current_dir(cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false);

        if let Some(env) = &def.env {
            for (k, v) in env {
                cmd.env(k, v);
            }
        }

        let mut child = cmd.spawn()?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        {
            let mut procs = self.processes.lock().unwrap();
            procs.insert(def.name.clone(), ManagedProcess {
                child,
                state: ServiceState::Starting,
                exit_code: None,
                url: None,
            });
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
                    // Detect readiness URL from common patterns
                    if let Some(url) = detect_url(&line, port) {
                        let mut p = procs.lock().unwrap();
                        if let Some(proc) = p.get_mut(&name) {
                            proc.state = ServiceState::Running;
                            proc.url = Some(url);
                        }
                    } else {
                        let mut p = procs.lock().unwrap();
                        if let Some(proc) = p.get_mut(&name) {
                            if proc.state == ServiceState::Starting {
                                proc.state = ServiceState::Running;
                            }
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
        let cwd = def.cwd.as_deref().ok_or_else(|| anyhow!("Docker service missing cwd"))?;
        let svc = def.compose_service.as_deref().ok_or_else(|| anyhow!("Missing composeService"))?;

        let args = vec!["up", "--no-build", svc];
        let child = Command::new("docker-compose")
            .args(&args)
            .current_dir(cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let mut procs = self.processes.lock().unwrap();
        procs.insert(def.name.clone(), ManagedProcess {
            child,
            state: ServiceState::Running,
            exit_code: None,
            url: None,
        });
        Ok(())
    }

    async fn start_ssh(&self, def: &ServiceDef) -> Result<()> {
        let host = def.host.as_deref().ok_or_else(|| anyhow!("SSH service missing host"))?;
        let command = def.command.as_deref().ok_or_else(|| anyhow!("SSH service missing command"))?;
        let cwd = def.cwd.as_deref().unwrap_or("~");

        let remote_cmd = format!("cd {cwd} && {command}");
        let child = Command::new("ssh")
            .args([host, &remote_cmd])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let mut procs = self.processes.lock().unwrap();
        procs.insert(def.name.clone(), ManagedProcess {
            child,
            state: ServiceState::Running,
            exit_code: None,
            url: None,
        });
        Ok(())
    }

    pub async fn stop_service(&self, name: &str) -> Result<()> {
        let mut procs = self.processes.lock().unwrap();
        if let Some(proc) = procs.get_mut(name) {
            proc.state = ServiceState::Stopping;
            // Send SIGTERM first
            #[cfg(unix)]
            if let Some(pid) = proc.child.id() {
                unsafe { libc::kill(pid as i32, libc::SIGTERM) };
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
            proc.child.start_kill().ok();
            proc.state = ServiceState::Stopped;
        }
    }
}

fn detect_url(line: &str, port: Option<u16>) -> Option<String> {
    // Match "http://localhost:3000" or "Local: http://localhost:3000"
    let re = regex::Regex::new(r"https?://[^\s]+").ok()?;
    if let Some(m) = re.find(line) {
        return Some(m.as_str().trim_end_matches([',', '.', ';', ')']).to_string());
    }
    // Try to build from port if mentioned
    if let Some(p) = port {
        if line.contains(&p.to_string()) {
            return Some(format!("http://localhost:{p}"));
        }
    }
    None
}
