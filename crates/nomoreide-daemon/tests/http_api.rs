use nomoreide_daemon::{serve_until, DaemonOptions};
use nomoreide_daemon_client::protocol::{
    DaemonErrorCode, ServiceRuntimeState, TimelineEventKind, TimelineSeverity,
};
use nomoreide_daemon_client::{
    is_pid_alive, read_daemon_state, DaemonClient, DaemonClientError, RuntimePaths,
};
use reqwest::StatusCode;
use serde_json::json;
use std::path::PathBuf;
use tokio::sync::oneshot;
use tokio::time::{sleep, Duration};
use uuid::Uuid;

fn temp_dir() -> PathBuf {
    std::env::temp_dir().join(format!("nomoreide-daemon-http-{}", Uuid::new_v4()))
}

#[tokio::test]
async fn serves_authenticated_redacted_service_discovery_on_loopback() {
    let root = temp_dir();
    let runtime_paths = RuntimePaths::new(root.join("runtime"));
    let config_path = root.join("config.json");
    tokio::fs::create_dir_all(&root).await.unwrap();
    tokio::fs::write(
        &config_path,
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "services": [
                {
                    "name": "api",
                    "port": 3000,
                    "description": "API",
                    "test": "npm test",
                    "dependsOn": ["database"],
                    "projectPath": "/workspace",
                    "command": "node",
                    "args": ["server.js"],
                    "cwd": "/workspace/api",
                    "env": { "Z_TOKEN": "secret-value", "A_MODE": "development" }
                },
                {
                    "name": "compose",
                    "kind": "docker-compose",
                    "cwd": "/workspace",
                    "composeFile": "compose.yml",
                    "composeService": "web"
                },
                {
                    "name": "remote",
                    "kind": "ssh",
                    "host": "dev-box",
                    "cwd": "/srv/app",
                    "command": "npm start",
                    "env": {}
                }
            ],
            "bundles": [{ "name": "app", "services": ["api", "compose"] }]
        }))
        .unwrap(),
    )
    .await
    .unwrap();

    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let task_paths = runtime_paths.clone();
    let mut server = tokio::spawn(async move {
        serve_until(
            DaemonOptions {
                port: 0,
                runtime_paths: task_paths,
                config_path,
            },
            async {
                let _ = shutdown_rx.await;
            },
        )
        .await
    });

    let state = wait_for_state(&runtime_paths, &mut server).await;
    assert!(state.url.starts_with("http://127.0.0.1:"));
    assert_ne!(state.port, 0);
    let http = reqwest::Client::new();

    let health = http
        .get(format!("{}/api/health", state.url))
        .send()
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);
    assert_eq!(
        health.json::<serde_json::Value>().await.unwrap(),
        json!({
            "ok": true,
            "app": "nomoreide",
            "version": env!("CARGO_PKG_VERSION"),
            "pid": std::process::id(),
            "ownerId": state.owner_id.clone()
        })
    );

    let missing = http
        .get(format!("{}/api/services", state.url))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);
    let wrong = http
        .get(format!("{}/api/services", state.url))
        .bearer_auth("wrong")
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(missing.bytes().await.unwrap(), wrong.bytes().await.unwrap());

    // Authentication guards routes, not the router: an unknown path is still a
    // 404 and a known path with the wrong method is still a 405, both without a
    // credential. Pinning them here keeps the guard from quietly widening into
    // an authentication wall that hides which endpoints exist.
    let unknown = http
        .get(format!("{}/api/nope", state.url))
        .send()
        .await
        .unwrap();
    assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
    let wrong_method = http
        .post(format!("{}/api/services", state.url))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong_method.status(), StatusCode::METHOD_NOT_ALLOWED);

    let client = DaemonClient::connect(state.endpoint().unwrap(), &runtime_paths)
        .await
        .unwrap();
    let discovery = client.list_services().await.unwrap();
    let pretty = serde_json::to_string_pretty(&discovery).unwrap();
    assert_eq!(
        pretty,
        concat!(
            "{\n",
            "  \"services\": [\n",
            "    {\n",
            "      \"name\": \"api\",\n",
            "      \"port\": 3000,\n",
            "      \"description\": \"API\",\n",
            "      \"test\": \"npm test\",\n",
            "      \"dependsOn\": [\n",
            "        \"database\"\n",
            "      ],\n",
            "      \"projectPath\": \"/workspace\",\n",
            "      \"command\": \"node\",\n",
            "      \"args\": [\n",
            "        \"server.js\"\n",
            "      ],\n",
            "      \"cwd\": \"/workspace/api\",\n",
            "      \"envKeys\": [\n",
            "        \"A_MODE\",\n",
            "        \"Z_TOKEN\"\n",
            "      ]\n",
            "    },\n",
            "    {\n",
            "      \"name\": \"compose\",\n",
            "      \"kind\": \"docker-compose\",\n",
            "      \"cwd\": \"/workspace\",\n",
            "      \"composeFile\": \"compose.yml\",\n",
            "      \"composeService\": \"web\"\n",
            "    },\n",
            "    {\n",
            "      \"name\": \"remote\",\n",
            "      \"kind\": \"ssh\",\n",
            "      \"host\": \"dev-box\",\n",
            "      \"cwd\": \"/srv/app\",\n",
            "      \"command\": \"npm start\",\n",
            "      \"envKeys\": []\n",
            "    }\n",
            "  ],\n",
            "  \"bundles\": [\n",
            "    {\n",
            "      \"name\": \"app\",\n",
            "      \"services\": [\n",
            "        \"api\",\n",
            "        \"compose\"\n",
            "      ]\n",
            "    }\n",
            "  ]\n",
            "}"
        )
    );
    assert!(!pretty.contains("secret-value"));
    assert!(!pretty.contains("development"));

    shutdown_tx.send(()).unwrap();
    server.await.unwrap().unwrap();
    assert!(!runtime_paths.state.exists());
    assert!(!runtime_paths.credential.exists());
    let _ = tokio::fs::remove_dir_all(root).await;
}

/// Announced so a log read has something of the child's own to find, rather
/// than only whatever the test harness prints around it. Deliberately ordinary
/// text: it must reach the logs without reaching the timeline.
const FIXTURE_MARKER: &str = "nomoreide daemon fixture child is here";

/// Reads like a service announcing it is up, so it is timeline material.
const FIXTURE_READY_LINE: &str = "fixture child listening for nothing";

#[test]
fn daemon_fixture_child() {
    if std::env::var_os("NOMOREIDE_DAEMON_FIXTURE_CHILD").is_none() {
        return;
    }
    println!("{FIXTURE_MARKER}");
    println!("{FIXTURE_READY_LINE}");
    loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
    }
}

#[tokio::test]
async fn authenticated_client_starts_and_stops_only_registered_local_services() {
    let root = temp_dir();
    let runtime_paths = RuntimePaths::new(root.join("runtime"));
    let config_path = root.join("config.json");
    let executable = std::env::current_exe().unwrap();
    let cwd = std::env::current_dir().unwrap();
    let held_port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let held_listener = std::net::TcpListener::bind(("127.0.0.1", held_port)).unwrap();
    tokio::fs::create_dir_all(&root).await.unwrap();
    tokio::fs::write(
        &config_path,
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "services": [
                {
                    "name": "sleeper",
                    "command": executable,
                    "args": ["--exact", "daemon_fixture_child", "--nocapture"],
                    "cwd": cwd,
                    "env": { "NOMOREIDE_DAEMON_FIXTURE_CHILD": "1" }
                },
                {
                    "name": "blocked",
                    "command": executable,
                    "args": ["--exact", "daemon_fixture_child", "--nocapture"],
                    "cwd": cwd,
                    "port": held_port,
                    "env": { "NOMOREIDE_DAEMON_FIXTURE_CHILD": "1" }
                },
                {
                    "name": "compose",
                    "kind": "docker-compose",
                    "cwd": cwd,
                    "composeService": "web"
                },
                {
                    "name": "remote",
                    "kind": "ssh",
                    "host": "nomoreide-test.invalid",
                    "cwd": "/srv/app",
                    "command": "true"
                }
            ],
            "bundles": []
        }))
        .unwrap(),
    )
    .await
    .unwrap();

    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let task_paths = runtime_paths.clone();
    let mut server = tokio::spawn(async move {
        serve_until(
            DaemonOptions {
                port: 0,
                runtime_paths: task_paths,
                config_path,
            },
            async {
                let _ = shutdown_rx.await;
            },
        )
        .await
    });
    let state = wait_for_state(&runtime_paths, &mut server).await;
    let http = reqwest::Client::new();
    let unauthorized = http
        .post(format!("{}/api/services/sleeper/start", state.url))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let client = DaemonClient::connect(state.endpoint().unwrap(), &runtime_paths)
        .await
        .unwrap();
    let missing = client.start_service("missing").await.unwrap_err();
    assert!(matches!(
        missing,
        DaemonClientError::Mutation(error)
            if error.code == DaemonErrorCode::ServiceNotFound
    ));
    let unsupported = client.start_service("compose").await.unwrap_err();
    assert!(matches!(
        unsupported,
        DaemonClientError::Mutation(error)
            if error.code == DaemonErrorCode::UnsupportedServiceKind
    ));
    // A remote service is a child this daemon spawns and supervises like any
    // other, so it is launched rather than refused. The host is unresolvable,
    // so the ssh client exits on its own straight afterwards — what is being
    // asserted here is the launch, and that the status says what it launched.
    let remote = client.start_service("remote").await.unwrap();
    assert_eq!(remote.kind.as_deref(), Some("ssh"));
    assert_eq!(remote.host.as_deref(), Some("nomoreide-test.invalid"));
    assert!(remote.pid.is_some());
    client.stop_service("remote").await.unwrap();

    let conflict = client.start_service("blocked").await.unwrap_err();
    assert!(matches!(
        conflict,
        DaemonClientError::Mutation(error)
            if error.code == DaemonErrorCode::PortInUse && error.conflict.is_some()
    ));
    assert!(held_listener.local_addr().is_ok());

    let unauthorized_status = http
        .get(format!("{}/api/status", state.url))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized_status.status(), StatusCode::UNAUTHORIZED);
    // Only the remote service has run so far, and a service that has stopped
    // stays in the report rather than vanishing from it.
    let before = client.status().await.unwrap();
    assert_eq!(
        before.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
        vec!["remote"]
    );

    let started = client.start_service("sleeper").await.unwrap();
    assert_eq!(started.state, ServiceRuntimeState::Running);
    let pid = started.pid.unwrap();
    assert!(is_pid_alive(pid));
    assert!(runtime_paths
        .state_dir
        .join("native/runtime-v1.json")
        .exists());

    // Status reports what the daemon is tracking, whoever started it.
    let tracked = client.status().await.unwrap();
    assert_eq!(
        tracked
            .iter()
            .map(|status| status.name.as_str())
            .collect::<Vec<_>>(),
        vec!["remote", "sleeper"]
    );
    let sleeper = tracked.iter().find(|s| s.name == "sleeper").unwrap();
    assert_eq!(sleeper.state, ServiceRuntimeState::Running);
    assert_eq!(sleeper.pid, Some(pid));
    // A local service is answerable to no host.
    assert_eq!(sleeper.kind.as_deref(), Some("local"));
    assert_eq!(sleeper.host, None);

    let stopped = client.stop_service("sleeper").await.unwrap();
    assert_eq!(stopped.state, ServiceRuntimeState::Stopped);
    assert!(!is_pid_alive(pid));
    // A stopped service stays in the report rather than vanishing from it.
    let after_stop = client.status().await.unwrap();
    assert_eq!(after_stop.len(), 2);
    assert!(after_stop
        .iter()
        .all(|status| status.state == ServiceRuntimeState::Stopped));

    let restarted = client.start_service("sleeper").await.unwrap();
    let restarted_pid = restarted.pid.unwrap();
    assert!(is_pid_alive(restarted_pid));

    // A restart replaces the process, and refuses the same names a start
    // refuses: it has to launch from a registered local definition.
    let unauthorized_restart = http
        .post(format!("{}/api/services/sleeper/restart", state.url))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized_restart.status(), StatusCode::UNAUTHORIZED);
    for (name, code) in [
        ("missing", DaemonErrorCode::ServiceNotFound),
        ("compose", DaemonErrorCode::UnsupportedServiceKind),
    ] {
        let refused = client.restart_service(name).await.unwrap_err();
        assert!(matches!(
            refused,
            DaemonClientError::Mutation(error) if error.code == code
        ));
    }
    let replaced = client.restart_service("sleeper").await.unwrap();
    assert_eq!(replaced.state, ServiceRuntimeState::Running);
    let replaced_pid = replaced.pid.unwrap();
    assert_ne!(replaced_pid, restarted_pid);
    assert!(!is_pid_alive(restarted_pid));
    assert!(is_pid_alive(replaced_pid));

    shutdown_tx.send(()).unwrap();
    server.await.unwrap().unwrap();
    assert!(!is_pid_alive(replaced_pid));
    assert!(!runtime_paths.state.exists());
    assert!(!runtime_paths.credential.exists());
    drop(held_listener);
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn managed_services_stay_stoppable_after_their_definition_drifts() {
    let root = temp_dir();
    let runtime_paths = RuntimePaths::new(root.join("runtime"));
    let config_path = root.join("config.json");
    let executable = std::env::current_exe().unwrap();
    let cwd = std::env::current_dir().unwrap();
    let service = |name: &str| {
        json!({
            "name": name,
            "command": executable,
            "args": ["--exact", "daemon_fixture_child", "--nocapture"],
            "cwd": cwd,
            "env": { "NOMOREIDE_DAEMON_FIXTURE_CHILD": "1" }
        })
    };
    tokio::fs::create_dir_all(&root).await.unwrap();
    let full_config = json!({
        "version": 1,
        "services": [service("removed"), service("unreadable")],
        "bundles": []
    });
    tokio::fs::write(
        &config_path,
        serde_json::to_vec_pretty(&full_config).unwrap(),
    )
    .await
    .unwrap();

    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let task_paths = runtime_paths.clone();
    let mut server = tokio::spawn(async move {
        serve_until(
            DaemonOptions {
                port: 0,
                runtime_paths: task_paths,
                config_path: config_path.clone(),
            },
            async {
                let _ = shutdown_rx.await;
            },
        )
        .await
    });
    let state = wait_for_state(&runtime_paths, &mut server).await;
    let client = DaemonClient::connect(state.endpoint().unwrap(), &runtime_paths)
        .await
        .unwrap();
    let removed_pid = client.start_service("removed").await.unwrap().pid.unwrap();
    let unreadable_pid = client
        .start_service("unreadable")
        .await
        .unwrap()
        .pid
        .unwrap();

    // Drift 1: the definition disappears from a config that still parses.
    let config_path = root.join("config.json");
    tokio::fs::write(
        &config_path,
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "services": [service("unreadable")],
            "bundles": []
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    let stopped = client.stop_service("removed").await.unwrap();
    assert_eq!(stopped.state, ServiceRuntimeState::Stopped);
    assert!(!is_pid_alive(removed_pid));
    // A name this daemon never started still has to be registered.
    let unknown = client.stop_service("never-started").await.unwrap_err();
    assert!(matches!(
        unknown,
        DaemonClientError::Mutation(error) if error.code == DaemonErrorCode::ServiceNotFound
    ));

    // Drift 2: the config cannot be read at all.
    tokio::fs::write(&config_path, b"{ not json").await.unwrap();
    let stopped = client.stop_service("unreadable").await.unwrap();
    assert_eq!(stopped.state, ServiceRuntimeState::Stopped);
    assert!(!is_pid_alive(unreadable_pid));
    let unreadable = client.stop_service("never-started").await.unwrap_err();
    assert!(matches!(
        unreadable,
        DaemonClientError::Mutation(error) if error.code == DaemonErrorCode::ConfigLoadFailed
    ));

    shutdown_tx.send(()).unwrap();
    server.await.unwrap().unwrap();
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[cfg(unix)]
#[tokio::test]
async fn corrupt_native_registry_fails_before_daemon_publication() {
    let root = temp_dir();
    let runtime_paths = RuntimePaths::new(root.join("runtime"));
    let registry_path = runtime_paths.state_dir.join("native/runtime-v1.json");
    tokio::fs::create_dir_all(registry_path.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&registry_path, b"not-json").await.unwrap();

    let error = serve_until(
        DaemonOptions {
            port: 0,
            runtime_paths: runtime_paths.clone(),
            config_path: root.join("config.json"),
        },
        std::future::pending(),
    )
    .await
    .unwrap_err();

    assert!(error
        .to_string()
        .contains("failed to reconcile the native runtime registry"));
    assert!(!runtime_paths.state.exists());
    assert!(!runtime_paths.credential.exists());
    let _ = tokio::fs::remove_dir_all(root).await;
}

/// This test owns the stop-scoping guarantee: the runtime is in-process here,
/// so a dependency left running can be asserted directly, without a daemon
/// process or an HTTP hop in between.
#[tokio::test]
async fn bundles_start_in_dependency_order_and_stop_only_their_own_members() {
    let root = temp_dir();
    let runtime_paths = RuntimePaths::new(root.join("runtime"));
    let config_path = root.join("config.json");
    let executable = std::env::current_exe().unwrap();
    let cwd = std::env::current_dir().unwrap();
    let service = |name: &str, depends_on: Option<Vec<&str>>| {
        let mut definition = json!({
            "name": name,
            "command": executable,
            "args": ["--exact", "daemon_fixture_child", "--nocapture"],
            "cwd": cwd,
            "env": { "NOMOREIDE_DAEMON_FIXTURE_CHILD": "1" }
        });
        if let Some(dependencies) = depends_on {
            definition["dependsOn"] = json!(dependencies);
        }
        definition
    };
    tokio::fs::create_dir_all(&root).await.unwrap();
    tokio::fs::write(
        &config_path,
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "services": [
                service("db", None),
                service("api", Some(vec!["db"])),
                {
                    "name": "compose",
                    "kind": "docker-compose",
                    "cwd": cwd,
                    "composeService": "web"
                }
            ],
            // The bundle names only `api`; `db` is pulled in as its dependency.
            "bundles": [
                { "name": "stack", "services": ["api"] },
                { "name": "mixed", "services": ["db", "compose"] }
            ]
        }))
        .unwrap(),
    )
    .await
    .unwrap();

    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let task_paths = runtime_paths.clone();
    let mut server = tokio::spawn(async move {
        serve_until(
            DaemonOptions {
                port: 0,
                runtime_paths: task_paths,
                config_path,
            },
            async {
                let _ = shutdown_rx.await;
            },
        )
        .await
    });
    let state = wait_for_state(&runtime_paths, &mut server).await;
    let http = reqwest::Client::new();
    let unauthorized = http
        .post(format!("{}/api/bundles/stack/start", state.url))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let client = DaemonClient::connect(state.endpoint().unwrap(), &runtime_paths)
        .await
        .unwrap();
    let missing = client.start_bundle("missing").await.unwrap_err();
    assert!(matches!(
        missing,
        DaemonClientError::Mutation(error)
            if error.code == DaemonErrorCode::BundleNotFound
    ));

    // A bundle holding a service this daemon cannot run is refused whole,
    // before any of its members start.
    let mixed = client.start_bundle("mixed").await.unwrap_err();
    assert!(matches!(
        mixed,
        DaemonClientError::Mutation(error)
            if error.code == DaemonErrorCode::UnsupportedServiceKind
    ));
    // Nothing launched: the journal only appears once a service is spawned, so
    // its absence proves `db` was never started on the way to the refusal.
    assert!(!runtime_paths
        .state_dir
        .join("native/runtime-v1.json")
        .exists());

    let started = client.start_bundle("stack").await.unwrap();
    let names = started
        .iter()
        .map(|status| status.name.as_str())
        .collect::<Vec<_>>();
    assert_eq!(names, vec!["db", "api"], "dependencies start first");
    assert!(started
        .iter()
        .all(|status| status.state == ServiceRuntimeState::Running));
    let db_pid = started[0].pid.unwrap();
    let api_pid = started[1].pid.unwrap();
    assert!(is_pid_alive(db_pid) && is_pid_alive(api_pid));

    // Stopping is scoped to the bundle's own members, so the dependency it
    // pulled in keeps running for whoever else may need it.
    let stopped = client.stop_bundle("stack").await.unwrap();
    assert_eq!(
        stopped
            .iter()
            .map(|status| status.name.as_str())
            .collect::<Vec<_>>(),
        vec!["api"]
    );
    assert!(!is_pid_alive(api_pid));
    assert!(is_pid_alive(db_pid));

    shutdown_tx.send(()).unwrap();
    server.await.unwrap().unwrap();
    assert!(!is_pid_alive(db_pid));
    let _ = tokio::fs::remove_dir_all(root).await;
}

/// Logs are a debugging capability, so they are read-only, unauthenticated only
/// to nobody, and deliberately more forgiving than a start: an unregistered name
/// is empty rather than an error, and a malformed `lines` falls back to the
/// default instead of failing the request.
#[tokio::test]
async fn buffered_service_logs_are_readable_and_lenient_about_their_line_budget() {
    let root = temp_dir();
    let runtime_paths = RuntimePaths::new(root.join("runtime"));
    let config_path = root.join("config.json");
    let executable = std::env::current_exe().unwrap();
    let cwd = std::env::current_dir().unwrap();
    tokio::fs::create_dir_all(&root).await.unwrap();
    tokio::fs::write(
        &config_path,
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "services": [{
                "name": "talker",
                "command": executable,
                "args": ["--exact", "daemon_fixture_child", "--nocapture"],
                "cwd": cwd,
                "env": { "NOMOREIDE_DAEMON_FIXTURE_CHILD": "1" }
            }],
            "bundles": []
        }))
        .unwrap(),
    )
    .await
    .unwrap();

    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let task_paths = runtime_paths.clone();
    let mut server = tokio::spawn(async move {
        serve_until(
            DaemonOptions {
                port: 0,
                runtime_paths: task_paths,
                config_path,
            },
            async {
                let _ = shutdown_rx.await;
            },
        )
        .await
    });
    let state = wait_for_state(&runtime_paths, &mut server).await;
    let http = reqwest::Client::new();
    let unauthorized = http
        .get(format!("{}/api/services/talker/logs", state.url))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let client = DaemonClient::connect(state.endpoint().unwrap(), &runtime_paths)
        .await
        .unwrap();
    // A name this daemon has never run has no lines, not an error.
    assert!(client.logs("never-started", 500).await.unwrap().is_empty());

    client.start_service("talker").await.unwrap();
    let entry = wait_for_marker(&client).await;
    assert_eq!(entry.service, "talker");
    assert_eq!(entry.stream, "stdout");
    // Rendered the way the reference writes it: an ISO instant in UTC with
    // millisecond precision.
    assert!(
        entry.timestamp.ends_with('Z') && entry.timestamp.len() == 24,
        "{}",
        entry.timestamp
    );

    // `lines` is a budget, not a filter: asking for one line yields the newest.
    let all = client.logs("talker", 500).await.unwrap();
    let newest = client.logs("talker", 1).await.unwrap();
    assert_eq!(newest.len(), 1);
    assert_eq!(newest[0], *all.last().unwrap());

    // Unparsable and non-positive budgets fall back to the default rather than
    // failing a read someone is debugging with.
    for lines in ["", "0", "-4", "many"] {
        let response = http
            .get(format!(
                "{}/api/services/talker/logs?lines={lines}",
                state.url
            ))
            .bearer_auth(credential(&runtime_paths).await)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "lines={lines}");
        let body = response.json::<serde_json::Value>().await.unwrap();
        assert_eq!(body["ok"], true, "lines={lines}");
        assert_eq!(
            body["logs"].as_array().unwrap().len(),
            all.len(),
            "lines={lines}"
        );
    }

    let _ = shutdown_tx.send(());
    let _ = server.await;
    let _ = tokio::fs::remove_dir_all(root).await;
}

/// The timeline is the account of what the runtime *did*, so a start and a stop
/// have to appear on it, and so does the line the child printed on its way up —
/// while ordinary output stays out.
#[tokio::test]
async fn the_timeline_records_lifecycle_moments_and_notable_log_lines() {
    let root = temp_dir();
    let runtime_paths = RuntimePaths::new(root.join("runtime"));
    let config_path = root.join("config.json");
    let executable = std::env::current_exe().unwrap();
    let cwd = std::env::current_dir().unwrap();
    tokio::fs::create_dir_all(&root).await.unwrap();
    tokio::fs::write(
        &config_path,
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "services": [{
                "name": "talker",
                "command": executable,
                "args": ["--exact", "daemon_fixture_child", "--nocapture"],
                "cwd": cwd,
                "env": { "NOMOREIDE_DAEMON_FIXTURE_CHILD": "1" }
            }],
            "bundles": []
        }))
        .unwrap(),
    )
    .await
    .unwrap();

    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let task_paths = runtime_paths.clone();
    let mut server = tokio::spawn(async move {
        serve_until(
            DaemonOptions {
                port: 0,
                runtime_paths: task_paths,
                config_path,
            },
            async {
                let _ = shutdown_rx.await;
            },
        )
        .await
    });
    let state = wait_for_state(&runtime_paths, &mut server).await;
    let http = reqwest::Client::new();
    let unauthorized = http
        .get(format!("{}/api/timeline", state.url))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let client = DaemonClient::connect(state.endpoint().unwrap(), &runtime_paths)
        .await
        .unwrap();
    assert!(client.timeline(200).await.unwrap().is_empty());

    let started = client.start_service("talker").await.unwrap();
    let start = wait_for_event(&client, |event| {
        event.kind == TimelineEventKind::ServiceLifecycle && event.title == "talker started"
    })
    .await;
    assert_eq!(start.service.as_deref(), Some("talker"));
    assert_eq!(start.severity, TimelineSeverity::Info);
    assert_eq!(start.data.as_ref().unwrap()["pid"], started.pid.unwrap());

    // The child's readiness line is worth an entry; its severity is info,
    // because announcing you are up is not a problem.
    let announced =
        wait_for_event(&client, |event| event.kind == TimelineEventKind::ServiceLog).await;
    assert_eq!(announced.severity, TimelineSeverity::Info);
    assert_eq!(announced.title, "talker stdout");
    assert_eq!(announced.detail.as_deref(), Some(FIXTURE_READY_LINE));
    // The child's other line said nothing about itself, so it is in the logs
    // and not on the timeline.
    assert!(client
        .logs("talker", 500)
        .await
        .unwrap()
        .iter()
        .any(|entry| entry.text == FIXTURE_MARKER));
    assert!(client
        .timeline(200)
        .await
        .unwrap()
        .iter()
        .all(|event| event.detail.as_deref() != Some(FIXTURE_MARKER)));

    client.stop_service("talker").await.unwrap();
    let stopped = wait_for_event(&client, |event| event.title == "talker stopped").await;
    assert_eq!(stopped.kind, TimelineEventKind::ServiceLifecycle);
    // A service that was asked to stop is not an error however it died.
    assert_eq!(stopped.severity, TimelineSeverity::Info);
    // Signals are reported by name, the way the reference reports them.
    assert_eq!(stopped.data.as_ref().unwrap()["signal"], json!("SIGTERM"));

    // Every event carries an id and a millisecond ISO timestamp.
    let events = client.timeline(200).await.unwrap();
    assert!(events
        .iter()
        .all(|event| !event.id.is_empty() && event.timestamp.len() == 24));
    // A limit is a budget on the newest events, and the daemon will not read
    // back more than the buffer holds however much is asked for.
    assert_eq!(
        client.timeline(1).await.unwrap(),
        vec![events.last().unwrap().clone()]
    );
    assert_eq!(client.timeline(100_000).await.unwrap().len(), events.len());

    let _ = shutdown_tx.send(());
    let _ = server.await;
    let _ = tokio::fs::remove_dir_all(root).await;
}

/// Events are raised as the runtime reaches each moment, so a read can arrive
/// before the one being waited for.
async fn wait_for_event(
    client: &DaemonClient,
    matches: impl Fn(&nomoreide_daemon_client::protocol::TimelineEvent) -> bool,
) -> nomoreide_daemon_client::protocol::TimelineEvent {
    for _ in 0..200 {
        if let Some(event) = client
            .timeline(200)
            .await
            .unwrap()
            .into_iter()
            .find(&matches)
        {
            return event;
        }
        sleep(Duration::from_millis(20)).await;
    }
    panic!("the timeline never recorded the event being waited for");
}

/// The child writes its line once it is scheduled, and the daemon buffers it
/// asynchronously, so the first read can legitimately be empty.
async fn wait_for_marker(
    client: &DaemonClient,
) -> nomoreide_daemon_client::protocol::ServiceLogEntry {
    for _ in 0..200 {
        if let Some(entry) = client
            .logs("talker", 500)
            .await
            .unwrap()
            .into_iter()
            .find(|entry| entry.text.contains(FIXTURE_MARKER))
        {
            return entry;
        }
        sleep(Duration::from_millis(20)).await;
    }
    panic!("the fixture child never announced itself");
}

async fn credential(paths: &RuntimePaths) -> String {
    tokio::fs::read_to_string(&paths.credential)
        .await
        .unwrap()
        .trim()
        .to_string()
}

async fn wait_for_state(
    paths: &RuntimePaths,
    server: &mut tokio::task::JoinHandle<anyhow::Result<()>>,
) -> nomoreide_daemon_client::DaemonState {
    for _ in 0..100 {
        if let Some(state) = read_daemon_state(&paths.state).await.unwrap() {
            return state;
        }
        if server.is_finished() {
            panic!("daemon stopped before publishing state: {:?}", server.await);
        }
        sleep(Duration::from_millis(20)).await;
    }
    panic!("daemon state was not published");
}
