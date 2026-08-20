use crate::AppState;
use nomoreide_core::config::ServiceDef;
use nomoreide_core::port_utils;
use nomoreide_core::process_manager::{ServiceState, ServiceStatus};
use nomoreide_core::service_graph;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};
use tauri::State;

#[tauri::command]
pub async fn list_services(state: State<'_, AppState>) -> Result<Vec<ServiceStatus>, String> {
    Ok(state.process_manager.status())
}

// ---------------------------------------------------------------------------
// Process tree — powers the service detail "Processes" tab. The desktop backend
// has no full health engine, so this is computed on demand via `ps` rather than
// folded into a dashboard health payload.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessRow {
    pub pid: u32,
    pub ppid: u32,
    pub cpu_percent: f64,
    pub rss_mb: f64,
    pub command: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessTreeSummary {
    pub root_pid: u32,
    pub process_count: usize,
    pub cpu_percent: f64,
    pub rss_mb: f64,
    pub processes: Vec<ProcessRow>,
}

/// Returns the process subtree rooted at a running service's PID, or `None`
/// when the service isn't running (or its root process has already exited).
#[tauri::command]
pub async fn service_processes(
    state: State<'_, AppState>,
    name: String,
) -> Result<Option<ProcessTreeSummary>, String> {
    let Some((root_pid, pgid)) = state.process_manager.service_process_ids(&name) else {
        return Ok(None);
    };
    Ok(process_tree(root_pid, pgid))
}

#[cfg(unix)]
fn process_tree(root_pid: Option<u32>, pgid: Option<u32>) -> Option<ProcessTreeSummary> {
    // pid -> (ppid, pgid, cpu%, rss_kb, command); plus a ppid -> children index.
    let out = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,pgid=,pcpu=,rss=,args="])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);

    let mut all: HashMap<u32, (u32, u32, f64, f64, String)> = HashMap::new();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let Some(pid) = it.next().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        let Some(ppid) = it.next().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        let Some(row_pgid) = it.next().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        let cpu = it.next().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
        let rss = it.next().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
        let command = it.collect::<Vec<_>>().join(" ");
        all.insert(pid, (ppid, row_pgid, cpu, rss, command));
        children.entry(ppid).or_default().push(pid);
    }

    let mut rows: Vec<ProcessRow> = Vec::new();
    let mut seen: HashSet<u32> = HashSet::new();
    let mut stack = root_pid.into_iter().collect::<Vec<_>>();
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        if let Some((ppid, _row_pgid, cpu, rss, command)) = all.get(&pid) {
            rows.push(ProcessRow {
                pid,
                ppid: *ppid,
                cpu_percent: *cpu,
                rss_mb: rss / 1024.0,
                command: command.clone(),
            });
        }
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids);
        }
    }

    // Package managers and shell wrappers sometimes exit or reparent the actual
    // dev server. For services spawned by the current backend, the stored process
    // group remains stable and captures those descendants.
    if let Some(group) = pgid {
        let mut group_pids: Vec<u32> = all
            .iter()
            .filter_map(|(pid, (_ppid, row_pgid, _cpu, _rss, _command))| {
                (*row_pgid == group).then_some(*pid)
            })
            .collect();
        group_pids.sort_unstable();
        for pid in group_pids {
            if !seen.insert(pid) {
                continue;
            }
            if let Some((ppid, _row_pgid, cpu, rss, command)) = all.get(&pid) {
                rows.push(ProcessRow {
                    pid,
                    ppid: *ppid,
                    cpu_percent: *cpu,
                    rss_mb: rss / 1024.0,
                    command: command.clone(),
                });
            }
        }
    }

    if rows.is_empty() {
        return None;
    }

    let root_pid = root_pid.or_else(|| rows.first().map(|row| row.pid))?;
    Some(ProcessTreeSummary {
        root_pid,
        process_count: rows.len(),
        cpu_percent: rows.iter().map(|r| r.cpu_percent).sum(),
        rss_mb: rows.iter().map(|r| r.rss_mb).sum(),
        processes: rows,
    })
}

#[cfg(not(unix))]
fn process_tree(_root_pid: Option<u32>, _pgid: Option<u32>) -> Option<ProcessTreeSummary> {
    None
}

#[tauri::command]
pub async fn start_service(state: State<'_, AppState>, name: String) -> Result<(), String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let def = config
        .services
        .iter()
        .find(|s| s.name == name)
        .cloned()
        .ok_or_else(|| format!("Service '{name}' not found"))?;
    state
        .process_manager
        .start_service(&def)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stop_service(state: State<'_, AppState>, name: String) -> Result<(), String> {
    state
        .process_manager
        .stop_service(&name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn restart_service(state: State<'_, AppState>, name: String) -> Result<(), String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let def = config
        .services
        .iter()
        .find(|s| s.name == name)
        .cloned()
        .ok_or_else(|| format!("Service '{name}' not found"))?;
    state
        .process_manager
        .restart_service(&def)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_bundle(state: State<'_, AppState>, name: String) -> Result<(), String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let bundle = config
        .bundles
        .iter()
        .find(|b| b.name == name)
        .cloned()
        .ok_or_else(|| format!("Bundle '{name}' not found"))?;

    // Topologically order the bundle (and any transitive deps it declares) so
    // dependencies come up before dependents. Errs on a cycle instead of
    // half-starting the bundle.
    let order = service_graph::resolve_start_order(&config.services, &bundle.services)?;
    let by_name: HashMap<&str, &ServiceDef> = config
        .services
        .iter()
        .map(|s| (s.name.as_str(), s))
        .collect();

    for svc_name in &order {
        let Some(def) = by_name.get(svc_name.as_str()) else {
            continue;
        };
        // Each declared dependency precedes this service in `order` and is thus
        // already started; wait for it to look ready before the dependent.
        if let Some(deps) = &def.depends_on {
            for dep in deps {
                if let Some(dep_def) = by_name.get(dep.as_str()) {
                    wait_for_service_ready(&state, dep_def).await;
                }
            }
        }
        state
            .process_manager
            .start_service(def)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Wait until a dependency looks ready before starting services that need it.
/// A service with a port is "ready" once that port is bound; portless services
/// have no probe, so we return immediately. Times out (does not error) so a
/// slow/never-binding dependency can't wedge a bundle start.
async fn wait_for_service_ready(state: &State<'_, AppState>, def: &ServiceDef) {
    let Some(port) = def.port else {
        return;
    };
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        match state.process_manager.service_status(&def.name) {
            Some(status)
                if status.state == ServiceState::Running
                    || status.state == ServiceState::Starting => {}
            // Stopped/stopping/gone → nothing to wait for.
            _ => return,
        }
        if !port_utils::is_port_available("127.0.0.1", port) {
            return; // port bound → ready
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[tauri::command]
pub async fn stop_bundle(state: State<'_, AppState>, name: String) -> Result<(), String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let bundle = config
        .bundles
        .iter()
        .find(|b| b.name == name)
        .cloned()
        .ok_or_else(|| format!("Bundle '{name}' not found"))?;

    // Reverse dependency order, scoped to the bundle's own members. Falls back
    // to declaration order if a cycle makes a topo sort impossible — stopping
    // must never fail the way a start can.
    let in_bundle: HashSet<&str> = bundle.services.iter().map(|s| s.as_str()).collect();
    let mut order: Vec<String> =
        service_graph::resolve_start_order(&config.services, &bundle.services)
            .unwrap_or_else(|_| bundle.services.clone())
            .into_iter()
            .filter(|svc_name| in_bundle.contains(svc_name.as_str()))
            .collect();
    order.reverse();

    for svc_name in &order {
        state
            .process_manager
            .stop_service(svc_name)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
