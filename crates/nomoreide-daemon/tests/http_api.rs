use nomoreide_daemon::{serve_until, DaemonOptions};
use nomoreide_daemon_client::protocol::{DaemonErrorCode, ServiceRuntimeState};
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

#[test]
fn daemon_fixture_child() {
    if std::env::var_os("NOMOREIDE_DAEMON_FIXTURE_CHILD").is_none() {
        return;
    }
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
    let conflict = client.start_service("blocked").await.unwrap_err();
    assert!(matches!(
        conflict,
        DaemonClientError::Mutation(error)
            if error.code == DaemonErrorCode::PortInUse && error.conflict.is_some()
    ));
    assert!(held_listener.local_addr().is_ok());

    // Nothing has been started, so the daemon is tracking nothing yet.
    let unauthorized_status = http
        .get(format!("{}/api/status", state.url))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized_status.status(), StatusCode::UNAUTHORIZED);
    assert!(client.status().await.unwrap().is_empty());

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
        vec!["sleeper"]
    );
    assert_eq!(tracked[0].state, ServiceRuntimeState::Running);
    assert_eq!(tracked[0].pid, Some(pid));

    let stopped = client.stop_service("sleeper").await.unwrap();
    assert_eq!(stopped.state, ServiceRuntimeState::Stopped);
    assert!(!is_pid_alive(pid));
    // A stopped service stays in the report rather than vanishing from it.
    let after_stop = client.status().await.unwrap();
    assert_eq!(after_stop.len(), 1);
    assert_eq!(after_stop[0].state, ServiceRuntimeState::Stopped);

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
