//! `nomoreide daemon [status|stop|restart] [--port=N]`.
//!
//! The Rust half of `src/cli/daemon.ts`. Bare `nomoreide daemon` runs the
//! machine-global daemon in the foreground and is handled in `main`, because
//! it never returns; everything here is the management surface around it.
//!
//! Deliberately not routed through `nomoreide_daemon_client::lifecycle`: that
//! module checks whether the recorded pid is alive before it believes a state
//! file, which is the right thing for spawning but the wrong thing here. The
//! reference reads the URL out of the state file and probes it, so a state
//! file naming a dead pid still gets probed, and `status` reports on whatever
//! actually answers that port. Reproducing the shipped behaviour means
//! reproducing that order.

use nomoreide_daemon_client::{
    self as daemon_client, protocol::ServiceRuntimeState, read_daemon_state, DaemonClient,
    DaemonEndpoint, DaemonProbe, RuntimePaths,
};
use reqwest::Client;
use std::time::Duration;

const USAGE: &str = "Usage: nomoreide daemon [status|stop|restart] [--port=N]";

/// How long `stop` waits for the daemon to actually go away, and how often it
/// asks. Both match the reference — a stop that returns before the port is
/// free would let the next `restart` race its own predecessor.
const STOP_TIMEOUT: Duration = Duration::from_secs(10);
const STOP_POLL: Duration = Duration::from_millis(200);

pub async fn run(args: &[String], paths: &RuntimePaths, port: u16) -> u8 {
    // The first bare word, so `--port=1 status` still finds `status`.
    let subcommand = args.iter().find(|arg| !arg.starts_with("--"));
    match subcommand.map(String::as_str) {
        Some("status") => status(paths, port).await,
        Some("stop") => stop(paths, port).await,
        Some("restart") => restart(paths, port).await,
        Some(_) => {
            eprintln!("{USAGE}");
            1
        }
        // Unreachable: `main` handles bare `daemon` before calling this.
        None => {
            eprintln!("{USAGE}");
            1
        }
    }
}

/// `--port=N` only. The reference matches on the `=` form, so a spaced
/// `--port 4318` is not a port — it is an unrecognised subcommand-less flag,
/// and the port falls back to the environment.
pub fn port_flag(args: &[String]) -> Option<u16> {
    args.iter()
        .find_map(|arg| arg.strip_prefix("--port="))
        .map(|value| daemon_client::resolve_daemon_port(Some(value)))
}

async fn status(paths: &RuntimePaths, port: u16) -> u8 {
    let http = Client::new();
    let state = read_daemon_state(&paths.state).await.ok().flatten();
    let target = target_for(state.as_ref().map(|state| state.url.as_str()), port);
    let url = &target.url;
    let DaemonProbe::NoMoreIde(health) = probe(&target, &http).await else {
        println!("NoMoreIDE daemon: not running (probed {url})");
        return 1;
    };
    let Some(endpoint) = target.endpoint.clone() else {
        // A probe that answered came from an endpoint that parsed.
        unreachable!("a daemon answered on an endpoint that will not parse")
    };

    let version = health
        .version
        .clone()
        .or_else(|| state.as_ref().and_then(|state| state.version.clone()))
        .unwrap_or_else(|| "unknown".to_string());
    let pid = health
        .pid
        .or_else(|| state.as_ref().map(|state| state.pid))
        .map_or_else(|| "?".to_string(), |pid| pid.to_string());
    println!("NoMoreIDE daemon: running at {url} (pid {pid}, v{version})");

    let client = match DaemonClient::connect(endpoint, paths).await {
        Ok(client) => client,
        Err(error) => {
            eprintln!("{error}");
            return 2;
        }
    };
    let services = match client.status().await {
        Ok(services) => services,
        Err(error) => {
            eprintln!("{error}");
            return 2;
        }
    };
    let running: Vec<_> = services
        .iter()
        .filter(|service| service.state == ServiceRuntimeState::Running)
        .collect();
    println!(
        "Services: {} running / {} known",
        running.len(),
        services.len()
    );
    for service in running {
        let pid = service
            .pid
            .map_or_else(|| "?".to_string(), |pid| pid.to_string());
        // The reference interpolates a missing URL as the empty string, which
        // leaves the line ending in two spaces. Kept: it is what a script
        // splitting on the separator already parses.
        println!(
            "  {}  pid {}  {}",
            service.name,
            pid,
            service.url.as_deref().unwrap_or("")
        );
    }
    0
}

async fn stop(paths: &RuntimePaths, port: u16) -> u8 {
    let http = Client::new();
    let state = read_daemon_state(&paths.state).await.ok().flatten();
    let target = target_for(state.as_ref().map(|state| state.url.as_str()), port);
    let url = &target.url;

    match probe(&target, &http).await {
        DaemonProbe::Down => {
            let _ = tokio::fs::remove_file(&paths.state).await;
            println!("NoMoreIDE daemon is not running.");
            return 0;
        }
        DaemonProbe::Foreign => {
            eprintln!("Port at {url} is held by a non-NoMoreIDE process; not touching it.");
            return 1;
        }
        DaemonProbe::NoMoreIde(_) => {}
    }

    let Some(endpoint) = target.endpoint.clone() else {
        unreachable!("a daemon answered on an endpoint that will not parse")
    };
    let client = match DaemonClient::connect(endpoint, paths).await {
        Ok(client) => client,
        Err(error) => {
            eprintln!("{error}");
            return 2;
        }
    };
    if let Err(error) = client.shutdown().await {
        eprintln!("{error}");
        return 2;
    }

    let deadline = std::time::Instant::now() + STOP_TIMEOUT;
    while std::time::Instant::now() < deadline {
        if probe(&target, &http).await == DaemonProbe::Down {
            println!("NoMoreIDE daemon stopped (all services shut down).");
            return 0;
        }
        tokio::time::sleep(STOP_POLL).await;
    }
    eprintln!("Daemon did not exit within 10s; its services may still be stopping.");
    1
}

async fn restart(paths: &RuntimePaths, port: u16) -> u8 {
    let stopped = stop(paths, port).await;
    if stopped != 0 {
        return stopped;
    }
    match daemon_client::ensure_daemon(paths, port, env!("CARGO_PKG_VERSION")).await {
        Ok(daemon) => {
            // Built from the port rather than printed from the parsed URL,
            // for the trailing-slash reason `Target` documents.
            println!(
                "NoMoreIDE daemon restarted: http://127.0.0.1:{} (pid {})",
                daemon.endpoint.port(),
                daemon.pid
            );
            0
        }
        Err(error) => {
            eprintln!("{error}");
            2
        }
    }
}

/// What to probe, and what to *call* it in the output.
///
/// The two are not the same string. `DaemonEndpoint` is a parsed `Url`, and
/// printing one back gives `http://127.0.0.1:4317/` — a trailing slash that
/// neither runtime ever wrote. Both daemons record `http://127.0.0.1:{port}`,
/// and the reference prints the recorded text verbatim, so the display string
/// is carried separately rather than round-tripped through the parser.
struct Target {
    /// `None` for a recorded URL that will not parse. The reference hands such
    /// a URL to `fetch`, which fails, and a failed probe is "down" — so an
    /// unparseable URL is down here too, rather than silently falling back to
    /// the configured port and reporting on a daemon nobody asked about.
    endpoint: Option<DaemonEndpoint>,
    url: String,
}

fn target_for(recorded: Option<&str>, port: u16) -> Target {
    match recorded {
        Some(url) => Target {
            endpoint: DaemonEndpoint::parse(url).ok(),
            url: url.to_string(),
        },
        None => Target {
            endpoint: Some(DaemonEndpoint::localhost(port)),
            url: format!("http://127.0.0.1:{port}"),
        },
    }
}

async fn probe(target: &Target, http: &Client) -> DaemonProbe {
    match &target.endpoint {
        Some(endpoint) => daemon_client::probe_daemon(endpoint, http).await,
        None => DaemonProbe::Down,
    }
}
