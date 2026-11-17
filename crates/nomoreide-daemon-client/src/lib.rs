//! Stateless discovery and protocol types for the machine-global NoMoreIDE daemon.

mod client;
mod lifecycle;
pub mod protocol;

pub use lifecycle::{
    ensure as ensure_daemon, stop as stop_daemon, EnsureStatus, EnsuredDaemon, LifecycleError,
    StopOutcome,
};

pub use client::{DaemonApiError, DaemonClient, DaemonClientError, ServiceAction};
/// Re-exported because the error types above carry one.
pub use reqwest::StatusCode;

use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use std::io;
use std::net::IpAddr;
use std::path::{Path, PathBuf};

pub const DEFAULT_DAEMON_PORT: u16 = 4317;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimePaths {
    pub state_dir: PathBuf,
    pub state: PathBuf,
    pub lock: PathBuf,
    pub credential: PathBuf,
}

impl RuntimePaths {
    pub fn new(state_dir: PathBuf) -> Self {
        Self {
            state: state_dir.join("daemon.json"),
            lock: state_dir.join("daemon.lock"),
            credential: state_dir.join("daemon.credential"),
            state_dir,
        }
    }
}

impl Default for RuntimePaths {
    fn default() -> Self {
        let state_dir = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".nomoreide");
        Self::new(state_dir)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonState {
    pub pid: u32,
    pub owner_id: String,
    pub url: String,
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub started_at: String,
}

impl DaemonState {
    pub fn endpoint(&self) -> io::Result<DaemonEndpoint> {
        let endpoint = DaemonEndpoint::parse(&self.url)?;
        if endpoint.port() != self.port {
            return Err(invalid_data("daemon URL and port do not match"));
        }
        Ok(endpoint)
    }

    pub fn validate(&self) -> io::Result<()> {
        if self.pid == 0
            || self.owner_id.trim().is_empty()
            || self.port == 0
            || self.started_at.trim().is_empty()
        {
            return Err(invalid_data("daemon state is incomplete"));
        }
        self.endpoint().map(|_| ())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonEndpoint(Url);

impl DaemonEndpoint {
    pub fn localhost(port: u16) -> Self {
        Self(Url::parse(&format!("http://127.0.0.1:{port}/")).expect("valid loopback URL"))
    }

    pub fn parse(value: &str) -> io::Result<Self> {
        let url = Url::parse(value).map_err(|_| invalid_data("daemon URL is invalid"))?;
        if url.scheme() != "http"
            || url.username() != ""
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid_data(
                "daemon URL must be unauthenticated loopback HTTP",
            ));
        }
        let loopback = match url.host_str() {
            Some("localhost") => true,
            Some(host) => host
                .trim_matches(['[', ']'])
                .parse::<IpAddr>()
                .is_ok_and(|ip| ip.is_loopback()),
            None => false,
        };
        if !loopback || url.port().is_none() {
            return Err(invalid_data(
                "daemon URL must use an explicit loopback port",
            ));
        }
        Ok(Self(url))
    }

    pub fn port(&self) -> u16 {
        self.0.port().expect("validated explicit port")
    }

    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }

    fn health_url(&self) -> Url {
        self.0.join("api/health").expect("validated base URL")
    }

    pub(crate) fn api_url(&self, path: &str) -> Url {
        self.0.join(path).expect("validated API path")
    }

    pub(crate) fn action_url(&self, collection: &str, name: &str, action: &str) -> Url {
        self.action_url_under(&["api", collection], name, action)
    }

    /// The same, for a collection that is more than one path segment deep.
    ///
    /// The segments are extended one at a time rather than joined, because
    /// `path_segments_mut` percent-encodes what it is given — a collection
    /// passed as `"terminal/sessions"` would arrive as `terminal%2Fsessions`
    /// and reach nothing. That encoding is exactly what `name` needs, though:
    /// a session id can hold a `#` or a space.
    pub(crate) fn action_url_under(&self, collection: &[&str], name: &str, action: &str) -> Url {
        let mut url = self.0.clone();
        {
            let mut segments = url
                .path_segments_mut()
                .expect("validated hierarchical daemon URL");
            segments.extend(collection);
            segments.push(name);
            segments.push(action);
        }
        url
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonHealth {
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub owner_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DaemonProbe {
    NoMoreIde(DaemonHealth),
    Foreign,
    Down,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscoveryStatus {
    Recorded,
    Adopted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredDaemon {
    pub status: DiscoveryStatus,
    pub endpoint: DaemonEndpoint,
    pub pid: u32,
    pub version_warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DaemonDiscovery {
    Running(DiscoveredDaemon),
    Foreign(DaemonEndpoint),
    Down(DaemonEndpoint),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthEnvelope {
    ok: bool,
    app: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    owner_id: Option<String>,
}

pub async fn probe_daemon(endpoint: &DaemonEndpoint, client: &Client) -> DaemonProbe {
    let response = match client.get(endpoint.health_url()).send().await {
        Ok(response) => response,
        Err(_) => return DaemonProbe::Down,
    };
    if !response.status().is_success() {
        return DaemonProbe::Foreign;
    }
    match response.json::<HealthEnvelope>().await {
        Ok(body) if body.ok && body.app == "nomoreide" => DaemonProbe::NoMoreIde(DaemonHealth {
            version: body.version,
            pid: body.pid,
            owner_id: body.owner_id,
        }),
        _ => DaemonProbe::Foreign,
    }
}

pub async fn read_daemon_state(path: &Path) -> io::Result<Option<DaemonState>> {
    let raw = match tokio::fs::read(path).await {
        Ok(raw) => raw,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let state = match serde_json::from_slice::<DaemonState>(&raw) {
        Ok(state) if state.validate().is_ok() => state,
        _ => return Ok(None),
    };
    Ok(Some(state))
}

pub async fn read_daemon_credential(paths: &RuntimePaths) -> io::Result<String> {
    let credential = tokio::fs::read_to_string(&paths.credential).await?;
    let credential = credential.trim();
    if credential.len() != 64 || !credential.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid_data("daemon credential is malformed"));
    }
    Ok(credential.to_ascii_lowercase())
}

pub async fn discover_daemon(
    paths: &RuntimePaths,
    configured_port: u16,
    client_version: &str,
    client: &Client,
) -> io::Result<DaemonDiscovery> {
    if let Some(state) = read_daemon_state(&paths.state).await? {
        if is_pid_alive(state.pid) {
            let endpoint = state.endpoint()?;
            if let DaemonProbe::NoMoreIde(health) = probe_daemon(&endpoint, client).await {
                if health.owner_id.as_deref() == Some(state.owner_id.as_str()) {
                    return Ok(DaemonDiscovery::Running(DiscoveredDaemon {
                        status: DiscoveryStatus::Recorded,
                        pid: health.pid.unwrap_or(state.pid),
                        version_warning: version_warning(client_version, &health),
                        endpoint,
                    }));
                }
            }
        }
    }

    let endpoint = DaemonEndpoint::localhost(configured_port);
    Ok(match probe_daemon(&endpoint, client).await {
        DaemonProbe::NoMoreIde(health) => DaemonDiscovery::Running(DiscoveredDaemon {
            status: DiscoveryStatus::Adopted,
            pid: health.pid.unwrap_or(0),
            version_warning: version_warning(client_version, &health),
            endpoint,
        }),
        DaemonProbe::Foreign => DaemonDiscovery::Foreign(endpoint),
        DaemonProbe::Down => DaemonDiscovery::Down(endpoint),
    })
}

pub fn resolve_daemon_port(value: Option<&str>) -> u16 {
    value
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(DEFAULT_DAEMON_PORT)
}

pub fn version_warning(client_version: &str, health: &DaemonHealth) -> Option<String> {
    let daemon_version = health.version.as_deref()?;
    if daemon_version == client_version {
        return None;
    }
    Some(format!(
        "NoMoreIDE daemon is v{daemon_version} but this client is v{client_version}. Run `nomoreide daemon restart` to update it (this stops the services it manages)."
    ))
}

pub fn is_pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid as i32, 0) };
        result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return false;
        }
        let mut code = 0;
        let ok = unsafe { GetExitCodeProcess(handle, &mut code) } != 0;
        unsafe { CloseHandle(handle) };
        ok && code == STILL_ACTIVE as u32
    }
}

fn invalid_data(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn endpoint_accepts_only_explicit_loopback_http() {
        for valid in [
            "http://127.0.0.1:4317",
            "http://localhost:4317",
            "http://[::1]:4317",
        ] {
            assert!(DaemonEndpoint::parse(valid).is_ok(), "{valid}");
        }
        for invalid in [
            "https://127.0.0.1:4317",
            "http://example.com:4317",
            "http://127.0.0.1",
            "http://user:pass@127.0.0.1:4317",
            "http://127.0.0.1:4317/unexpected",
            "http://127.0.0.1:4317/?token=secret",
        ] {
            assert!(DaemonEndpoint::parse(invalid).is_err(), "{invalid}");
        }
    }

    #[tokio::test]
    async fn invalid_or_non_loopback_state_is_ignored() {
        let path = std::env::temp_dir().join(format!("daemon-state-{}.json", std::process::id()));
        tokio::fs::write(
            &path,
            br#"{"pid":42,"url":"http://example.com:4317","port":4317,"startedAt":"now"}"#,
        )
        .await
        .unwrap();
        assert_eq!(read_daemon_state(&path).await.unwrap(), None);
        let _ = tokio::fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn credential_reader_accepts_only_the_private_token_shape() {
        let paths = RuntimePaths::new(
            std::env::temp_dir().join(format!("daemon-credential-{}", std::process::id())),
        );
        tokio::fs::create_dir_all(&paths.state_dir).await.unwrap();
        tokio::fs::write(&paths.credential, format!("{}\n", "aB".repeat(32)))
            .await
            .unwrap();
        assert_eq!(
            read_daemon_credential(&paths).await.unwrap(),
            "ab".repeat(32)
        );
        tokio::fs::write(&paths.credential, "short").await.unwrap();
        assert_eq!(
            read_daemon_credential(&paths).await.unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        let _ = tokio::fs::remove_dir_all(paths.state_dir).await;
    }

    #[test]
    fn port_and_version_negotiation_match_the_compatibility_contract() {
        assert_eq!(resolve_daemon_port(Some("9000")), 9000);
        assert_eq!(resolve_daemon_port(Some("0")), DEFAULT_DAEMON_PORT);
        assert_eq!(resolve_daemon_port(Some("invalid")), DEFAULT_DAEMON_PORT);
        let health = DaemonHealth {
            version: Some("0.0.1".into()),
            pid: Some(42),
            owner_id: None,
        };
        let warning = version_warning("0.1.103", &health).unwrap();
        assert!(warning.contains("0.0.1"));
        assert!(warning.contains("nomoreide daemon restart"));
    }

    #[tokio::test]
    async fn discovery_reuses_a_live_recorded_daemon_and_negotiates_version() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 1024];
            let read = stream.read(&mut request).await.unwrap();
            assert!(String::from_utf8_lossy(&request[..read]).contains("GET /api/health"));
            let body = format!(
                r#"{{"ok":true,"app":"nomoreide","version":"0.0.1","pid":{},"ownerId":"test-owner"}}"#,
                std::process::id()
            );
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
        });

        let paths = RuntimePaths::new(
            std::env::temp_dir().join(format!("daemon-discovery-{}-{port}", std::process::id())),
        );
        tokio::fs::create_dir_all(&paths.state_dir).await.unwrap();
        let state = DaemonState {
            pid: std::process::id(),
            owner_id: "test-owner".into(),
            url: format!("http://127.0.0.1:{port}"),
            port,
            version: Some("0.0.1".into()),
            started_at: "2026-08-20T00:00:00Z".into(),
        };
        tokio::fs::write(&paths.state, serde_json::to_vec(&state).unwrap())
            .await
            .unwrap();

        let discovered = discover_daemon(&paths, DEFAULT_DAEMON_PORT, "0.1.103", &Client::new())
            .await
            .unwrap();

        let DaemonDiscovery::Running(discovered) = discovered else {
            panic!("expected recorded daemon");
        };
        assert_eq!(discovered.status, DiscoveryStatus::Recorded);
        assert_eq!(discovered.pid, std::process::id());
        assert!(discovered.version_warning.unwrap().contains("0.0.1"));
        server.await.unwrap();
        let _ = tokio::fs::remove_dir_all(paths.state_dir).await;
    }
}
