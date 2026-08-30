//! The two tools an agent reaches for when a service is misbehaving.
//!
//! `nomoreide_service_context` returns one service's debugging packet as prose;
//! `nomoreide_service_health` returns the verdict behind that packet as JSON,
//! for one service or for every registered one.
//!
//! Both read the service *definition* from local config and everything else
//! from the daemon, exactly as the reference does. That split matters: the
//! definition is what the user registered and is readable without a daemon,
//! while the runtime reading only exists where the processes do.

use super::{daemon_message, render, state_label};
use nomoreide_core::agent_context::{LogLine, RuntimeSnapshot, ServiceSnapshot, TimelineLine};
use nomoreide_core::config::{Config, ServiceDef};
use nomoreide_core::service_health::{
    compute_service_health, HealthInput, HealthStatus, ServiceHealth,
};
use nomoreide_daemon_client::protocol::{
    ServiceLogEntry, ServiceRuntimeStatus, TimelineEvent, TimelineSeverity,
};
use nomoreide_daemon_client::DaemonClient;
use serde::Serialize;
use serde_json::Value;

/// The reference quotes the newest 80 lines and reads 200 timeline events
/// before narrowing them to the service in question.
const LOG_BUDGET: u32 = 80;
const TIMELINE_READ_SIZE: u32 = 200;

pub(super) async fn service_context(
    client: &DaemonClient,
    config: &Config,
    name: &str,
) -> Result<String, String> {
    let definition = require_service(config, name)?;
    let reading = Reading::of(client, std::slice::from_ref(definition)).await?;
    Ok(reading.health(definition).agent_context)
}

pub(super) async fn service_health(
    client: &DaemonClient,
    config: &Config,
    service: Option<&str>,
) -> Result<String, String> {
    // A named service must exist; asking about every service when none are
    // registered is an empty answer rather than a failure.
    let definitions = match service {
        Some(name) => std::slice::from_ref(require_service(config, name)?),
        None => config.services.as_slice(),
    };
    let reading = Reading::of(client, definitions).await?;
    let verdicts = definitions
        .iter()
        .map(|definition| {
            let health = reading.health(definition);
            (definition, health)
        })
        .collect::<Vec<_>>();
    let views = verdicts
        .iter()
        .map(|(definition, health)| {
            ServiceHealthView::of(&definition.name, health, reading.logs(&definition.name))
        })
        .collect::<Vec<_>>();
    // One name asks about one service, so it reads back as one object; the
    // unnamed form is a list even when the list holds a single service.
    match service {
        Some(_) => render(&views[0]),
        None => render(&views),
    }
}

fn require_service<'a>(config: &'a Config, name: &str) -> Result<&'a ServiceDef, String> {
    config
        .services
        .iter()
        .find(|service| service.name == name)
        .ok_or_else(|| format!("Service \"{name}\" is not registered."))
}

/// Everything the daemon can say about the services under examination, read
/// once. Status and the timeline are whole-runtime reads, so asking about ten
/// services costs one of each plus one log read per service — the same traffic
/// the reference generates.
struct Reading {
    statuses: Vec<ServiceRuntimeStatus>,
    timeline: Vec<TimelineEvent>,
    logs: Vec<(String, Vec<ServiceLogEntry>)>,
}

impl Reading {
    async fn of(client: &DaemonClient, definitions: &[ServiceDef]) -> Result<Self, String> {
        let statuses = client.status().await.map_err(daemon_message)?;
        let timeline = client
            .timeline(TIMELINE_READ_SIZE)
            .await
            .map_err(daemon_message)?;
        let mut logs = Vec::with_capacity(definitions.len());
        for definition in definitions {
            logs.push((
                definition.name.clone(),
                client
                    .logs(&definition.name, LOG_BUDGET)
                    .await
                    .map_err(daemon_message)?,
            ));
        }
        Ok(Self {
            statuses,
            timeline,
            logs,
        })
    }

    fn logs(&self, name: &str) -> &[ServiceLogEntry] {
        self.logs
            .iter()
            .find(|(service, _)| service == name)
            .map_or(&[], |(_, logs)| logs.as_slice())
    }

    fn health(&self, definition: &ServiceDef) -> ServiceHealth {
        let status = self
            .statuses
            .iter()
            .find(|status| status.name == definition.name);
        let logs = self
            .logs(&definition.name)
            .iter()
            .map(log_line)
            .collect::<Vec<_>>();
        let timeline = self
            .timeline
            .iter()
            .filter(|event| event.service.as_deref() == Some(definition.name.as_str()))
            .map(timeline_line)
            .collect::<Vec<_>>();
        compute_service_health(&HealthInput {
            service: ServiceSnapshot {
                name: &definition.name,
                command: definition.command.as_deref(),
                cwd: definition.cwd.as_deref(),
                port: definition.port,
            },
            status: status.map(runtime_snapshot),
            logs: &logs,
            timeline: &timeline,
        })
    }
}

fn log_line(entry: &ServiceLogEntry) -> LogLine<'_> {
    LogLine {
        stream: &entry.stream,
        text: &entry.text,
        timestamp: &entry.timestamp,
    }
}

fn timeline_line(event: &TimelineEvent) -> TimelineLine<'_> {
    TimelineLine {
        timestamp: &event.timestamp,
        severity: match event.severity {
            TimelineSeverity::Info => "info",
            TimelineSeverity::Warning => "warning",
            TimelineSeverity::Error => "error",
        },
        title: &event.title,
        detail: event.detail.as_deref(),
    }
}

fn runtime_snapshot(status: &ServiceRuntimeStatus) -> RuntimeSnapshot<'_> {
    RuntimeSnapshot {
        state: state_label(status.state),
        pid: status.pid,
        url: status.url.as_deref(),
        // Health only asks whether the run ended badly, so the presence
        // distinction the wire carries is flattened away here on purpose.
        exit_code: status.exit_code.flatten(),
        started_at: status.started_at.as_deref(),
    }
}

/// The reference's `ServiceHealth`.
///
/// `checks` and `ports` are always empty: this tool runs no discrete health
/// check and hands the computation an empty port list, so neither can ever have
/// a member. They stay in the shape because a client reads the fields it was
/// promised. `processTree` is absent for a different reason — no native runtime
/// samples one — so the field never appears at all.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceHealthView<'a> {
    service: &'a str,
    status: HealthStatus,
    summary: &'a str,
    checked_at: String,
    checks: [Value; 0],
    ports: [Value; 0],
    #[serde(skip_serializing_if = "Option::is_none")]
    last_error_log: Option<&'a ServiceLogEntry>,
    agent_context: &'a str,
}

impl<'a> ServiceHealthView<'a> {
    fn of(service: &'a str, health: &'a ServiceHealth, logs: &'a [ServiceLogEntry]) -> Self {
        Self {
            service,
            status: health.status,
            summary: &health.summary,
            checked_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            checks: [],
            ports: [],
            last_error_log: health.last_error_log.map(|index| &logs[index]),
            agent_context: &health.agent_context,
        }
    }
}
