//! Saved and discovered SSH servers, connection checks, and read-only metrics.
//!
//! The Rust half of `src/core/ssh-servers.ts`. Everything here runs one `ssh`
//! and parses what comes back; nothing writes to the far end, and the remote
//! side needs only POSIX `sh`, `awk`, `ps`, `find` and procfs — not Node, not
//! an agent.
//!
//! **Three guards that look like one.** A host is checked against
//! [`SAFE_SSH_HOST`] before every remote call, but where the refusal surfaces
//! differs per endpoint, because in the reference the guard sits inside
//! whichever block that route wraps. A probe turns it into a 400; a listing,
//! preview or sample turns it into the same 502 a dead link would give. That is
//! reproduced by *where* the error is returned from, not by classifying it.
//!
//! **The escaping is this module's, not the shared helper's.** `log-sources.ts`
//! escapes a quote as `'\''` and this module escapes it as `'"'"'`. Both are
//! correct shell and the two are not interchangeable here, because a failed
//! command quotes its own argv back to the caller — so the escape is part of
//! the answer. They stay separate deliberately.

use crate::config::SshServerDef;
use crate::exec_file::{exec_file, ExecOptions, ExecOutput};
use crate::js_number;
use crate::locale;
use crate::read_only_files::{
    assert_read_only_path, parse_read_only_directory, parse_read_only_file, FILE_PREVIEW_BYTES,
    FILE_READ_TIMEOUT_MS, READ_DIRECTORY_SCRIPT, READ_FILE_SCRIPT,
};
use crate::zod_report::{report, ZodIssue};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// A probe waits less than a read does: it exists to answer "is this machine
/// there", and a machine that needs seven seconds to say so is not.
const SSH_TIMEOUT: Duration = Duration::from_millis(7_000);

const SSH_OPTIONS: [&str; 4] = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"];

/// A host name, an IP, `user@host`, or a `~/.ssh/config` alias — and nothing
/// that could be read as an option or as more shell. The leading character
/// class is what refuses `-oProxyCommand=…`.
fn safe_ssh_host() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._:@-]*$").expect("valid pattern"))
}

fn assert_safe_ssh_host(host: &str) -> Result<(), String> {
    if safe_ssh_host().is_match(host) {
        return Ok(());
    }
    Err("SSH host must be a host name or ~/.ssh/config alias.".to_string())
}

/// One argument, quoted for the *remote* shell.
///
/// See the module note: this spelling differs from `log_sources`' on purpose.
fn shell_escape(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn remote_sh_command(script: &str, path: &str) -> String {
    format!(
        "LC_ALL=C sh -c {} nomoreide {}",
        shell_escape(script),
        shell_escape(path)
    )
}

fn ssh_argv(host: &str, command: &str) -> Vec<String> {
    let mut argv = vec!["ssh".to_string()];
    argv.extend(SSH_OPTIONS.iter().map(|option| option.to_string()));
    argv.push(host.to_string());
    argv.push(command.to_string());
    argv
}

async fn run_ssh(
    host: &str,
    command: &str,
    timeout: Duration,
    max_buffer: usize,
) -> Result<ExecOutput, String> {
    exec_file(
        &ssh_argv(host, command),
        &ExecOptions {
            timeout,
            max_buffer,
            cwd: None,
        },
    )
    .await
}

/// Explicit, concrete aliases from `~/.ssh/config`. A pattern is not a host.
///
/// `Host` is matched case-insensitively and one line may name several. A
/// candidate holding `*`, `?` or `!` is a pattern rather than a machine, and one
/// starting with `-` would be read as an option by every tool downstream. What
/// survives is deduplicated and sorted the way the platform collates, not the
/// way bytes do.
pub fn parse_ssh_config_hosts(contents: &str) -> Vec<String> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let host_line =
        PATTERN.get_or_init(|| Regex::new(r"(?i)^Host\s+(.+)$").expect("valid pattern"));

    let mut hosts: Vec<String> = Vec::new();
    for raw_line in contents.lines() {
        let line = raw_line.trim();
        let Some(captures) = host_line.captures(line) else {
            continue;
        };
        let names = captures.get(1).map_or("", |group| group.as_str());
        for candidate in names.split_whitespace() {
            if candidate.contains(['*', '?', '!']) || candidate.starts_with('-') {
                continue;
            }
            if !hosts.iter().any(|existing| existing == candidate) {
                hosts.push(candidate.to_string());
            }
        }
    }
    hosts.sort_by(|left, right| locale::compare(left, right));
    hosts
}

/// A missing or unreadable config is no hosts, not a failure — the servers page
/// still has the user's saved machines to show.
pub async fn discover_ssh_hosts(config_path: &Path) -> Vec<String> {
    match tokio::fs::read_to_string(config_path).await {
        Ok(contents) => parse_ssh_config_hosts(&contents),
        Err(_) => Vec::new(),
    }
}

/// `~/.ssh`.
///
/// Resolved here rather than in the route because this is the crate that
/// already depends on `dirs`, and because the config reader and the setup probe
/// want the same directory — one answer, not two that could drift.
pub fn ssh_directory() -> PathBuf {
    crate::home::home_directory().join(".ssh")
}

/// One row per host, whether it came from the user, from `~/.ssh/config`, or
/// from a host provider.
///
/// Merged on the host string, so a machine that is both saved and discovered is
/// one row. The saved metadata wins: a provider supplies a starting point, and
/// what the user typed is not overridden by it.
pub fn merge_ssh_servers(
    saved: &[SshServerDef],
    discovered: &[String],
    host_targets: &[HostSshTarget],
) -> Vec<Value> {
    let mut hosts: Vec<&str> = Vec::new();
    for host in discovered
        .iter()
        .map(String::as_str)
        .chain(saved.iter().map(|server| server.host.as_str()))
        .chain(host_targets.iter().map(|target| target.host.as_str()))
    {
        if !hosts.contains(&host) {
            hosts.push(host);
        }
    }
    hosts.sort_by(|left, right| locale::compare(left, right));

    hosts
        .into_iter()
        .map(|host| {
            // Last wins, not first. The reference builds a `Map` from each
            // list, and a `Map` keeps the *later* value for a repeated key —
            // so when two provider instances answer at one address, or two
            // saved rows name one host, it is the last of them that describes
            // the row. `find` would take the first and disagree.
            let saved_server = saved.iter().rev().find(|server| server.host == host);
            let target = host_targets.iter().rev().find(|target| target.host == host);
            let mut row = Map::new();
            row.insert("host".into(), Value::String(host.to_string()));
            let name = saved_server
                .and_then(|server| server.name.clone())
                .or_else(|| target.and_then(|target| target.name.clone()));
            if let Some(name) = name {
                row.insert("name".into(), Value::String(name));
            }
            let environment = saved_server
                .and_then(|server| server.environment.clone())
                .or_else(|| target.and_then(|target| target.environment.clone()));
            if let Some(environment) = environment {
                row.insert("environment".into(), Value::String(environment));
            }
            if let Some(instance) = target.map(|target| target.instance.clone()) {
                row.insert("instance".into(), instance);
            }
            row.insert(
                "discovered".into(),
                Value::Bool(discovered.iter().any(|entry| entry == host)),
            );
            row.insert(
                "saved".into(),
                Value::Bool(saved.iter().any(|server| server.host == host)),
            );
            Value::Object(row)
        })
        .collect()
}

/// The saved-server schema, as a check rather than a parser.
///
/// Zod runs **every** check on a string rather than stopping at the first, and
/// collects all of their issues — so a blank host reports both "at least 1
/// character" and the pattern. The order is the order the schema declares:
/// `trim`, `min`, `max`, `regex` within a field, and `host`, `name`,
/// `environment` across them. The caller hands the report back as the error
/// message, so both orderings are part of the answer.
///
/// Returns the **trimmed** definition, because that is what the schema produces
/// and therefore what gets stored — a host saved with padding is saved without.
pub fn check_ssh_server(server: &SshServerDef) -> Result<SshServerDef, String> {
    let mut issues = Vec::new();
    let host = server.host.trim().to_string();
    let host_path = vec![Value::String("host".into())];
    length_issues(&host, 1, 255, &host_path, &mut issues);
    if !safe_ssh_host().is_match(&host) {
        issues.push(ZodIssue::invalid_regex(HOST_MESSAGE, host_path));
    }

    // Neither of these has a pattern — any text is a name.
    let name = server.name.as_ref().map(|value| value.trim().to_string());
    if let Some(name) = &name {
        length_issues(name, 1, 80, &[Value::String("name".into())], &mut issues);
    }
    let environment = server
        .environment
        .as_ref()
        .map(|value| value.trim().to_string());
    if let Some(environment) = &environment {
        length_issues(
            environment,
            1,
            40,
            &[Value::String("environment".into())],
            &mut issues,
        );
    }

    if issues.is_empty() {
        return Ok(SshServerDef {
            host,
            name,
            environment,
        });
    }
    Err(report(&issues))
}

/// `sshServerSchema.shape.host.parse(value)` — the same string rules with an
/// empty path, because there is no object around it to name the field.
pub fn check_ssh_host(host: &str) -> Result<String, String> {
    let trimmed = host.trim().to_string();
    let mut issues = Vec::new();
    length_issues(&trimmed, 1, 255, &[], &mut issues);
    if !safe_ssh_host().is_match(&trimmed) {
        issues.push(ZodIssue::invalid_regex(HOST_MESSAGE, Vec::new()));
    }
    if issues.is_empty() {
        return Ok(trimmed);
    }
    Err(report(&issues))
}

const HOST_MESSAGE: &str = "SSH host must be a host name or ~/.ssh/config alias.";

/// `min` and then `max`, each reported if it fails. Both can, for a value that
/// is somehow shorter than the floor and longer than the ceiling — they cannot
/// here, but the schema does not know that and neither does this.
fn length_issues(
    value: &str,
    minimum: i64,
    maximum: i64,
    path: &[Value],
    issues: &mut Vec<ZodIssue>,
) {
    // `String.prototype.length`: UTF-16 code units, not characters.
    let length = value.encode_utf16().count() as i64;
    if length < minimum {
        issues.push(ZodIssue::too_small_string(minimum, path.to_vec()));
    }
    if length > maximum {
        issues.push(ZodIssue::too_big_string(maximum, path.to_vec()));
    }
}

/// A machine a connected host provider contributed, as an SSH target.
#[derive(Debug, Clone, PartialEq)]
pub struct HostSshTarget {
    pub host: String,
    pub name: Option<String>,
    pub environment: Option<String>,
    /// The provider's own reference to the machine, passed through untouched.
    pub instance: Value,
}

/// How long a provider's instance list is reused.
///
/// The servers view reloads on an interval *and* on every window focus, and
/// each reload would otherwise be one API call per connected provider.
/// Instances do not change on a human timescale, so a short window trades
/// staleness nobody notices for not being rate-limited by the vendor. A power
/// action clears it explicitly, which is the one case where the delay would be
/// visible.
const HOST_TARGET_TTL_MS: f64 = 30_000.0;

static HOST_TARGETS: Mutex<Option<(f64, Vec<HostSshTarget>)>> = Mutex::new(None);

/// Every connected host provider's instances, as SSH targets.
///
/// **Never fails.** A provider that is not connected, whose token has expired,
/// or whose API is down contributes nothing; the user's hand-registered and
/// `~/.ssh/config` hosts must still list. A provider outage is not a reason for
/// the servers page to go blank, and there is nowhere in that page's shape to
/// report one.
///
/// The empty answer is cached like any other, which is deliberate: a provider
/// that is down would otherwise be retried on every reload of a page that
/// reloads on focus.
pub async fn host_provider_ssh_targets(
    store: &crate::config::ConfigStore,
    config: &crate::config::Config,
) -> Vec<HostSshTarget> {
    if let Some(cached) = cached_host_targets() {
        return cached;
    }
    let targets: Vec<HostSshTarget> = crate::vultr_context::list_instances(store, config)
        .await
        .map(|instances| {
            instances
                .iter()
                .filter_map(crate::vultr_provider::to_ssh_target)
                .collect()
        })
        .unwrap_or_default();
    if let Ok(mut cache) = HOST_TARGETS.lock() {
        *cache = Some((now_ms(), targets.clone()));
    }
    targets
}

/// Forget the cached instance list.
///
/// For after a power action or a change of credential — the moments the delay
/// above would show, because the user just acted and is looking at the row for
/// it. **Nothing calls this yet**: the routes that do in the reference are
/// `/api/hosts/*`, which no client asks for and which the daemon does not
/// serve. It exists because the cache and the way out of it belong together;
/// a cache whose invalidation arrives with a later port is a cache someone has
/// to rediscover the need for.
pub fn invalidate_host_ssh_targets() {
    if let Ok(mut cache) = HOST_TARGETS.lock() {
        *cache = None;
    }
}

fn cached_host_targets() -> Option<Vec<HostSshTarget>> {
    let cache = HOST_TARGETS.lock().ok()?;
    let (at, targets) = cache.as_ref()?;
    (now_ms() - at < HOST_TARGET_TTL_MS).then(|| targets.clone())
}

/// Is the machine there, and what is it?
///
/// Never fails for an unreachable host — that is an answer, not an error, and
/// the caller renders `reachable: false` beside the reason. Only the host guard
/// produces an `Err`, which is why a bad host name is the one refusal this
/// endpoint reports with a failure status.
pub async fn probe_ssh_server(host: &str) -> Result<Value, String> {
    assert_safe_ssh_host(host)?;
    let started_at = now_ms();
    let outcome = run_ssh(
        host,
        r"printf 'NMI\t'; hostname; uname -s",
        SSH_TIMEOUT,
        64 * 1024,
    )
    .await;

    let mut probe = Map::new();
    probe.insert("host".into(), Value::String(host.to_string()));
    let failure = match outcome {
        Err(failure) => Some(failure),
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
            let lines: Vec<&str> = stdout.trim().split('\n').map(str::trim_end).collect();
            let first: Vec<&str> = lines
                .first()
                .map_or(Vec::new(), |line| line.split('\t').collect());
            if first.first() != Some(&"NMI") {
                Some("Remote probe returned an unexpected response.".to_string())
            } else {
                probe.insert("reachable".into(), Value::Bool(true));
                probe.insert("latencyMs".into(), js_number::value(now_ms() - started_at));
                let hostname = first.get(1).map(|value| value.trim()).unwrap_or_default();
                if !hostname.is_empty() {
                    probe.insert("hostname".into(), Value::String(hostname.to_string()));
                }
                let platform = lines.get(1).map(|value| value.trim()).unwrap_or_default();
                if !platform.is_empty() {
                    probe.insert("platform".into(), Value::String(platform.to_string()));
                }
                return Ok(Value::Object(probe));
            }
        }
    };

    probe.insert("reachable".into(), Value::Bool(false));
    probe.insert("latencyMs".into(), js_number::value(now_ms() - started_at));
    probe.insert(
        "error".into(),
        Value::String(concise_ssh_error(&failure.unwrap_or_default())),
    );
    Ok(Value::Object(probe))
}

/// The **last** line of what went wrong.
///
/// A failed `ssh` writes a banner, then a diagnosis, then "lost connection";
/// the last line is the one worth putting in a table cell. This is the only
/// place on this surface that shortens a failure — the reads quote the whole
/// command and all of stderr, because their answer is the failure.
fn concise_ssh_error(failure: &str) -> String {
    // `error.stderr || error.message`: the message is the fallback, and by the
    // time it is reached it has already had the command prefixed to it.
    let stderr = failure
        .split_once('\n')
        .map(|(_command, rest)| rest.trim())
        .filter(|rest| !rest.is_empty());
    let text = stderr.unwrap_or(failure);
    text.split('\n').next_back().unwrap_or(text).to_string()
}

pub async fn read_remote_host_metrics(host: &str) -> Result<Value, String> {
    assert_safe_ssh_host(host)?;
    let output = run_ssh(host, REMOTE_METRICS_COMMAND, SSH_TIMEOUT, 2 * 1024 * 1024).await?;
    parse_remote_metrics(host, &String::from_utf8_lossy(&output.stdout), now_ms())
}

/// List one directory without parsing human-oriented `ls` output.
///
/// The path is one shell-escaped positional argument, so a browser cannot
/// append a command to it, and `find`'s NUL-delimited fields keep a name with a
/// newline in it from becoming two entries.
pub async fn read_remote_directory(
    host: &str,
    path: &str,
    include_hidden: bool,
) -> Result<Value, String> {
    assert_safe_ssh_host(host)?;
    assert_read_only_path(path, false)?;
    let command = remote_sh_command(READ_DIRECTORY_SCRIPT, path);
    let output = run_ssh(
        host,
        &command,
        Duration::from_millis(FILE_READ_TIMEOUT_MS),
        4 * 1024 * 1024,
    )
    .await?;
    let listing = parse_read_only_directory(&output.stdout, include_hidden)?;
    Ok(with_host(host, listing))
}

pub async fn read_remote_file(host: &str, path: &str) -> Result<Value, String> {
    assert_safe_ssh_host(host)?;
    assert_read_only_path(path, true)?;
    let command = remote_sh_command(READ_FILE_SCRIPT, path);
    let output = run_ssh(
        host,
        &command,
        Duration::from_millis(FILE_READ_TIMEOUT_MS),
        FILE_PREVIEW_BYTES + 64 * 1024,
    )
    .await?;
    let file = parse_read_only_file(path, &output.stdout)?;
    Ok(with_host(host, file))
}

/// `{ host, ...rest }` — the host comes first, ahead of everything the shared
/// parser produced.
fn with_host(host: &str, rest: Value) -> Value {
    let mut merged = Map::new();
    merged.insert("host".into(), Value::String(host.to_string()));
    if let Value::Object(fields) = rest {
        for (key, value) in fields {
            merged.insert(key, value);
        }
    }
    Value::Object(merged)
}

/// The sample, out of a tab-and-line format chosen so the remote needs no
/// interpreter.
///
/// Lines are read into a table keyed by their `NMI_` marker until
/// `NMI_PROCESSES`, after which everything that matches the process shape is a
/// process and everything that does not is skipped — `ps` output can carry a
/// header or a wrapped line and neither is worth failing over.
pub fn parse_remote_metrics(host: &str, output: &str, sampled_at: f64) -> Result<Value, String> {
    let mut values: Vec<(String, Vec<String>)> = Vec::new();
    let mut processes: Vec<Value> = Vec::new();
    let mut reading_processes = false;

    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let process_line = PATTERN.get_or_init(|| {
        Regex::new(r"^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.*)$").expect("valid pattern")
    });

    for line in output.split('\n').map(|line| line.trim_end_matches('\r')) {
        if line == "NMI_PROCESSES" {
            reading_processes = true;
            continue;
        }
        if reading_processes {
            let Some(captures) = process_line.captures(line) else {
                continue;
            };
            let field = |index: usize| captures.get(index).map_or("", |m| m.as_str());
            processes.push(json!({
                "pid": js_number::value(js_number::parse(field(1))),
                "ppid": js_number::value(js_number::parse(field(2))),
                "user": field(3),
                "cpuPercent": js_number::value(js_number::parse(field(4))),
                "rssMb": js_number::value(js_number::parse(field(5)) / 1024.0),
                "command": field(6),
            }));
            continue;
        }
        let mut fields = line.split('\t');
        let key = fields.next().unwrap_or_default();
        if key.starts_with("NMI_") {
            values.push((
                key.to_string(),
                fields.map(str::to_string).collect::<Vec<_>>(),
            ));
        }
    }

    // `Map.get` after `Map.set` twice returns the *last* write.
    let lookup = |key: &str| {
        values
            .iter()
            .rev()
            .find(|(name, _)| name == key)
            .map(|(_, rest)| rest.as_slice())
    };
    let required = |key: &'static str, length: usize| -> Result<&[String], String> {
        lookup(key)
            .filter(|rest| rest.len() >= length)
            .ok_or_else(|| format!("Remote metrics response is missing {key}."))
    };
    let number_at = |key: &'static str, index: usize| -> Result<f64, String> {
        let value = js_number::parse(&required(key, index + 1)?[index]);
        if !value.is_finite() {
            return Err(format!("Remote metrics response has invalid {key}."));
        }
        Ok(value)
    };

    let meta = required("NMI_META", 2)?.to_vec();
    let cpu = number_at("NMI_CPU", 0)?;
    let memory: Vec<f64> = required("NMI_MEMORY", 2)?
        .iter()
        .map(|value| js_number::parse(value))
        .collect();
    let load: Vec<f64> = required("NMI_LOAD", 3)?
        .iter()
        .map(|value| js_number::parse(value))
        .collect();
    let uptime_seconds = number_at("NMI_UPTIME", 0)?;
    let logical_cpu_count = number_at("NMI_CPUS", 0)?;

    let memory_total_bytes = memory[0] * 1024.0;
    let memory_available_bytes = memory[1] * 1024.0;
    let memory_used_bytes = (memory_total_bytes - memory_available_bytes).max(0.0);

    let disk_values: Option<Vec<f64>> =
        lookup("NMI_DISK").map(|rest| rest.iter().map(|value| js_number::parse(value)).collect());
    let disk = match disk_values {
        Some(values) if values.len() >= 3 => json!({
            "path": "/",
            "totalBytes": js_number::value(values[0] * 1024.0),
            "usedBytes": js_number::value(values[1] * 1024.0),
            "availableBytes": js_number::value(values[2] * 1024.0),
            "usedPercent": js_number::value(percent(values[1], values[0])),
        }),
        _ => Value::Null,
    };

    Ok(json!({
        "host": host,
        // The remote's own name, falling back to how it was addressed.
        "hostname": meta.first().filter(|value| !value.is_empty()).map_or(host, |value| value.as_str()),
        "platform": meta.get(1).filter(|value| !value.is_empty()).map_or("Linux", |value| value.as_str()),
        "current": {
            "t": js_number::value(sampled_at),
            "cpuPercent": js_number::value(cpu),
            "memoryUsedBytes": js_number::value(memory_used_bytes),
            "memoryTotalBytes": js_number::value(memory_total_bytes),
            "memoryUsedPercent": js_number::value(percent(memory_used_bytes, memory_total_bytes)),
            "loadAverage": load.iter().map(|value| js_number::value(*value)).collect::<Vec<_>>(),
            "uptimeSeconds": js_number::value(uptime_seconds),
            "logicalCpuCount": js_number::value(logical_cpu_count),
            "disk": disk,
        },
        "processes": processes,
    }))
}

/// Clamped to 0–100 and rounded to one decimal, so a reading taken across a
/// boundary cannot report 101%.
fn percent(value: f64, total: f64) -> f64 {
    if total <= 0.0 {
        return 0.0;
    }
    let ratio = (value / total * 100.0).clamp(0.0, 100.0);
    (ratio * 10.0).round() / 10.0
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as f64)
        .unwrap_or_default()
}

/// The remote sampler. Linux-first, read-only, and quoted back verbatim in a
/// failed command's error message — so it is reproduced byte for byte.
const REMOTE_METRICS_COMMAND: &str = r#"LC_ALL=C sh -c '
read_cpu() { awk '\''/^cpu / { idle=$5+$6; total=0; for(i=2;i<=NF;i++) total+=$i; print idle, total; exit }'\'' /proc/stat; }
set -- $(read_cpu); idle1=$1; total1=$2
sleep 0.2
set -- $(read_cpu); idle2=$1; total2=$2
cpu=$(awk -v i1="$idle1" -v t1="$total1" -v i2="$idle2" -v t2="$total2" '\''BEGIN { d=t2-t1; if (d<=0) print "0.0"; else printf "%.1f", (1-(i2-i1)/d)*100 }'\'')
mem_total=$(awk '\''/^MemTotal:/ {print $2}'\'' /proc/meminfo)
mem_available=$(awk '\''/^MemAvailable:/ {print $2}'\'' /proc/meminfo)
set -- $(cat /proc/loadavg); load1=$1; load5=$2; load15=$3
set -- $(cat /proc/uptime); uptime=$1
set -- $(df -Pk / | tail -n 1); disk_total=$2; disk_used=$3; disk_available=$4
printf "NMI_META\t%s\t%s\n" "$(hostname)" "$(uname -s)"
printf "NMI_CPU\t%s\n" "$cpu"
printf "NMI_MEMORY\t%s\t%s\n" "$mem_total" "$mem_available"
printf "NMI_LOAD\t%s\t%s\t%s\n" "$load1" "$load5" "$load15"
printf "NMI_UPTIME\t%s\n" "$uptime"
printf "NMI_CPUS\t%s\n" "$(getconf _NPROCESSORS_ONLN 2>/dev/null || grep -c ^processor /proc/cpuinfo)"
printf "NMI_DISK\t%s\t%s\t%s\n" "$disk_total" "$disk_used" "$disk_available"
printf "NMI_PROCESSES\n"
ps -eo pid=,ppid=,user=,pcpu=,rss=,args= --sort=-pcpu | head -n 101
'"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pattern_is_not_a_host() {
        let hosts = parse_ssh_config_hosts(
            "Host alpha\n  HostName 10.0.0.1\nhost beta\nHOST gamma delta\n\
             Host *.example.com\nHost web-?\nHost !secret\nHost -oProxyCommand=danger\nHost alpha\n",
        );
        assert_eq!(hosts, ["alpha", "beta", "delta", "gamma"]);
    }

    #[test]
    fn hosts_sort_the_way_the_platform_collates() {
        let hosts = parse_ssh_config_hosts("Host zeta Zulu eclair \u{e9}clair\n");
        assert_eq!(hosts, ["eclair", "\u{e9}clair", "zeta", "Zulu"]);
    }

    #[test]
    fn a_saved_row_keeps_its_own_name_over_a_provider_s() {
        let saved = vec![SshServerDef {
            host: "alpha".to_string(),
            name: Some("Mine".to_string()),
            environment: None,
        }];
        let targets = vec![HostSshTarget {
            host: "alpha".to_string(),
            name: Some("Theirs".to_string()),
            environment: Some("prod".to_string()),
            instance: json!({ "id": "i-1" }),
        }];
        let merged = merge_ssh_servers(&saved, &["alpha".to_string()], &targets);
        assert_eq!(merged.len(), 1, "one host is one row, not three");
        assert_eq!(merged[0]["name"], "Mine");
        // Nothing saved for it, so the provider's value is the one left.
        assert_eq!(merged[0]["environment"], "prod");
        assert_eq!(merged[0]["discovered"], true);
        assert_eq!(merged[0]["saved"], true);
    }

    #[test]
    fn a_row_omits_what_it_does_not_have() {
        let merged = merge_ssh_servers(&[], &["beta".to_string()], &[]);
        let row = merged[0].as_object().unwrap();
        assert_eq!(
            row.keys().collect::<Vec<_>>(),
            ["host", "discovered", "saved"],
            "an absent name is omitted, not null"
        );
    }

    #[test]
    fn an_option_shaped_host_is_refused_everywhere() {
        assert!(assert_safe_ssh_host("-oProxyCommand=danger").is_err());
        assert!(assert_safe_ssh_host("alpha; rm -rf /").is_err());
        assert!(assert_safe_ssh_host("deploy@10.0.0.1").is_ok());
        assert!(assert_safe_ssh_host("srv-1.example.com:22").is_ok());
    }

    #[test]
    fn a_quote_in_a_path_is_escaped_this_module_s_way() {
        // `'"'"'`, not `'\''` — see the module note.
        assert_eq!(shell_escape("it's"), "'it'\"'\"'s'");
        assert!(remote_sh_command("script", "/srv").ends_with(" nomoreide '/srv'"));
    }

    #[test]
    fn the_last_line_of_stderr_is_the_concise_error() {
        let failure = "Command failed: ssh alpha true\n\
                       ssh: connect to host dead port 22: Connection refused\nlost connection\n";
        assert_eq!(concise_ssh_error(failure), "lost connection");
    }

    #[test]
    fn a_missing_section_names_itself() {
        let failure = parse_remote_metrics("alpha", "NMI_CPU\t1.0\n", 0.0).unwrap_err();
        assert_eq!(failure, "Remote metrics response is missing NMI_META.");
        // Present but short is the same refusal: a section is its fields.
        let short =
            parse_remote_metrics("alpha", "NMI_META\tbox\nNMI_CPU\t1.0\n", 0.0).unwrap_err();
        assert_eq!(short, "Remote metrics response is missing NMI_META.");
    }

    #[test]
    fn a_value_that_is_not_a_number_names_itself() {
        let sample = "NMI_META\tbox\tLinux\nNMI_CPU\tnope\nNMI_MEMORY\t8\t3\nNMI_LOAD\t1\t2\t3\n";
        let failure = parse_remote_metrics("alpha", sample, 0.0).unwrap_err();
        assert_eq!(failure, "Remote metrics response has invalid NMI_CPU.");
    }

    #[test]
    fn no_disk_section_is_a_null_disk_rather_than_a_zeroed_one() {
        let sample = "NMI_META\tbox\tLinux\nNMI_CPU\t12.5\nNMI_MEMORY\t8000000\t3000000\n\
                      NMI_LOAD\t0.5\t0.7\t1.2\nNMI_UPTIME\t1\nNMI_CPUS\t4\nNMI_PROCESSES\n";
        let metrics = parse_remote_metrics("alpha", sample, 0.0).unwrap();
        assert_eq!(metrics["current"]["disk"], Value::Null);
        assert_eq!(metrics["current"]["memoryUsedBytes"], 5_120_000_000i64);
        assert_eq!(metrics["current"]["memoryUsedPercent"], 62.5);
    }

    #[test]
    fn a_line_that_is_not_a_process_is_skipped_rather_than_fatal() {
        let sample = "NMI_META\tbox\tLinux\nNMI_CPU\t1\nNMI_MEMORY\t8\t3\nNMI_LOAD\t1\t2\t3\n\
                      NMI_UPTIME\t1\nNMI_CPUS\t1\nNMI_PROCESSES\n\
                      \x20   1     0 root      0.5   12345 /sbin/init\n\
                      a header line that matches nothing\n";
        let metrics = parse_remote_metrics("alpha", sample, 0.0).unwrap();
        let processes = metrics["processes"].as_array().unwrap();
        assert_eq!(processes.len(), 1);
        assert_eq!(processes[0]["pid"], 1);
        assert_eq!(processes[0]["rssMb"], 12.0556640625);
        assert_eq!(processes[0]["command"], "/sbin/init");
    }

    #[test]
    fn a_whole_percentage_has_no_fractional_part() {
        let sample = "NMI_META\tbox\tLinux\nNMI_CPU\t1\nNMI_MEMORY\t8\t3\nNMI_LOAD\t1\t2\t3\n\
                      NMI_UPTIME\t1\nNMI_CPUS\t1\nNMI_DISK\t100000000\t40000000\t55000000\n";
        let metrics = parse_remote_metrics("alpha", sample, 0.0).unwrap();
        assert_eq!(metrics["current"]["disk"]["usedPercent"].to_string(), "40");
        assert_eq!(
            metrics["current"]["disk"]["totalBytes"].to_string(),
            "102400000000"
        );
    }
}
