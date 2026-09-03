//! `nomoreide tui` — the interactive terminal service dashboard.
//!
//! A daemon client, not a supervisor: services keep running when this screen
//! exits. Ratatui owns the viewport and only paints changed cells, while
//! Crossterm owns terminal setup, input, resize events, and cleanup.

use std::collections::HashMap;
use std::io::{self, IsTerminal, Stdout};
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use nomoreide_core::config::{BundleDef, Config, ConfigStore, ServiceDef};
use nomoreide_daemon_client::{
    protocol::{ServiceLogEntry, ServiceRuntimeState},
    DaemonClient, RuntimePaths, ServiceAction,
};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Layout, Margin, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Cell, Paragraph, Row, Table, TableState};
use ratatui::{Frame, Terminal};

use crate::commands::{CliError, CliResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Services,
    Bundles,
    Logs,
}

struct App {
    mode: Mode,
    selected_index: usize,
    selected_service: Option<String>,
    log_offset: usize,
    notice: Option<String>,
}

struct Snapshot {
    config: Config,
    runtime: HashMap<String, String>,
    logs: Vec<ServiceLogEntry>,
    current_service: Option<String>,
}

const LOG_PAGE: usize = 20;
const ACCENT: Color = Color::Indexed(141);
const CYAN: Color = Color::Indexed(81);
const GREEN: Color = Color::Indexed(84);
const YELLOW: Color = Color::Indexed(221);
const RED: Color = Color::Indexed(203);
const MUTED: Color = Color::Indexed(245);
const FAINT: Color = Color::Indexed(239);
const SELECTED_BG: Color = Color::Indexed(236);

pub async fn run(paths: &RuntimePaths, port: u16) -> CliResult {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(CliError::Failure(
            "The TUI requires an interactive terminal.".to_string(),
        ));
    }

    let store = ConfigStore::new(ConfigStore::default_path());
    let client = connect(paths, port).await?;
    let mut terminal = TerminalSession::enter().map_err(terminal_failure)?;
    let mut events = event_reader();
    let mut app = App {
        mode: Mode::Services,
        selected_index: 0,
        selected_service: None,
        log_offset: 0,
        notice: None,
    };

    refresh(&mut terminal, &client, &store, &mut app).await?;
    let mut ticker = tokio::time::interval(Duration::from_secs(1));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticker.tick().await;

    loop {
        let input = tokio::select! {
            input = events.recv() => match input {
                Some(input) => Some(input),
                None => break,
            },
            _ = ticker.tick() => None,
        };

        match input {
            None | Some(Input::Resize) => {}
            Some(Input::Key(key)) => {
                if is_quit(key) {
                    break;
                }
                handle_key(&client, &store, &terminal, &mut app, key).await?;
            }
        }
        refresh(&mut terminal, &client, &store, &mut app).await?;
    }
    Ok(())
}

async fn handle_key(
    client: &DaemonClient,
    store: &ConfigStore,
    terminal: &TerminalSession,
    app: &mut App,
    key: KeyEvent,
) -> CliResult {
    let config = store.load().await?;
    let service = config.services.get(app.selected_index).cloned();
    let bundle = config.bundles.get(app.selected_index).cloned();
    let page = terminal.list_page_size();

    match key.code {
        KeyCode::Up if app.mode == Mode::Logs => app.log_offset = app.log_offset.saturating_add(1),
        KeyCode::Up => app.selected_index = app.selected_index.saturating_sub(1),
        KeyCode::Down if app.mode == Mode::Logs => {
            app.log_offset = app.log_offset.saturating_sub(1)
        }
        KeyCode::Down => {
            let count = selected_count(app.mode, &config);
            app.selected_index = app
                .selected_index
                .saturating_add(1)
                .min(count.saturating_sub(1));
        }
        KeyCode::PageUp if app.mode == Mode::Logs => {
            app.log_offset = app.log_offset.saturating_add(LOG_PAGE)
        }
        KeyCode::PageDown if app.mode == Mode::Logs => {
            app.log_offset = app.log_offset.saturating_sub(LOG_PAGE)
        }
        KeyCode::PageUp => app.selected_index = app.selected_index.saturating_sub(page),
        KeyCode::PageDown => {
            let count = selected_count(app.mode, &config);
            app.selected_index = app
                .selected_index
                .saturating_add(page)
                .min(count.saturating_sub(1));
        }
        KeyCode::End if app.mode == Mode::Logs => app.log_offset = 0,
        KeyCode::Esc => {
            app.mode = Mode::Services;
            app.selected_index = 0;
            app.log_offset = 0;
        }
        KeyCode::Char('b' | 'B') => {
            app.mode = if app.mode == Mode::Bundles {
                Mode::Services
            } else {
                Mode::Bundles
            };
            app.selected_index = 0;
            app.log_offset = 0;
        }
        KeyCode::Char('l' | 'L') => {
            if let Some(service) = &service {
                app.mode = Mode::Logs;
                app.selected_service = Some(service.name.clone());
                app.log_offset = 0;
            }
        }
        KeyCode::Char('s' | 'S') if app.mode != Mode::Logs => {
            let target = selected_target(app.mode, &service, &bundle);
            let result = act(client, app.mode, &service, &bundle, ServiceAction::Start).await;
            app.notice = Some(action_notice(result, "Start", target));
        }
        KeyCode::Char('x' | 'X') if app.mode != Mode::Logs => {
            let target = selected_target(app.mode, &service, &bundle);
            let result = act(client, app.mode, &service, &bundle, ServiceAction::Stop).await;
            app.notice = Some(action_notice(result, "Stop", target));
        }
        KeyCode::Char('r' | 'R') if app.mode == Mode::Services => {
            if let Some(service) = &service {
                let result = client
                    .service_action_value(&service.name, ServiceAction::Restart)
                    .await
                    .map(|_| ())
                    .map_err(daemon_failure);
                app.notice = Some(action_notice(result, "Restart", Some(&service.name)));
            } else {
                app.notice = Some("No service selected".to_string());
            }
        }
        _ => {}
    }
    Ok(())
}

fn selected_count(mode: Mode, config: &Config) -> usize {
    if mode == Mode::Bundles {
        config.bundles.len()
    } else {
        config.services.len()
    }
}

fn is_quit(key: KeyEvent) -> bool {
    key.code == KeyCode::Char('q')
        || key.code == KeyCode::Char('Q')
        || (key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL))
}

async fn refresh(
    terminal: &mut TerminalSession,
    client: &DaemonClient,
    store: &ConfigStore,
    app: &mut App,
) -> CliResult {
    let snapshot = snapshot(client, store, app).await?;
    app.selected_index = app
        .selected_index
        .min(selected_count(app.mode, &snapshot.config).saturating_sub(1));
    terminal
        .draw(|frame| render_ui(frame, app, &snapshot))
        .map_err(terminal_failure)?;
    Ok(())
}

async fn snapshot(
    client: &DaemonClient,
    store: &ConfigStore,
    app: &App,
) -> Result<Snapshot, CliError> {
    let config = store.load().await?;
    let current_service = app.selected_service.clone().or_else(|| {
        config
            .services
            .get(app.selected_index)
            .map(|service| service.name.clone())
    });
    let statuses = client.status().await.map_err(daemon_failure)?;
    let runtime = statuses
        .into_iter()
        .map(|status| (status.name, state_label(status.state).to_string()))
        .collect();
    let logs = match (app.mode, &current_service) {
        (Mode::Logs, Some(name)) => client.logs(name, 200).await.map_err(daemon_failure)?,
        _ => Vec::new(),
    };
    Ok(Snapshot {
        config,
        runtime,
        logs,
        current_service,
    })
}

fn render_ui(frame: &mut Frame, app: &App, snapshot: &Snapshot) {
    let notice_height = u16::from(app.notice.is_some()) * 2;
    let [header, body, notice, footer] = Layout::vertical([
        Constraint::Length(3),
        Constraint::Min(1),
        Constraint::Length(notice_height),
        Constraint::Length(2),
    ])
    .areas(frame.area());

    render_header(frame, header, app.mode, snapshot);
    match app.mode {
        Mode::Services => render_services(frame, body, app, snapshot),
        Mode::Bundles => render_bundles(frame, body, app, snapshot),
        Mode::Logs => render_logs(frame, body, app, snapshot),
    }
    if let Some(message) = &app.notice {
        let color = if message.starts_with("Could not") {
            RED
        } else {
            ACCENT
        };
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled("  ◆  ", Style::default().fg(color)),
                Span::styled(message, Style::default().fg(Color::White)),
            ])),
            notice,
        );
    }
    frame.render_widget(Paragraph::new(footer_lines(app.mode)), footer);
}

fn render_header(frame: &mut Frame, area: Rect, mode: Mode, snapshot: &Snapshot) {
    let running = snapshot
        .runtime
        .values()
        .filter(|status| status.as_str() == "running")
        .count();
    let title = Line::from(vec![
        Span::styled(
            "◆",
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
        ),
        Span::raw("  "),
        Span::styled(
            "NoMoreIDE",
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled("  SERVICE CONTROL", Style::default().fg(MUTED)),
    ]);
    let summary = Line::from(vec![
        Span::raw("   "),
        tab("SERVICES", mode == Mode::Services),
        Span::raw(" "),
        tab("BUNDLES", mode == Mode::Bundles),
        Span::raw(" "),
        tab("LOGS", mode == Mode::Logs),
        Span::styled(
            format!("   {} services  ·  ", snapshot.config.services.len()),
            Style::default().fg(MUTED),
        ),
        Span::styled(format!("{running} running"), Style::default().fg(GREEN)),
    ]);
    frame.render_widget(Paragraph::new(vec![title, summary]), area);
}

fn tab(label: &'static str, selected: bool) -> Span<'static> {
    if selected {
        Span::styled(
            format!("[ {label} ]"),
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        )
    } else {
        Span::styled(format!("  {label}  "), Style::default().fg(MUTED))
    }
}

fn render_services(frame: &mut Frame, area: Rect, app: &App, snapshot: &Snapshot) {
    let rows = snapshot.config.services.iter().map(|service| {
        let status = snapshot
            .runtime
            .get(&service.name)
            .map(String::as_str)
            .unwrap_or("stopped");
        let (color, marker) = status_style(status);
        Row::new(vec![
            Cell::from(service.name.clone()),
            Cell::from(Line::from(vec![
                Span::styled(marker, Style::default().fg(color)),
                Span::raw(format!(" {status}")),
            ])),
            Cell::from(
                service
                    .port
                    .map_or_else(|| "—".to_string(), |port| format!(":{port}")),
            ),
            Cell::from(
                service
                    .description
                    .clone()
                    .unwrap_or_else(|| "—".to_string()),
            ),
        ])
    });
    let table = Table::new(
        rows,
        [
            Constraint::Length(24),
            Constraint::Length(12),
            Constraint::Length(8),
            Constraint::Min(12),
        ],
    )
    .header(table_header(["SERVICE", "STATUS", "PORT", "DESCRIPTION"]))
    .block(panel("SERVICES", "runtime and local ports"))
    .row_highlight_style(Style::default().bg(SELECTED_BG))
    .highlight_symbol("› ");
    let mut state = TableState::default()
        .with_selected((!snapshot.config.services.is_empty()).then_some(app.selected_index));
    frame.render_stateful_widget(table, area, &mut state);

    if snapshot.config.services.is_empty() {
        render_empty(
            frame,
            area,
            "No services configured",
            "Add one with `nomoreide add service`.",
        );
    }
}

fn render_bundles(frame: &mut Frame, area: Rect, app: &App, snapshot: &Snapshot) {
    let rows = snapshot.config.bundles.iter().map(|bundle| {
        let status = bundle_status(&bundle.services, &snapshot.runtime);
        let (color, marker) = status_style(status);
        let members = if bundle.services.is_empty() {
            "No services".to_string()
        } else {
            bundle.services.join("  ·  ")
        };
        Row::new(vec![
            Cell::from(bundle.name.clone()),
            Cell::from(Line::from(vec![
                Span::styled(marker, Style::default().fg(color)),
                Span::raw(format!(" {status}")),
            ])),
            Cell::from(members).style(Style::default().fg(MUTED)),
        ])
    });
    let table = Table::new(
        rows,
        [
            Constraint::Length(24),
            Constraint::Length(12),
            Constraint::Min(12),
        ],
    )
    .header(table_header(["BUNDLE", "STATUS", "SERVICES"]))
    .block(panel("BUNDLES", "coordinated service groups"))
    .row_highlight_style(Style::default().bg(SELECTED_BG))
    .highlight_symbol("› ");
    let mut state = TableState::default()
        .with_selected((!snapshot.config.bundles.is_empty()).then_some(app.selected_index));
    frame.render_stateful_widget(table, area, &mut state);

    if snapshot.config.bundles.is_empty() {
        render_empty(
            frame,
            area,
            "No bundles configured",
            "Create one with `nomoreide add bundle`.",
        );
    }
}

fn render_logs(frame: &mut Frame, area: Rect, app: &App, snapshot: &Snapshot) {
    let service = snapshot
        .current_service
        .as_deref()
        .unwrap_or("No service selected");
    let effective_offset = app.log_offset.min(snapshot.logs.len().saturating_sub(1));
    let end = snapshot.logs.len().saturating_sub(effective_offset);
    let capacity = usize::from(area.height.saturating_sub(2)).max(1);
    let start = end.saturating_sub(capacity);
    let state = if effective_offset == 0 {
        format!("{service}  ·  LIVE")
    } else {
        format!("{service}  ·  paused {effective_offset} lines from live")
    };
    let lines = snapshot.logs[start..end].iter().map(|entry| {
        let (color, marker) = if entry.stream == "stderr" {
            (RED, "!")
        } else {
            (CYAN, "·")
        };
        Line::from(vec![
            Span::styled(
                format!("{:<12}", compact_timestamp(&entry.timestamp)),
                Style::default().fg(MUTED),
            ),
            Span::styled(format!("  {marker}  "), Style::default().fg(color)),
            Span::raw(sanitize(&entry.text)),
        ])
    });
    frame.render_widget(
        Paragraph::new(lines.collect::<Vec<_>>()).block(panel("LOGS", &state)),
        area,
    );
    if snapshot.logs.is_empty() {
        render_empty(
            frame,
            area,
            "Waiting for output",
            "Logs will appear here as the service writes them.",
        );
    }
}

fn panel<'a>(title: &'a str, detail: &'a str) -> Block<'a> {
    Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(FAINT))
        .title(Line::from(vec![
            Span::styled(
                format!(" {title} "),
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(format!(" {detail} "), Style::default().fg(MUTED)),
        ]))
}

fn table_header<const N: usize>(labels: [&'static str; N]) -> Row<'static> {
    Row::new(labels.map(Cell::from)).style(Style::default().fg(MUTED))
}

fn render_empty(frame: &mut Frame, area: Rect, title: &str, hint: &str) {
    let inner = area.inner(Margin {
        vertical: 2,
        horizontal: 3,
    });
    frame.render_widget(
        Paragraph::new(vec![
            Line::styled(
                title.to_string(),
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD),
            ),
            Line::styled(hint.to_string(), Style::default().fg(MUTED)),
        ]),
        inner,
    );
}

fn footer_lines(mode: Mode) -> Vec<Line<'static>> {
    match mode {
        Mode::Services => vec![
            hint_line(&[
                ("↑↓/Pg", "Navigate"),
                ("S", "Start"),
                ("X", "Stop"),
                ("R", "Restart"),
            ]),
            hint_line(&[("L", "Logs"), ("B", "Bundles"), ("Q", "Quit")]),
        ],
        Mode::Bundles => vec![hint_line(&[
            ("↑↓/Pg", "Navigate"),
            ("S", "Start all"),
            ("X", "Stop all"),
            ("Esc", "Services"),
            ("Q", "Quit"),
        ])],
        Mode::Logs => vec![hint_line(&[
            ("↑↓", "Scroll"),
            ("PgUp/PgDn", "Page"),
            ("End", "Live"),
            ("Esc", "Services"),
            ("Q", "Quit"),
        ])],
    }
}

fn hint_line(hints: &[(&str, &str)]) -> Line<'static> {
    let mut spans = vec![Span::raw("  ")];
    for (index, (key, action)) in hints.iter().enumerate() {
        if index > 0 {
            spans.push(Span::styled("  ·  ", Style::default().fg(FAINT)));
        }
        spans.push(Span::styled(
            (*key).to_string(),
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        ));
        spans.push(Span::styled(
            format!(" {action}"),
            Style::default().fg(MUTED),
        ));
    }
    Line::from(spans)
}

fn status_style(status: &str) -> (Color, &'static str) {
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

fn sanitize(value: &str) -> String {
    value
        .chars()
        .filter_map(|character| match character {
            '\r' | '\n' | '\t' => Some(' '),
            character if character.is_control() => None,
            character => Some(character),
        })
        .collect()
}

fn selected_target<'a>(
    mode: Mode,
    service: &'a Option<ServiceDef>,
    bundle: &'a Option<BundleDef>,
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
    bundle: &Option<BundleDef>,
    action: ServiceAction,
) -> CliResult {
    if mode == Mode::Bundles {
        if let Some(bundle) = bundle {
            client
                .bundle_action_value(&bundle.name, action)
                .await
                .map_err(daemon_failure)?;
        }
    } else if let Some(service) = service {
        client
            .service_action_value(&service.name, action)
            .await
            .map_err(daemon_failure)?;
    }
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

async fn connect(paths: &RuntimePaths, port: u16) -> Result<DaemonClient, CliError> {
    DaemonClient::discover(paths, port, env!("CARGO_PKG_VERSION"))
        .await
        .map_err(daemon_failure)
}

fn daemon_failure(error: nomoreide_daemon_client::DaemonClientError) -> CliError {
    CliError::Failure(error.to_string())
}

fn terminal_failure(error: io::Error) -> CliError {
    CliError::Failure(error.to_string())
}

enum Input {
    Key(KeyEvent),
    Resize,
}

fn event_reader() -> tokio::sync::mpsc::UnboundedReceiver<Input> {
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
    std::thread::spawn(move || loop {
        match event::read() {
            Ok(Event::Key(key))
                if matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) =>
            {
                if sender.send(Input::Key(key)).is_err() {
                    break;
                }
            }
            Ok(Event::Resize(_, _)) => {
                if sender.send(Input::Resize).is_err() {
                    break;
                }
            }
            Ok(_) => {}
            Err(_) => break,
        }
    });
    receiver
}

struct TerminalSession {
    terminal: Terminal<CrosstermBackend<Stdout>>,
}

impl TerminalSession {
    fn enter() -> io::Result<Self> {
        enable_raw_mode()?;
        let mut stdout = io::stdout();
        if let Err(error) = execute!(stdout, EnterAlternateScreen) {
            let _ = disable_raw_mode();
            return Err(error);
        }
        let terminal = match Terminal::new(CrosstermBackend::new(stdout)) {
            Ok(terminal) => terminal,
            Err(error) => {
                let _ = disable_raw_mode();
                let _ = execute!(io::stdout(), LeaveAlternateScreen);
                return Err(error);
            }
        };
        Ok(Self { terminal })
    }

    fn draw<F>(&mut self, draw: F) -> io::Result<()>
    where
        F: FnOnce(&mut Frame),
    {
        self.terminal.draw(draw).map(|_| ())
    }

    fn list_page_size(&self) -> usize {
        self.terminal
            .size()
            .map(|area| usize::from(area.height.saturating_sub(8)).max(1))
            .unwrap_or(LOG_PAGE)
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(self.terminal.backend_mut(), LeaveAlternateScreen);
        let _ = self.terminal.show_cursor();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;

    fn buffer_text(app: &App, snapshot: &Snapshot, width: u16, height: u16) -> String {
        let backend = TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).expect("test terminal");
        terminal
            .draw(|frame| render_ui(frame, app, snapshot))
            .expect("draw frame");
        terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .fold(String::new(), |mut output, cell| {
                output.push_str(cell.symbol());
                output
            })
    }

    fn app(mode: Mode) -> App {
        App {
            mode,
            selected_index: 0,
            selected_service: None,
            log_offset: 0,
            notice: None,
        }
    }

    fn snapshot(config: Config) -> Snapshot {
        Snapshot {
            config,
            runtime: HashMap::new(),
            logs: Vec::new(),
            current_service: None,
        }
    }

    #[test]
    fn services_screen_has_an_actionable_empty_state() {
        let output = buffer_text(&app(Mode::Services), &snapshot(Config::default()), 100, 24);
        assert!(output.contains("NoMoreIDE"));
        assert!(output.contains("No services configured"));
        assert!(output.contains("nomoreide add service"));
    }

    #[test]
    fn core_service_controls_fit_an_eighty_column_terminal() {
        let output = buffer_text(&app(Mode::Services), &snapshot(Config::default()), 80, 24);
        assert!(output.contains("Navigate"));
        assert!(output.contains("Restart"));
        assert!(output.contains("Bundles"));
        assert!(output.contains("Quit"));
    }

    #[test]
    fn a_long_service_list_scrolls_inside_one_frame() {
        let mut config = Config::default();
        for index in 0..30 {
            config.services.push(
                serde_json::from_value(serde_json::json!({
                    "name": format!("service-{index:02}")
                }))
                .expect("service fixture"),
            );
        }
        let mut app = app(Mode::Services);
        app.selected_index = 29;
        let output = buffer_text(&app, &snapshot(config), 100, 16);
        assert!(!output.contains("service-00"));
        assert!(output.contains("service-29"));
        assert_eq!(output.chars().count(), 100 * 16);
    }

    #[test]
    fn logs_are_clipped_to_the_panel_height() {
        let mut snapshot = snapshot(Config::default());
        snapshot.current_service = Some("api".to_string());
        snapshot.logs = (0..30)
            .map(|index| ServiceLogEntry {
                service: "api".into(),
                stream: "stdout".into(),
                text: format!("line-{index:02}"),
                timestamp: "2026-09-02T12:34:56.000Z".into(),
            })
            .collect();
        let output = buffer_text(&app(Mode::Logs), &snapshot, 100, 16);
        assert!(!output.contains("line-00"));
        assert!(output.contains("line-29"));
        assert_eq!(output.chars().count(), 100 * 16);
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

    #[test]
    fn log_text_cannot_inject_terminal_controls() {
        assert_eq!(sanitize("one\ntwo\x1b[2J"), "one two[2J");
    }
}
