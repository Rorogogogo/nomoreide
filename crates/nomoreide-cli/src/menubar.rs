//! `nomoreide menubar`: NoMoreIDE in the macOS menu bar.
//!
//! An icon whose menu shows the shared daemon's services — start, stop,
//! restart, open — and opens the full dashboard in its own window. The window
//! is the daemon's own page, so it is the same dashboard the browser gets and
//! sees the same services agents start over MCP.
//!
//! **It is a front door, not a runtime.** Services live in the machine-global
//! daemon, so quitting the menu bar app leaves them running, exactly as
//! closing a browser tab does. "Stop Daemon and Quit" is the way to end both.
//!
//! The command line half is here and platform-neutral; the app itself is in
//! [`macos`], the only platform it exists on.

#[cfg(target_os = "macos")]
mod app_menu;
#[cfg(target_os = "macos")]
mod icon;
#[cfg(target_os = "macos")]
mod login;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
mod menu;
#[cfg(target_os = "macos")]
mod poller;

use nomoreide_daemon_client::RuntimePaths;

const USAGE: &str = "Usage: nomoreide menubar [--background] [--login on|off]";

/// What `nomoreide menubar` was asked to do.
#[derive(Debug, PartialEq, Eq)]
enum Request {
    /// Run the app; `background` leaves the window closed (how login starts it).
    Run { background: bool },
    /// Install or remove the login item, then exit.
    Login(bool),
}

fn parse(args: &[String]) -> Result<Request, String> {
    let mut background = false;
    let mut login = None;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--background" => background = true,
            "--login" => {
                login = Some(match rest.next().map(String::as_str) {
                    Some("on") => true,
                    Some("off") => false,
                    _ => return Err(USAGE.to_string()),
                })
            }
            "--login=on" => login = Some(true),
            "--login=off" => login = Some(false),
            _ => return Err(USAGE.to_string()),
        }
    }
    Ok(match login {
        Some(on) => Request::Login(on),
        None => Request::Run { background },
    })
}

pub async fn run(args: &[String], paths: &RuntimePaths, port: u16) -> u8 {
    let request = match parse(args) {
        Ok(request) => request,
        Err(usage) => {
            eprintln!("{usage}");
            return 1;
        }
    };
    #[cfg(target_os = "macos")]
    {
        macos::run(request, paths, port).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (request, paths, port);
        eprintln!(
            "nomoreide menubar is macOS-only. Use `nomoreide web` for the dashboard in a browser."
        );
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn opens_the_window_unless_started_in_the_background() {
        assert_eq!(parse(&[]), Ok(Request::Run { background: false }));
        assert_eq!(
            parse(&args(&["--background"])),
            Ok(Request::Run { background: true })
        );
    }

    #[test]
    fn login_takes_on_or_off_in_either_spelling() {
        assert_eq!(parse(&args(&["--login", "on"])), Ok(Request::Login(true)));
        assert_eq!(parse(&args(&["--login=off"])), Ok(Request::Login(false)));
        assert!(parse(&args(&["--login"])).is_err());
        assert!(parse(&args(&["--login", "yes"])).is_err());
    }

    #[test]
    fn refuses_what_it_does_not_know() {
        assert!(parse(&args(&["--window"])).is_err());
    }
}
