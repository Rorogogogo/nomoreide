//! The MCP surface must reach the daemon that owns the services, not a runtime
//! of its own: a tool call has to start a real process another session can see,
//! and stop it again, without ever putting anything but protocol frames on
//! stdout.

use serde_json::{json, Value};
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const FIXTURE_VARIABLE: &str = "NOMOREIDE_MCP_RUNTIME_FIXTURE_CHILD";

/// The service the daemon is asked to run. Inert unless the parent selects it.
#[test]
fn mcp_runtime_fixture_child() {
    if std::env::var_os(FIXTURE_VARIABLE).is_none() {
        return;
    }
    loop {
        std::thread::sleep(Duration::from_secs(60));
    }
}

#[test]
fn mcp_tools_start_and_stop_a_service_in_the_shared_daemon() {
    let home = temp_home();
    write_config(&home);
    let port = reserved_port();
    let mut daemon = DaemonProcess::spawn(&home, port);

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

    // A second session reaches the same daemon, so the service it did not
    // start is still its to stop.
    let stopped = call_tools(
        &home,
        port,
        &[("nomoreide_stop_service", json!({ "name": "sleeper" }))],
    );
    assert_eq!(status_of(&stopped[0])["state"], "stopped");
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
    let port = reserved_port();
    let mut daemon = DaemonProcess::spawn(&home, port);

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

/// The status an agent reads back, parsed out of the tool's text content.
fn status_of(response: &Value) -> Value {
    let text = response["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_else(|| panic!("expected tool text content: {response}"));
    serde_json::from_str(text)
        .unwrap_or_else(|error| panic!("expected a status document, got {text:?}: {error}"))
}

struct DaemonProcess(Child);

impl DaemonProcess {
    fn spawn(home: &Path, port: u16) -> Self {
        let daemon = command(env!("CARGO_BIN_EXE_nomoreide"), home, port)
            .arg("daemon")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let state = home.join(".nomoreide").join("daemon.json");
        let deadline = Instant::now() + Duration::from_secs(20);
        while !state.exists() {
            assert!(
                Instant::now() < deadline,
                "the daemon never published state"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        Self(daemon)
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
            "services": [{
                "name": "sleeper",
                "command": std::env::current_exe().unwrap(),
                "args": ["--exact", "mcp_runtime_fixture_child", "--nocapture"],
                "cwd": std::env::current_dir().unwrap(),
                "env": { FIXTURE_VARIABLE: "1" }
            }],
            "bundles": []
        }))
        .unwrap(),
    )
    .unwrap();
}

fn temp_home() -> PathBuf {
    let home = std::env::temp_dir().join(format!(
        "nomoreide-mcp-runtime-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&home).unwrap();
    home
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
