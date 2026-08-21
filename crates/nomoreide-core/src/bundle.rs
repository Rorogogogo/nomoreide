//! Bundle start/stop ordering (mirrors `startBundle`/`stopBundle` in
//! `src/core/process-manager.ts`).
//!
//! A bundle names services to run together. Starting one has to bring
//! dependencies up before their dependents, and stopping one has to take them
//! down in the opposite order. Both the daemon and the desktop app need that
//! sequencing, so it lives here rather than in either runtime: the callers keep
//! their own policy (which services they will admit, how failures are reported)
//! and share only the ordering and the readiness probe.

use crate::config::{Config, ServiceDef};
use crate::port_utils;
use crate::process_manager::{ProcessManager, ServiceState};
use crate::service_graph;
use std::collections::HashSet;
use std::time::Duration;

/// How long a dependent waits for a dependency to bind its port before it
/// starts anyway.
pub const READY_TIMEOUT: Duration = Duration::from_secs(15);

const READY_POLL_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, PartialEq, Eq)]
pub enum BundleOrderError {
    /// No bundle by that name is registered.
    NotRegistered,
    /// The expanded set contains a dependency cycle, so no start order exists.
    DependencyCycle(String),
}

/// The order a bundle's services start in: dependencies first, expanded to
/// include transitive dependencies the bundle did not name itself. Members that
/// are not registered services are skipped, exactly as the reference skips
/// them — a bundle listing a stale name still starts everything else.
pub fn start_order(config: &Config, bundle: &str) -> Result<Vec<String>, BundleOrderError> {
    let members = members(config, bundle)?;
    service_graph::resolve_start_order(&config.services, &members)
        .map_err(BundleOrderError::DependencyCycle)
}

/// The order a bundle's services stop in: dependents before what they depend
/// on, scoped to the bundle's own members so a shared dependency pulled in by
/// `start_order` is not stopped out from under another bundle.
///
/// Unlike starting, this never fails on a cycle. A cycle means there is no
/// correct order, but refusing to stop would strand running processes, so the
/// bundle's declared order is used as-is.
pub fn stop_order(config: &Config, bundle: &str) -> Result<Vec<String>, BundleOrderError> {
    let members = members(config, bundle)?;
    let in_bundle: HashSet<&str> = members.iter().map(String::as_str).collect();
    let mut order = service_graph::resolve_start_order(&config.services, &members)
        .unwrap_or_else(|_| members.clone())
        .into_iter()
        .filter(|name| in_bundle.contains(name.as_str()))
        .collect::<Vec<_>>();
    order.reverse();
    Ok(order)
}

fn members(config: &Config, bundle: &str) -> Result<Vec<String>, BundleOrderError> {
    config
        .bundles
        .iter()
        .find(|candidate| candidate.name == bundle)
        .map(|candidate| candidate.services.clone())
        .ok_or(BundleOrderError::NotRegistered)
}

/// Wait until a dependency looks ready before starting what needs it.
///
/// Readiness is only observable for a service that declares a port, so a
/// portless one returns immediately. This times out instead of failing: a
/// dependency that never binds must not wedge the whole bundle, and the
/// dependent may well run without it.
pub async fn wait_for_service_ready(manager: &ProcessManager, def: &ServiceDef, timeout: Duration) {
    let Some(port) = def.port else {
        return;
    };
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        match manager.service_status(&def.name) {
            // Still coming up — keep waiting for the port.
            Some(status)
                if status.state == ServiceState::Running
                    || status.state == ServiceState::Starting => {}
            // Stopped, stopping, or never tracked: there is nothing to wait for.
            _ => return,
        }
        if !port_utils::is_port_available("127.0.0.1", port) {
            return;
        }
        tokio::time::sleep(READY_POLL_INTERVAL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::BundleDef;

    fn service(name: &str, depends_on: &[&str]) -> ServiceDef {
        ServiceDef {
            name: name.to_string(),
            kind: Some("local".to_string()),
            command: Some("true".to_string()),
            args: None,
            cwd: Some("/tmp".to_string()),
            port: None,
            description: None,
            project_path: None,
            env: None,
            test: None,
            depends_on: if depends_on.is_empty() {
                None
            } else {
                Some(depends_on.iter().map(|dep| dep.to_string()).collect())
            },
            compose_file: None,
            compose_service: None,
            host: None,
        }
    }

    fn config(services: Vec<ServiceDef>, members: &[&str]) -> Config {
        Config {
            services,
            bundles: vec![BundleDef {
                name: "web".into(),
                services: members.iter().map(|name| name.to_string()).collect(),
            }],
            ..Config::default()
        }
    }

    #[test]
    fn an_unregistered_bundle_is_reported_rather_than_treated_as_empty() {
        let config = config(vec![], &[]);
        assert_eq!(
            start_order(&config, "missing"),
            Err(BundleOrderError::NotRegistered)
        );
        assert_eq!(
            stop_order(&config, "missing"),
            Err(BundleOrderError::NotRegistered)
        );
    }

    #[test]
    fn starting_expands_transitive_dependencies_and_stopping_stays_in_the_bundle() {
        let config = config(
            vec![
                service("api", &["db"]),
                service("db", &[]),
                service("worker", &["api"]),
            ],
            &["worker"],
        );

        // `db` and `api` are pulled in even though the bundle names neither.
        assert_eq!(
            start_order(&config, "web").unwrap(),
            vec!["db".to_string(), "api".into(), "worker".into()]
        );
        // Stopping touches only the member, so a dependency another bundle may
        // still need is left running.
        assert_eq!(
            stop_order(&config, "web").unwrap(),
            vec!["worker".to_string()]
        );
    }

    #[test]
    fn stopping_reverses_the_start_order_for_members() {
        let config = config(
            vec![service("api", &["db"]), service("db", &[])],
            &["api", "db"],
        );
        assert_eq!(
            start_order(&config, "web").unwrap(),
            vec!["db".to_string(), "api".into()]
        );
        assert_eq!(
            stop_order(&config, "web").unwrap(),
            vec!["api".to_string(), "db".into()]
        );
    }

    #[test]
    fn a_cycle_refuses_to_start_but_still_stops_in_declaration_order() {
        let config = config(
            vec![service("api", &["worker"]), service("worker", &["api"])],
            &["api", "worker"],
        );
        assert!(matches!(
            start_order(&config, "web"),
            Err(BundleOrderError::DependencyCycle(_))
        ));
        // Stopping must not be blocked by an ordering it cannot compute.
        assert_eq!(
            stop_order(&config, "web").unwrap(),
            vec!["worker".to_string(), "api".into()]
        );
    }

    #[test]
    fn members_that_are_not_registered_services_are_skipped() {
        let config = config(vec![service("api", &[])], &["api", "ghost"]);
        assert_eq!(
            start_order(&config, "web").unwrap(),
            vec!["api".to_string()]
        );
        assert_eq!(stop_order(&config, "web").unwrap(), vec!["api".to_string()]);
    }
}
