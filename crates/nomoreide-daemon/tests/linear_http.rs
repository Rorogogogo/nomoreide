use nomoreide_daemon::{run_embedded, DaemonOptions};
use nomoreide_daemon_client::RuntimePaths;
use serde_json::{json, Value};
use tokio::time::{sleep, Duration};

#[tokio::test]
async fn linear_connection_is_authenticated_redacted_and_removable() {
    let root = std::env::temp_dir().join(format!("nomoreide-linear-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&root).await.unwrap();
    let config_path = root.join("config.json");
    tokio::fs::write(&config_path, serde_json::to_vec(&json!({
        "version": 1, "services": [], "bundles": [],
        "connections": {"linear": {"source":"stored", "token":"test-secret-do-not-expose", "username":"Test User"}}
    })).unwrap()).await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let options = DaemonOptions {
        port,
        runtime_paths: RuntimePaths::new(root.join("runtime")),
        config_path: config_path.clone(),
    };
    let server = tokio::spawn(run_embedded(options, listener, "test-local-auth".into()));
    let http = reqwest::Client::new();
    let base = format!("http://127.0.0.1:{port}");
    for _ in 0..100 {
        if http
            .get(format!("{base}/api/health"))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            break;
        }
        sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        http.get(format!("{base}/api/linear/connection"))
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    let response = http
        .get(format!("{base}/api/linear/connection"))
        .bearer_auth("test-local-auth")
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let data: Value = response.json().await.unwrap();
    assert_eq!(data["connected"], true);
    assert_eq!(data["username"], "Test User");
    assert!(!data.to_string().contains("test-secret"));
    let invalid = http
        .post(format!("{base}/api/linear/request"))
        .bearer_auth("test-local-auth")
        .json(&json!({"operation":"issue", "id":"../token"}))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid.status(), reqwest::StatusCode::BAD_REQUEST);
    assert!(http
        .delete(format!("{base}/api/linear/connection"))
        .bearer_auth("test-local-auth")
        .send()
        .await
        .unwrap()
        .status()
        .is_success());
    let missing = http
        .post(format!("{base}/api/linear/request"))
        .bearer_auth("test-local-auth")
        .json(&json!({"operation":"metadata"}))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), reqwest::StatusCode::BAD_REQUEST);
    let config = tokio::fs::read_to_string(config_path).await.unwrap();
    assert!(!config.contains("test-secret"));
    server.abort();
    let _ = server.await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}
