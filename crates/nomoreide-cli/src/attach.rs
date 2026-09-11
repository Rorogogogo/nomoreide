use crate::commands::{CliError, CliResult};
use nomoreide_daemon_client::RuntimePaths;

const USAGE: &str = "Usage: nomoreide attach [--session ID] [--daemon]\n\nOpens a managed shell in this terminal and adds it to the NoMoreIDE dock.\nPrefers the running desktop app; --daemon selects the standalone daemon.\nUse Bring back in the dock to detach here without stopping the shell.";

pub async fn run(args: &[String], paths: &RuntimePaths, port: u16) -> CliResult {
    if args == ["--help"] || args == ["-h"] {
        println!("{USAGE}");
        return Ok(());
    }
    #[cfg(unix)]
    {
        use nomoreide_core::terminal::attach::{self, AttachRequest};
        use std::io::IsTerminal;
        let (session_id, daemon) = parse_args(args)?;
        if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
            return Err(CliError::usage(
                "nomoreide attach requires an interactive terminal",
            ));
        }
        if std::env::var_os("NOMOREIDE_TERMINAL_SESSION").is_some() {
            return Err(CliError::usage(
                "This shell is already attached to NoMoreIDE",
            ));
        }
        let desktop = RuntimePaths::desktop();
        let desktop_socket = attach::socket_path(&desktop.state_dir);
        let target = if !daemon && std::os::unix::net::UnixStream::connect(&desktop_socket).is_ok()
        {
            desktop
        } else {
            nomoreide_daemon_client::DaemonClient::ensure(paths, port, env!("CARGO_PKG_VERSION"))
                .await
                .map_err(|error| CliError::failure(error.to_string()))?;
            paths.clone()
        };
        let standalone = target == *paths;
        let request = AttachRequest {
            cwd: std::env::current_dir()
                .map_err(|error| CliError::failure(error.to_string()))?
                .to_string_lossy()
                .into_owned(),
            session_id,
            shell: std::env::var("SHELL").ok(),
            path: std::env::var("PATH").ok(),
        };
        tokio::task::spawn_blocking(move || {
            let attachment = attach::request(&target.state_dir, &request).map_err(|error| {
                format!("Could not attach to NoMoreIDE: {error}. Make sure the running app or daemon has been updated and restarted.")
            })?;
            eprintln!("Attached to NoMoreIDE: {}", attachment.session.id);
            let result = nomoreide_core::external_terminal::run_attach(
                &attachment.socket_path,
                &attachment.token,
            );
            eprintln!(
                "\r\nDetached. Reconnect with: nomoreide attach --session {}{}",
                attachment.session.id,
                if standalone { " --daemon" } else { "" }
            );
            result
        })
        .await
        .map_err(|error| CliError::failure(error.to_string()))?
        .map_err(CliError::failure)
    }
    #[cfg(not(unix))]
    {
        let _ = (args, paths, port);
        Err(CliError::usage(
            "Terminal attachment currently requires macOS or Linux",
        ))
    }
}

fn parse_args(args: &[String]) -> Result<(Option<String>, bool), CliError> {
    let mut session = None;
    let mut daemon = false;
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--daemon" if !daemon => daemon = true,
            "--session" if session.is_none() => {
                session = Some(
                    args.next()
                        .filter(|id| !id.is_empty() && !id.starts_with('-'))
                        .ok_or_else(|| CliError::usage(USAGE))?
                        .clone(),
                );
            }
            _ => return Err(CliError::usage(USAGE)),
        }
    }
    Ok((session, daemon))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_attach_and_explicit_reconnect() {
        assert!(matches!(parse_args(&[]), Ok((None, false))));
        let args = ["--session", "cli:123", "--daemon"].map(str::to_string);
        assert!(matches!(parse_args(&args), Ok((Some(id), true)) if id == "cli:123"));
    }

    #[test]
    fn rejects_missing_duplicate_and_unknown_arguments() {
        for args in [
            vec!["--session"],
            vec!["--session", "--daemon"],
            vec!["--daemon", "--daemon"],
            vec!["--bogus"],
        ] {
            assert!(parse_args(&args.into_iter().map(str::to_string).collect::<Vec<_>>()).is_err());
        }
    }
}
