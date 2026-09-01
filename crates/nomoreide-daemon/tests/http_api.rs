use futures_util::{SinkExt, StreamExt};
use nomoreide_daemon::{run_embedded, serve_until, DaemonOptions};
use nomoreide_daemon_client::protocol::{ServiceRuntimeState, TimelineEventKind, TimelineSeverity};
use nomoreide_daemon_client::{
    is_pid_alive, read_daemon_state, DaemonClient, DaemonClientError, RuntimePaths,
};
use reqwest::StatusCode;
use serde_json::json;
use std::path::PathBuf;
use tokio::sync::oneshot;
use tokio::time::{sleep, Duration};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

fn temp_dir() -> PathBuf {
    std::env::temp_dir().join(format!("nomoreide-daemon-http-{}", Uuid::new_v4()))
}

#[tokio::test]
async fn embedded_daemon_keeps_auth_in_memory_and_allows_only_desktop_origins() {
    let root = temp_dir();
    let runtime_paths = RuntimePaths::new(root.join("runtime"));
    let config_path = root.join("config.json");
    tokio::fs::create_dir_all(&root).await.unwrap();
    tokio::fs::write(
        &config_path,
        serde_json::to_vec_pretty(&json!({ "version": 1, "services": [], "bundles": [] })).unwrap(),
    )
    .await
    .unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let credential = "desktop-test-credential".to_string();
    let task_paths = runtime_paths.clone();
    let mut server = tokio::spawn(async move {
        run_embedded(
            DaemonOptions {
                port,
                runtime_paths: task_paths,
                config_path,
            },
            listener,
            credential,
        )
        .await
    });
    let base_url = format!("http://127.0.0.1:{port}");
    let http = reqwest::Client::new();
    for _ in 0..100 {
        if http
            .get(format!("{base_url}/api/health"))
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            break;
        }
        assert!(
            !server.is_finished(),
            "embedded daemon stopped during startup"
        );
        sleep(Duration::from_millis(20)).await;
    }

    assert!(!runtime_paths.state.exists());
    assert!(!runtime_paths.credential.exists());

    let missing = http
        .get(format!("{base_url}/api/terminal/capabilities"))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);
    let wrong = http
        .get(format!("{base_url}/api/terminal/capabilities"))
        .header("origin", "tauri://localhost")
        .bearer_auth("wrong-desktop-credential")
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
    let allowed = http
        .get(format!("{base_url}/api/terminal/capabilities"))
        .header("origin", "tauri://localhost")
        .bearer_auth("desktop-test-credential")
        .send()
        .await
        .unwrap();
    assert_eq!(allowed.status(), StatusCode::OK);
    assert_eq!(
        allowed
            .headers()
            .get("access-control-allow-origin")
            .unwrap(),
        "tauri://localhost"
    );

    let preflight = http
        .request(
            reqwest::Method::OPTIONS,
            format!("{base_url}/api/terminal/capabilities"),
        )
        .header("origin", "http://127.0.0.1:5173")
        .header("access-control-request-method", "GET")
        .header("access-control-request-headers", "authorization")
        .send()
        .await
        .unwrap();
    assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
    let refused = http
        .request(
            reqwest::Method::OPTIONS,
            format!("{base_url}/api/terminal/capabilities"),
        )
        .header("origin", "https://example.com")
        .header("access-control-request-method", "GET")
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);

    let created = http
        .post(format!("{base_url}/api/terminal/sessions"))
        .bearer_auth("desktop-test-credential")
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::CREATED);
    let session_id = created.json::<serde_json::Value>().await.unwrap()["session"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let socket_url = format!("ws://127.0.0.1:{port}/api/terminal/socket?id={session_id}");
    let unauthenticated_socket = tokio_tungstenite::connect_async(&socket_url)
        .await
        .unwrap_err();
    assert!(matches!(
        unauthenticated_socket,
        tokio_tungstenite::tungstenite::Error::Http(response)
            if response.status() == StatusCode::UNAUTHORIZED
    ));

    let mut socket_request = socket_url.into_client_request().unwrap();
    socket_request
        .headers_mut()
        .insert("origin", "tauri://localhost".parse().unwrap());
    socket_request.headers_mut().insert(
        "sec-websocket-protocol",
        "nomoreide, nomoreide-bearer.desktop-test-credential"
            .parse()
            .unwrap(),
    );
    let (mut socket, response) = tokio_tungstenite::connect_async(socket_request)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
    assert_eq!(
        response.headers().get("sec-websocket-protocol").unwrap(),
        "nomoreide"
    );
    let first = socket.next().await.unwrap().unwrap().into_text().unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&first).unwrap()["state"],
        "running"
    );

    socket
        .send(Message::Text(
            json!({ "type": "input", "data": "printf 'NOMOREIDE_SOCKET_OK\\n'\r" }).to_string(),
        ))
        .await
        .unwrap();
    let output = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let text = socket.next().await.unwrap().unwrap().into_text().unwrap();
            let message = serde_json::from_str::<serde_json::Value>(&text).unwrap();
            if message["type"] == "output"
                && message["data"]
                    .as_str()
                    .is_some_and(|data| data.contains("NOMOREIDE_SOCKET_OK"))
            {
                break message;
            }
        }
    })
    .await
    .expect("terminal socket did not return PTY output");
    assert_eq!(output["type"], "output");

    socket
        .send(Message::Text(
            json!({ "type": "restart", "cols": 101, "rows": 37 }).to_string(),
        ))
        .await
        .unwrap();
    let restarted = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let text = socket.next().await.unwrap().unwrap().into_text().unwrap();
            let message = serde_json::from_str::<serde_json::Value>(&text).unwrap();
            if message["type"] == "state"
                && message["state"] == "running"
                && message["cols"] == 101
                && message["rows"] == 37
            {
                break message;
            }
        }
    })
    .await
    .expect("terminal socket did not report the restarted PTY");
    assert_eq!(restarted["state"], "running");

    socket
        .send(Message::Text(json!({ "type": "stop" }).to_string()))
        .await
        .unwrap();
    let stopped_socket = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let text = socket.next().await.unwrap().unwrap().into_text().unwrap();
            let message = serde_json::from_str::<serde_json::Value>(&text).unwrap();
            if message["type"] == "state" && message["state"] == "exited" {
                break message;
            }
        }
    })
    .await
    .expect("terminal socket did not report the stopped PTY");
    assert_eq!(stopped_socket["state"], "exited");

    let stopped = http
        .post(format!("{base_url}/api/daemon/shutdown"))
        .bearer_auth("desktop-test-credential")
        .send()
        .await
        .unwrap();
    assert_eq!(stopped.status(), StatusCode::OK);
    tokio::time::timeout(Duration::from_secs(5), &mut server)
        .await
        .expect("embedded daemon did not stop")
        .unwrap()
        .unwrap();
    let _ = tokio::fs::remove_dir_all(root).await;
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
    // A wrong method on an exact route is not a 405: the reference's router
    // declines to match and the request falls through to the SPA shell, which
    // answers the same 404 an unrouted path gets. Only the reference's *pattern*
    // routes check the method themselves and answer 405.
    let wrong_method = http
        .post(format!("{}/api/status", state.url))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong_method.status(), StatusCode::NOT_FOUND);

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
                    // A directory with no compose project in it, so bringing
                    // the service up fails the same way whether or not this
                    // machine has Docker at all.
                    "cwd": root,
                    "composeService": "web"
                },
                {
                    "name": "podman",
                    "kind": "podman",
                    "cwd": cwd,
                    "command": "podman start web"
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
            if error.message == "Service \"missing\" is not registered."
    ));
    // A kind this daemon implements no runtime for is still refused as a kind.
    let unsupported = client.start_service("podman").await.unwrap_err();
    assert!(matches!(
        unsupported,
        DaemonClientError::Mutation(error)
            if error.message
                == "Only local, ssh, and docker-compose services are supported by the native daemon."
    ));
    // A compose service is not refused for its kind any more: it gets as far
    // as asking compose to bring it up, and fails there because this fixture
    // is not a compose project.
    let composeless = client.start_service("compose").await.unwrap_err();
    assert!(matches!(
        composeless,
        DaemonClientError::Mutation(error)
            if error.message == "Failed to start the registered service."
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
            // A port conflict is the one refusal that carries structure. The
            // status and the conflict are the whole contract — there is no
            // error code on the wire, because the reference does not send one.
            if error.status == StatusCode::CONFLICT && error.conflict.is_some()
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
    // refuses: it has to launch from a definition this daemon can run.
    let unauthorized_restart = http
        .post(format!("{}/api/services/sleeper/restart", state.url))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized_restart.status(), StatusCode::UNAUTHORIZED);
    for (name, message) in [
        ("missing", "Service \"missing\" is not registered."),
        (
            "podman",
            "Only local, ssh, and docker-compose services are supported by the native daemon.",
        ),
    ] {
        let refused = client.restart_service(name).await.unwrap_err();
        assert!(matches!(
            refused,
            DaemonClientError::Mutation(error) if error.message == message
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
    // A name this daemon never started still has to be registered: see the
    // declared divergence on `stop_service`.
    let unknown = client.stop_service("never-started").await.unwrap_err();
    assert!(matches!(
        unknown,
        DaemonClientError::Mutation(error)
            if error.message == "Service \"never-started\" is not registered."
    ));

    // Drift 2: the config cannot be read at all.
    tokio::fs::write(&config_path, b"{ not json").await.unwrap();
    let stopped = client.stop_service("unreadable").await.unwrap();
    assert_eq!(stopped.state, ServiceRuntimeState::Stopped);
    assert!(!is_pid_alive(unreadable_pid));
    let unreadable = client.stop_service("never-started").await.unwrap_err();
    assert!(matches!(
        unreadable,
        DaemonClientError::Mutation(error)
            if error.message == "Failed to load NoMoreIDE config."
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
                    "name": "podman",
                    "kind": "podman",
                    "cwd": cwd,
                    "command": "podman start web"
                }
            ],
            // The bundle names only `api`; `db` is pulled in as its dependency.
            "bundles": [
                { "name": "stack", "services": ["api"] },
                { "name": "mixed", "services": ["db", "podman"] }
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
            if error.message == "Bundle \"missing\" is not registered."
    ));

    // A bundle holding a service of a kind this daemon implements no runtime
    // for is refused whole, before any of its members start. A config can name
    // such a kind by hand even though registration will not accept one.
    let mixed = client.start_bundle("mixed").await.unwrap_err();
    assert!(matches!(
        mixed,
        DaemonClientError::Mutation(error)
            if error.message
                == "Only local, ssh, and docker-compose services are supported by the native daemon."
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

/// The shutdown endpoint drains the runtime the way a signal does, and it is
/// behind the credential — stopping this daemon stops every service on the
/// machine, which is not something an unauthenticated caller gets to do.
#[tokio::test]
async fn shutdown_is_authenticated_and_actually_stops_the_daemon() {
    let root = temp_dir();
    let runtime_paths = RuntimePaths::new(root.join("runtime"));
    let config_path = root.join("config.json");
    tokio::fs::create_dir_all(&root).await.unwrap();
    tokio::fs::write(
        &config_path,
        serde_json::to_vec_pretty(&json!({ "version": 1, "services": [], "bundles": [] })).unwrap(),
    )
    .await
    .unwrap();

    // No external shutdown: the only thing that may end this server is the
    // request below, which is the whole point of the test.
    let (_shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
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

    let unauthenticated = http
        .post(format!("{}/api/daemon/shutdown", state.url))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);

    let accepted = http
        .post(format!("{}/api/daemon/shutdown", state.url))
        .bearer_auth(credential(&runtime_paths).await)
        .send()
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::OK);
    assert_eq!(
        accepted.json::<serde_json::Value>().await.unwrap(),
        json!({ "ok": true })
    );

    // It answers before it is down, so the proof it meant it is the server
    // task ending on its own.
    for _ in 0..200 {
        if server.is_finished() {
            server.await.unwrap().unwrap();
            tokio::fs::remove_dir_all(&root).await.ok();
            return;
        }
        sleep(Duration::from_millis(20)).await;
    }
    panic!("the daemon acknowledged a shutdown it never performed");
}

/// The error inbox is behind the credential like the rest of the runtime, and
/// an id it does not hold is a 404 rather than an empty prompt.
#[tokio::test]
async fn the_error_inbox_is_authenticated_and_answers_for_ids_it_does_not_hold() {
    let root = temp_dir();
    let runtime_paths = RuntimePaths::new(root.join("runtime"));
    let config_path = root.join("config.json");
    tokio::fs::create_dir_all(&root).await.unwrap();
    tokio::fs::write(
        &config_path,
        serde_json::to_vec_pretty(&json!({ "version": 1, "services": [], "bundles": [] })).unwrap(),
    )
    .await
    .unwrap();

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
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
    let token = credential(&runtime_paths).await;

    let unauthenticated = http
        .get(format!("{}/api/errors", state.url))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);

    // Nothing has run, so there is nothing to report — and that is an empty
    // list, not an error.
    let listed = http
        .get(format!("{}/api/errors", state.url))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(listed.status(), StatusCode::OK);
    assert_eq!(
        listed.json::<serde_json::Value>().await.unwrap(),
        json!({ "ok": true, "incidents": [] })
    );

    let missing = http
        .get(format!("{}/api/errors/7/prompt", state.url))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);

    let _ = shutdown_tx.send(());
    let _ = server.await;
    tokio::fs::remove_dir_all(&root).await.ok();
}

/// Git search is the daemon's first `/api/git/*` surface, and it answers about
/// the selected repository — so the fixture is a real repository, and what the
/// endpoints report has to be what `git ls-files` says, not what is on disk.
#[tokio::test]
async fn searches_the_selected_repository_by_file_name_and_by_content() {
    let root = temp_dir();
    let runtime_paths = RuntimePaths::new(root.join("runtime"));
    let config_path = root.join("config.json");
    let repo = root.join("repo");
    tokio::fs::create_dir_all(repo.join("src")).await.unwrap();

    tokio::fs::write(repo.join("src/widget.ts"), "export const widget = 1;\n")
        .await
        .unwrap();
    tokio::fs::write(repo.join("README.md"), "# widget\n\nAbout the widget.\n")
        .await
        .unwrap();
    // Ignored, so neither search may see it even though it is on disk and
    // matches both queries.
    tokio::fs::write(repo.join(".gitignore"), "secret/\n")
        .await
        .unwrap();
    tokio::fs::create_dir_all(repo.join("secret"))
        .await
        .unwrap();
    tokio::fs::write(repo.join("secret/widget.ts"), "const widget = 2;\n")
        .await
        .unwrap();

    for args in [vec!["init", "--quiet"], vec!["add", "-A"]] {
        let status = tokio::process::Command::new("git")
            .args(&args)
            .current_dir(&repo)
            .status()
            .await
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    tokio::fs::write(
        &config_path,
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "services": [],
            "bundles": [],
            "gitRepositories": [{ "name": "demo", "path": repo.to_string_lossy() }],
            "selectedGitRepository": "demo"
        }))
        .unwrap(),
    )
    .await
    .unwrap();

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
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
    let token = credential(&runtime_paths).await;

    // Search speaks for the workspace, so it sits behind the credential with
    // the rest of the runtime.
    let unauthenticated = http
        .get(format!("{}/api/git/search/files?q=widget", state.url))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);

    let by_name = http
        .get(format!("{}/api/git/search/files?q=widget", state.url))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(by_name.status(), StatusCode::OK);
    let body = by_name.json::<serde_json::Value>().await.unwrap();
    assert_eq!(body["ok"], json!(true));
    let paths: Vec<&str> = body["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| file["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, vec!["src/widget.ts"]);
    // The palette highlights what matched, so the offsets travel with the path.
    assert!(!body["files"][0]["positions"].as_array().unwrap().is_empty());

    let by_content = http
        .get(format!("{}/api/git/search/content?q=widget", state.url))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(by_content.status(), StatusCode::OK);
    let body = by_content.json::<serde_json::Value>().await.unwrap();
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["truncated"], json!(false));
    let files: Vec<&str> = body["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| file["path"].as_str().unwrap())
        .collect();
    assert_eq!(files, vec!["README.md", "src/widget.ts"]);
    assert_eq!(body["files"][0]["matches"][0]["line"], json!(1));
    assert_eq!(body["totalMatches"], json!(3));

    // An include glob narrows it the way the panel's "files to include" does.
    let scoped = http
        .get(format!(
            "{}/api/git/search/content?q=widget&include=**/*.ts",
            state.url
        ))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    let body = scoped.json::<serde_json::Value>().await.unwrap();
    assert_eq!(body["files"].as_array().unwrap().len(), 1);
    assert_eq!(body["files"][0]["path"], json!("src/widget.ts"));

    // An empty box is the panel at rest, not a bad request.
    let blank = http
        .get(format!("{}/api/git/search/content?q=%20", state.url))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(blank.status(), StatusCode::OK);
    assert_eq!(
        blank.json::<serde_json::Value>().await.unwrap(),
        json!({ "ok": true, "files": [], "totalMatches": 0, "truncated": false })
    );

    // A malformed regex is the user's own typing: 400 carrying what is wrong
    // with it, so the panel can show it under the input.
    let malformed = http
        .get(format!("{}/api/git/search/content?q=a(&regex=1", state.url))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(malformed.status(), StatusCode::BAD_REQUEST);
    let body = malformed.json::<serde_json::Value>().await.unwrap();
    assert_eq!(body["ok"], json!(false));
    assert!(body["error"]
        .as_str()
        .unwrap()
        .contains("Invalid search pattern"));

    let _ = shutdown_tx.send(());
    let _ = server.await;
    tokio::fs::remove_dir_all(&root).await.ok();
}
