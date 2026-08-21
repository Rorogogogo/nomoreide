use nomoreide_core::config::ConfigStore;
use nomoreide_core::port_utils::PortHolder;
use nomoreide_core::process_manager::{
    PortConflictError, ProcessManager, ServiceState, ServiceStatus,
};
use nomoreide_daemon_client::protocol::{
    PortConflict, PortHolderIdentity, ServiceRuntimeState, ServiceRuntimeStatus,
};
use std::future::Future;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use tokio::sync::RwLock;

const PHASE_RUNNING: u8 = 0;
const PHASE_DRAINING: u8 = 1;
const PHASE_CLEANUP_FAILED: u8 = 2;

#[derive(Debug)]
pub(crate) enum RuntimeMutationError {
    ServiceNotFound,
    UnsupportedServiceKind,
    PortConflict {
        message: String,
        conflict: Box<PortConflict>,
    },
    DaemonDraining,
    DaemonCleanupFailed,
    ConfigLoadFailed,
    ServiceStartFailed,
    CleanupFailed,
}

pub(crate) struct DaemonRuntime {
    config_store: ConfigStore,
    process_manager: Arc<ProcessManager>,
    mutation_gate: RwLock<()>,
    phase: AtomicU8,
}

impl DaemonRuntime {
    pub(crate) fn new(config_store: ConfigStore, process_manager: ProcessManager) -> Self {
        Self {
            config_store,
            process_manager: Arc::new(process_manager),
            mutation_gate: RwLock::new(()),
            phase: AtomicU8::new(PHASE_RUNNING),
        }
    }

    pub(crate) async fn reconcile_runtime(&self) -> anyhow::Result<()> {
        self.process_manager.reconcile_runtime().await
    }

    pub(crate) async fn start_service(
        &self,
        name: &str,
    ) -> Result<ServiceRuntimeStatus, RuntimeMutationError> {
        self.launch(name, Launch::Start).await
    }

    /// A restart ends in a start, so it takes the start gate rather than the
    /// lenient stop one, and it resolves the definition *before* anything is
    /// stopped: a restart that could never start again must not take the
    /// running process down on its way to failing.
    pub(crate) async fn restart_service(
        &self,
        name: &str,
    ) -> Result<ServiceRuntimeStatus, RuntimeMutationError> {
        self.launch(name, Launch::Restart).await
    }

    /// Both launches hold a single mutation permit for the whole operation. A
    /// restart that took one permit to stop and a second to start would let a
    /// shutdown drain in between and leave the service down. The stop and the
    /// start are handed to the process manager together so they also share its
    /// per-service operation lock.
    async fn launch(
        &self,
        name: &str,
        mode: Launch,
    ) -> Result<ServiceRuntimeStatus, RuntimeMutationError> {
        self.require_start_allowed()?;
        let _permit = self.mutation_gate.read().await;
        self.require_start_allowed()?;
        let service = self.registered_local_service(name).await?;
        match mode {
            Launch::Start => self.process_manager.start_service(&service).await,
            Launch::Restart => self.process_manager.restart_service(&service).await,
        }
        .map_err(launch_error)?;
        self.process_manager
            .service_status(name)
            .map(runtime_status)
            .ok_or(RuntimeMutationError::ServiceStartFailed)
    }

    /// Stopping is a remediation capability, so a name this daemon is already
    /// running stays stoppable even after its definition was edited, removed,
    /// or made temporarily unreadable — otherwise config drift would strand a
    /// live process group with no way to reach it. Names this daemon does not
    /// own still have to be registered local services.
    pub(crate) async fn stop_service(
        &self,
        name: &str,
    ) -> Result<ServiceRuntimeStatus, RuntimeMutationError> {
        self.require_stop_allowed()?;
        let _permit = self.mutation_gate.read().await;
        self.require_stop_allowed()?;
        if self.process_manager.service_status(name).is_none() {
            self.registered_local_service(name).await?;
        }
        self.process_manager
            .stop_service(name)
            .await
            .map_err(|_| RuntimeMutationError::CleanupFailed)?;
        Ok(self
            .process_manager
            .service_status(name)
            .map(runtime_status)
            .unwrap_or_else(|| stopped_status(name)))
    }

    pub(crate) async fn shutdown(&self) -> Result<(), String> {
        self.shutdown_with(async {
            self.process_manager
                .shutdown_all()
                .await
                .map_err(|error| error.to_string())
        })
        .await
    }

    async fn shutdown_with<F>(&self, cleanup: F) -> Result<(), String>
    where
        F: Future<Output = Result<(), String>>,
    {
        let phase = self.phase.load(Ordering::Acquire);
        if phase == PHASE_DRAINING {
            return Err("daemon cleanup is already in progress".into());
        }
        self.phase.store(PHASE_DRAINING, Ordering::Release);
        let _permit = self.mutation_gate.write().await;
        match cleanup.await {
            Ok(()) => Ok(()),
            Err(error) => {
                self.phase.store(PHASE_CLEANUP_FAILED, Ordering::Release);
                Err(error)
            }
        }
    }

    fn require_start_allowed(&self) -> Result<(), RuntimeMutationError> {
        match self.phase.load(Ordering::Acquire) {
            PHASE_RUNNING => Ok(()),
            PHASE_DRAINING => Err(RuntimeMutationError::DaemonDraining),
            _ => Err(RuntimeMutationError::DaemonCleanupFailed),
        }
    }

    fn require_stop_allowed(&self) -> Result<(), RuntimeMutationError> {
        match self.phase.load(Ordering::Acquire) {
            PHASE_RUNNING | PHASE_CLEANUP_FAILED => Ok(()),
            _ => Err(RuntimeMutationError::DaemonDraining),
        }
    }

    async fn registered_local_service(
        &self,
        name: &str,
    ) -> Result<nomoreide_core::config::ServiceDef, RuntimeMutationError> {
        let config = self
            .config_store
            .load()
            .await
            .map_err(|_| RuntimeMutationError::ConfigLoadFailed)?;
        let service = config
            .services
            .into_iter()
            .find(|service| service.name == name)
            .ok_or(RuntimeMutationError::ServiceNotFound)?;
        if service.effective_kind() != "local" {
            return Err(RuntimeMutationError::UnsupportedServiceKind);
        }
        Ok(service)
    }
}

#[derive(Clone, Copy)]
enum Launch {
    Start,
    Restart,
}

/// A restart reports a failed stop as a failed start, because the process
/// manager returns one result for both phases. The daemon keeps the protocol's
/// existing error codes rather than inventing a restart-only one the reference
/// implementation does not have.
fn launch_error(error: anyhow::Error) -> RuntimeMutationError {
    if let Some(conflict) = error.downcast_ref::<PortConflictError>() {
        return RuntimeMutationError::PortConflict {
            message: conflict.to_string(),
            conflict: Box::new(PortConflict {
                service: conflict.service.clone(),
                port: conflict.port,
                holder: conflict.holder.as_ref().map(holder_identity),
            }),
        };
    }
    RuntimeMutationError::ServiceStartFailed
}

fn runtime_status(status: ServiceStatus) -> ServiceRuntimeStatus {
    ServiceRuntimeStatus {
        name: status.name,
        state: match status.state {
            ServiceState::Stopped => ServiceRuntimeState::Stopped,
            ServiceState::Starting => ServiceRuntimeState::Starting,
            ServiceState::Running => ServiceRuntimeState::Running,
            ServiceState::Stopping => ServiceRuntimeState::Stopping,
            ServiceState::Exited => ServiceRuntimeState::Exited,
        },
        pid: status.pid,
        pgid: status.pgid,
        exit_code: status.exit_code,
        url: status.url,
    }
}

fn stopped_status(name: &str) -> ServiceRuntimeStatus {
    ServiceRuntimeStatus {
        name: name.to_string(),
        state: ServiceRuntimeState::Stopped,
        pid: None,
        pgid: None,
        exit_code: None,
        url: None,
    }
}

fn holder_identity(holder: &PortHolder) -> PortHolderIdentity {
    PortHolderIdentity {
        pid: holder.pid,
        pgid: holder.pgid,
        uid: holder.uid,
        command: holder.command.clone(),
        start_token: holder.start_token.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nomoreide_core::log_store::LogStore;
    use uuid::Uuid;

    fn runtime() -> DaemonRuntime {
        let root = std::env::temp_dir().join(format!("nomoreide-runtime-{}", Uuid::new_v4()));
        DaemonRuntime::new(
            ConfigStore::new(root.join("config.json")),
            ProcessManager::new(LogStore::new(root.join("logs"))),
        )
    }

    #[tokio::test]
    async fn cleanup_failure_blocks_starts_allows_stops_and_can_be_retried() {
        let runtime = runtime();

        assert_eq!(
            runtime
                .shutdown_with(async { Err("first cleanup failed".into()) })
                .await,
            Err("first cleanup failed".into())
        );
        assert!(matches!(
            runtime.start_service("missing").await,
            Err(RuntimeMutationError::DaemonCleanupFailed)
        ));
        // A restart ends in a start, so it is gated like one rather than like
        // the remediation stop beside it.
        assert!(matches!(
            runtime.restart_service("missing").await,
            Err(RuntimeMutationError::DaemonCleanupFailed)
        ));
        assert!(matches!(
            runtime.stop_service("missing").await,
            Err(RuntimeMutationError::ServiceNotFound)
        ));
        assert_eq!(runtime.shutdown_with(async { Ok(()) }).await, Ok(()));
    }

    #[tokio::test]
    async fn shutdown_waits_for_admitted_mutations_before_cleanup() {
        let runtime = Arc::new(runtime());
        let mutation = runtime.mutation_gate.read().await;
        let shutdown_runtime = runtime.clone();
        let shutdown =
            tokio::spawn(async move { shutdown_runtime.shutdown_with(async { Ok(()) }).await });
        tokio::task::yield_now().await;

        assert_eq!(runtime.phase.load(Ordering::Acquire), PHASE_DRAINING);
        assert!(!shutdown.is_finished());
        drop(mutation);
        assert_eq!(shutdown.await.unwrap(), Ok(()));
    }
}
