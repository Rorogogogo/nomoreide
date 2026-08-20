use nomoreide_daemon::{serve_until, DaemonOptions};
use nomoreide_daemon_client::{read_daemon_state, DaemonClient, RuntimePaths};
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
