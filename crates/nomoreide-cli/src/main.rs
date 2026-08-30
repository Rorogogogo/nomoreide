//! The `nomoreide` binary's front door — the Rust half of `src/index.ts`.
//!
//! Dispatch order matters and mirrors the reference exactly. In particular
//! `start` is overloaded: with no service name it is the MCP server (the shape
//! an agent launches), and with one it is a service start. An agent config
//! that says `nomoreide start` has to keep working.

mod agents;
mod commands;
mod daemon_cli;
mod database;
mod flags;
mod git;
mod profile;
mod setup;

use std::process::ExitCode;

use nomoreide_daemon_client::{resolve_daemon_port, RuntimePaths};

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // No deprecation notice here. The reference prints one on an interactive
    // stderr telling the reader to install *this* binary; having installed it,
    // there is nothing left to say.
    let command = args.first().map(String::as_str).unwrap_or("mcp");
    let paths = RuntimePaths::default();
    let configured_port =
        resolve_daemon_port(std::env::var("NOMOREIDE_DAEMON_PORT").ok().as_deref());

    let code = match command {
        "setup" => setup::run(&args[1..]),
        // Bare `start` is the MCP server: it is what an agent spawns, and it
        // predates the service-runtime meaning of the word.
        "mcp" | "start" if args.len() <= 1 => match nomoreide_mcp::run_stdio().await {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("nomoreide: MCP server failed: {error}");
                1
            }
        },
        "daemon" => {
            let rest = &args[1..];
            let port = daemon_cli::port_flag(rest).unwrap_or(configured_port);
            if rest.iter().any(|arg| !arg.starts_with("--")) {
                daemon_cli::run(rest, &paths, port).await
            } else {
                return run_foreground_daemon(port).await;
            }
        }
        "web" => web(&paths, configured_port).await,
        _ => commands::run(&args, &paths, configured_port).await,
    };
    ExitCode::from(code)
}

/// `nomoreide daemon` with no subcommand: be the machine-global daemon.
///
/// Split out because it never returns normally — everything else in `main`
/// produces an exit code, and this produces a process that lives until a
/// signal or `/api/daemon/shutdown`.
async fn run_foreground_daemon(port: u16) -> ExitCode {
    let options = nomoreide_daemon::DaemonOptions {
        port,
        ..Default::default()
    };
    match nomoreide_daemon::run(options).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("nomoreide: daemon failed: {error:#}");
            ExitCode::FAILURE
        }
    }
}

/// `nomoreide web [--port=N]` — make sure a daemon is up and say where it is.
///
/// Both lines go to **stderr**, including the URL. That looks wrong until you
/// remember what calls this: a shell function that opens the browser, and a
/// wrapper that wants the URL out of band from whatever the daemon then logs.
/// The reference puts both there, so both stay there.
async fn web(paths: &RuntimePaths, configured_port: u16) -> u8 {
    let port = std::env::args()
        .find_map(|arg| {
            arg.strip_prefix("--port=")
                .map(|value| resolve_daemon_port(Some(value)))
        })
        .unwrap_or(configured_port);
    match nomoreide_daemon_client::ensure_daemon(paths, port, env!("CARGO_PKG_VERSION")).await {
        Ok(daemon) => {
            if let Some(warning) = &daemon.version_warning {
                eprintln!("{warning}");
            }
            eprintln!(
                "NoMoreIDE web UI: http://127.0.0.1:{}",
                daemon.endpoint.port()
            );
            0
        }
        Err(error) => {
            eprintln!("{error}");
            1
        }
    }
}
