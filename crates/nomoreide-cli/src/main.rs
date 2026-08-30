mod setup;

use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    if raw.first().map(String::as_str) == Some("setup") {
        return ExitCode::from(setup::run(&raw[1..]));
    }
    let mut args = std::env::args_os().skip(1);
    match (args.next().as_deref(), args.next()) {
        (Some(command), None) if command == "daemon" => {
            let options = nomoreide_daemon::DaemonOptions {
                port: nomoreide_daemon_client::resolve_daemon_port(
                    std::env::var("NOMOREIDE_DAEMON_PORT").ok().as_deref(),
                ),
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
        (Some(command), None) if command == "mcp" => match nomoreide_mcp::run_stdio().await {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("nomoreide: MCP server failed: {error}");
                ExitCode::FAILURE
            }
        },
        _ => {
            eprintln!("Usage: nomoreide <daemon|mcp|setup>");
            ExitCode::FAILURE
        }
    }
}
