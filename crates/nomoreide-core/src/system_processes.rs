//! The host's process table, and the one guarded way to end a process on it.
//!
//! The Rust half of `src/core/system-processes.ts`. `ps` is the source: it is
//! on every Unix this runs on, it needs no privileges, and it reports the two
//! fields the page is actually about — what a process costs, and who owns it.
//!
//! **Everything here exists to make one button safe.** A process list on a
//! dashboard is only useful if it can be acted on, and acting on it means
//! sending a signal to a pid a browser named. Four classes of process are
//! therefore refused outright: one the daemon manages (stop it properly
//! instead), init and anything below it, this application's own process tree,
//! and anything belonging to another user. What is left is a process this user
//! started and this daemon has no opinion about, which is the only kind worth
//! offering a button for.

use crate::exec_file::{exec_file, ExecOptions};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::time::Duration;

/// One managed service's root process, so its whole tree can be spared.
pub struct ManagedRoot {
    pub pid: i64,
    pub service: String,
}

#[derive(Debug, Clone)]
pub struct SystemProcess {
    pub uid: i64,
    pub user: String,
    pub pid: i64,
    pub ppid: i64,
    pub cpu_percent: f64,
    pub rss_mb: f64,
    pub command: String,
}

fn row_pattern() -> &'static regex::Regex {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    PATTERN.get_or_init(|| {
        regex::Regex::new(r"^(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+)$")
            .expect("valid ps row pattern")
    })
}

/// One row per line `ps` printed, and nothing for a line that does not match.
///
/// A header, a wrapped command, or a process that vanished mid-listing all
/// produce lines this cannot read; dropping them is right, because the
/// alternative is a row with a zero pid on a page with a terminate button.
pub fn parse_system_processes(raw: &str) -> Vec<SystemProcess> {
    raw.trim()
        .split('\n')
        .filter_map(|line| {
            let found = row_pattern().captures(line.trim())?;
            let number = |index: usize| crate::js_number::parse(&found[index]);
            Some(SystemProcess {
                uid: number(1) as i64,
                user: found[2].to_string(),
                pid: number(3) as i64,
                ppid: number(4) as i64,
                cpu_percent: number(5),
                // `ps` reports resident memory in kilobytes.
                rss_mb: number(6) / 1024.0,
                command: found[7].to_string(),
            })
        })
        .collect()
}

pub async fn read_system_processes() -> Result<Vec<SystemProcess>, String> {
    let output = exec_file(
        &[
            "ps".to_string(),
            "-ax".to_string(),
            "-o".to_string(),
            "uid=,user=,pid=,ppid=,%cpu=,rss=,command=".to_string(),
        ],
        &ExecOptions {
            timeout: Duration::from_millis(10_000),
            max_buffer: 8 << 20,
            cwd: None,
        },
    )
    .await?;
    Ok(parse_system_processes(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

/// Why a process may not be terminated from here, or nothing when it may.
fn protection_of(
    row: &SystemProcess,
    managed: &HashMap<i64, String>,
    app_tree: &HashSet<i64>,
    current_uid: Option<u32>,
) -> Option<&'static str> {
    if managed.contains_key(&row.pid) {
        return Some("managed");
    }
    if row.pid <= 1 {
        return Some("system");
    }
    if app_tree.contains(&row.pid) {
        return Some("this-app");
    }
    match current_uid {
        Some(uid) if row.uid == i64::from(uid) => None,
        // An unknown uid is treated as "not mine", which fails closed.
        _ => Some("permission"),
    }
}

/// Every row, with its protection decided.
///
/// Key order is the reference's, which builds the row and then spreads the
/// verdict onto it: the parsed fields, then `canTerminate`, then the two
/// optional ones the verdict added.
pub fn classify_system_processes(
    rows: &[SystemProcess],
    managed_roots: &[ManagedRoot],
    current_pid: i64,
    current_uid: Option<u32>,
) -> Vec<Value> {
    let children = children_by_parent(rows);
    let app_tree = app_tree_pids(rows, &children, current_pid);
    let managed = managed_services(&children, managed_roots);

    rows.iter()
        .map(|row| {
            let protection = protection_of(row, &managed, &app_tree, current_uid);
            let mut entry = Map::new();
            entry.insert("uid".into(), Value::from(row.uid));
            entry.insert("user".into(), Value::String(row.user.clone()));
            entry.insert("pid".into(), Value::from(row.pid));
            entry.insert("ppid".into(), Value::from(row.ppid));
            entry.insert(
                "cpuPercent".into(),
                crate::js_number::value(row.cpu_percent),
            );
            entry.insert("rssMb".into(), crate::js_number::value(row.rss_mb));
            entry.insert("command".into(), Value::String(row.command.clone()));
            entry.insert("canTerminate".into(), Value::Bool(protection.is_none()));
            if let Some(service) = managed.get(&row.pid) {
                entry.insert("managedService".into(), Value::String(service.clone()));
            }
            if let Some(protection) = protection {
                entry.insert("protection".into(), Value::String(protection.to_string()));
            }
            Value::Object(entry)
        })
        .collect()
}

fn children_by_parent(rows: &[SystemProcess]) -> HashMap<i64, Vec<i64>> {
    let mut children: HashMap<i64, Vec<i64>> = HashMap::new();
    for row in rows {
        children.entry(row.ppid).or_default().push(row.pid);
    }
    children
}

/// This process, everything that launched it, and everything it launched.
///
/// Both directions matter: killing an ancestor takes the daemon down with it,
/// and killing a descendant kills something the daemon is in the middle of.
fn app_tree_pids(
    rows: &[SystemProcess],
    children: &HashMap<i64, Vec<i64>>,
    pid: i64,
) -> HashSet<i64> {
    let by_pid: HashMap<i64, i64> = rows.iter().map(|row| (row.pid, row.ppid)).collect();
    let mut related = HashSet::from([pid]);

    let mut parent = by_pid.get(&pid).copied();
    while let Some(current) = parent {
        if current <= 0 || related.contains(&current) {
            break;
        }
        related.insert(current);
        parent = by_pid.get(&current).copied();
    }

    let mut stack: Vec<i64> = children.get(&pid).cloned().unwrap_or_default();
    while let Some(child) = stack.pop() {
        if !related.insert(child) {
            continue;
        }
        stack.extend(children.get(&child).cloned().unwrap_or_default());
    }
    related
}

/// Each managed root's whole tree, mapped to the service that owns it.
fn managed_services(
    children: &HashMap<i64, Vec<i64>>,
    roots: &[ManagedRoot],
) -> HashMap<i64, String> {
    let mut result: HashMap<i64, String> = HashMap::new();
    for root in roots {
        let mut stack = vec![root.pid];
        while let Some(pid) = stack.pop() {
            if result.contains_key(&pid) {
                continue;
            }
            result.insert(pid, root.service.clone());
            stack.extend(children.get(&pid).cloned().unwrap_or_default());
        }
    }
    result
}

/// End one process, after proving it is still the process the caller meant.
///
/// The command is re-read and compared rather than trusted, because a pid is
/// reused the moment its process ends: without the check, a page left open
/// while a process exited would signal whatever took its number.
pub async fn terminate_system_process(
    pid: f64,
    expected_command: &str,
    managed_roots: &[ManagedRoot],
) -> Result<(), String> {
    if !is_safe_integer(pid) || pid <= 1.0 {
        return Err("Invalid process id.".into());
    }
    let pid = pid as i64;
    let rows = read_system_processes().await?;
    let classified = classify_system_processes(
        &rows,
        managed_roots,
        std::process::id() as i64,
        Some(current_uid()),
    );
    let Some(target) = classified
        .iter()
        .find(|row| row.get("pid").and_then(Value::as_i64) == Some(pid))
    else {
        return Err(format!("Process {pid} is no longer running."));
    };
    if target.get("command").and_then(Value::as_str) != Some(expected_command) {
        return Err(format!(
            "Process {pid} changed before it could be terminated."
        ));
    }
    if target.get("canTerminate").and_then(Value::as_bool) != Some(true) {
        let protection = target
            .get("protection")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        return Err(format!("Process {pid} is protected ({protection})."));
    }
    signal_term(pid)
}

/// `Number.isSafeInteger`.
fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}

fn current_uid() -> u32 {
    // Safe: `getuid` takes no arguments and cannot fail.
    unsafe { libc::getuid() }
}

fn signal_term(pid: i64) -> Result<(), String> {
    // Safe: a signal to a pid this has already proven it may signal. A failure
    // is reported rather than ignored, because the caller pressed a button.
    let sent = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    if sent == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str =
        "  501 roro              4242   1  0.0   8192 /usr/bin/some command --flag\n\
                            0 root                 1   0  0.1   1024 /sbin/launchd\n\
                          501 roro              4243 4242  2.5  16384 child of the first\n\
                          not a row at all\n";

    #[test]
    fn a_line_that_is_not_a_row_is_dropped() {
        let rows = parse_system_processes(SAMPLE);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].pid, 4242);
        assert_eq!(rows[0].command, "/usr/bin/some command --flag");
        // Kilobytes on the wire, megabytes in the answer.
        assert_eq!(rows[0].rss_mb, 8.0);
        assert_eq!(rows[2].cpu_percent, 2.5);
    }

    #[test]
    fn init_and_another_users_process_are_both_protected() {
        let rows = parse_system_processes(SAMPLE);
        let classified = classify_system_processes(&rows, &[], 999_999, Some(501));
        let protection = |index: usize| {
            classified[index]
                .get("protection")
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        assert_eq!(protection(0), None, "this user's own process");
        assert_eq!(protection(1), Some("system".into()), "init");

        let others = classify_system_processes(&rows, &[], 999_999, Some(502));
        assert_eq!(
            others[0].get("protection").and_then(Value::as_str),
            Some("permission"),
            "another user's process"
        );
    }

    #[test]
    fn a_managed_root_protects_its_whole_tree() {
        let rows = parse_system_processes(SAMPLE);
        let roots = [ManagedRoot {
            pid: 4242,
            service: "api".into(),
        }];
        let classified = classify_system_processes(&rows, &roots, 999_999, Some(501));
        for index in [0, 2] {
            assert_eq!(
                classified[index].get("protection").and_then(Value::as_str),
                Some("managed"),
                "row {index}"
            );
            assert_eq!(
                classified[index]
                    .get("managedService")
                    .and_then(Value::as_str),
                Some("api")
            );
        }
    }

    #[test]
    fn this_process_and_its_ancestors_are_spared() {
        let rows = parse_system_processes(SAMPLE);
        // 4243's parent is 4242, so naming the child protects the parent too.
        let classified = classify_system_processes(&rows, &[], 4243, Some(501));
        assert_eq!(
            classified[0].get("protection").and_then(Value::as_str),
            Some("this-app"),
            "the ancestor"
        );
        assert_eq!(
            classified[2].get("protection").and_then(Value::as_str),
            Some("this-app"),
            "the process itself"
        );
    }

    #[tokio::test]
    async fn a_pid_at_or_below_init_is_refused_before_anything_is_read() {
        for pid in [0.0, 1.0, -5.0, f64::NAN, 1.5] {
            assert_eq!(
                terminate_system_process(pid, "x", &[]).await,
                Err("Invalid process id.".into()),
                "{pid}"
            );
        }
    }
}
