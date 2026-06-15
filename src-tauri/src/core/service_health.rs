use serde::{Deserialize, Serialize};
use super::log_store::LogEntry;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum HealthStatus {
    Unknown,
    Starting,
    Healthy,
    Warning,
    Unhealthy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceHealth {
    pub status: HealthStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub rss_mb: Option<f64>,
    pub cpu_pct: Option<f64>,
}

pub fn compute_health(
    running: bool,
    exit_code: Option<i32>,
    rss_mb: Option<f64>,
    recent_logs: &[LogEntry],
) -> ServiceHealth {
    if !running {
        let status = match exit_code {
            Some(0) | None => HealthStatus::Unknown,
            Some(_) => HealthStatus::Unhealthy,
        };
        return ServiceHealth { status, last_error: None, rss_mb, cpu_pct: None };
    }

    let last_error = recent_logs.iter().rev()
        .find(|e| e.severity.as_deref() == Some("error"))
        .map(|e| e.text.clone());

    let high_memory = rss_mb.map_or(false, |m| m >= 1000.0);
    let has_error = last_error.is_some();

    let status = if high_memory || has_error {
        HealthStatus::Warning
    } else {
        HealthStatus::Healthy
    };

    ServiceHealth { status, last_error, rss_mb, cpu_pct: None }
}
