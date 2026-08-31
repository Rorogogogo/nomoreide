//! `nomoreide tui` — the Rust half of `src/tui/app.ts`.
//!
//! A **daemon client**, not a supervisor: it starts and stops services through
//! the machine-global daemon, so everything it launched is still running after
//! it quits, and the status it shows is every session's services rather than
//! its own. Quitting is therefore not a shutdown, which is why `q` says
//! nothing about the services it leaves behind.
//!
//! [`render_screen`] is deliberately a pure function of a snapshot. It is the
//! part with a contract — the exact bytes a terminal receives — and keeping it
//! free of I/O is what lets both the unit tests below and the parity gate
//! compare frames rather than screenshots.

use std::collections::HashMap;

use nomoreide_core::config::{Config, ServiceDef};
use nomoreide_daemon_client::{
    protocol::{ServiceLogEntry, ServiceRuntimeState},
    DaemonClient, RuntimePaths, ServiceAction,
};

use crate::commands::{CliError, CliResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Services,
    Bundles,
    Logs,
}

pub struct ScreenState<'a> {
    pub mode: Mode,
    pub selected_index: usize,
    pub selected_service: Option<&'a str>,
    pub config: &'a Config,
    /// Service name to runtime state. A name the daemon has never run is
    /// reported as `stopped` rather than left blank — the reference's `??`.
    pub runtime: &'a HashMap<String, String>,
    pub logs: &'a [ServiceLogEntry],
}

/// How many log lines fit on the logs screen. The reference takes the *last*
/// twenty, so the newest are the ones kept.
const LOG_TAIL: usize = 20;

pub fn render_screen(state: &ScreenState) -> String {
    let mut lines = vec![
        "NoMoreIDE".to_string(),
        "s start   x stop   r restart   b bundles   l logs   q quit".to_string(),
        String::new(),
    ];

    match state.mode {
        Mode::Bundles => {
            lines.push("Bundles".to_string());
            for (index, bundle) in state.config.bundles.iter().enumerate() {
                let marker = if index == state.selected_index {
                    ">"
                } else {
                    " "
                };
                lines.push(format!(
                    "{marker} {}  [{}]",
                    bundle.name,
                    bundle.services.join(", ")
                ));
            }
        }
        Mode::Logs => {
            // The trailing space when no service is selected is the
            // reference's: it interpolates an empty string after "Logs ".
            lines.push(format!(
                "Logs {}",
                state
                    .selected_service
                    .map(|name| format!("- {name}"))
                    .unwrap_or_default()
            ));
            let start = state.logs.len().saturating_sub(LOG_TAIL);
            for entry in &state.logs[start..] {
                lines.push(format!(
                    "{} {} {}",
                    entry.timestamp,
                    pad_end(&entry.stream, 6),
                    entry.text
                ));
            }
        }
        Mode::Services => {
            lines.push("Services".to_string());
            for (index, service) in state.config.services.iter().enumerate() {
                let marker = if index == state.selected_index {
                    ">"
                } else {
                    " "
                };
                let status = state
                    .runtime
                    .get(&service.name)
                    .map(String::as_str)
                    .unwrap_or("stopped");
                let port = service
                    .port
                    .map_or_else(|| "-".to_string(), |port| port.to_string());
                let description = service
                    .description
                    .as_deref()
                    .map(|text| format!(" {text}"))
                    .unwrap_or_default();
                lines.push(format!(
                    "{marker} {} {} port {}{description}",
                    pad_end(&service.name, 18),
                    pad_end(status, 8),
                    pad_end(&port, 5),
                ));
            }
            lines.push(String::new());
            lines.push("Bundles".to_string());
            for bundle in &state.config.bundles {
                lines.push(format!(
                    "  {}  [{}]",
                    bundle.name,
                    bundle.services.join(", ")
                ));
            }
        }
    }

    format!("{}\n", lines.join("\n"))
}

/// `String.prototype.padEnd`, which counts **UTF-16 code units** and never
/// truncates. `{:<width$}` would count `char`s, so a name holding an emoji
/// would line up differently under the two runtimes.
fn pad_end(value: &str, width: usize) -> String {
    let units = value.chars().map(char::len_utf16).sum::<usize>();
    if units >= width {
        return value.to_string();
    }
    format!("{value}{}", " ".repeat(width - units))
}

/// One keystroke, named the way Node's `readline` names it — those names are
/// what the reference's key handling is written against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Key {
    Up,
    Down,
    Escape,
    Quit,
    Char(char),
    /// A key the screen does nothing with — an unnamed escape sequence such as
    /// a left or right arrow. It still has to *arrive*, because the reference
    /// redraws after every keypress whether or not it acted on it, and a
    /// swallowed key means a frame the reference drew and this did not.
    Other,
}

/// Decode one chunk of stdin into keystrokes.
///
/// A chunk rather than a byte at a time, because that is how the distinction
/// between `escape` and an arrow key is actually made: a terminal sends
/// `ESC [ A` in one burst, so an `ESC` with nothing after it *in the same
/// read* is the escape key. Node's readline uses the same lookahead.
fn decode(chunk: &[u8]) -> Vec<Key> {
    let mut keys = Vec::new();
    let mut index = 0;
    while index < chunk.len() {
        match chunk[index] {
            // Ctrl-C, which the reference treats exactly as `q`.
            0x03 => {
                keys.push(Key::Quit);
                index += 1;
            }
            0x1b => {
                match chunk.get(index + 1..index + 3) {
                    Some(b"[A") => {
                        keys.push(Key::Up);
                        index += 3;
                    }
                    Some(b"[B") => {
                        keys.push(Key::Down);
                        index += 3;
                    }
                    // Consumed whole rather than decoded: emitting its bytes
                    // as characters would fire `s`/`x`/`r` actions from a
                    // keystroke nobody pressed. It still counts as a key, so
                    // the redraw happens.
                    Some(_) => {
                        keys.push(Key::Other);
                        index += 3;
                    }
                    None => {
                        keys.push(Key::Escape);
                        index = chunk.len();
                    }
                }
            }
            byte => {
                keys.push(Key::Char(byte as char));
                index += 1;
            }
        }
    }
    keys
}

pub async fn run(paths: &RuntimePaths, port: u16) -> CliResult {
    let store = nomoreide_core::config::ConfigStore::new(
        nomoreide_core::config::ConfigStore::default_path(),
    );
    let mut mode = Mode::Services;
    let mut selected_index: usize = 0;
    let mut selected_service: Option<String> = None;

    // Only on a terminal, matching the reference's `if (process.stdin.isTTY)`.
    // Piped input needs no raw mode, and asking for it would fail.
    let _raw = RawMode::enter();

    let mut keys = key_reader();
    render(
        paths,
        port,
        &store,
        mode,
        selected_index,
        &mut selected_service,
    )
    .await?;

    while let Some(key) = keys.recv().await {
        let config = store.load().await?;
        let service = config.services.get(selected_index).cloned();
        let bundle = config.bundles.get(selected_index).cloned();

        if key == Key::Quit || key == Key::Char('q') {
            // Services belong to the daemon and keep running after this exits.
            break;
        }

        let client = connect(paths, port).await?;
        match key {
            Key::Up => selected_index = selected_index.saturating_sub(1),
            Key::Down => {
                let count = if mode == Mode::Bundles {
                    config.bundles.len()
                } else {
                    config.services.len()
                };
                // `Math.min(Math.max(0, max), index + 1)` where `max` is
                // `length - 1`: an empty list clamps to 0, not to -1.
                let max = count.saturating_sub(1);
                selected_index = (selected_index + 1).min(max);
            }
            Key::Char('b') => {
                mode = if mode == Mode::Bundles {
                    Mode::Services
                } else {
                    Mode::Bundles
                };
                selected_index = 0;
            }
            Key::Char('l') => {
                if let Some(service) = &service {
                    mode = Mode::Logs;
                    selected_service = Some(service.name.clone());
                }
            }
            Key::Escape => mode = Mode::Services,
            Key::Char('s') => act(&client, mode, &service, &bundle, ServiceAction::Start).await?,
            Key::Char('x') => act(&client, mode, &service, &bundle, ServiceAction::Stop).await?,
            Key::Char('r') => {
                // No bundle branch, as in the reference: `r` restarts the
                // selected *service* whatever mode the screen is in.
                if let Some(service) = &service {
                    client
                        .service_action_value(&service.name, ServiceAction::Restart)
                        .await
                        .map_err(daemon_failure)?;
                }
            }
            _ => {}
        }

        render(
            paths,
            port,
            &store,
            mode,
            selected_index,
            &mut selected_service,
        )
        .await?;
    }
    Ok(())
}

async fn act(
    client: &DaemonClient,
    mode: Mode,
    service: &Option<ServiceDef>,
    bundle: &Option<nomoreide_core::config::BundleDef>,
    action: ServiceAction,
) -> CliResult {
    if mode == Mode::Bundles {
        if let Some(bundle) = bundle {
            client
                .bundle_action_value(&bundle.name, action)
                .await
                .map_err(daemon_failure)?;
        }
        return Ok(());
    }
    if let Some(service) = service {
        client
            .service_action_value(&service.name, action)
            .await
            .map_err(daemon_failure)?;
    }
    Ok(())
}

/// Draw one frame.
///
/// `\x1bc` is a full terminal reset, which is what the reference clears with —
/// not a cursor-home plus erase. It scrolls the previous frame out of the
/// scrollback rather than overwriting it, and a gate reading a pipe sees the
/// escape as the frame separator.
async fn render(
    paths: &RuntimePaths,
    port: u16,
    store: &nomoreide_core::config::ConfigStore,
    mode: Mode,
    selected_index: usize,
    selected_service: &mut Option<String>,
) -> CliResult {
    use std::io::Write;

    let config = store.load().await?;
    let client = connect(paths, port).await?;
    let current = selected_service
        .clone()
        .or_else(|| config.services.get(selected_index).map(|s| s.name.clone()));
    let statuses = client.status().await.map_err(daemon_failure)?;
    let runtime: HashMap<String, String> = statuses
        .into_iter()
        .map(|status| (status.name, state_label(status.state).to_string()))
        .collect();
    let logs = match &current {
        Some(name) => client.logs(name, 200).await.map_err(daemon_failure)?,
        None => Vec::new(),
    };
    let output = render_screen(&ScreenState {
        mode,
        selected_index,
        selected_service: current.as_deref(),
        config: &config,
        runtime: &runtime,
        logs: &logs,
    });
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(b"\x1bc");
    let _ = stdout.write_all(output.as_bytes());
    let _ = stdout.flush();
    Ok(())
}

fn state_label(state: ServiceRuntimeState) -> &'static str {
    match state {
        ServiceRuntimeState::Stopped => "stopped",
        ServiceRuntimeState::Starting => "starting",
        ServiceRuntimeState::Running => "running",
        ServiceRuntimeState::Stopping => "stopping",
        ServiceRuntimeState::Exited => "exited",
    }
}

/// Read stdin on its own thread and hand keystrokes to the async loop.
///
/// A thread rather than async stdin because the read has to keep working while
/// the loop is awaiting the daemon, and because raw-mode stdin has no useful
/// async form on the platforms this runs on.
fn key_reader() -> tokio::sync::mpsc::UnboundedReceiver<Key> {
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut stdin = std::io::stdin().lock();
        let mut buffer = [0u8; 256];
        loop {
            match stdin.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    for key in decode(&buffer[..count]) {
                        if sender.send(key).is_err() {
                            return;
                        }
                    }
                }
            }
        }
    });
    receiver
}

async fn connect(paths: &RuntimePaths, port: u16) -> Result<DaemonClient, CliError> {
    DaemonClient::discover(paths, port, env!("CARGO_PKG_VERSION"))
        .await
        .map_err(daemon_failure)
}

fn daemon_failure(error: nomoreide_daemon_client::DaemonClientError) -> CliError {
    CliError::Failure(error.to_string())
}

#[cfg(unix)]
struct RawMode {
    original: Option<libc::termios>,
}

#[cfg(unix)]
impl RawMode {
    fn enter() -> Self {
        let fd = libc::STDIN_FILENO;
        if unsafe { libc::isatty(fd) } != 1 {
            return Self { original: None };
        }
        let mut original = unsafe { std::mem::zeroed::<libc::termios>() };
        if unsafe { libc::tcgetattr(fd, &mut original) } != 0 {
            return Self { original: None };
        }
        let mut raw = original;
        unsafe { libc::cfmakeraw(&mut raw) };
        if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &raw) } != 0 {
            return Self { original: None };
        }
        Self {
            original: Some(original),
        }
    }
}

#[cfg(unix)]
impl Drop for RawMode {
    /// Restored on the way out however the loop ended. A TUI that exits
    /// leaving the terminal in raw mode leaves the *shell* unusable, which is
    /// worse than anything the TUI itself could get wrong.
    fn drop(&mut self) {
        if let Some(original) = self.original {
            unsafe {
                libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &original);
            }
        }
    }
}

#[cfg(not(unix))]
struct RawMode;

#[cfg(not(unix))]
impl RawMode {
    fn enter() -> Self {
        Self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_escape_with_nothing_after_it_is_the_escape_key() {
        assert_eq!(decode(b"\x1b"), vec![Key::Escape]);
        assert_eq!(decode(b"\x1b[A"), vec![Key::Up]);
        assert_eq!(decode(b"\x1b[B"), vec![Key::Down]);
        // An unnamed arrow key is consumed whole — three bytes — so none of it
        // leaks through as a character that would trigger an action. It is
        // still reported, because the screen redraws on any key.
        assert_eq!(decode(b"\x1b[Cq"), vec![Key::Other, Key::Char('q')]);
    }

    #[test]
    fn ctrl_c_quits_like_q() {
        assert_eq!(decode(b"\x03"), vec![Key::Quit]);
        assert_eq!(decode(b"q"), vec![Key::Char('q')]);
    }

    #[test]
    fn pad_end_counts_utf16_code_units_and_never_truncates() {
        assert_eq!(pad_end("api", 6), "api   ");
        assert_eq!(
            pad_end("a-very-long-service-name", 6),
            "a-very-long-service-name"
        );
        // One astral character is two UTF-16 units, so it consumes two columns
        // of padding the way JavaScript counts them.
        assert_eq!(pad_end("\u{1F600}", 4), "\u{1F600}  ");
    }
}
