use nomoreide_daemon_client::{DaemonClient, RuntimePaths, DEFAULT_DAEMON_PORT};
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
    fn execute<'a>(&'a self, name: &'a str, _arguments: &'a Map<String, Value>) -> ToolFuture<'a> {
        Box::pin(async move {
            if name != "nomoreide_list_services" {
                return Err(format!("Tool '{name}' is not implemented."));
            }
            let client = DaemonClient::discover(&self.paths, self.port, env!("CARGO_PKG_VERSION"))
                .await
                .map_err(|error| error.to_string())?;
            let discovery = client
                .list_services()
                .await
                .map_err(|error| error.to_string())?;
            serde_json::to_string_pretty(&discovery).map_err(|error| error.to_string())
        })
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
