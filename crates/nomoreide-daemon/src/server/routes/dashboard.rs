//! The overview page's one request, and the all-projects lens beside it.
//!
//! `/api/dashboard` is the widest answer the daemon gives: config, runtime,
//! ports, health, timeline, logs and the selected repository's git state, in
//! one response. It is one request rather than seven because the page needs all
//! of it at once and a browser only gives a host six sockets — but also because
//! these readings have to agree with each other. Ports are computed from the
//! same runtime snapshot the health verdicts are, so a service cannot be
//! "running" in one field and its port "available" in another.
//!
//! Almost every part is built by a module that is already ported. What lives
//! here is the *assembly*, which is where a field goes missing or arrives under
//! a different name without any single module being wrong.

use crate::server::app::AppState;
use crate::server::errors::{error, method_not_allowed};
use crate::server::routes::daemon_cwd;
use axum::extract::State;
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use nomoreide_core::agent_context::{
    build_service_agent_context, AgentContextInput, LogLine, RuntimeSnapshot, ServiceSnapshot,
    TimelineLine,
};
use nomoreide_core::config::{
    is_git_worktree, selected_git_cwd, selected_git_repository, Config, ConfigStore, GitRepoDef,
};
use nomoreide_core::git_manager::GitManager;
use nomoreide_core::port_utils::get_port_binding_status;
use nomoreide_core::project_overview::{build_project_overview, OVERVIEW_DOMAINS};
use nomoreide_core::service_health::{compute_service_health, HealthInput};
use nomoreide_daemon_client::protocol::{ServiceLogEntry, ServiceRuntimeStatus};
use serde_json::{json, Map, Value};

/// The tail read per service, and the slice of it the payload carries.
const LOG_TAIL: usize = 80;
const PAYLOAD_TAIL: usize = 40;
const TIMELINE_LIMIT: usize = 120;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/dashboard", get(dashboard))
        .route("/api/overview/:domain", get(overview).fallback(method_not_allowed))
}

// --- the all-projects lens ---------------------------------------------------

/// The domain is read from the raw path rather than from a decoded parameter.
///
/// The reference matches it with a regular expression and reports whatever
/// matched, so an escaped domain comes back escaped — `git%20` names itself in
/// the error. Decoding first would report a domain nobody asked for.
async fn overview(State(state): State<AppState>, uri: Uri) -> Response {
    let domain = uri
        .path()
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_string();
    if !OVERVIEW_DOMAINS.contains(&domain.as_str()) {
        return error(
            StatusCode::NOT_FOUND,
            &format!("Unknown overview domain: {domain}"),
        );
    }
    // A per-project failure rides on that project's row, so this only fails
    // when the config itself could not be read.
    match build_project_overview(&state.config_store, &domain).await {
        Ok(projects) => Json(json!({ "ok": true, "projects": projects })).into_response(),
        Err(reason) => error(StatusCode::INTERNAL_SERVER_ERROR, &reason),
    }
}

// --- the dashboard -----------------------------------------------------------

async fn dashboard(State(state): State<AppState>) -> Response {
    let cwd = daemon_cwd();
    let Ok(mut config) = state.config_store.load().await else {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to read the configuration",
        );
    };
    config = adopt_working_directory(&state.config_store, config, &cwd).await;

    let selected = selected_git_repository(&config).cloned();
    let git_cwd = match &selected {
        Some(repository) => selected_git_cwd(&config, &repository.path).await,
        None => String::new(),
    };

    let runtime = state.runtime.status();
    let ports = build_port_overview(&config, &runtime);
    let timeline = state.runtime.timeline(TIMELINE_LIMIT);
    let timeline_value = serde_json::to_value(&timeline).unwrap_or(Value::Array(Vec::new()));
    let service_logs: Vec<(String, Vec<ServiceLogEntry>)> = config
        .services
        .iter()
        .map(|service| {
            (
                service.name.clone(),
                state.runtime.logs(&service.name, LOG_TAIL),
            )
        })
        .collect();

    let health = build_health(&config, &ports, &runtime, &service_logs, &timeline_value);
    let git = build_git(selected.as_ref(), &git_cwd).await;

    let mut runtime_services = Map::new();
    for status in &runtime {
        runtime_services.insert(
            status.name.clone(),
            serde_json::to_value(status).unwrap_or(Value::Null),
        );
    }

    Json(json!({
        "ok": true,
        "cwd": cwd,
        "config": config.public_value(),
        "runtime": { "services": Value::Object(runtime_services) },
        "ports": ports,
        "health": health,
        "timeline": timeline_value,
        "logs": merge_service_logs(&service_logs),
        "git": git,
    }))
    .into_response()
}

/// Adopt the working directory when nothing is registered yet.
///
/// Only when the list is *empty*: a user who has registered repositories and
/// deselected them has said something, and adopting on top of that would keep
/// undoing it. A directory that is not a worktree is left alone so the page can
/// show its empty state rather than pointing at a folder that is not a project.
async fn adopt_working_directory(store: &ConfigStore, config: Config, cwd: &str) -> Config {
    if selected_git_repository(&config).is_some() || !config.git_repositories.is_empty() {
        return config;
    }
    if !is_git_worktree(cwd).await {
        return config;
    }
    let name = std::path::Path::new(cwd)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "repo".to_string());
    store
        .register_git_repository(GitRepoDef {
            name,
            path: cwd.to_string(),
            active_worktree_path: None,
            github_credential: None,
            provider_projects: None,
            legacy_vercel_project_id: None,
        })
        .await
        // A registration that fails leaves the empty state, which is the same
        // thing the caller would have shown anyway.
        .unwrap_or(config)
}

// --- ports -------------------------------------------------------------------

/// Every port a service claims, and what is actually listening on it.
///
/// A port is `managed` when one of its services is running and that service's
/// own runtime url — or, when it has none, its configured port — is this one.
/// The distinction matters: `occupied` means something else took the port, and
/// telling a user that when it is their own service is how a stop button gets
/// pressed on the wrong thing.
fn build_port_overview(config: &Config, runtime: &[ServiceRuntimeStatus]) -> Value {
    let mut claims: Vec<(u16, Vec<String>, Vec<String>)> = Vec::new();
    let entry = |claims: &mut Vec<(u16, Vec<String>, Vec<String>)>, port: u16| -> usize {
        match claims.iter().position(|(existing, ..)| *existing == port) {
            Some(index) => index,
            None => {
                claims.push((port, Vec::new(), Vec::new()));
                claims.len() - 1
            }
        }
    };

    for service in &config.services {
        if let Some(port) = service.port {
            let index = entry(&mut claims, port);
            if !claims[index].1.contains(&service.name) {
                claims[index].1.push(service.name.clone());
            }
        }
    }
    for status in runtime {
        let Some(url) = status.url.as_deref() else {
            continue;
        };
        let Some(port) = port_from_url(url) else {
            continue;
        };
        let index = entry(&mut claims, port);
        if !claims[index].1.contains(&status.name) {
            claims[index].1.push(status.name.clone());
        }
        if !claims[index].2.contains(&url.to_string()) {
            claims[index].2.push(url.to_string());
        }
    }
    claims.sort_by_key(|(port, ..)| *port);

    let mut overview = Vec::new();
    for (port, services, urls) in claims {
        let binding = get_port_binding_status(port);
        let managed = services.iter().any(|name| {
            let Some(status) = runtime.iter().find(|status| &status.name == name) else {
                return false;
            };
            if serde_json::to_value(status.state).ok().and_then(|s| s.as_str().map(str::to_string))
                != Some("running".to_string())
            {
                return false;
            }
            match status.url.as_deref().and_then(port_from_url) {
                Some(url_port) => url_port == port,
                None => config
                    .services
                    .iter()
                    .any(|service| &service.name == name && service.port == Some(port)),
            }
        });

        let mut sorted_services = services;
        sorted_services.sort();
        let mut sorted_urls = urls;
        sorted_urls.sort();

        overview.push(json!({
            "port": port,
            "available": binding.available,
            "hosts": binding
                .bindings
                .iter()
                .map(|binding| json!({ "host": binding.host, "available": !binding.bound }))
                .collect::<Vec<_>>(),
            "state": if managed {
                "managed"
            } else if binding.available {
                "available"
            } else {
                "occupied"
            },
            "services": sorted_services,
            "urls": sorted_urls,
        }));
    }
    Value::Array(overview)
}

/// The *explicit* port in a url, which is what `new URL(...).port` reports —
/// empty for a default port, so `http://host/` claims nothing.
fn port_from_url(url: &str) -> Option<u16> {
    let authority = url.split_once("://")?.1;
    let authority = authority
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        // Credentials come before the host and may hold a colon of their own.
        .rsplit('@')
        .next()
        .unwrap_or_default();
    // An IPv6 literal is bracketed, so only a colon after the bracket is a port.
    let tail = match authority.rsplit_once(']') {
        Some((_, tail)) => tail,
        None => authority,
    };
    let port = tail.rsplit_once(':')?.1;
    if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    port.parse().ok()
}

// --- health ------------------------------------------------------------------

/// One verdict per registered service, each carrying the ports it claims and a
/// prose packet an agent can be handed as-is.
fn build_health(
    config: &Config,
    ports: &Value,
    runtime: &[ServiceRuntimeStatus],
    service_logs: &[(String, Vec<ServiceLogEntry>)],
    timeline: &Value,
) -> Value {
    let checked_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let empty = Vec::new();
    let mut health = Map::new();

    for service in &config.services {
        let status = runtime.iter().find(|status| status.name == service.name);
        let logs = service_logs
            .iter()
            .find(|(name, _)| name == &service.name)
            .map(|(_, lines)| lines)
            .unwrap_or(&empty);
        let log_lines: Vec<LogLine<'_>> = logs
            .iter()
            .map(|line| LogLine {
                stream: &line.stream,
                text: &line.text,
                timestamp: &line.timestamp,
            })
            .collect();

        let service_timeline = timeline_for(timeline, &service.name);
        let timeline_lines: Vec<TimelineLine<'_>> = service_timeline
            .iter()
            .map(|event| TimelineLine {
                timestamp: event.0.as_str(),
                severity: event.1.as_str(),
                title: event.2.as_str(),
                detail: event.3.as_deref(),
            })
            .collect();

        let state_text = status
            .and_then(|status| serde_json::to_value(status.state).ok())
            .and_then(|value| value.as_str().map(str::to_string));
        let snapshot = ServiceSnapshot {
            name: &service.name,
            command: service.command.as_deref(),
            cwd: service.cwd.as_deref(),
            port: service.port,
        };
        let runtime_snapshot = status.map(|status| RuntimeSnapshot {
            state: state_text.as_deref().unwrap_or("unknown"),
            pid: status.pid,
            url: status.url.as_deref(),
            exit_code: status.exit_code,
            started_at: status.started_at.as_deref(),
        });

        let verdict = compute_service_health(&HealthInput {
            service: ServiceSnapshot { ..snapshot },
            status: runtime_snapshot.as_ref().map(|snapshot| RuntimeSnapshot {
                state: snapshot.state,
                pid: snapshot.pid,
                url: snapshot.url,
                exit_code: snapshot.exit_code,
                started_at: snapshot.started_at,
            }),
            logs: &log_lines,
            timeline: &timeline_lines,
        });
        let agent_context = build_service_agent_context(&AgentContextInput {
            service: ServiceSnapshot { ..snapshot },
            status: runtime_snapshot,
            health_summary: &verdict.summary,
            recent_logs: &log_lines,
            timeline: &timeline_lines,
        });

        let service_ports: Vec<Value> = ports
            .as_array()
            .map(|entries| {
                entries
                    .iter()
                    .filter(|entry| {
                        entry
                            .get("services")
                            .and_then(Value::as_array)
                            .is_some_and(|names| {
                                names.iter().any(|name| name.as_str() == Some(&service.name))
                            })
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();

        let mut row = Map::new();
        row.insert("service".into(), Value::String(service.name.clone()));
        row.insert(
            "status".into(),
            serde_json::to_value(verdict.status).unwrap_or(Value::Null),
        );
        row.insert("summary".into(), Value::String(verdict.summary.clone()));
        row.insert("checkedAt".into(), Value::String(checked_at.clone()));
        row.insert("checks".into(), Value::Array(Vec::new()));
        if let Some(index) = verdict.last_error_log {
            if let Some(line) = logs.get(index) {
                row.insert(
                    "lastErrorLog".into(),
                    serde_json::to_value(line).unwrap_or(Value::Null),
                );
            }
        }
        row.insert("ports".into(), Value::Array(service_ports));
        row.insert("agentContext".into(), Value::String(agent_context));
        health.insert(service.name.clone(), Value::Object(row));
    }
    Value::Object(health)
}

/// The timeline entries naming one service, flattened into the four strings the
/// context packet quotes.
fn timeline_for(timeline: &Value, service: &str) -> Vec<(String, String, String, Option<String>)> {
    timeline
        .as_array()
        .map(|events| {
            events
                .iter()
                .filter(|event| event.get("service").and_then(Value::as_str) == Some(service))
                .map(|event| {
                    let text = |key: &str| {
                        event
                            .get(key)
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string()
                    };
                    (
                        text("timestamp"),
                        text("severity"),
                        text("title"),
                        event
                            .get("detail")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

// --- logs and git ------------------------------------------------------------

/// Every service's tail in one chronological list.
///
/// Timestamps compare as strings because the log store writes them all the same
/// width in UTC, so lexical order is chronological order. The sort is stable,
/// so one service's lines keep their relative order when a burst shares a
/// millisecond.
fn merge_service_logs(service_logs: &[(String, Vec<ServiceLogEntry>)]) -> Value {
    let mut merged: Vec<&ServiceLogEntry> = Vec::new();
    for (_, lines) in service_logs {
        let start = lines.len().saturating_sub(PAYLOAD_TAIL);
        merged.extend(lines[start..].iter());
    }
    merged.sort_by(|left, right| left.timestamp.cmp(&right.timestamp));
    Value::Array(
        merged
            .into_iter()
            .map(|line| serde_json::to_value(line).unwrap_or(Value::Null))
            .collect(),
    )
}

async fn build_git(selected: Option<&GitRepoDef>, git_cwd: &str) -> Value {
    let status = if git_cwd.is_empty() {
        None
    } else {
        GitManager::status(git_cwd).await.ok()
    };
    let branches = if git_cwd.is_empty() {
        Vec::new()
    } else {
        GitManager::branches(git_cwd).await.unwrap_or_default()
    };

    let mut git = Map::new();
    git.insert("cwd".into(), Value::String(git_cwd.to_string()));
    git.insert(
        "selectedRepository".into(),
        selected
            .map(|repository| serde_json::to_value(repository).unwrap_or(Value::Null))
            .unwrap_or(Value::Null),
    );
    git.insert(
        "status".into(),
        status
            .as_ref()
            .map(|status| serde_json::to_value(status).unwrap_or(Value::Null))
            .unwrap_or(Value::Null),
    );
    git.insert(
        "branches".into(),
        serde_json::to_value(&branches).unwrap_or(Value::Array(Vec::new())),
    );
    // Only when a directory was chosen and could not be read: no repository at
    // all is an empty state, not an error.
    if !git_cwd.is_empty() && status.is_none() {
        git.insert(
            "error".into(),
            Value::String(format!("Not a Git repository: {git_cwd}")),
        );
    }
    Value::Object(git)
}
