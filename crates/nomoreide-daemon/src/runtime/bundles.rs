//! Bundle lifecycle for the daemon.
//!
//! The ordering and the readiness probe come from `nomoreide_core::bundle`, so
//! this module only carries daemon policy: which services it will admit, how a
//! partial failure is reported, and how each phase is gated.

use super::{launch_error, local_service, runtime_status, DaemonRuntime, RuntimeMutationError};
use nomoreide_core::bundle::{self, BundleOrderError};
use nomoreide_core::config::{Config, ServiceDef};
use nomoreide_daemon_client::protocol::ServiceRuntimeStatus;

impl DaemonRuntime {
    /// Start every service a bundle needs, dependencies first.
    ///
    /// Every member is admitted before any of them starts. A bundle naming one
    /// service this daemon cannot run is refused whole rather than started
    /// halfway — the same reason a restart resolves its definition before it
    /// stops anything.
    pub(crate) async fn start_bundle(
        &self,
        name: &str,
    ) -> Result<Vec<ServiceRuntimeStatus>, RuntimeMutationError> {
        self.require_start_allowed()?;
        let _permit = self.mutation_gate.read().await;
        self.require_start_allowed()?;
        let config = self.config().await?;
        let order = bundle::start_order(&config, name).map_err(order_error)?;
        let admitted = order
            .iter()
            .map(|service| local_service(&config, service))
            .collect::<Result<Vec<_>, _>>()?;

        let mut statuses = Vec::with_capacity(admitted.len());
        for service in admitted {
            self.await_dependencies(&config, service).await;
            self.process_manager
                .start_service(service)
                .await
                .map_err(launch_error)?;
            statuses.push(
                self.process_manager
                    .service_status(&service.name)
                    .map(runtime_status)
                    .ok_or(RuntimeMutationError::ServiceStartFailed)?,
            );
        }
        Ok(statuses)
    }

    /// Stop a bundle's own members, dependents first.
    ///
    /// Every member is attempted even after one fails. Stopping is remediation:
    /// letting a single stuck process group strand the rest of the bundle would
    /// leave more running than it cleaned up.
    pub(crate) async fn stop_bundle(
        &self,
        name: &str,
    ) -> Result<Vec<ServiceRuntimeStatus>, RuntimeMutationError> {
        self.require_stop_allowed()?;
        let _permit = self.mutation_gate.read().await;
        self.require_stop_allowed()?;
        let config = self.config().await?;
        let order = bundle::stop_order(&config, name).map_err(order_error)?;

        let mut statuses = Vec::with_capacity(order.len());
        let mut failed = false;
        for service in &order {
            // A name this daemon is already running stays stoppable even if its
            // definition drifted, matching `stop_service`.
            if self.process_manager.service_status(service).is_none() {
                local_service(&config, service)?;
            }
            match self.process_manager.stop_service(service).await {
                Ok(()) => statuses.push(
                    self.process_manager
                        .service_status(service)
                        .map(runtime_status)
                        .unwrap_or_else(|| super::stopped_status(service)),
                ),
                Err(_) => failed = true,
            }
        }
        if failed {
            return Err(RuntimeMutationError::CleanupFailed);
        }
        Ok(statuses)
    }

    /// Give each declared dependency a chance to bind its port before the
    /// service that needs it starts. Dependencies precede their dependents in
    /// the resolved order, so each one has already been asked to start.
    async fn await_dependencies(&self, config: &Config, service: &ServiceDef) {
        for dependency in service.depends_on.iter().flatten() {
            if let Ok(def) = local_service(config, dependency) {
                bundle::wait_for_service_ready(&self.process_manager, def, bundle::READY_TIMEOUT)
                    .await;
            }
        }
    }
}

fn order_error(error: BundleOrderError) -> RuntimeMutationError {
    match error {
        BundleOrderError::NotRegistered => RuntimeMutationError::BundleNotFound,
        BundleOrderError::DependencyCycle(message) => {
            RuntimeMutationError::DependencyCycle(message)
        }
    }
}
