//! The menu's view of the shared daemon, and the actions the menu asks for.
//!
//! One task owns the [`DaemonClient`]. It polls with *discovery*, not
//! `ensure`: a menu that restarted the daemon three seconds after
//! `nomoreide daemon stop` would be overruling the person who stopped it. The
//! daemon is started only when asked — by "Start Daemon", by opening the
//! window, or once when the app launches.

use std::time::Duration;

use nomoreide_daemon_client::protocol::{ServiceDefinition, ServiceRuntimeState};
use nomoreide_daemon_client::RuntimePaths;
use nomoreide_daemon_client::{DaemonClient, DaemonClientError};
use tao::event_loop::EventLoopProxy;
use tokio::sync::mpsc::UnboundedReceiver;

use super::macos::Msg;

const POLL: Duration = Duration::from_secs(3);
const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ServiceRow {
    pub name: String,
    pub port: Option<u16>,
    pub state: ServiceRuntimeState,
}

/// Everything the menu shows. Sent only when it changes, so the menu is not
/// rebuilt under the pointer every three seconds.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(super) struct Snapshot {
    /// The dashboard's URL; `None` while no daemon is reachable.
    pub url: Option<String>,
    /// Bumped each time a daemon is (re)connected. A new daemon has a new
    /// credential, so an open window must reload to pick it up.
    pub generation: u64,
    pub services: Vec<ServiceRow>,
    pub bundles: Vec<String>,
    /// Why there is no daemon, when it is something other than "not running".
    pub problem: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Verb {
    Start,
    Stop,
    Restart,
}

#[derive(Debug)]
pub(super) enum Action {
    /// Start the daemon if none is running.
    Ensure,
    Service(Verb, String),
    Bundle(Verb, String),
    /// Stop the daemon (and with it every service), then quit.
    StopDaemonAndQuit,
}

fn definition_row(definition: &ServiceDefinition) -> (String, Option<u16>) {
    match definition {
        ServiceDefinition::Local(service) => (service.name.clone(), service.port),
        ServiceDefinition::DockerCompose(service) => (service.name.clone(), service.port),
        ServiceDefinition::Ssh(service) => (service.name.clone(), service.port),
    }
}

async fn snapshot(client: &DaemonClient, generation: u64) -> Result<Snapshot, String> {
    let discovery = client.list_services().await.map_err(|e| e.to_string())?;
    let statuses = client.status().await.map_err(|e| e.to_string())?;
    let state_of = |name: &str| {
        statuses
            .iter()
            .find(|status| status.name == name)
            .map_or(ServiceRuntimeState::Stopped, |status| status.state)
    };
    let mut services: Vec<ServiceRow> = discovery
        .services
        .iter()
        .map(definition_row)
        .map(|(name, port)| ServiceRow {
            state: state_of(&name),
            name,
            port,
        })
        .collect();
    // A service the daemon runs that is no longer in config still runs, and
    // still needs a Stop.
    for status in &statuses {
        if !services.iter().any(|row| row.name == status.name) {
            services.push(ServiceRow {
                name: status.name.clone(),
                port: None,
                state: status.state,
            });
        }
    }
    Ok(Snapshot {
        url: Some(client.endpoint().as_str().to_string()),
        generation,
        services,
        bundles: discovery.bundles.into_iter().map(|b| b.name).collect(),
        problem: None,
    })
}

struct Poller {
    paths: RuntimePaths,
    port: u16,
    client: Option<DaemonClient>,
    generation: u64,
    /// The daemon instance `generation` counts; see [`DaemonClient::owner_id`].
    owner: Option<String>,
    problem: Option<String>,
}

impl Poller {
    fn connected(&mut self, client: DaemonClient) {
        if self.owner.as_deref() != Some(client.owner_id()) {
            self.owner = Some(client.owner_id().to_string());
            self.generation += 1;
        }
        self.client = Some(client);
    }

    async fn connect(&mut self) {
        if self.client.is_some() {
            return;
        }
        match DaemonClient::discover(&self.paths, self.port, VERSION).await {
            Ok(client) => self.connected(client),
            Err(DaemonClientError::DaemonDown) => self.problem = None,
            Err(error) => self.problem = Some(error.to_string()),
        }
    }

    async fn ensure(&mut self) {
        match DaemonClient::ensure(&self.paths, self.port, VERSION).await {
            Ok(client) => self.connected(client),
            Err(error) => self.problem = Some(error.to_string()),
        }
    }

    /// Run one action. Returns false when the app should quit.
    async fn perform(&mut self, action: Action) -> bool {
        if let Action::Ensure = action {
            self.ensure().await;
            return true;
        }
        self.connect().await;
        let Some(client) = &self.client else {
            return !matches!(action, Action::StopDaemonAndQuit);
        };
        let outcome = match &action {
            Action::Ensure => Ok(()),
            Action::Service(verb, name) => match verb {
                Verb::Start => client.start_service(name).await.map(drop),
                Verb::Stop => client.stop_service(name).await.map(drop),
                Verb::Restart => client.restart_service(name).await.map(drop),
            },
            Action::Bundle(Verb::Stop, name) => client.stop_bundle(name).await.map(drop),
            Action::Bundle(_, name) => client.start_bundle(name).await.map(drop),
            Action::StopDaemonAndQuit => client.shutdown().await,
        };
        if let Err(error) = outcome {
            eprintln!("nomoreide menubar: {action:?} failed: {error}");
        }
        !matches!(action, Action::StopDaemonAndQuit)
    }

    async fn snapshot(&mut self) -> Snapshot {
        self.connect().await;
        if let Some(client) = &self.client {
            match snapshot(client, self.generation).await {
                Ok(snapshot) => {
                    self.problem = None;
                    return snapshot;
                }
                // The daemon went away or was replaced; rediscover next time,
                // and say why in the menu rather than "not running".
                Err(error) => {
                    if self.problem.as_deref() != Some(error.as_str()) {
                        eprintln!("nomoreide menubar: cannot read the daemon: {error}");
                    }
                    self.problem = Some(error);
                    self.client = None;
                }
            }
        }
        Snapshot {
            generation: self.generation,
            problem: self.problem.clone(),
            ..Snapshot::default()
        }
    }
}

pub(super) async fn run(
    paths: RuntimePaths,
    port: u16,
    proxy: EventLoopProxy<Msg>,
    mut actions: UnboundedReceiver<Action>,
) {
    let mut poller = Poller {
        paths,
        port,
        client: None,
        generation: 0,
        owner: None,
        problem: None,
    };
    let mut last: Option<Snapshot> = None;
    loop {
        let action = tokio::select! {
            action = actions.recv() => match action {
                Some(action) => Some(action),
                None => return,
            },
            _ = tokio::time::sleep(POLL) => None,
        };
        if let Some(action) = action {
            if !poller.perform(action).await {
                let _ = proxy.send_event(Msg::Quit);
                return;
            }
        }
        let snapshot = poller.snapshot().await;
        if last.as_ref() != Some(&snapshot) {
            if proxy.send_event(Msg::Snapshot(snapshot.clone())).is_err() {
                return;
            }
            last = Some(snapshot);
        }
    }
}
