//! The MCP surface must reach the daemon that owns the services, not a runtime
//! of its own: a tool call has to start a real process another session can see,
//! and stop it again, without ever putting anything but protocol frames on
//! stdout.

use serde_json::{json, Value};
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const FIXTURE_VARIABLE: &str = "NOMOREIDE_MCP_RUNTIME_FIXTURE_CHILD";

/// Announced so a log read finds a line the service wrote itself.
const FIXTURE_MARKER: &str = "nomoreide mcp fixture child started";

/// The service the daemon is asked to run. Inert unless the parent selects it.
#[test]
fn mcp_runtime_fixture_child() {
    if std::env::var_os(FIXTURE_VARIABLE).is_none() {
        return;
    }
    println!("{FIXTURE_MARKER}");
    loop {
        std::thread::sleep(Duration::from_secs(60));
    }
}

/// Reading logs has to reach the daemon that owns the process, so a session
/// that did not start a service can still see what it printed.
#[test]
fn mcp_tools_read_logs_from_the_shared_daemon() {
    let home = temp_home();
    write_config(&home);
    let (mut daemon, port) = DaemonProcess::spawn(&home);

    call_tools(
        &home,
        port,
        &[("nomoreide_start_service", json!({ "name": "sleeper" }))],
    );

    // The child writes once it is scheduled and the daemon buffers that
    // asynchronously, so the first read can legitimately come back empty.
    let deadline = Instant::now() + Duration::from_secs(20);
    let entry = loop {
        let read = call_tools(
            &home,
            port,
            &[("nomoreide_read_logs", json!({ "name": "sleeper" }))],
        );
        let entries = match status_of(&read[0]) {
            Value::Array(entries) => entries,
            other => panic!("expected an array of log entries, got {other}"),
        };
        if let Some(entry) = entries.into_iter().find(|entry| {
            entry["text"]
                .as_str()
                .is_some_and(|text| text.contains(FIXTURE_MARKER))
        }) {
            break entry;
        }
        assert!(
            Instant::now() < deadline,
            "the fixture child never announced itself"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(entry["service"], "sleeper");
    assert_eq!(entry["stream"], "stdout");
    // The reference reports exactly these four fields.
    let fields = entry.as_object().unwrap().keys().collect::<Vec<_>>();
    assert_eq!(fields, vec!["service", "stream", "text", "timestamp"]);

    // A service this daemon has never run reads back as no lines, not an error.
    let unknown = call_tools(
        &home,
        port,
        &[("nomoreide_read_logs", json!({ "name": "never-started" }))],
    );
    assert_eq!(status_of(&unknown[0]), json!([]));

    daemon.shutdown();
    let _ = std::fs::remove_dir_all(home);
}

#[test]
fn mcp_tools_start_and_stop_a_service_in_the_shared_daemon() {
    let home = temp_home();
    write_config(&home);
    let (mut daemon, port) = DaemonProcess::spawn(&home);

    let started = call_tools(
        &home,
        port,
        &[
            ("nomoreide_start_service", json!({ "name": "sleeper" })),
            ("nomoreide_start_service", json!({ "name": "missing" })),
        ],
    );

    let status = status_of(&started[0]);
    assert_eq!(status["state"], "running");
    assert_eq!(status["name"], "sleeper");
    assert!(status.get("pgid").is_none(), "{status}");
    let pid = status["pid"].as_u64().unwrap() as u32;
    assert!(process_exists(pid));

    // An unregistered name reports the daemon's own explanation as a tool
    // error rather than a protocol failure.
    assert_eq!(started[1]["result"]["isError"], true);
    assert_eq!(
        started[1]["result"]["content"][0]["text"],
        "Tool 'nomoreide_start_service' execution failed: Service is not registered."
    );

    // A second session reaches the same daemon, so it sees the service it did
    // not start and is still the one to stop it.
    let stopped = call_tools(
        &home,
        port,
        &[
            ("nomoreide_status", json!({})),
            ("nomoreide_stop_service", json!({ "name": "sleeper" })),
        ],
    );
    let reported = status_of(&stopped[0]);
    assert_eq!(
        reported["services"]["sleeper"]["state"], "running",
        "status should report the running service: {reported}"
    );
    assert_eq!(reported["services"]["sleeper"]["pid"], pid);
    assert!(reported["services"]["sleeper"].get("pgid").is_none());
    assert_eq!(status_of(&stopped[1])["state"], "stopped");
    assert!(!process_exists(pid));

    daemon.shutdown();
    let _ = std::fs::remove_dir_all(home);
}

/// A restart has to replace the process rather than report the old one back,
/// and it has to work on a service that is not running — the daemon resolves
/// the definition and launches it either way.
#[test]
fn mcp_tools_restart_a_service_in_the_shared_daemon() {
    let home = temp_home();
    write_config(&home);
    let (mut daemon, port) = DaemonProcess::spawn(&home);

    let started = call_tools(
        &home,
        port,
        &[("nomoreide_start_service", json!({ "name": "sleeper" }))],
    );
    let first_pid = status_of(&started[0])["pid"].as_u64().unwrap() as u32;
    assert!(process_exists(first_pid));

    // A second session restarts what it did not start.
    let restarted = call_tools(
        &home,
        port,
        &[
            ("nomoreide_restart_service", json!({ "name": "sleeper" })),
            ("nomoreide_restart_service", json!({ "name": "missing" })),
        ],
    );
    let status = status_of(&restarted[0]);
    assert_eq!(status["state"], "running");
    assert_eq!(status["name"], "sleeper");
    assert!(status.get("pgid").is_none(), "{status}");
    let second_pid = status["pid"].as_u64().unwrap() as u32;
    assert_ne!(
        second_pid, first_pid,
        "a restart must replace the running process"
    );
    assert!(!process_exists(first_pid));
    assert!(process_exists(second_pid));

    // An unregistered name cannot be restarted, because a restart has to start
    // from a definition.
    assert_eq!(restarted[1]["result"]["isError"], true);
    assert_eq!(
        restarted[1]["result"]["content"][0]["text"],
        "Tool 'nomoreide_restart_service' execution failed: Service is not registered."
    );

    // Restarting a stopped service starts it.
    let cycled = call_tools(
        &home,
        port,
        &[
            ("nomoreide_stop_service", json!({ "name": "sleeper" })),
            ("nomoreide_restart_service", json!({ "name": "sleeper" })),
        ],
    );
    assert_eq!(status_of(&cycled[0])["state"], "stopped");
    assert!(!process_exists(second_pid));
    let third = status_of(&cycled[1]);
    assert_eq!(third["state"], "running");
    let third_pid = third["pid"].as_u64().unwrap() as u32;
    assert!(process_exists(third_pid));

    daemon.shutdown();
    assert!(!process_exists(third_pid));
    let _ = std::fs::remove_dir_all(home);
}

/// The bundle tools have to reach the same daemon and hand back the reference's
/// array of statuses, ordered so dependencies come up first.
#[test]
fn mcp_tools_start_and_stop_a_bundle_in_the_shared_daemon() {
    let home = temp_home();
    write_config(&home);
    let (mut daemon, port) = DaemonProcess::spawn(&home);

    let started = call_tools(
        &home,
        port,
        &[
            ("nomoreide_start_bundle", json!({ "name": "pair" })),
            ("nomoreide_start_bundle", json!({ "name": "missing" })),
        ],
    );

    let statuses = statuses_of(&started[0]);
    assert_eq!(
        statuses
            .iter()
            .map(|status| status["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["sleeper", "follower"],
        "the dependency starts before the service that declares it"
    );
    assert!(statuses
        .iter()
        .all(|status| status["state"] == "running" && status.get("pgid").is_none()));
    let pids = statuses
        .iter()
        .map(|status| status["pid"].as_u64().unwrap() as u32)
        .collect::<Vec<_>>();
    assert!(pids.iter().copied().all(process_exists));

    assert_eq!(started[1]["result"]["isError"], true);
    assert_eq!(
        started[1]["result"]["content"][0]["text"],
        "Tool 'nomoreide_start_bundle' execution failed: Bundle is not registered."
    );

    // Stopping is scoped to the bundle's own members, so the dependency it
    // pulled in is left running.
    let stopped = call_tools(
        &home,
        port,
        &[("nomoreide_stop_bundle", json!({ "name": "pair" }))],
    );
    let stopped_statuses = statuses_of(&stopped[0]);
    assert_eq!(
        stopped_statuses
            .iter()
            .map(|status| status["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["follower"]
    );
    assert!(!process_exists(pids[1]));
    assert!(
        process_exists(pids[0]),
        "the dependency the bundle pulled in is left running"
    );

    daemon.shutdown();
    assert!(!process_exists(pids[0]));
    let _ = std::fs::remove_dir_all(home);
}

/// The timeline has to reach the same daemon and narrow to one service, so a
/// session can ask what happened to the thing it is debugging rather than what
/// happened to everything.
#[test]
fn mcp_tools_read_the_timeline_from_the_shared_daemon() {
    let home = temp_home();
    write_config(&home);
    let (mut daemon, port) = DaemonProcess::spawn(&home);

    call_tools(
        &home,
        port,
        &[
            ("nomoreide_start_service", json!({ "name": "sleeper" })),
            ("nomoreide_start_service", json!({ "name": "follower" })),
        ],
    );

    let deadline = Instant::now() + Duration::from_secs(20);
    let events = loop {
        let read = call_tools(&home, port, &[("nomoreide_timeline", json!({}))]);
        let events = match status_of(&read[0]) {
            Value::Array(events) => events,
            other => panic!("expected an array of events, got {other}"),
        };
        let started = |service: &str| {
            events
                .iter()
                .any(|event| event["title"] == format!("{service} started"))
        };
        if started("sleeper") && started("follower") {
            break events;
        }
        assert!(
            Instant::now() < deadline,
            "the timeline never recorded both starts: {events:?}"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    let lifecycle = events
        .iter()
        .find(|event| event["title"] == "sleeper started")
        .unwrap();
    assert_eq!(lifecycle["kind"], "service.lifecycle");
    assert_eq!(lifecycle["severity"], "info");
    assert_eq!(lifecycle["service"], "sleeper");

    // Filtering happens before the limit is applied, so naming a service
    // returns that service's own events rather than whatever survived a filter
    // over an already-truncated read.
    let filtered = call_tools(
        &home,
        port,
        &[("nomoreide_timeline", json!({ "service": "sleeper" }))],
    );
    let scoped = match status_of(&filtered[0]) {
        Value::Array(events) => events,
        other => panic!("expected an array of events, got {other}"),
    };
    assert!(!scoped.is_empty());
    assert!(scoped.iter().all(|event| event["service"] == "sleeper"));

    // A limit reports the newest events, not the oldest.
    let limited = call_tools(
        &home,
        port,
        &[("nomoreide_timeline", json!({ "limit": 1 }))],
    );
    let newest = match status_of(&limited[0]) {
        Value::Array(events) => events,
        other => panic!("expected an array of events, got {other}"),
    };
    assert_eq!(newest.len(), 1);

    // A service the daemon has never heard of simply has no events.
    let unknown = call_tools(
        &home,
        port,
        &[("nomoreide_timeline", json!({ "service": "never-started" }))],
    );
    assert_eq!(status_of(&unknown[0]), json!([]));

    daemon.shutdown();
    let _ = std::fs::remove_dir_all(home);
}

/// The debugging packet joins two sources that only the tool can join: the
/// definition the user registered, read from config, and the runtime reading,
/// read from the daemon that owns the process. Neither half alone answers
/// "what is wrong with this service".
#[test]
fn mcp_tools_report_service_context_and_health_from_config_and_the_daemon() {
    let home = temp_home();
    write_config(&home);
    let (mut daemon, port) = DaemonProcess::spawn(&home);

    call_tools(
        &home,
        port,
        &[("nomoreide_start_service", json!({ "name": "sleeper" }))],
    );
    await_announcement(&home, port);

    let answers = call_tools(
        &home,
        port,
        &[
            ("nomoreide_service_context", json!({ "name": "sleeper" })),
            ("nomoreide_service_context", json!({ "name": "missing" })),
            ("nomoreide_service_health", json!({ "service": "sleeper" })),
            ("nomoreide_service_health", json!({})),
            ("nomoreide_service_health", json!({ "service": "missing" })),
        ],
    );

    let packet = text_of(&answers[0]);
    assert!(
        packet.starts_with("Investigate NoMoreIDE service \"sleeper\".\n"),
        "{packet}"
    );
    assert!(packet.contains("- state: running"), "{packet}");
    assert!(
        packet.contains("- configured port: not configured"),
        "{packet}"
    );
    assert!(packet.contains("- runtime url: not detected"), "{packet}");
    assert!(
        packet.contains("- Service is running without detected warnings."),
        "{packet}"
    );
    // The service announced itself, so both the log tail and the timeline it
    // produced reach the packet.
    assert!(packet.contains(FIXTURE_MARKER), "{packet}");
    assert!(packet.contains("[info] sleeper started"), "{packet}");
    assert!(packet.ends_with('\n'), "{packet:?}");

    // A packet is only meaningful for a registered service; an unknown name is
    // a refusal, unlike a log read, which reads back empty.
    assert_eq!(answers[1]["result"]["isError"], true);
    assert_eq!(
        text_of(&answers[1]),
        "Tool 'nomoreide_service_context' execution failed: Service \"missing\" is not registered."
    );

    let health = status_of(&answers[2]);
    assert_eq!(health["service"], "sleeper");
    assert_eq!(health["status"], "healthy");
    assert_eq!(
        health["summary"],
        "Service is running without detected warnings."
    );
    // Reported because a client reads the fields it was promised, even though
    // this tool never fills them.
    assert_eq!(health["checks"], json!([]));
    assert_eq!(health["ports"], json!([]));
    assert!(health["agentContext"].as_str().unwrap().contains("sleeper"));
    // Nothing samples a process tree natively, so the field is absent rather
    // than reported empty.
    assert!(health.get("processTree").is_none(), "{health}");
    assert!(health.get("lastErrorLog").is_none(), "{health}");

    // Unnamed asks about every registered service, in config order, and a
    // service the daemon has never run is unknown rather than unhealthy.
    let all = statuses_of(&answers[3]);
    assert_eq!(all.len(), 2);
    assert_eq!(all[0]["service"], "sleeper");
    assert_eq!(all[1]["service"], "follower");
    assert_eq!(all[1]["status"], "unknown");
    assert_eq!(all[1]["summary"], "Service is not running.");

    assert_eq!(answers[4]["result"]["isError"], true);
    assert_eq!(
        text_of(&answers[4]),
        "Tool 'nomoreide_service_health' execution failed: Service \"missing\" is not registered."
    );

    daemon.shutdown();
    let _ = std::fs::remove_dir_all(home);
}

/// Wait until the fixture child's own line has reached the daemon's buffer.
/// The child writes once it is scheduled and the daemon buffers that
/// asynchronously, so the first read can legitimately come back empty.
fn await_announcement(home: &Path, port: u16) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let read = call_tools(
            home,
            port,
            &[("nomoreide_read_logs", json!({ "name": "sleeper" }))],
        );
        let announced = match status_of(&read[0]) {
            Value::Array(entries) => entries.iter().any(|entry| {
                entry["text"]
                    .as_str()
                    .is_some_and(|text| text.contains(FIXTURE_MARKER))
            }),
            other => panic!("expected an array of log entries, got {other}"),
        };
        if announced {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the fixture child never announced itself"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn call_tools(home: &Path, port: u16, calls: &[(&str, Value)]) -> Vec<Value> {
    let mut frames = vec![
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "integration-test", "version": "1" }
            }
        }),
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
    ];
    for (index, (name, arguments)) in calls.iter().enumerate() {
        frames.push(json!({
            "jsonrpc": "2.0",
            "id": index + 2,
            "method": "tools/call",
            "params": { "name": name, "arguments": arguments }
        }));
    }

    let mut child = command(env!("CARGO_BIN_EXE_nomoreide"), home, port)
        .arg("mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    {
        let stdin = child.stdin.as_mut().unwrap();
        for frame in &frames {
            writeln!(stdin, "{}", serde_json::to_string(frame).unwrap()).unwrap();
        }
    }
    drop(child.stdin.take());

    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stderr).unwrap(), "");
    let responses = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("stdout line must be JSON"))
        .collect::<Vec<_>>();
    // The initialize reply plus one reply per call; the notification is silent.
    assert_eq!(responses.len(), calls.len() + 1);
    responses[1..].to_vec()
}

/// The array of statuses a bundle tool reports back.
fn statuses_of(response: &Value) -> Vec<Value> {
    match status_of(response) {
        Value::Array(statuses) => statuses,
        other => panic!("expected an array of statuses, got {other}"),
    }
}

/// The raw text a tool answered with, for the tools that answer in prose.
fn text_of(response: &Value) -> &str {
    response["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_else(|| panic!("expected tool text content: {response}"))
}

/// The status an agent reads back, parsed out of the tool's text content.
fn status_of(response: &Value) -> Value {
    let text = response["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_else(|| panic!("expected tool text content: {response}"));
    serde_json::from_str(text)
        .unwrap_or_else(|error| panic!("expected a status document, got {text:?}: {error}"))
}

struct DaemonProcess(Child);

/// Reserving an ephemeral port and binding it in the daemon are two steps, and
/// the kernel is free to hand the same port to another test in between —
/// whichever daemon loses that race exits without ever publishing state.
/// Serializing reservation with startup closes the window: by the time the lock
/// is released the daemon holds the port, so the next reservation cannot pick
/// it.
static PORT_HANDOFF: Mutex<()> = Mutex::new(());

impl DaemonProcess {
    /// Start a daemon on a port reserved for it, returning both.
    fn spawn(home: &Path) -> (Self, u16) {
        // A panicking test must not wedge every other one behind a poisoned
        // lock; the guard only orders startup, it protects no shared state.
        let handoff = PORT_HANDOFF
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let port = reserved_port();
        let daemon = Self::spawn_on(home, port);
        drop(handoff);
        (daemon, port)
    }

    fn spawn_on(home: &Path, port: u16) -> Self {
        let daemon = command(env!("CARGO_BIN_EXE_nomoreide"), home, port)
            .arg("daemon")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        Self::await_published(daemon, home)
    }

    /// Wait until the state file names *this* daemon. A daemon that cannot take
    /// ownership of the home exits without publishing anything, so accepting
    /// state written by any other daemon would hand the test a client pointed
    /// at a process it does not own — the failure this waits out is silent
    /// cross-talk, not a missing file.
    fn await_published(mut daemon: Child, home: &Path) -> Self {
        let expected = daemon.id();
        let state = home.join(".nomoreide").join("daemon.json");
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(published) = std::fs::read(&state)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .and_then(|state| state["pid"].as_u64())
            {
                if published == u64::from(expected) {
                    return Self(daemon);
                }
                panic!(
                    "daemon {expected} never took ownership of {home:?}; it is held by {published}"
                );
            }
            if let Ok(Some(status)) = daemon.try_wait() {
                panic!("the daemon exited before publishing state: {status}");
            }
            assert!(
                Instant::now() < deadline,
                "the daemon never published state"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Ask for the same graceful shutdown an operator would, so the daemon
    /// stops its services instead of orphaning them.
    fn shutdown(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(self.0.id() as libc::pid_t, libc::SIGTERM);
        }
        #[cfg(not(unix))]
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl Drop for DaemonProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn command(program: &str, home: &Path, port: u16) -> Command {
    let mut command = Command::new(program);
    command
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("NOMOREIDE_DAEMON_PORT", port.to_string());
    command
}

fn write_config(home: &Path) {
    let directory = home.join(".config").join("nomoreide");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(
        directory.join("config.json"),
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "services": [
                fixture_service("sleeper", None),
                fixture_service("follower", Some(vec!["sleeper"]))
            ],
            // The bundle names only the dependent; `sleeper` comes along as its
            // dependency.
            "bundles": [{ "name": "pair", "services": ["follower"] }]
        }))
        .unwrap(),
    )
    .unwrap();
}

fn fixture_service(name: &str, depends_on: Option<Vec<&str>>) -> Value {
    let mut definition = json!({
        "name": name,
        "command": std::env::current_exe().unwrap(),
        "args": ["--exact", "mcp_runtime_fixture_child", "--nocapture"],
        "cwd": std::env::current_dir().unwrap(),
        "env": { FIXTURE_VARIABLE: "1" }
    });
    if let Some(dependencies) = depends_on {
        definition["dependsOn"] = json!(dependencies);
    }
    definition
}

/// A home no other test can be handed. Naming it after the clock is not enough:
/// these tests start together, `SystemTime` is only microsecond-resolute here,
/// and `create_dir_all` succeeds on a directory that already exists — so two
/// tests silently shared one home, and with it one daemon, one state file and
/// one credential. Each then stopped the other's services. A counter makes the
/// name unique within the process, and creating the directory *exclusively*
/// proves it rather than assuming it, so a name that is somehow still taken
/// fails the test instead of quietly aliasing another one.
fn temp_home() -> PathBuf {
    static NEXT_HOME: AtomicU32 = AtomicU32::new(0);
    let root = std::env::temp_dir();
    loop {
        let home = root.join(format!(
            "nomoreide-mcp-runtime-{}-{}",
            std::process::id(),
            NEXT_HOME.fetch_add(1, Ordering::Relaxed)
        ));
        match std::fs::create_dir(&home) {
            Ok(()) => return home,
            // Only a leftover from a run whose pid this one reuses.
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => panic!("could not create {home:?}: {error}"),
        }
    }
}

fn reserved_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[cfg(unix)]
fn process_exists(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(not(unix))]
fn process_exists(_pid: u32) -> bool {
    true
}
