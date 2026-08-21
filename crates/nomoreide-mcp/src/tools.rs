use nomoreide_daemon_client::protocol::{ServiceRuntimeState, ServiceRuntimeStatus};
use nomoreide_daemon_client::{DaemonClient, DaemonClientError, RuntimePaths, DEFAULT_DAEMON_PORT};
use serde::Serialize;
use serde_json::Map;
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;

pub(crate) type ToolFuture<'a> = Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>>;

pub(crate) trait ToolExecutor: Send + Sync {
    fn execute<'a>(&'a self, name: &'a str, arguments: &'a Map<String, Value>) -> ToolFuture<'a>;
}

pub(crate) struct NativeToolExecutor {
    paths: RuntimePaths,
    port: u16,
}

impl Default for NativeToolExecutor {
    fn default() -> Self {
        Self {
            paths: RuntimePaths::default(),
            port: std::env::var("NOMOREIDE_DAEMON_PORT")
                .ok()
                .and_then(|value| value.parse().ok())
                .filter(|port| *port > 0)
                .unwrap_or(DEFAULT_DAEMON_PORT),
        }
    }
}

impl ToolExecutor for NativeToolExecutor {
    fn execute<'a>(&'a self, name: &'a str, arguments: &'a Map<String, Value>) -> ToolFuture<'a> {
        Box::pin(async move {
            let tool = NativeTool::parse(name, arguments)?;
            let client = DaemonClient::discover(&self.paths, self.port, env!("CARGO_PKG_VERSION"))
                .await
                .map_err(|error| error.to_string())?;
            match tool {
                NativeTool::ListServices => {
                    let discovery = client.list_services().await.map_err(daemon_message)?;
                    render(&discovery)
                }
                NativeTool::StartService(service) => {
                    let status = client
                        .start_service(service)
                        .await
                        .map_err(daemon_message)?;
                    render(&ServiceStatusView::of(&status))
                }
                NativeTool::StopService(service) => {
                    let status = client.stop_service(service).await.map_err(daemon_message)?;
                    render(&ServiceStatusView::of(&status))
                }
                NativeTool::RestartService(service) => {
                    let status = client
                        .restart_service(service)
                        .await
                        .map_err(daemon_message)?;
                    render(&ServiceStatusView::of(&status))
                }
                NativeTool::StartBundle(bundle) => {
                    let statuses = client.start_bundle(bundle).await.map_err(daemon_message)?;
                    render(&status_views(&statuses))
                }
                NativeTool::StopBundle(bundle) => {
                    let statuses = client.stop_bundle(bundle).await.map_err(daemon_message)?;
                    render(&status_views(&statuses))
                }
            }
        })
    }
}

/// A tool this runtime serves itself, with its arguments already read. The
/// protocol layer enforces each tool's argument contract before execution;
/// re-reading it here keeps this boundary self-contained.
enum NativeTool<'a> {
    ListServices,
    StartService(&'a str),
    StopService(&'a str),
    RestartService(&'a str),
    StartBundle(&'a str),
    StopBundle(&'a str),
}

impl<'a> NativeTool<'a> {
    fn parse(name: &str, arguments: &'a Map<String, Value>) -> Result<Self, String> {
        match name {
            "nomoreide_list_services" => Ok(Self::ListServices),
            "nomoreide_start_service" => Ok(Self::StartService(service_name(arguments)?)),
            "nomoreide_stop_service" => Ok(Self::StopService(service_name(arguments)?)),
            "nomoreide_restart_service" => Ok(Self::RestartService(service_name(arguments)?)),
            "nomoreide_start_bundle" => Ok(Self::StartBundle(bundle_name(arguments)?)),
            "nomoreide_stop_bundle" => Ok(Self::StopBundle(bundle_name(arguments)?)),
            _ => Err(format!("Tool '{name}' is not implemented.")),
        }
    }
}

fn service_name(arguments: &Map<String, Value>) -> Result<&str, String> {
    required_name(arguments, "service")
}

fn bundle_name(arguments: &Map<String, Value>) -> Result<&str, String> {
    required_name(arguments, "bundle")
}

fn required_name<'a>(arguments: &'a Map<String, Value>, kind: &str) -> Result<&'a str, String> {
    arguments
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| format!("Registered {kind} name is required."))
}

/// The reference returns a bundle's statuses as a plain array, in the order the
/// services were acted on.
fn status_views(statuses: &[ServiceRuntimeStatus]) -> Vec<ServiceStatusView<'_>> {
    statuses.iter().map(ServiceStatusView::of).collect()
}

fn render<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string_pretty(value).map_err(|error| error.to_string())
}

/// Agents read the daemon's own explanation — "Service is not registered.", a
/// port conflict, a draining daemon — rather than this client's transport
/// wrapper around it.
fn daemon_message(error: DaemonClientError) -> String {
    match error {
        DaemonClientError::Mutation(failure) => failure.message,
        other => other.to_string(),
    }
}

/// The status shape the reference implementation returns for these tools. The
/// process-group id the daemon tracks is an ownership detail agents have no use
/// for, so it stays inside the daemon boundary.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceStatusView<'a> {
    name: &'a str,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
}

impl<'a> ServiceStatusView<'a> {
    fn of(status: &'a ServiceRuntimeStatus) -> Self {
        Self {
            name: &status.name,
            state: match status.state {
                ServiceRuntimeState::Stopped => "stopped",
                ServiceRuntimeState::Starting => "starting",
                ServiceRuntimeState::Running => "running",
                // The reference runtime has no distinct stopping state.
                ServiceRuntimeState::Stopping => "stopped",
                ServiceRuntimeState::Exited => "exited",
            },
            pid: status.pid,
            url: status.url.as_deref(),
            exit_code: status.exit_code,
        }
    }
}

#[cfg(test)]
pub(crate) struct StaticToolExecutor {
    pub result: Result<String, String>,
}

#[cfg(test)]
impl ToolExecutor for StaticToolExecutor {
    fn execute<'a>(&'a self, _name: &'a str, _arguments: &'a Map<String, Value>) -> ToolFuture<'a> {
        Box::pin(async move { self.result.clone() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nomoreide_daemon_client::protocol::DaemonErrorCode;
    use nomoreide_daemon_client::{DaemonApiError, StatusCode};

    fn status(state: ServiceRuntimeState) -> ServiceRuntimeStatus {
        ServiceRuntimeStatus {
            name: "api".into(),
            state,
            pid: Some(4321),
            pgid: Some(4321),
            exit_code: None,
            url: Some("http://localhost:3000".into()),
        }
    }

    #[test]
    fn status_text_matches_the_reference_field_set_and_order() {
        let rendered = render(&ServiceStatusView::of(&status(
            ServiceRuntimeState::Running,
        )))
        .unwrap();
        assert_eq!(
            rendered,
            "{\n  \"name\": \"api\",\n  \"state\": \"running\",\n  \"pid\": 4321,\n  \"url\": \"http://localhost:3000\"\n}"
        );
        assert!(!rendered.contains("pgid"));
    }

    #[test]
    fn a_stopped_service_reports_only_what_the_reference_reports() {
        let stopped = ServiceRuntimeStatus {
            pid: None,
            pgid: None,
            exit_code: Some(0),
            url: None,
            ..status(ServiceRuntimeState::Stopped)
        };
        assert_eq!(
            render(&ServiceStatusView::of(&stopped)).unwrap(),
            "{\n  \"name\": \"api\",\n  \"state\": \"stopped\",\n  \"exitCode\": 0\n}"
        );
        // The reference has no distinct stopping state to report.
        assert_eq!(
            ServiceStatusView::of(&status(ServiceRuntimeState::Stopping)).state,
            "stopped"
        );
    }

    #[test]
    fn mutations_need_a_service_name_and_report_the_daemon_explanation() {
        let mut arguments = Map::new();
        assert!(NativeTool::parse("nomoreide_start_service", &arguments).is_err());
        arguments.insert("name".into(), Value::String(String::new()));
        assert!(NativeTool::parse("nomoreide_stop_service", &arguments).is_err());
        assert!(NativeTool::parse("nomoreide_restart_service", &arguments).is_err());
        assert!(NativeTool::parse("nomoreide_start_bundle", &arguments).is_err());
        arguments.insert("name".into(), Value::String("api".into()));
        assert!(matches!(
            NativeTool::parse("nomoreide_stop_service", &arguments),
            Ok(NativeTool::StopService("api"))
        ));
        assert!(matches!(
            NativeTool::parse("nomoreide_restart_service", &arguments),
            Ok(NativeTool::RestartService("api"))
        ));
        assert!(matches!(
            NativeTool::parse("nomoreide_start_bundle", &arguments),
            Ok(NativeTool::StartBundle("api"))
        ));
        assert!(matches!(
            NativeTool::parse("nomoreide_stop_bundle", &arguments),
            Ok(NativeTool::StopBundle("api"))
        ));
        assert!(NativeTool::parse("nomoreide_status", &arguments).is_err());

        assert_eq!(
            daemon_message(DaemonClientError::Mutation(Box::new(DaemonApiError {
                status: StatusCode::CONFLICT,
                code: DaemonErrorCode::PortInUse,
                message: "Port 3000 is already in use for api".into(),
                conflict: None,
            }))),
            "Port 3000 is already in use for api"
        );
    }
}
