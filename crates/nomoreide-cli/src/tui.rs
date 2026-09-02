//! `nomoreide tui` — the interactive terminal service dashboard.
//!
//! A **daemon client**, not a supervisor: it starts and stops services through
//! the machine-global daemon, so everything it launched is still running after
//! it quits, and the status it shows is every session's services rather than
//! its own. Quitting is therefore not a shutdown, which is why `q` says
//! nothing about the services it leaves behind.
//!
//! [`render_screen`] is deliberately a pure function of a snapshot. Keeping
//! layout separate from I/O makes the visual hierarchy and ANSI output easy to
//! test without starting a daemon or taking terminal screenshots.

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
    /// Number of lines between the viewport and the live end of the log.
    pub log_offset: usize,
    pub notice: Option<&'a str>,
}

struct RenderOptions<'a> {
    mode: Mode,
    selected_index: usize,
    selected_service: &'a mut Option<String>,
    log_offset: usize,
    notice: Option<&'a str>,
}

/// How many recent log lines are shown before the terminal viewport clips.
const LOG_TAIL: usize = 20;

const RESET: &str = "\x1b[0m";
const BOLD: &str = "\x1b[1m";
const DIM: &str = "\x1b[2m";
const WHITE: &str = "\x1b[38;5;255m";
const MUTED: &str = "\x1b[38;5;245m";
const FAINT: &str = "\x1b[38;5;239m";
const ACCENT: &str = "\x1b[38;5;141m";
const CYAN: &str = "\x1b[38;5;81m";
const GREEN: &str = "\x1b[38;5;84m";
const YELLOW: &str = "\x1b[38;5;221m";
const RED: &str = "\x1b[38;5;203m";
const SELECTED_BG: &str = "\x1b[48;5;236m";
const PANEL_WIDTH: usize = 92;

pub fn render_screen(state: &ScreenState) -> String {
    let running = state
        .runtime
        .values()
        .filter(|status| status.as_str() == "running")
        .count();
    let mut lines = vec![format!(
        "{BOLD}{ACCENT}◆{RESET}  {BOLD}{WHITE}NoMoreIDE{RESET}  {DIM}{MUTED}SERVICE CONTROL{RESET}"
    )];
    lines.push(format!(
        "   {}   {DIM}{MUTED}{} services  ·  {GREEN}{running} running{RESET}",
        render_tabs(state.mode),
        state.config.services.len()
    ));
    lines.push(String::new());

    match state.mode {
        Mode::Bundles => {
            panel_top(&mut lines, "BUNDLES", "coordinated service groups");
            let header = format!(
                "{DIM}{MUTED}{}  {}  SERVICES{RESET}",
                pad_end("BUNDLE", 24),
                pad_end("STATUS", 12),
            );
            panel_row(&mut lines, &header, false);
            lines.push(format!("{FAINT}├{}┤{RESET}", "─".repeat(PANEL_WIDTH)));
            for (index, bundle) in state.config.bundles.iter().enumerate() {
                let members = if bundle.services.is_empty() {
                    "No services".to_string()
                } else {
                    fit(&bundle.services.join("  ·  "), 44)
                };
                let status = bundle_status(&bundle.services, state.runtime);
                let (status_color, status_dot) = status_style(status);
                let status_cell = format!("{status_color}{status_dot} {status}{RESET}");
                let content = format!(
                    "{}  {}{}  {DIM}{MUTED}{members}{RESET}",
                    pad_end(&fit(&bundle.name, 24), 24),
                    status_cell,
                    " ".repeat(12usize.saturating_sub(status.len() + 2)),
                );
                panel_row(&mut lines, &content, index == state.selected_index);
            }
            if state.config.bundles.is_empty() {
                panel_empty(
                    &mut lines,
                    "No bundles configured",
                    "Create one with `nomoreide add bundle`.",
                );
            }
            panel_bottom(&mut lines);
        }
        Mode::Logs => {
            let service = state.selected_service.unwrap_or("No service selected");
            let effective_offset = state.log_offset.min(state.logs.len().saturating_sub(1));
            let end = state.logs.len().saturating_sub(effective_offset);
            let start = end.saturating_sub(LOG_TAIL);
            let log_state = if effective_offset == 0 {
                format!("{service}  ·  LIVE")
            } else {
                format!("{service}  ·  paused {effective_offset} lines from live")
            };
            panel_top(&mut lines, "LOGS", &log_state);
            for entry in &state.logs[start..end] {
                let (stream_color, stream_marker) = if entry.stream == "stderr" {
                    (RED, "!")
                } else {
                    (CYAN, "·")
                };
                let content = format!(
                    "{DIM}{MUTED}{}{RESET}  {stream_color}{stream_marker}{RESET}  {}",
                    compact_timestamp(&entry.timestamp),
                    fit(&entry.text, 72)
                );
                panel_row(&mut lines, &content, false);
            }
            if state.logs.is_empty() {
                panel_empty(
                    &mut lines,
                    "Waiting for output",
                    "Logs will appear here as the service writes them.",
                );
            }
            panel_bottom(&mut lines);
        }
        Mode::Services => {
            panel_top(&mut lines, "SERVICES", "runtime and local ports");
            panel_header(&mut lines, "SERVICE", "STATUS", "PORT", "DESCRIPTION");
            for (index, service) in state.config.services.iter().enumerate() {
                let status = state
                    .runtime
                    .get(&service.name)
                    .map(String::as_str)
                    .unwrap_or("stopped");
                let port = service
                    .port
                    .map_or_else(|| "—".to_string(), |port| format!(":{port}"));
                let description = fit(service.description.as_deref().unwrap_or("—"), 36);
                let (status_color, status_dot) = status_style(status);
                let status_cell = format!("{status_color}{status_dot} {status}{RESET}");
                let content = format!(
                    "{}  {}{}  {CYAN}{}{RESET}  {DIM}{MUTED}{description}{RESET}",
                    pad_end(&fit(&service.name, 24), 24),
                    status_cell,
                    " ".repeat(12usize.saturating_sub(status.len() + 2)),
                    pad_end(&port, 8),
                );
                panel_row(&mut lines, &content, index == state.selected_index);
            }
            if state.config.services.is_empty() {
                panel_empty(
                    &mut lines,
                    "No services configured",
                    "Add one with `nomoreide add service`.",
                );
            }
            panel_bottom(&mut lines);
        }
    }

    if let Some(notice) = state.notice {
        let color = if notice.starts_with("Could not") {
            RED
        } else {
            ACCENT
        };
        lines.push(String::new());
        lines.push(format!(
            "   {color}◆{RESET}  {WHITE}{}{RESET}",
            fit(notice, 84)
        ));
    }
    lines.push(String::new());
    lines.push(render_footer(state.mode));

    format!("{}\n", lines.join("\n"))
}

fn render_tabs(mode: Mode) -> String {
    [
        (Mode::Services, "SERVICES"),
        (Mode::Bundles, "BUNDLES"),
        (Mode::Logs, "LOGS"),
    ]
    .into_iter()
    .map(|(tab, label)| {
        if tab == mode {
            format!("{BOLD}{WHITE}[ {label} ]{RESET}")
        } else {
            format!("{DIM}{MUTED}  {label}  {RESET}")
        }
    })
    .collect::<Vec<_>>()
    .join(" ")
}

fn panel_top(lines: &mut Vec<String>, title: &str, detail: &str) {
    let label = format!(" {title} ");
    let detail = format!(" {} ", fit(detail, 48));
    let fill = PANEL_WIDTH.saturating_sub(label.chars().count() + detail.chars().count() + 1);
    lines.push(format!(
        "{FAINT}╭─{RESET}{BOLD}{WHITE}{label}{RESET}{FAINT}{}{RESET}{DIM}{MUTED}{detail}{RESET}{FAINT}╮{RESET}",
        "─".repeat(fill)
    ));
}

fn panel_header(
    lines: &mut Vec<String>,
    service: &str,
    status: &str,
    port: &str,
    description: &str,
) {
    let content = format!(
        "{DIM}{MUTED}{}  {}  {}  {description}{RESET}",
        pad_end(service, 24),
        pad_end(status, 12),
        pad_end(port, 8),
    );
    panel_row(lines, &content, false);
    lines.push(format!("{FAINT}├{}┤{RESET}", "─".repeat(PANEL_WIDTH)));
}

fn panel_row(lines: &mut Vec<String>, content: &str, selected: bool) {
    let marker = if selected {
        format!("{ACCENT}›{RESET}{SELECTED_BG}")
    } else {
        " ".to_string()
    };
    let background = if selected { SELECTED_BG } else { "" };
    let content = if selected {
        content.replace(RESET, &format!("{RESET}{SELECTED_BG}"))
    } else {
        content.to_string()
    };
    let padding = " ".repeat(PANEL_WIDTH.saturating_sub(visible_width(&content) + 4));
    lines.push(format!(
        "{FAINT}│{RESET}{background} {marker} {content}{padding} {RESET}{FAINT}│{RESET}"
    ));
}

fn panel_empty(lines: &mut Vec<String>, title: &str, hint: &str) {
    panel_row(lines, "", false);
    panel_row(lines, &format!("{BOLD}{WHITE}{title}{RESET}"), false);
    panel_row(lines, &format!("{DIM}{MUTED}{hint}{RESET}"), false);
    panel_row(lines, "", false);
}

fn panel_bottom(lines: &mut Vec<String>) {
    lines.push(format!("{FAINT}╰{}╯{RESET}", "─".repeat(PANEL_WIDTH)));
}

fn render_footer(mode: Mode) -> String {
    let mut hints = if mode == Mode::Logs {
        vec![("↑↓", "Scroll"), ("PgUp/PgDn", "Page"), ("End", "Live")]
    } else {
        vec![("↑↓", "Navigate")]
    };
    if mode == Mode::Services {
        hints.extend([("S", "Start"), ("X", "Stop")]);
    } else if mode == Mode::Bundles {
        hints.extend([("S", "Start all"), ("X", "Stop all")]);
    }
    if mode == Mode::Services {
        hints.extend([("R", "Restart"), ("L", "Logs"), ("B", "Bundles")]);
    } else {
        hints.push(("Esc", "Services"));
    }
    hints.push(("Q", "Quit"));

    let rendered = hints
        .into_iter()
        .map(|(key, action)| format!("{BOLD}{WHITE}{key}{RESET} {DIM}{MUTED}{action}{RESET}"))
        .collect::<Vec<_>>()
        .join(&format!("  {FAINT}·{RESET}  "));
    format!("   {rendered}")
}

fn status_style(status: &str) -> (&'static str, &'static str) {
    match status {
        "running" => (GREEN, "●"),
        "starting" | "stopping" | "partial" => (YELLOW, "◐"),
        "exited" => (RED, "●"),
        _ => (MUTED, "○"),
    }
}

fn bundle_status(services: &[String], runtime: &HashMap<String, String>) -> &'static str {
    if services.is_empty() {
        return "empty";
    }

    let running = services
        .iter()
        .filter(|service| runtime.get(*service).map(String::as_str) == Some("running"))
        .count();
    if running == services.len() {
        "running"
    } else if running == 0
        && services.iter().all(|service| {
            runtime
                .get(service)
                .map(|status| status == "stopped")
                .unwrap_or(true)
        })
    {
        "stopped"
    } else {
        "partial"
    }
}

fn compact_timestamp(timestamp: &str) -> &str {
    timestamp
        .split('T')
        .nth(1)
        .and_then(|time| time.get(..8))
        .unwrap_or(timestamp)
}

fn visible_width(value: &str) -> usize {
    let mut in_escape = false;
    value
        .chars()
        .filter(|character| {
            if *character == '\x1b' {
                in_escape = true;
                return false;
            }
            if in_escape {
                if *character == 'm' {
                    in_escape = false;
                }
                return false;
            }
            true
        })
        .count()
}

fn fit(value: &str, width: usize) -> String {
    if value.chars().count() <= width {
        return value.to_string();
    }
    if width == 0 {
        return String::new();
    }
    let mut fitted = value
        .chars()
        .take(width.saturating_sub(1))
        .collect::<String>();
    fitted.push('…');
    fitted
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
    PageUp,
    PageDown,
    End,
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
                let remaining = &chunk[index..];
                if remaining.starts_with(b"\x1b[5~") {
                    keys.push(Key::PageUp);
                    index += 4;
                } else if remaining.starts_with(b"\x1b[6~") {
                    keys.push(Key::PageDown);
                    index += 4;
                } else if remaining.starts_with(b"\x1b[F") || remaining.starts_with(b"\x1b[4~") {
                    keys.push(Key::End);
                    index += if remaining.starts_with(b"\x1b[4~") {
                        4
                    } else {
                        3
                    };
                } else if remaining.starts_with(b"\x1b[A") {
                    keys.push(Key::Up);
                    index += 3;
                } else if remaining.starts_with(b"\x1b[B") {
                    keys.push(Key::Down);
                    index += 3;
                } else if remaining.len() == 1 {
                    keys.push(Key::Escape);
                    index = chunk.len();
                } else {
                    // Consume an unknown escape sequence as one inert key so
                    // its bytes cannot accidentally trigger service actions.
                    keys.push(Key::Other);
                    index += remaining.len().min(3);
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
    let mut log_offset: usize = 0;
    let mut notice: Option<String> = None;

    // Only on a terminal, matching the reference's `if (process.stdin.isTTY)`.
    // Piped input needs no raw mode, and asking for it would fail.
    let _terminal = TerminalSession::enter();

    let mut keys = key_reader();
    render(
        paths,
        port,
        &store,
        RenderOptions {
            mode,
            selected_index,
            selected_service: &mut selected_service,
            log_offset,
            notice: notice.as_deref(),
        },
    )
    .await?;

    let mut refresh = tokio::time::interval(std::time::Duration::from_secs(1));
    refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // `interval` yields immediately once; the initial frame above already
    // covers that tick.
    refresh.tick().await;

    loop {
        let key = tokio::select! {
            key = keys.recv() => match key {
                Some(key) => Some(key),
                None => break,
            },
            _ = refresh.tick() => None,
        };

        let Some(key) = key else {
            render(
                paths,
                port,
                &store,
                RenderOptions {
                    mode,
                    selected_index,
                    selected_service: &mut selected_service,
                    log_offset,
                    notice: notice.as_deref(),
                },
            )
            .await?;
            continue;
        };

        let config = store.load().await?;
        let service = config.services.get(selected_index).cloned();
        let bundle = config.bundles.get(selected_index).cloned();

        if key == Key::Quit || matches!(key, Key::Char('q' | 'Q')) {
            // Services belong to the daemon and keep running after this exits.
            break;
        }

        let client = connect(paths, port).await?;
        match key {
            Key::Up if mode == Mode::Logs => log_offset = log_offset.saturating_add(1),
            Key::Up => selected_index = selected_index.saturating_sub(1),
            Key::Down if mode == Mode::Logs => log_offset = log_offset.saturating_sub(1),
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
            Key::Char('b' | 'B') => {
                mode = if mode == Mode::Bundles {
                    Mode::Services
                } else {
                    Mode::Bundles
                };
                selected_index = 0;
                log_offset = 0;
            }
            Key::Char('l' | 'L') => {
                if let Some(service) = &service {
                    mode = Mode::Logs;
                    selected_service = Some(service.name.clone());
                    log_offset = 0;
                }
            }
            Key::PageUp if mode == Mode::Logs => log_offset = log_offset.saturating_add(LOG_TAIL),
            Key::PageDown if mode == Mode::Logs => log_offset = log_offset.saturating_sub(LOG_TAIL),
            Key::End if mode == Mode::Logs => log_offset = 0,
            Key::Escape => {
                mode = Mode::Services;
                log_offset = 0;
            }
            Key::Char('s' | 'S') if mode != Mode::Logs => {
                let target = selected_target(mode, &service, &bundle);
                let result = act(&client, mode, &service, &bundle, ServiceAction::Start).await;
                notice = Some(action_notice(result, "Start", target));
            }
            Key::Char('x' | 'X') if mode != Mode::Logs => {
                let target = selected_target(mode, &service, &bundle);
                let result = act(&client, mode, &service, &bundle, ServiceAction::Stop).await;
                notice = Some(action_notice(result, "Stop", target));
            }
            Key::Char('r' | 'R') if mode == Mode::Services => {
                if let Some(service) = &service {
                    let result = client
                        .service_action_value(&service.name, ServiceAction::Restart)
                        .await
                        .map(|_| ())
                        .map_err(daemon_failure);
                    notice = Some(action_notice(result, "Restart", Some(&service.name)));
                } else {
                    notice = Some("No service selected".to_string());
                }
            }
            _ => {}
        }

        render(
            paths,
            port,
            &store,
            RenderOptions {
                mode,
                selected_index,
                selected_service: &mut selected_service,
                log_offset,
                notice: notice.as_deref(),
            },
        )
        .await?;
    }
    Ok(())
}

fn selected_target<'a>(
    mode: Mode,
    service: &'a Option<ServiceDef>,
    bundle: &'a Option<nomoreide_core::config::BundleDef>,
) -> Option<&'a str> {
    if mode == Mode::Bundles {
        bundle.as_ref().map(|bundle| bundle.name.as_str())
    } else {
        service.as_ref().map(|service| service.name.as_str())
    }
}

fn action_notice(result: CliResult, action: &str, target: Option<&str>) -> String {
    let Some(target) = target else {
        return "Nothing selected".to_string();
    };
    match result {
        Ok(()) => format!("{action} requested for {target}"),
        Err(error) => format!(
            "Could not {} {}: {}",
            action.to_lowercase(),
            target,
            error.message_text().unwrap_or("unknown error")
        ),
    }
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
/// Replace the current alternate-screen frame without touching shell history.
async fn render(
    paths: &RuntimePaths,
    port: u16,
    store: &nomoreide_core::config::ConfigStore,
    options: RenderOptions<'_>,
) -> CliResult {
    use std::io::Write;

    let RenderOptions {
        mode,
        selected_index,
        selected_service,
        log_offset,
        notice,
    } = options;
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
    let logs = match (mode, &current) {
        (Mode::Logs, Some(name)) => client.logs(name, 200).await.map_err(daemon_failure)?,
        _ => Vec::new(),
    };
    let output = render_screen(&ScreenState {
        mode,
        selected_index,
        selected_service: current.as_deref(),
        config: &config,
        runtime: &runtime,
        logs: &logs,
        log_offset,
        notice,
    });
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(b"\x1b[H\x1b[2J");
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

struct TerminalSession {
    _raw: RawMode,
    interactive: bool,
}

impl TerminalSession {
    fn enter() -> Self {
        use std::io::{IsTerminal, Write};

        let interactive = std::io::stdin().is_terminal() && std::io::stdout().is_terminal();
        if interactive {
            let mut stdout = std::io::stdout().lock();
            let _ = stdout.write_all(b"\x1b[?1049h\x1b[?25l");
            let _ = stdout.flush();
        }
        Self {
            _raw: RawMode::enter(),
            interactive,
        }
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        if self.interactive {
            use std::io::Write;

            let mut stdout = std::io::stdout().lock();
            let _ = stdout.write_all(b"\x1b[0m\x1b[?25h\x1b[?1049l");
            let _ = stdout.flush();
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
        assert_eq!(decode(b"\x1b[5~"), vec![Key::PageUp]);
        assert_eq!(decode(b"\x1b[6~"), vec![Key::PageDown]);
        assert_eq!(decode(b"\x1b[F"), vec![Key::End]);
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

    #[test]
    fn fit_truncates_long_cells_without_breaking_the_panel() {
        assert_eq!(fit("short", 8), "short");
        assert_eq!(fit("a very long value", 8), "a very …");
        assert_eq!(fit("anything", 0), "");
    }

    #[test]
    fn empty_services_screen_has_navigation_color_and_an_actionable_state() {
        let config = Config::default();
        let runtime = HashMap::new();
        let output = render_screen(&ScreenState {
            mode: Mode::Services,
            selected_index: 0,
            selected_service: None,
            config: &config,
            runtime: &runtime,
            logs: &[],
            log_offset: 0,
            notice: None,
        });

        assert!(output.contains("\x1b[38;5;141m"));
        assert!(output.contains("[ SERVICES ]"));
        assert!(output.contains("No services configured"));
        assert!(output.contains("nomoreide add service"));
        assert!(output.contains('╭'));
        assert!(output.contains('╯'));
    }

    #[test]
    fn logs_can_pause_behind_the_live_tail() {
        let config = Config::default();
        let runtime = HashMap::new();
        let logs = ["oldest", "middle", "newest"].map(|text| ServiceLogEntry {
            service: "api".into(),
            stream: "stdout".into(),
            text: text.into(),
            timestamp: "2026-09-02T12:34:56.000Z".into(),
        });
        let output = render_screen(&ScreenState {
            mode: Mode::Logs,
            selected_index: 0,
            selected_service: Some("api"),
            config: &config,
            runtime: &runtime,
            logs: &logs,
            log_offset: 1,
            notice: None,
        });

        assert!(output.contains("paused 1 lines from live"));
        assert!(output.contains("oldest"));
        assert!(output.contains("middle"));
        assert!(!output.contains("newest"));
        assert!(output.contains("PgUp/PgDn"));
    }

    #[test]
    fn bundle_health_summarizes_all_members() {
        let services = vec!["api".to_string(), "web".to_string()];
        let mut runtime = HashMap::new();

        assert_eq!(bundle_status(&services, &runtime), "stopped");
        runtime.insert("api".into(), "running".into());
        assert_eq!(bundle_status(&services, &runtime), "partial");
        runtime.insert("web".into(), "running".into());
        assert_eq!(bundle_status(&services, &runtime), "running");
    }
}
