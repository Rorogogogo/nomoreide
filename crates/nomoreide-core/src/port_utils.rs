#![allow(dead_code)]
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::net::TcpListener;
#[cfg(unix)]
use std::process::Command;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortBindingStatus {
    pub port: u16,
    pub available: bool,
    pub bindings: Vec<PortBinding>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortBinding {
    pub host: String,
    pub port: u16,
    pub bound: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortHolder {
    pub pid: u32,
    pub pgid: Option<u32>,
    pub uid: Option<u32>,
    pub command: String,
    pub start_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortHolderExpectation {
    pub pid: u32,
    pub command: String,
    pub start_token: String,
}

impl From<&PortHolder> for PortHolderExpectation {
    fn from(holder: &PortHolder) -> Self {
        Self {
            pid: holder.pid,
            command: holder.command.clone(),
            start_token: holder.start_token.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ManagedProcessRoot {
    pub pid: u32,
    pub pgid: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SystemProcess {
    pid: u32,
    ppid: u32,
    pgid: u32,
    uid: u32,
    command: String,
    start_token: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessProtection {
    Managed,
    Permission,
    System,
    ThisApp,
}

pub fn is_port_available(host: &str, port: u16) -> bool {
    TcpListener::bind((host, port)).is_ok()
}

pub fn check_host_port(host: &str, port: u16) -> bool {
    !is_port_available(host, port)
}

pub fn get_port_binding_status(port: u16) -> PortBindingStatus {
    let hosts = ["127.0.0.1", "::1", "0.0.0.0"];
    let bindings = hosts
        .iter()
        .map(|host| PortBinding {
            host: (*host).to_string(),
            port,
            bound: check_host_port(host, port),
        })
        .collect::<Vec<_>>();
    let available = bindings.iter().all(|binding| !binding.bound);
    PortBindingStatus {
        port,
        available,
        bindings,
    }
}

#[cfg(unix)]
pub fn get_port_holder(port: u16) -> Result<Option<PortHolder>> {
    let port_filter = format!("-iTCP:{port}");
    let output = Command::new("lsof")
        .args(["-nP", &port_filter, "-sTCP:LISTEN", "-t"])
        .output();
    let output = match output {
        Ok(output) if output.status.success() => output,
        Ok(_) => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let pid = String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .next()
        .and_then(|value| value.parse::<u32>().ok());
    let Some(pid) = pid else {
        return Ok(None);
    };
    Ok(inspect_process(pid)?.map(|process| PortHolder {
        pid: process.pid,
        pgid: Some(process.pgid),
        uid: Some(process.uid),
        command: process.command,
        start_token: process.start_token,
    }))
}

#[cfg(not(unix))]
pub fn get_port_holder(_port: u16) -> Result<Option<PortHolder>> {
    Ok(None)
}

#[cfg(unix)]
pub async fn terminate_port_holder(
    port: u16,
    expected: &PortHolderExpectation,
    managed_roots: &[ManagedProcessRoot],
    term_grace: Duration,
    kill_grace: Duration,
) -> Result<()> {
    let Some(holder) = get_port_holder(port)? else {
        if is_port_available("127.0.0.1", port) {
            return Ok(());
        }
        return Err(anyhow!(
            "Port {port} is occupied but its holder could not be verified"
        ));
    };
    validate_current_holder(expected, &holder, managed_roots)?;
    signal_holder(&holder, libc::SIGTERM)?;
    if wait_for_port_free(port, term_grace).await {
        return Ok(());
    }

    let Some(holder) = get_port_holder(port)? else {
        return wait_for_port_free(port, kill_grace)
            .await
            .then_some(())
            .ok_or_else(|| anyhow!("Port {port} did not become available"));
    };
    validate_current_holder(expected, &holder, managed_roots)?;
    signal_holder(&holder, libc::SIGKILL)?;
    if wait_for_port_free(port, kill_grace).await {
        Ok(())
    } else {
        Err(anyhow!("Port {port} holder termination was not confirmed"))
    }
}

#[cfg(not(unix))]
pub async fn terminate_port_holder(
    _port: u16,
    _expected: &PortHolderExpectation,
    _managed_roots: &[ManagedProcessRoot],
    _term_grace: Duration,
    _kill_grace: Duration,
) -> Result<()> {
    Err(anyhow!(
        "Port-holder termination is not supported on this platform"
    ))
}

#[cfg(unix)]
fn validate_current_holder(
    expected: &PortHolderExpectation,
    holder: &PortHolder,
    managed_roots: &[ManagedProcessRoot],
) -> Result<()> {
    let rows = read_system_processes()?;
    validate_holder(
        expected,
        holder,
        &rows,
        managed_roots,
        std::process::id(),
        unsafe { libc::geteuid() },
    )
}

#[cfg(unix)]
fn inspect_process(pid: u32) -> Result<Option<SystemProcess>> {
    let pid_string = pid.to_string();
    let output = Command::new("ps")
        .args([
            "-o",
            "uid=,pid=,ppid=,pgid=,lstart=,command=",
            "-p",
            &pid_string,
        ])
        .output()?;
    if !output.status.success() {
        return Ok(None);
    }
    let mut process = String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(parse_system_process);
    if let Some(process) = process.as_mut() {
        process.start_token = kernel_start_token(pid)?;
    }
    Ok(process)
}

#[cfg(unix)]
pub(crate) fn inspect_process_identity(pid: u32) -> Result<Option<PortHolder>> {
    Ok(inspect_process(pid)?.map(|process| PortHolder {
        pid: process.pid,
        pgid: Some(process.pgid),
        uid: Some(process.uid),
        command: process.command,
        start_token: process.start_token,
    }))
}

#[cfg(not(unix))]
pub(crate) fn inspect_process_identity(_pid: u32) -> Result<Option<PortHolder>> {
    Ok(None)
}

/// The kernel's process-creation token on its own, read without forking `ps`.
///
/// `pid` plus this token is the exact identity of one process instance: the
/// token is stamped at fork and survives `exec`, so it is stable across the
/// whole launch handshake and it cannot be replayed by pid reuse. A vanished
/// process reports `None` rather than an error.
#[cfg(unix)]
pub(crate) fn process_start_token(pid: u32) -> Result<Option<String>> {
    match kernel_start_token(pid) {
        Ok(token) => Ok(Some(token)),
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                || error.raw_os_error() == Some(libc::ESRCH) =>
        {
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}

#[cfg(not(unix))]
pub(crate) fn process_start_token(_pid: u32) -> Result<Option<String>> {
    Ok(None)
}

#[cfg(unix)]
fn read_system_processes() -> Result<Vec<SystemProcess>> {
    let output = Command::new("ps")
        .args(["-ax", "-o", "uid=,pid=,ppid=,pgid=,lstart=,command="])
        .output()?;
    if !output.status.success() {
        return Err(anyhow!("Could not inspect system processes"));
    }
    let mut processes = Vec::new();
    for mut process in String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(parse_system_process)
    {
        if let Ok(start_token) = kernel_start_token(process.pid) {
            process.start_token = start_token;
            processes.push(process);
        }
    }
    Ok(processes)
}

fn parse_system_process(line: &str) -> Option<SystemProcess> {
    let fields = line.split_whitespace().collect::<Vec<_>>();
    if fields.len() < 10 {
        return None;
    }
    Some(SystemProcess {
        uid: fields[0].parse().ok()?,
        pid: fields[1].parse().ok()?,
        ppid: fields[2].parse().ok()?,
        pgid: fields[3].parse().ok()?,
        start_token: String::new(),
        command: fields[9..].join(" "),
    })
}

#[cfg(target_os = "linux")]
fn kernel_start_token(pid: u32) -> std::io::Result<String> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let command_end = stat.rfind(')').ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid process stat")
    })?;
    let fields = stat[command_end + 1..]
        .split_whitespace()
        .collect::<Vec<_>>();
    let start_ticks = fields.get(19).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "missing process start time",
        )
    })?;
    Ok(format!("linux:{start_ticks}"))
}

#[cfg(target_os = "macos")]
fn kernel_start_token(pid: u32) -> std::io::Result<String> {
    const PROC_PIDTBSDINFO: libc::c_int = 3;
    const MAXCOMLEN: usize = 16;

    #[repr(C)]
    struct ProcBsdInfo {
        pbi_flags: u32,
        pbi_status: u32,
        pbi_xstatus: u32,
        pbi_pid: u32,
        pbi_ppid: u32,
        pbi_uid: u32,
        pbi_gid: u32,
        pbi_ruid: u32,
        pbi_rgid: u32,
        pbi_svuid: u32,
        pbi_svgid: u32,
        rfu_1: u32,
        pbi_comm: [libc::c_char; MAXCOMLEN],
        pbi_name: [libc::c_char; 2 * MAXCOMLEN],
        pbi_nfiles: u32,
        pbi_pgid: u32,
        pbi_pjobc: u32,
        e_tdev: u32,
        e_tpgid: u32,
        pbi_nice: i32,
        pbi_start_tvsec: u64,
        pbi_start_tvusec: u64,
    }

    #[link(name = "proc")]
    extern "C" {
        fn proc_pidinfo(
            pid: libc::c_int,
            flavor: libc::c_int,
            arg: u64,
            buffer: *mut libc::c_void,
            buffer_size: libc::c_int,
        ) -> libc::c_int;
    }

    let pid = libc::c_int::try_from(pid)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid pid"))?;
    let mut info = std::mem::MaybeUninit::<ProcBsdInfo>::zeroed();
    let expected_size = std::mem::size_of::<ProcBsdInfo>();
    let result = unsafe {
        proc_pidinfo(
            pid,
            PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            expected_size as libc::c_int,
        )
    };
    if result != expected_size as libc::c_int {
        return Err(std::io::Error::last_os_error());
    }
    let info = unsafe { info.assume_init() };
    Ok(format!(
        "darwin:{}:{}",
        info.pbi_start_tvsec, info.pbi_start_tvusec
    ))
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn kernel_start_token(_pid: u32) -> std::io::Result<String> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "strong process identity is unsupported on this platform",
    ))
}

fn validate_holder(
    expected: &PortHolderExpectation,
    current: &PortHolder,
    rows: &[SystemProcess],
    managed_roots: &[ManagedProcessRoot],
    current_pid: u32,
    current_uid: u32,
) -> Result<()> {
    if expected.pid != current.pid
        || expected.command != current.command
        || expected.start_token != current.start_token
    {
        return Err(anyhow!("Port holder changed before it could be terminated"));
    }
    let target = rows
        .iter()
        .find(|process| process.pid == current.pid)
        .ok_or_else(|| anyhow!("Port holder is no longer running"))?;
    if target.command != expected.command || target.start_token != expected.start_token {
        return Err(anyhow!("Port holder changed before it could be terminated"));
    }
    if let Some(protection) =
        classify_process(rows, target, managed_roots, current_pid, current_uid)
    {
        return Err(anyhow!("Port holder is protected ({protection:?})"));
    }
    Ok(())
}

fn classify_process(
    rows: &[SystemProcess],
    target: &SystemProcess,
    managed_roots: &[ManagedProcessRoot],
    current_pid: u32,
    current_uid: u32,
) -> Option<ProcessProtection> {
    if target.pid <= 1 {
        return Some(ProcessProtection::System);
    }
    if target.uid != current_uid {
        return Some(ProcessProtection::Permission);
    }
    if managed_roots
        .iter()
        .any(|root| root.pid == target.pid || root.pgid == Some(target.pgid))
    {
        return Some(ProcessProtection::Managed);
    }

    let children = child_index(rows);
    for root in managed_roots {
        if descendants(&children, root.pid).contains(&target.pid) {
            return Some(ProcessProtection::Managed);
        }
    }
    related_processes(rows, &children, current_pid)
        .contains(&target.pid)
        .then_some(ProcessProtection::ThisApp)
}

fn child_index(rows: &[SystemProcess]) -> HashMap<u32, Vec<u32>> {
    let mut children = HashMap::<u32, Vec<u32>>::new();
    for row in rows {
        children.entry(row.ppid).or_default().push(row.pid);
    }
    children
}

fn descendants(children: &HashMap<u32, Vec<u32>>, root: u32) -> HashSet<u32> {
    let mut result = HashSet::new();
    let mut stack = children.get(&root).cloned().unwrap_or_default();
    while let Some(pid) = stack.pop() {
        if result.insert(pid) {
            stack.extend(children.get(&pid).into_iter().flatten());
        }
    }
    result
}

fn related_processes(
    rows: &[SystemProcess],
    children: &HashMap<u32, Vec<u32>>,
    current_pid: u32,
) -> HashSet<u32> {
    let by_pid = rows
        .iter()
        .map(|process| (process.pid, process))
        .collect::<HashMap<_, _>>();
    let mut related = descendants(children, current_pid);
    related.insert(current_pid);
    let mut parent = by_pid.get(&current_pid).map(|process| process.ppid);
    while let Some(pid) = parent.filter(|pid| *pid > 0 && !related.contains(pid)) {
        related.insert(pid);
        parent = by_pid.get(&pid).map(|process| process.ppid);
    }
    related
}

#[cfg(unix)]
fn signal_holder(holder: &PortHolder, signal: libc::c_int) -> Result<()> {
    let pid = libc::pid_t::try_from(holder.pid).map_err(|_| anyhow!("Invalid process id"))?;
    let target = if holder.pgid == Some(holder.pid) {
        -pid
    } else {
        pid
    };
    let result = unsafe { libc::kill(target, signal) };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error.into())
    }
}

async fn wait_for_port_free(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if is_port_available("127.0.0.1", port) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::process::CommandExt;
    #[cfg(unix)]
    use std::path::PathBuf;

    fn row(pid: u32, ppid: u32, pgid: u32, uid: u32, command: &str) -> SystemProcess {
        SystemProcess {
            pid,
            ppid,
            pgid,
            uid,
            command: command.into(),
            start_token: format!("start-{pid}"),
        }
    }

    fn holder(process: &SystemProcess) -> PortHolder {
        PortHolder {
            pid: process.pid,
            pgid: Some(process.pgid),
            uid: Some(process.uid),
            command: process.command.clone(),
            start_token: process.start_token.clone(),
        }
    }

    #[test]
    fn holder_validation_requires_the_expected_identity() {
        let target = row(20, 1, 20, 501, "node server.js");
        let rows = vec![row(1, 0, 1, 0, "launchd"), target.clone()];
        let mut expected = PortHolderExpectation::from(&holder(&target));
        expected.command = "different command".into();

        let error = validate_holder(&expected, &holder(&target), &rows, &[], 99, 501).unwrap_err();

        assert!(error.to_string().contains("changed"));
    }

    #[test]
    fn holder_validation_rejects_managed_app_and_foreign_processes() {
        let rows = vec![
            row(1, 0, 1, 0, "launchd"),
            row(10, 1, 10, 501, "nomoreide"),
            row(11, 10, 11, 501, "app-child"),
            row(20, 1, 20, 501, "managed"),
            row(21, 20, 20, 501, "managed-child"),
            row(30, 1, 30, 502, "foreign"),
        ];
        for (pid, expected_protection) in [
            (10, "ThisApp"),
            (11, "ThisApp"),
            (20, "Managed"),
            (21, "Managed"),
            (30, "Permission"),
        ] {
            let target = rows.iter().find(|row| row.pid == pid).unwrap();
            let error = validate_holder(
                &PortHolderExpectation::from(&holder(target)),
                &holder(target),
                &rows,
                &[ManagedProcessRoot {
                    pid: 20,
                    pgid: Some(20),
                }],
                10,
                501,
            )
            .unwrap_err();
            assert!(error.to_string().contains(expected_protection));
        }
    }

    #[test]
    fn holder_validation_allows_an_exact_unprotected_same_user_process() {
        let target = row(40, 1, 40, 501, "node external.js");
        let rows = vec![row(1, 0, 1, 0, "launchd"), target.clone()];

        validate_holder(
            &PortHolderExpectation::from(&holder(&target)),
            &holder(&target),
            &rows,
            &[],
            99,
            501,
        )
        .unwrap();
    }

    #[cfg(unix)]
    #[test]
    #[allow(clippy::zombie_processes)] // Parent mode intentionally orphans the listener to test an unrelated holder.
    fn port_holder_process_helper() {
        let Ok(mode) = std::env::var("NOMOREIDE_PORT_HELPER_MODE") else {
            return;
        };
        let port = std::env::var("NOMOREIDE_PORT_HELPER_PORT")
            .unwrap()
            .parse::<u16>()
            .unwrap();
        let pid_file = PathBuf::from(std::env::var("NOMOREIDE_PORT_HELPER_PID_FILE").unwrap());
        if mode == "parent" {
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "port_utils::tests::port_holder_process_helper",
                    "--nocapture",
                ])
                .env("NOMOREIDE_PORT_HELPER_MODE", "listener")
                .env("NOMOREIDE_PORT_HELPER_PORT", port.to_string())
                .env("NOMOREIDE_PORT_HELPER_PID_FILE", &pid_file)
                .process_group(0)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            return;
        }

        let _listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
        std::fs::write(pid_file, std::process::id().to_string()).unwrap();
        loop {
            std::thread::park_timeout(Duration::from_secs(60));
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn holder_termination_requires_a_fresh_exact_identity() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let pid_file = std::env::temp_dir().join(format!(
            "nomoreide-port-holder-{}-{}.pid",
            std::process::id(),
            port
        ));
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "port_utils::tests::port_holder_process_helper",
                "--nocapture",
            ])
            .env("NOMOREIDE_PORT_HELPER_MODE", "parent")
            .env("NOMOREIDE_PORT_HELPER_PORT", port.to_string())
            .env("NOMOREIDE_PORT_HELPER_PID_FILE", &pid_file)
            .status()
            .unwrap();
        assert!(status.success());

        let deadline = Instant::now() + Duration::from_secs(3);
        let (pid, holder) = loop {
            let pid = std::fs::read_to_string(&pid_file)
                .ok()
                .and_then(|value| value.trim().parse::<u32>().ok());
            let holder = get_port_holder(port).unwrap();
            if let (Some(pid), Some(holder)) = (pid, holder) {
                break (pid, holder);
            }
            assert!(
                Instant::now() < deadline,
                "listener identity was not observable"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        let guard = HelperProcessGuard(pid);
        let mut stale = PortHolderExpectation::from(&holder);
        stale.start_token.push_str("-stale");

        let error = terminate_port_holder(
            port,
            &stale,
            &[],
            Duration::from_millis(50),
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("changed"));
        assert!(!is_port_available("127.0.0.1", port));
        terminate_port_holder(
            port,
            &PortHolderExpectation::from(&holder),
            &[],
            Duration::from_millis(100),
            Duration::from_secs(2),
        )
        .await
        .unwrap();
        assert!(is_port_available("127.0.0.1", port));
        std::mem::forget(guard);
        let _ = std::fs::remove_file(pid_file);
    }

    #[cfg(unix)]
    struct HelperProcessGuard(u32);

    #[cfg(unix)]
    impl Drop for HelperProcessGuard {
        fn drop(&mut self) {
            unsafe {
                libc::kill(-(self.0 as libc::pid_t), libc::SIGKILL);
            }
        }
    }
}
