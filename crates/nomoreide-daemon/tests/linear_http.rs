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

/// The browser sign-in's two refusals, and the one guarantee that matters more
/// than either: an expired OAuth grant with nothing to renew it must ask for a
/// reconnect rather than send a token Linear will refuse.
///
/// Driven over HTTP rather than as a unit test because the interesting part is
/// the *route's* resolution of a stored connection — which is where a token is
/// picked, aged and presented, and the one place all three can disagree.
#[tokio::test]
async fn the_linear_sign_in_carries_pkce_no_secret_and_a_callback_outside_the_credential_layer() {
    let root =
        std::env::temp_dir().join(format!("nomoreide-linear-oauth-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&root).await.unwrap();
    let config_path = root.join("config.json");
    // An OAuth connection that expired an hour ago and carries no refresh
    // token — the shape a connection written by an older build has.
    tokio::fs::write(
        &config_path,
        serde_json::to_vec(&json!({
            "version": 1, "services": [], "bundles": [],
            "connections": {"linear": {
                "source": "oauth",
                "token": "expired-access-token",
                "expiresAt": 1_000_000_000_i64,
            }}
        }))
        .unwrap(),
    )
    .await
    .unwrap();
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

    // Connected, and the panel is told *how* — the difference a broken
    // connection turns on.
    let data: Value = http
        .get(format!("{base}/api/linear/connection"))
        .bearer_auth("test-local-auth")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(data["connected"], true);
    assert_eq!(data["source"], "oauth");
    assert_eq!(data["oauthAvailable"], true);
    assert!(!data.to_string().contains("expired-access-token"));

    // A sign-in nobody has started is idle, never an error.
    let phase: Value = http
        .get(format!("{base}/api/linear/oauth/status"))
        .bearer_auth("test-local-auth")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(phase["phase"], "idle");

    // Starting a sign-in reaches no network: Linear publishes no discovery
    // document and no registration endpoint, so the spec states both and
    // `begin_login` has nothing to fetch. That is why this is assertable here.
    let started: Value = http
        .post(format!("{base}/api/linear/oauth/start"))
        .bearer_auth("test-local-auth")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let url = started["url"].as_str().expect("an authorize URL");
    assert!(
        url.starts_with("https://linear.app/oauth/authorize?"),
        "{url}"
    );
    assert!(url.contains("code_challenge_method=S256"), "{url}");
    assert!(url.contains("code_challenge="), "{url}");
    // The redirect Linear matches literally. A change here is a change somebody
    // must also make in the Linear app's settings, or every sign-in is refused
    // before a consent screen is ever drawn.
    assert!(
        url.contains(
            "redirect_uri=http%3A%2F%2F127.0.0.1%3A4317%2Fapi%2Flinear%2Foauth%2Fcallback"
        ),
        "{url}"
    );
    // No secret, anywhere. Shipping one from a binary the user runs would be
    // shipping a secret that is not secret; PKCE is what stands in for it.
    assert!(!url.contains("client_secret"), "{url}");

    // ...and the phase the dashboard polls now says so. Recorded by `start`
    // rather than inferred, so a browser tab that never comes back is
    // distinguishable from one that was never opened.
    let phase: Value = http
        .get(format!("{base}/api/linear/oauth/status"))
        .bearer_auth("test-local-auth")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(phase["phase"], "pending");

    // The one that matters: an expired grant with no refresh token asks for a
    // reconnect. Without the expiry check this would reach Linear with a dead
    // token and come back as an unexplained 401.
    let stale = http
        .post(format!("{base}/api/linear/request"))
        .bearer_auth("test-local-auth")
        .json(&json!({"operation": "metadata"}))
        .send()
        .await
        .unwrap();
    assert_eq!(stale.status(), reqwest::StatusCode::BAD_REQUEST);
    let body: Value = stale.json().await.unwrap();
    assert!(
        body["error"].as_str().unwrap_or_default().contains("again"),
        "{body}"
    );

    // **The callback must be reachable with no credential at all.** Linear
    // redirects a browser here, and a redirect carries no `Authorization`
    // header — mounting this route with the authenticated ones answered
    // `401 Authentication required` and the code was never exchanged. Asserted
    // by its absence: no `bearer_auth` on this request.
    let unauthenticated = http
        .get(format!(
            "{base}/api/linear/oauth/callback?code=abc&state=xyz"
        ))
        .send()
        .await
        .unwrap();
    assert_ne!(
        unauthenticated.status(),
        reqwest::StatusCode::UNAUTHORIZED,
        "the callback must not sit behind the credential layer"
    );

    // A callback with a state this daemon never minted exchanges nothing.
    let forged = http
        .get(format!(
            "{base}/api/linear/oauth/callback?code=abc&state=never-minted"
        ))
        .bearer_auth("test-local-auth")
        .send()
        .await
        .unwrap();
    assert_eq!(forged.status(), reqwest::StatusCode::BAD_REQUEST);

    server.abort();
    let _ = server.await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}
