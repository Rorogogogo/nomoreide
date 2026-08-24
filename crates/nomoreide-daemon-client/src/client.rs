use crate::protocol::{
    BundleMutationEnvelope, DaemonErrorCode, ErrorEnvelope, Incident, IncidentPromptEnvelope,
    IncidentsEnvelope, LogsEnvelope, MutationErrorEnvelope, PortConflict, ServiceDiscovery,
    ServiceDiscoveryEnvelope, ServiceLogEntry, ServiceMutationEnvelope, ServiceRuntimeStatus,
    ShutdownEnvelope, StatusEnvelope, TerminalSessionEnvelope, TerminalSessionInfo,
    TerminalSessionsEnvelope, TimelineEnvelope, TimelineEvent,
};
use crate::{
    discover_daemon, is_pid_alive, probe_daemon, read_daemon_credential, read_daemon_state,
    DaemonDiscovery, DaemonEndpoint, DaemonProbe, DiscoveryStatus, RuntimePaths,
};
use reqwest::header::{HeaderValue, AUTHORIZATION};
use reqwest::{Client, StatusCode};
use thiserror::Error;

const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
const MUTATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// A bundle starts its services one at a time and lets each dependency bind its
/// port first, so it needs room for several readiness waits in a row rather
/// than the single-service budget.
const BUNDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

#[derive(Debug, Error)]
pub enum DaemonClientError {
    #[error("failed to configure the daemon HTTP client: {0}")]
    Client(#[source] reqwest::Error),
    #[error("failed to read daemon runtime state: {0}")]
    State(#[source] std::io::Error),
    #[error("failed to read the daemon credential: {0}")]
    Credential(#[source] std::io::Error),
    #[error("daemon request failed: {0}")]
    Request(#[source] reqwest::Error),
    #[error("daemon request failed ({status}): {message}")]
    Http { status: StatusCode, message: String },
    #[error(transparent)]
    Mutation(#[from] Box<DaemonApiError>),
    #[error("daemon returned an invalid response: {0}")]
    Protocol(String),
    #[error("another application is listening on the NoMoreIDE daemon port")]
    ForeignDaemon,
    #[error("the NoMoreIDE daemon is not running")]
    DaemonDown,
    #[error("the NoMoreIDE daemon identity could not be verified")]
    IdentityUnverified,
}

#[derive(Debug, Error)]
#[error("daemon mutation failed ({status}, {code:?}): {message}")]
pub struct DaemonApiError {
    pub status: StatusCode,
    pub code: DaemonErrorCode,
    pub message: String,
    pub conflict: Option<PortConflict>,
}

#[derive(Debug, Clone)]
pub struct DaemonClient {
    endpoint: DaemonEndpoint,
    paths: RuntimePaths,
    owner_id: String,
    http: Client,
    authorization: HeaderValue,
}

impl DaemonClient {
    pub async fn discover(
        paths: &RuntimePaths,
        configured_port: u16,
        client_version: &str,
    ) -> Result<Self, DaemonClientError> {
        let http = daemon_http_client()?;
        let endpoint = match discover_daemon(paths, configured_port, client_version, &http)
            .await
            .map_err(DaemonClientError::State)?
        {
            DaemonDiscovery::Running(daemon) if daemon.status == DiscoveryStatus::Recorded => {
                daemon.endpoint
            }
            DaemonDiscovery::Running(_) => return Err(DaemonClientError::IdentityUnverified),
            DaemonDiscovery::Foreign(_) => return Err(DaemonClientError::ForeignDaemon),
            DaemonDiscovery::Down(_) => return Err(DaemonClientError::DaemonDown),
        };
        let owner_id = verify_daemon_identity(paths, &endpoint, &http, None).await?;
        let credential = read_daemon_credential(paths)
            .await
            .map_err(DaemonClientError::Credential)?;
        Self::new(endpoint, paths.clone(), owner_id, credential, http)
    }

    pub async fn connect(
        endpoint: DaemonEndpoint,
        paths: &RuntimePaths,
    ) -> Result<Self, DaemonClientError> {
        let http = daemon_http_client()?;
        let owner_id = verify_daemon_identity(paths, &endpoint, &http, None).await?;
        let credential = read_daemon_credential(paths)
            .await
            .map_err(DaemonClientError::Credential)?;
        Self::new(endpoint, paths.clone(), owner_id, credential, http)
    }

    fn new(
        endpoint: DaemonEndpoint,
        paths: RuntimePaths,
        owner_id: String,
        credential: String,
        http: Client,
    ) -> Result<Self, DaemonClientError> {
        let mut authorization = HeaderValue::from_str(&format!("Bearer {credential}"))
            .map_err(|_| DaemonClientError::Protocol("daemon credential is malformed".into()))?;
        authorization.set_sensitive(true);
        Ok(Self {
            endpoint,
            paths,
            owner_id,
            http,
            authorization,
        })
    }

    pub async fn list_services(&self) -> Result<ServiceDiscovery, DaemonClientError> {
        let body = self.read(self.endpoint.api_url("api/services")).await?;
        let envelope = serde_json::from_slice::<ServiceDiscoveryEnvelope>(&body)
            .map_err(|error| DaemonClientError::Protocol(error.to_string()))?;
        if !envelope.ok {
            return Err(DaemonClientError::Protocol(
                "daemon returned an unsuccessful response".into(),
            ));
        }
        Ok(envelope.into())
    }

    /// GET a read-only endpoint and hand back its body.
    async fn read(&self, url: reqwest::Url) -> Result<Vec<u8>, DaemonClientError> {
        let response = self.send_authenticated(self.http.get(url)).await?;
        let status = response.status();
        let body = response.bytes().await.map_err(DaemonClientError::Request)?;
        if !status.is_success() {
            let message = serde_json::from_slice::<ErrorEnvelope>(&body)
                .ok()
                .filter(|envelope| !envelope.ok)
                .map(|envelope| envelope.error)
                .unwrap_or_else(|| "Daemon request failed.".to_string());
            return Err(DaemonClientError::Http { status, message });
        }
        Ok(body.to_vec())
    }

    pub async fn start_service(
        &self,
        name: &str,
    ) -> Result<ServiceRuntimeStatus, DaemonClientError> {
        self.service_action(name, "start").await
    }

    pub async fn stop_service(
        &self,
        name: &str,
    ) -> Result<ServiceRuntimeStatus, DaemonClientError> {
        self.service_action(name, "stop").await
    }

    pub async fn restart_service(
        &self,
        name: &str,
    ) -> Result<ServiceRuntimeStatus, DaemonClientError> {
        self.service_action(name, "restart").await
    }

    /// Every service the daemon is tracking, however it was started.
    pub async fn status(&self) -> Result<Vec<ServiceRuntimeStatus>, DaemonClientError> {
        let body = self.read(self.endpoint.api_url("api/status")).await?;
        let envelope = serde_json::from_slice::<StatusEnvelope>(&body)
            .map_err(|error| DaemonClientError::Protocol(error.to_string()))?;
        if !envelope.ok {
            return Err(DaemonClientError::Protocol(
                "daemon returned an unsuccessful response".into(),
            ));
        }
        Ok(envelope.services)
    }

    /// The tail of a service's buffered output, newest last.
    pub async fn logs(
        &self,
        name: &str,
        lines: u32,
    ) -> Result<Vec<ServiceLogEntry>, DaemonClientError> {
        let mut url = self.endpoint.action_url("services", name, "logs");
        url.query_pairs_mut()
            .append_pair("lines", &lines.to_string());
        let body = self.read(url).await?;
        let envelope = serde_json::from_slice::<LogsEnvelope>(&body)
            .map_err(|error| DaemonClientError::Protocol(error.to_string()))?;
        if !envelope.ok {
            return Err(DaemonClientError::Protocol(
                "daemon returned an unsuccessful response".into(),
            ));
        }
        Ok(envelope.logs)
    }

    /// The most recent timeline events, oldest last.
    pub async fn timeline(&self, limit: u32) -> Result<Vec<TimelineEvent>, DaemonClientError> {
        let mut url = self.endpoint.api_url("api/timeline");
        url.query_pairs_mut()
            .append_pair("limit", &limit.to_string());
        let body = self.read(url).await?;
        let envelope = serde_json::from_slice::<TimelineEnvelope>(&body)
            .map_err(|error| DaemonClientError::Protocol(error.to_string()))?;
        if !envelope.ok {
            return Err(DaemonClientError::Protocol(
                "daemon returned an unsuccessful response".into(),
            ));
        }
        Ok(envelope.timeline)
    }

    pub async fn start_bundle(
        &self,
        name: &str,
    ) -> Result<Vec<ServiceRuntimeStatus>, DaemonClientError> {
        self.bundle_action(name, "start").await
    }

    pub async fn stop_bundle(
        &self,
        name: &str,
    ) -> Result<Vec<ServiceRuntimeStatus>, DaemonClientError> {
        self.bundle_action(name, "stop").await
    }

    /// The incidents the daemon's inbox is holding, most recently active first.
    pub async fn list_errors(&self, limit: u32) -> Result<Vec<Incident>, DaemonClientError> {
        let mut url = self.endpoint.api_url("api/errors");
        url.query_pairs_mut()
            .append_pair("limit", &limit.to_string());
        let body = self.read(url).await?;
        let envelope = serde_json::from_slice::<IncidentsEnvelope>(&body)
            .map_err(|error| DaemonClientError::Protocol(error.to_string()))?;
        if !envelope.ok {
            return Err(DaemonClientError::Protocol(
                "daemon returned an unsuccessful response".into(),
            ));
        }
        Ok(envelope.incidents)
    }

    /// The debugging prompt for one incident. A 404 is not a transport failure
    /// — it is the daemon saying it holds no such incident — so it comes back
    /// as `None` rather than as an error.
    pub async fn error_prompt(
        &self,
        id: u64,
    ) -> Result<Option<IncidentPromptEnvelope>, DaemonClientError> {
        let url = self.endpoint.api_url(&format!("api/errors/{id}/prompt"));
        match self.read(url).await {
            Ok(body) => {
                let envelope = serde_json::from_slice::<IncidentPromptEnvelope>(&body)
                    .map_err(|error| DaemonClientError::Protocol(error.to_string()))?;
                Ok(Some(envelope))
            }
            Err(DaemonClientError::Http { status, .. }) if status == StatusCode::NOT_FOUND => {
                Ok(None)
            }
            Err(other) => Err(other),
        }
    }

    /// Ask the daemon to stop itself, and with it every service on the machine.
    ///
    /// The daemon answers before it is down — draining takes as long as the
    /// services take to stop — so a caller that needs the port free has to
    /// watch for it rather than trust this returning.
    pub async fn shutdown(&self) -> Result<(), DaemonClientError> {
        let body = self
            .mutation(self.endpoint.api_url("api/daemon/shutdown"), BUNDLE_TIMEOUT)
            .await?;
        let envelope = serde_json::from_slice::<ShutdownEnvelope>(&body)
            .map_err(|error| DaemonClientError::Protocol(error.to_string()))?;
        if !envelope.ok {
            return Err(DaemonClientError::Protocol(
                "daemon returned an unsuccessful response".into(),
            ));
        }
        Ok(())
    }

    /// The terminal tabs the daemon owns, in the order they were created.
    pub async fn list_terminal_sessions(
        &self,
    ) -> Result<Vec<TerminalSessionInfo>, DaemonClientError> {
        let body = self
            .read(self.endpoint.api_url("api/terminal/sessions"))
            .await?;
        let envelope = serde_json::from_slice::<TerminalSessionsEnvelope>(&body)
            .map_err(|error| DaemonClientError::Protocol(error.to_string()))?;
        if !envelope.ok {
            return Err(DaemonClientError::Protocol(
                "daemon returned an unsuccessful response".into(),
            ));
        }
        Ok(envelope.sessions)
    }

    /// Move a running agent session out to the system terminal.
    pub async fn open_terminal(&self, id: &str) -> Result<TerminalSessionInfo, DaemonClientError> {
        self.terminal_control(id, "open-system-terminal").await
    }

    /// Bring one back to the dock.
    pub async fn reclaim_terminal(
        &self,
        id: &str,
    ) -> Result<TerminalSessionInfo, DaemonClientError> {
        self.terminal_control(id, "reclaim-dock").await
    }

    /// Both control actions are the same request with a different last segment.
    ///
    /// The id is a path *segment*, so it is appended through the URL rather
    /// than formatted into one: a session named after a service can hold a `#`
    /// or a space, and either would silently truncate or corrupt a hand-built
    /// path.
    async fn terminal_control(
        &self,
        id: &str,
        action: &str,
    ) -> Result<TerminalSessionInfo, DaemonClientError> {
        let url = self
            .endpoint
            .action_url_under(&["api", "terminal", "sessions"], id, action);
        let body = self.terminal_mutation(url, MUTATION_TIMEOUT).await?;
        let envelope = serde_json::from_slice::<TerminalSessionEnvelope>(&body)
            .map_err(|error| DaemonClientError::Protocol(error.to_string()))?;
        if !envelope.ok {
            return Err(DaemonClientError::Protocol(
                "daemon returned an unsuccessful response".into(),
            ));
        }
        Ok(envelope.session)
    }

    async fn service_action(
        &self,
        name: &str,
        action: &str,
    ) -> Result<ServiceRuntimeStatus, DaemonClientError> {
        let body = self
            .mutation(
                self.endpoint.action_url("services", name, action),
                MUTATION_TIMEOUT,
            )
            .await?;
        let envelope = serde_json::from_slice::<ServiceMutationEnvelope>(&body)
            .map_err(|error| DaemonClientError::Protocol(error.to_string()))?;
        if !envelope.ok {
            return Err(DaemonClientError::Protocol(
                "daemon returned an unsuccessful response".into(),
            ));
        }
        Ok(envelope.status)
    }

    async fn bundle_action(
        &self,
        name: &str,
        action: &str,
    ) -> Result<Vec<ServiceRuntimeStatus>, DaemonClientError> {
        let body = self
            .mutation(
                self.endpoint.action_url("bundles", name, action),
                BUNDLE_TIMEOUT,
            )
            .await?;
        let envelope = serde_json::from_slice::<BundleMutationEnvelope>(&body)
            .map_err(|error| DaemonClientError::Protocol(error.to_string()))?;
        if !envelope.ok {
            return Err(DaemonClientError::Protocol(
                "daemon returned an unsuccessful response".into(),
            ));
        }
        Ok(envelope.statuses)
    }

    /// POST a mutation and hand back its body, turning any non-success status
    /// into the daemon's own typed refusal where it sent one.
    async fn mutation(
        &self,
        url: reqwest::Url,
        timeout: std::time::Duration,
    ) -> Result<Vec<u8>, DaemonClientError> {
        let request = self.http.post(url).timeout(timeout);
        let response = self.send_authenticated(request).await?;
        let status = response.status();
        let body = response.bytes().await.map_err(DaemonClientError::Request)?;
        if !status.is_success() {
            if let Ok(envelope) = serde_json::from_slice::<MutationErrorEnvelope>(&body) {
                if !envelope.ok {
                    return Err(DaemonClientError::Mutation(Box::new(DaemonApiError {
                        status,
                        code: envelope.code,
                        message: envelope.error,
                        conflict: envelope.conflict,
                    })));
                }
            }
            let message = serde_json::from_slice::<ErrorEnvelope>(&body)
                .ok()
                .filter(|envelope| !envelope.ok)
                .map(|envelope| envelope.error)
                .unwrap_or_else(|| "Daemon request failed.".to_string());
            return Err(DaemonClientError::Http { status, message });
        }
        Ok(body.to_vec())
    }

    /// A terminal control POST, which carries the header the daemon requires
    /// before it will move a session between presentations.
    async fn terminal_mutation(
        &self,
        url: reqwest::Url,
        timeout: std::time::Duration,
    ) -> Result<Vec<u8>, DaemonClientError> {
        let request = self
            .http
            .post(url)
            .timeout(timeout)
            .header("x-nomoreide-terminal-control", "1");
        let response = self.send_authenticated(request).await?;
        let status = response.status();
        let body = response.bytes().await.map_err(DaemonClientError::Request)?;
        if !status.is_success() {
            let message = serde_json::from_slice::<ErrorEnvelope>(&body)
                .ok()
                .filter(|envelope| !envelope.ok)
                .map(|envelope| envelope.error)
                .unwrap_or_else(|| "Daemon request failed.".to_string());
            return Err(DaemonClientError::Http { status, message });
        }
        Ok(body.to_vec())
    }

    async fn send_authenticated(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, DaemonClientError> {
        verify_daemon_identity(
            &self.paths,
            &self.endpoint,
            &self.http,
            Some(&self.owner_id),
        )
        .await?;
        request
            .header(AUTHORIZATION, self.authorization.clone())
            .send()
            .await
            .map_err(DaemonClientError::Request)
    }
}

async fn verify_daemon_identity(
    paths: &RuntimePaths,
    endpoint: &DaemonEndpoint,
    http: &Client,
    expected_owner_id: Option<&str>,
) -> Result<String, DaemonClientError> {
    let state = read_daemon_state(&paths.state)
        .await
        .map_err(DaemonClientError::State)?;
    let Some(state) = state else {
        return Err(DaemonClientError::IdentityUnverified);
    };
    if !is_pid_alive(state.pid)
        || state.endpoint().ok().as_ref() != Some(endpoint)
        || expected_owner_id.is_some_and(|expected| expected != state.owner_id)
    {
        return Err(DaemonClientError::IdentityUnverified);
    }
    match probe_daemon(endpoint, http).await {
        DaemonProbe::NoMoreIde(health)
            if health.owner_id.as_deref() == Some(state.owner_id.as_str()) =>
        {
            Ok(state.owner_id)
        }
        _ => Err(DaemonClientError::IdentityUnverified),
    }
}

fn daemon_http_client() -> Result<Client, DaemonClientError> {
    Client::builder()
        .no_proxy()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(DaemonClientError::Client)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DaemonState;
    use std::process::Command;
    use std::time::Instant;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::time::timeout;

    const PROXY_CHILD: &str = "NOMOREIDE_PROXY_REGRESSION_CHILD";

    #[tokio::test]
    async fn identity_mismatch_never_sends_the_credential() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let paths = runtime_paths("identity-mismatch", port);
        write_runtime(&paths, port, "recorded-owner", true).await;
        let secret = "ab".repeat(32);
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for _ in 0..2 {
                requests.push(
                    respond_once(
                        &listener,
                        &format!(
                            r#"{{"ok":true,"app":"nomoreide","pid":{},"ownerId":"spoof-owner"}}"#,
                            std::process::id()
                        ),
                    )
                    .await,
                );
            }
            requests
        });

        let error = DaemonClient::discover(&paths, port, env!("CARGO_PKG_VERSION"))
            .await
            .unwrap_err();

        assert!(matches!(error, DaemonClientError::IdentityUnverified));
        for request in server.await.unwrap() {
            assert!(!request.to_ascii_lowercase().contains("authorization:"));
            assert!(!request.contains(&secret));
        }
        let _ = tokio::fs::remove_dir_all(paths.state_dir).await;
    }

    #[tokio::test]
    async fn hanging_health_response_is_bounded() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let paths = runtime_paths("hanging-health", port);
        write_runtime(&paths, port, "recorded-owner", false).await;
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 2048];
            let read = stream.read(&mut request).await.unwrap();
            assert!(String::from_utf8_lossy(&request[..read]).contains("GET /api/health"));
            std::future::pending::<()>().await;
        });
        let started = Instant::now();

        let result = timeout(
            REQUEST_TIMEOUT + std::time::Duration::from_secs(2),
            DaemonClient::connect(DaemonEndpoint::localhost(port), &paths),
        )
        .await;

        assert!(result.is_ok(), "client exceeded its total request timeout");
        assert!(matches!(
            result.unwrap(),
            Err(DaemonClientError::IdentityUnverified)
        ));
        assert!(started.elapsed() < REQUEST_TIMEOUT + std::time::Duration::from_secs(2));
        server.abort();
        let _ = tokio::fs::remove_dir_all(paths.state_dir).await;
    }

    #[tokio::test]
    async fn replacement_listener_never_receives_the_credential() {
        let initial = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = initial.local_addr().unwrap().port();
        let paths = runtime_paths("replacement-listener", port);
        write_runtime(&paths, port, "recorded-owner", true).await;
        let initial_server = tokio::spawn(async move {
            respond_once(
                &initial,
                &format!(
                    r#"{{"ok":true,"app":"nomoreide","pid":{},"ownerId":"recorded-owner"}}"#,
                    std::process::id()
                ),
            )
            .await
        });
        let client = DaemonClient::connect(DaemonEndpoint::localhost(port), &paths)
            .await
            .unwrap();
        assert!(!initial_server
            .await
            .unwrap()
            .to_ascii_lowercase()
            .contains("authorization:"));

        let replacement = TcpListener::bind(("127.0.0.1", port)).await.unwrap();
        let replacement_server = tokio::spawn(async move {
            respond_once(
                &replacement,
                &format!(
                    r#"{{"ok":true,"app":"nomoreide","pid":{},"ownerId":"replacement-owner"}}"#,
                    std::process::id()
                ),
            )
            .await
        });

        let error = client.list_services().await.unwrap_err();

        assert!(matches!(error, DaemonClientError::IdentityUnverified));
        let request = replacement_server.await.unwrap();
        assert!(request.contains("GET /api/health"));
        assert!(!request.to_ascii_lowercase().contains("authorization:"));
        assert!(!request.contains(&"ab".repeat(32)));
        let _ = tokio::fs::remove_dir_all(paths.state_dir).await;
    }

    #[tokio::test]
    async fn stale_client_rejects_a_new_daemon_owner() {
        let initial = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = initial.local_addr().unwrap().port();
        let paths = runtime_paths("new-daemon-owner", port);
        write_runtime(&paths, port, "initial-owner", true).await;
        let initial_server = tokio::spawn(async move {
            respond_once(
                &initial,
                &format!(
                    r#"{{"ok":true,"app":"nomoreide","pid":{},"ownerId":"initial-owner"}}"#,
                    std::process::id()
                ),
            )
            .await
        });
        let client = DaemonClient::connect(DaemonEndpoint::localhost(port), &paths)
            .await
            .unwrap();
        initial_server.await.unwrap();

        write_runtime(&paths, port, "new-owner", true).await;
        tokio::fs::write(&paths.credential, "cd".repeat(32))
            .await
            .unwrap();
        let replacement = TcpListener::bind(("127.0.0.1", port)).await.unwrap();
        let replacement_contacted = tokio::spawn(async move {
            timeout(
                std::time::Duration::from_secs(1),
                respond_once(
                    &replacement,
                    &format!(
                        r#"{{"ok":true,"app":"nomoreide","pid":{},"ownerId":"new-owner"}}"#,
                        std::process::id()
                    ),
                ),
            )
            .await
            .is_ok()
        });

        let error = client.list_services().await.unwrap_err();

        assert!(matches!(error, DaemonClientError::IdentityUnverified));
        assert!(!replacement_contacted.await.unwrap());
        let _ = tokio::fs::remove_dir_all(paths.state_dir).await;
    }

    #[tokio::test]
    async fn daemon_http_client_ignores_environment_proxies() {
        if std::env::var_os(PROXY_CHILD).is_none() {
            let output = Command::new(std::env::current_exe().unwrap())
                .arg("daemon_http_client_ignores_environment_proxies")
                .arg("--nocapture")
                .env(PROXY_CHILD, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "proxy regression child failed:\nstdout:\n{}\nstderr:\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }

        let daemon = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = daemon.local_addr().unwrap().port();
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
        for key in ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] {
            std::env::set_var(key, &proxy_url);
        }
        for key in ["NO_PROXY", "no_proxy"] {
            std::env::remove_var(key);
        }

        let paths = runtime_paths("proxy-bypass", port);
        write_runtime(&paths, port, "recorded-owner", true).await;
        let daemon_server = tokio::spawn(async move {
            let health = format!(
                r#"{{"ok":true,"app":"nomoreide","pid":{},"ownerId":"recorded-owner"}}"#,
                std::process::id()
            );
            let first = respond_once(&daemon, &health).await;
            let second = respond_once(&daemon, &health).await;
            let third = respond_once(&daemon, r#"{"ok":true,"services":[],"bundles":[]}"#).await;
            (first, second, third)
        });
        let proxy_received = tokio::spawn(async move {
            timeout(std::time::Duration::from_secs(1), proxy.accept())
                .await
                .is_ok()
        });

        let client = DaemonClient::connect(DaemonEndpoint::localhost(port), &paths)
            .await
            .unwrap();
        assert_eq!(client.list_services().await.unwrap().services, Vec::new());
        let (health_request, repeated_health_request, service_request) =
            daemon_server.await.unwrap();
        assert!(health_request.contains("GET /api/health"));
        assert!(!health_request
            .to_ascii_lowercase()
            .contains("authorization:"));
        assert!(repeated_health_request.contains("GET /api/health"));
        assert!(!repeated_health_request
            .to_ascii_lowercase()
            .contains("authorization:"));
        assert!(service_request.contains("GET /api/services"));
        assert!(service_request
            .to_ascii_lowercase()
            .contains("authorization: bearer "));
        assert!(!proxy_received.await.unwrap());
        let _ = tokio::fs::remove_dir_all(paths.state_dir).await;
    }

    fn runtime_paths(label: &str, port: u16) -> RuntimePaths {
        RuntimePaths::new(std::env::temp_dir().join(format!(
            "nomoreide-daemon-client-{label}-{}-{port}",
            std::process::id()
        )))
    }

    async fn write_runtime(paths: &RuntimePaths, port: u16, owner_id: &str, credential: bool) {
        tokio::fs::create_dir_all(&paths.state_dir).await.unwrap();
        let state = DaemonState {
            pid: std::process::id(),
            owner_id: owner_id.into(),
            url: format!("http://127.0.0.1:{port}"),
            port,
            version: Some(env!("CARGO_PKG_VERSION").into()),
            started_at: "2026-08-20T00:00:00Z".into(),
        };
        tokio::fs::write(&paths.state, serde_json::to_vec(&state).unwrap())
            .await
            .unwrap();
        if credential {
            tokio::fs::write(&paths.credential, "ab".repeat(32))
                .await
                .unwrap();
        }
    }

    async fn respond_once(listener: &TcpListener, body: &str) -> String {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0u8; 4096];
        let read = stream.read(&mut request).await.unwrap();
        let request = String::from_utf8_lossy(&request[..read]).into_owned();
        stream
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        request
    }
}
