//! Registering a service writes config and nothing else. It has to work with
//! no daemon anywhere: a service is registered before it has ever run, and
//! making the registration depend on a runtime would invert that order.

use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};

#[test]
fn mcp_registration_writes_config_without_a_daemon() {
    let home = temp_home();
    let config = home.join(".config").join("nomoreide").join("config.json");

    let registered = call_tools(
        &home,
        &[
            (
                "nomoreide_register_service",
                json!({
                    "name": "api",
                    "command": "npm run dev",
                    "cwd": "/srv/api",
                    "port": 3000,
                    "env": { "TOKEN": "secret" },
                    // A local service carries no compose field, so this one is
                    // dropped rather than stored where nothing would read it.
                    "composeService": "ignored"
                }),
            ),
            (
                "nomoreide_register_service",
                json!({
                    "name": "db",
                    "kind": "docker-compose",
                    "cwd": "/srv/db",
                    "composeService": "postgres"
                }),
            ),
            (
                "nomoreide_register_bundle",
                json!({ "name": "dev", "services": ["api", "db"] }),
            ),
        ],
    );

    let public = document(&registered[0]);
    assert_eq!(service(&public, "api")["port"], 3000);
    // The dashboard never receives process environment values.
    assert!(service(&public, "api").get("env").is_none(), "{public}");
    assert!(
        service(&public, "api").get("composeService").is_none(),
        "{public}"
    );
    assert_eq!(
        document(&registered[2])["bundles"][0]["services"],
        json!(["api", "db"])
    );

    let stored = read_config(&config);
    assert_eq!(service(&stored, "api")["env"]["TOKEN"], "secret");
    assert!(service(&stored, "api").get("composeService").is_none());
    assert_eq!(service(&stored, "db")["kind"], "docker-compose");
    assert!(service(&stored, "db").get("command").is_none());

    // A second process reads back what the first wrote, because the only state
    // either of them has is the file.
    let revised = call_tools(
        &home,
        &[
            (
                "nomoreide_register_service",
                json!({ "name": "api", "command": "npm start", "cwd": "/srv/api" }),
            ),
            (
                "nomoreide_register_bundle",
                json!({ "name": "dev", "services": ["db"] }),
            ),
            // Neither the fields together nor any one of them describes a
            // service, so the refusal has to say which readings were tried.
            ("nomoreide_register_service", json!({ "name": "nothing" })),
        ],
    );

    let replaced = document(&revised[0]);
    assert_eq!(replaced["services"].as_array().unwrap().len(), 2);
    assert_eq!(service(&replaced, "api")["command"], "npm start");
    // Replacement is not a patch: the fields the new definition omits are gone.
    assert!(
        service(&replaced, "api").get("port").is_none(),
        "{replaced}"
    );
    assert!(
        service(&read_config(&config), "api").get("env").is_none(),
        "the replaced definition kept the environment of the one before it"
    );
    assert_eq!(
        document(&revised[1])["bundles"][0]["services"],
        json!(["db"])
    );

    assert_eq!(revised[2]["result"]["isError"], true);
    let refusal = revised[2]["result"]["content"][0]["text"].as_str().unwrap();
    let issues: Value = serde_json::from_str(
        refusal
            .strip_prefix("Tool 'nomoreide_register_service' execution failed: ")
            .unwrap_or_else(|| panic!("unexpected refusal: {refusal}")),
    )
    .unwrap();
    assert_eq!(issues[0]["code"], "invalid_union");
    let readings = issues[0]["unionErrors"].as_array().unwrap();
    assert_eq!(readings.len(), 3);
    // The local reading wanted a command and a cwd; the other two wanted a
    // `kind` naming them before anything else.
    assert_eq!(readings[0]["issues"][0]["path"], json!(["command"]));
    assert_eq!(readings[1]["issues"][0]["expected"], "docker-compose");
    assert_eq!(readings[2]["issues"][0]["expected"], "ssh");

    let _ = std::fs::remove_dir_all(home);
}

fn read_config(path: &std::path::Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

/// Registration appends rather than patches, so a service's position moves when
/// it is replaced; every assertion here addresses one by name.
fn service<'a>(config: &'a Value, name: &str) -> &'a Value {
    config["services"]
        .as_array()
        .unwrap()
        .iter()
        .find(|service| service["name"] == name)
        .unwrap_or_else(|| panic!("{name} is not in {config}"))
}

/// The public config document a registration answered with.
fn document(response: &Value) -> Value {
    let text = response["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_else(|| panic!("expected tool text content: {response}"));
    serde_json::from_str(text)
        .unwrap_or_else(|error| panic!("expected a config document, got {text:?}: {error}"))
}

/// Drive the MCP binary against a config home of its own, with `HOME` pointed
/// there too so no daemon this machine happens to be running is reachable.
fn call_tools(home: &std::path::Path, calls: &[(&str, Value)]) -> Vec<Value> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_nomoreide"))
        .arg("mcp")
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("NOMOREIDE_AUTO_UI", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
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
    assert_eq!(responses.len(), calls.len() + 1);
    responses[1..].to_vec()
}

/// A home no other test can be handed: a process-wide counter for the name, and
/// an exclusive create to prove it rather than assume it.
fn temp_home() -> PathBuf {
    static NEXT_HOME: AtomicU32 = AtomicU32::new(0);
    let root = std::env::temp_dir();
    loop {
        let home = root.join(format!(
            "nomoreide-mcp-registration-{}-{}",
            std::process::id(),
            NEXT_HOME.fetch_add(1, Ordering::Relaxed)
        ));
        match std::fs::create_dir(&home) {
            Ok(()) => {
                std::fs::create_dir_all(home.join(".config").join("nomoreide")).unwrap();
                return home;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => panic!("could not create a test home: {error}"),
        }
    }
}
