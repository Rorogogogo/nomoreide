use crate::runtime::{DaemonRuntime, RuntimeMutationError};
use crate::service_discovery::build_service_discovery;
use crate::DaemonOwnership;
use anyhow::{Context, Result};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use nomoreide_core::config::ConfigStore;
use nomoreide_core::log_store::LogStore;
use nomoreide_core::process_manager::ProcessManager;
use nomoreide_core::runtime_registry::RuntimeRegistry;
use nomoreide_daemon_client::protocol::{
    DaemonErrorCode, ErrorEnvelope, MutationErrorEnvelope, ServiceDiscoveryEnvelope,
    ServiceMutationEnvelope,
};
use nomoreide_daemon_client::{DaemonState, RuntimePaths};
use serde::Serialize;
use std::future::Future;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};

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
    runtime: Arc<DaemonRuntime>,
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
    let (shutdown_tx, shutdown_rx) = mpsc::channel(1);
    tokio::spawn(forward_shutdown_signals(shutdown_tx));
    serve_with_shutdown_requests(options, shutdown_rx).await
}

pub async fn serve_until<F>(options: DaemonOptions, shutdown: F) -> Result<()>
where
    F: Future<Output = ()> + Send + 'static,
{
    let (shutdown_tx, shutdown_rx) = mpsc::channel(1);
    tokio::spawn(async move {
        shutdown.await;
        let _ = shutdown_tx.send(()).await;
    });
    serve_with_shutdown_requests(options, shutdown_rx).await
}

pub async fn serve_with_shutdown_requests(
    options: DaemonOptions,
    mut shutdown_requests: mpsc::Receiver<()>,
) -> Result<()> {
    let ownership = DaemonOwnership::acquire(options.runtime_paths.clone())
        .context("failed to acquire daemon ownership")?;
    let config_store = ConfigStore::new(options.config_path);
    let log_store = LogStore::new(options.runtime_paths.state_dir.join("logs"));
    let registry = RuntimeRegistry::new(
        options
            .runtime_paths
            .state_dir
            .join("native")
            .join("runtime-v1.json"),
    );
    let runtime = Arc::new(DaemonRuntime::new(
        config_store.clone(),
        ProcessManager::with_runtime_registry(log_store, registry),
    ));
    runtime
        .reconcile_runtime()
        .await
        .context("failed to reconcile the native runtime registry")?;

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
        config_store,
        runtime: runtime.clone(),
    };
    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/services", get(list_services))
        .route("/api/services/:name/start", post(start_service))
        .route("/api/services/:name/stop", post(stop_service))
        .route("/api/services/:name/restart", post(restart_service))
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .with_state(app_state);

    let (http_shutdown_tx, http_shutdown_rx) = oneshot::channel();
    let shutdown_runtime = runtime.clone();
    let shutdown_coordinator = tokio::spawn(async move {
        let mut http_shutdown_tx = Some(http_shutdown_tx);
        loop {
            match shutdown_requests.recv().await {
                Some(()) => match shutdown_runtime.shutdown().await {
                    Ok(()) => {
                        if let Some(sender) = http_shutdown_tx.take() {
                            let _ = sender.send(());
                        }
                        return;
                    }
                    Err(error) => {
                        eprintln!("nomoreide: daemon cleanup failed; shutdown refused: {error}");
                    }
                },
                None => std::future::pending::<()>().await,
            }
        }
    });

    let server_result = axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = http_shutdown_rx.await;
        })
        .await;
    shutdown_coordinator.abort();
    server_result.context("daemon HTTP server failed")?;
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

async fn start_service(
    State(state): State<AppState>,
    Path(name): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&headers, &state.credential) {
        return error(StatusCode::UNAUTHORIZED, "Authentication required.");
    }
    match state.runtime.start_service(&name).await {
        Ok(status) => Json(ServiceMutationEnvelope { ok: true, status }).into_response(),
        Err(error) => mutation_error(error),
    }
}

async fn stop_service(
    State(state): State<AppState>,
    Path(name): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&headers, &state.credential) {
        return error(StatusCode::UNAUTHORIZED, "Authentication required.");
    }
    match state.runtime.stop_service(&name).await {
        Ok(status) => Json(ServiceMutationEnvelope { ok: true, status }).into_response(),
        Err(error) => mutation_error(error),
    }
}

async fn restart_service(
    State(state): State<AppState>,
    Path(name): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&headers, &state.credential) {
        return error(StatusCode::UNAUTHORIZED, "Authentication required.");
    }
    match state.runtime.restart_service(&name).await {
        Ok(status) => Json(ServiceMutationEnvelope { ok: true, status }).into_response(),
        Err(error) => mutation_error(error),
    }
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

fn mutation_error(error: RuntimeMutationError) -> Response {
    let (status, code, message, conflict) = match error {
        RuntimeMutationError::ServiceNotFound => (
            StatusCode::NOT_FOUND,
            DaemonErrorCode::ServiceNotFound,
            "Service is not registered.".to_string(),
            None,
        ),
        RuntimeMutationError::UnsupportedServiceKind => (
            StatusCode::UNPROCESSABLE_ENTITY,
            DaemonErrorCode::UnsupportedServiceKind,
            "Only registered local services are supported by the native daemon.".to_string(),
            None,
        ),
        RuntimeMutationError::PortConflict { message, conflict } => (
            StatusCode::CONFLICT,
            DaemonErrorCode::PortInUse,
            message,
            Some(*conflict),
        ),
        RuntimeMutationError::DaemonDraining => (
            StatusCode::SERVICE_UNAVAILABLE,
            DaemonErrorCode::DaemonDraining,
            "The daemon is draining process mutations.".to_string(),
            None,
        ),
        RuntimeMutationError::DaemonCleanupFailed => (
            StatusCode::SERVICE_UNAVAILABLE,
            DaemonErrorCode::DaemonCleanupFailed,
            "The daemon previously failed to clean up its services; new starts are disabled."
                .to_string(),
            None,
        ),
        RuntimeMutationError::ConfigLoadFailed => (
            StatusCode::INTERNAL_SERVER_ERROR,
            DaemonErrorCode::ConfigLoadFailed,
            "Failed to load NoMoreIDE config.".to_string(),
            None,
        ),
        RuntimeMutationError::ServiceStartFailed => (
            StatusCode::INTERNAL_SERVER_ERROR,
            DaemonErrorCode::ServiceStartFailed,
            "Failed to start the registered service.".to_string(),
            None,
        ),
        RuntimeMutationError::CleanupFailed => (
            StatusCode::INTERNAL_SERVER_ERROR,
            DaemonErrorCode::CleanupFailed,
            "Failed to confirm service cleanup.".to_string(),
            None,
        ),
    };
    (
        status,
        Json(MutationErrorEnvelope {
            ok: false,
            error: message,
            code,
            conflict,
        }),
    )
        .into_response()
}

async fn forward_shutdown_signals(sender: mpsc::Sender<()>) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let Ok(mut terminate) = signal(SignalKind::terminate()) else {
            return;
        };
        let Ok(mut interrupt) = signal(SignalKind::interrupt()) else {
            return;
        };
        loop {
            tokio::select! {
                _ = terminate.recv() => {}
                _ = interrupt.recv() => {}
            }
            if sender.send(()).await.is_err() {
                return;
            }
        }
    }
    #[cfg(not(unix))]
    loop {
        if tokio::signal::ctrl_c().await.is_err() || sender.send(()).await.is_err() {
            return;
        }
    }
}
