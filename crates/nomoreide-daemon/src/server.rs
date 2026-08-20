use crate::service_discovery::build_service_discovery;
use crate::DaemonOwnership;
use anyhow::{Context, Result};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::Utc;
use nomoreide_core::config::ConfigStore;
use nomoreide_daemon_client::protocol::{ErrorEnvelope, ServiceDiscoveryEnvelope};
use nomoreide_daemon_client::{DaemonState, RuntimePaths};
use serde::Serialize;
use std::future::Future;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;

#[derive(Debug, Clone)]
pub struct DaemonOptions {
    pub port: u16,
    pub runtime_paths: RuntimePaths,
    pub config_path: PathBuf,
}

impl Default for DaemonOptions {
    fn default() -> Self {
        Self {
            port: nomoreide_daemon_client::DEFAULT_DAEMON_PORT,
            runtime_paths: RuntimePaths::default(),
            config_path: ConfigStore::default_path(),
        }
    }
}

#[derive(Clone)]
struct AppState {
    credential: String,
    owner_id: String,
    config_store: ConfigStore,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthEnvelope {
    ok: bool,
    app: &'static str,
    version: &'static str,
    pid: u32,
    owner_id: String,
}

pub async fn run(options: DaemonOptions) -> Result<()> {
    serve_until(options, shutdown_signal()).await
}

pub async fn serve_until<F>(options: DaemonOptions, shutdown: F) -> Result<()>
where
    F: Future<Output = ()> + Send + 'static,
{
    let ownership = DaemonOwnership::acquire(options.runtime_paths.clone())
        .context("failed to acquire daemon ownership")?;
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, options.port)))
        .await
        .context("failed to bind the daemon loopback listener")?;
    let address = listener
        .local_addr()
        .context("failed to inspect the daemon listener")?;
    let state = DaemonState {
        pid: std::process::id(),
        owner_id: ownership.owner_id().to_string(),
        url: format!("http://127.0.0.1:{}", address.port()),
        port: address.port(),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        started_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    };
    ownership
        .publish(&state)
        .context("failed to publish daemon state")?;

    let app_state = AppState {
        credential: ownership.credential().to_string(),
        owner_id: ownership.owner_id().to_string(),
        config_store: ConfigStore::new(options.config_path),
    };
    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/services", get(list_services))
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .with_state(app_state);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await
        .context("daemon HTTP server failed")?;
    drop(ownership);
    Ok(())
}

async fn health(State(state): State<AppState>) -> Json<HealthEnvelope> {
    Json(HealthEnvelope {
        ok: true,
        app: "nomoreide",
        version: env!("CARGO_PKG_VERSION"),
        pid: std::process::id(),
        owner_id: state.owner_id,
    })
}

async fn list_services(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &state.credential) {
        return error(StatusCode::UNAUTHORIZED, "Authentication required.");
    }
    let config = match state.config_store.load().await {
        Ok(config) => config,
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to load NoMoreIDE config.",
            )
        }
    };
    let discovery = match build_service_discovery(&config) {
        Ok(discovery) => discovery,
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to build service discovery.",
            )
        }
    };
    (
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(ServiceDiscoveryEnvelope {
            ok: true,
            services: discovery.services,
            bundles: discovery.bundles,
        }),
    )
        .into_response()
}

fn authorized(headers: &HeaderMap, credential: &str) -> bool {
    let Some(candidate) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return false;
    };
    bool::from(candidate.as_bytes().ct_eq(credential.as_bytes()))
}

async fn not_found() -> Response {
    error(StatusCode::NOT_FOUND, "Not found.")
}

async fn method_not_allowed() -> Response {
    error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed.")
}

fn error(status: StatusCode, message: &str) -> Response {
    (
        status,
        Json(ErrorEnvelope {
            ok: false,
            error: message.to_string(),
        }),
    )
        .into_response()
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut terminate) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = terminate.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
