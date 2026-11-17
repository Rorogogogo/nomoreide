//! Start at login, as a per-user LaunchAgent, and the single-instance socket.
//!
//! The LaunchAgent runs `nomoreide menubar --background`. It records the
//! binary the same way `nomoreide setup` does ([`native_server_command`]):
//! absolute, symlinks unresolved, so a versioned-directory install keeps
//! starting the current version after an upgrade.
//!
//! A login item started by launchd has a minimal PATH. That does not reach
//! services: the daemon resolves the login-shell PATH for everything it
//! spawns (`service_path()` in `process_manager.rs`).

use std::io::Write;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;

use nomoreide_core::agent_profiles::debug_setup::native_server_command;
use nomoreide_daemon_client::RuntimePaths;

const LABEL: &str = "com.nomoreide.menubar";

/// Where a running menu bar app listens for "show your window".
pub(super) fn socket(paths: &RuntimePaths) -> PathBuf {
    paths.state_dir.join("menubar.sock")
}

/// If the menu bar app is already running, ask it to show its window.
pub(super) fn open_running(paths: &RuntimePaths) -> bool {
    UnixStream::connect(socket(paths)).is_ok_and(|mut stream| stream.write_all(b"open\n").is_ok())
}

fn plist_path() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(format!("Library/LaunchAgents/{LABEL}.plist")))
}

pub(super) fn starts_at_login() -> bool {
    plist_path().is_some_and(|path| path.exists())
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn plist(program: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{}</string>
    <string>menubar</string>
    <string>--background</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
"#,
        xml_escape(program)
    )
}

/// Start at login, or stop doing so. Takes effect at the next login.
pub(super) fn set_login(on: bool) -> std::io::Result<()> {
    let Some(path) = plist_path() else {
        return Err(std::io::Error::other("the home folder is unknown"));
    };
    if !on {
        return match std::fs::remove_file(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        };
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, plist(&native_server_command()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_login_item_runs_the_menubar_in_the_background() {
        let plist = plist("/opt/nomoreide <1.0>/bin/nomoreide");
        assert!(plist.contains("<string>/opt/nomoreide &lt;1.0&gt;/bin/nomoreide</string>"));
        assert!(plist.contains("<string>menubar</string>"));
        assert!(plist.contains("<string>--background</string>"));
        assert!(plist.contains(LABEL));
    }

    #[test]
    fn the_socket_lives_beside_the_daemon_state() {
        let paths = RuntimePaths::new(PathBuf::from("/tmp/state"));
        assert_eq!(socket(&paths), PathBuf::from("/tmp/state/menubar.sock"));
    }
}
