//! The menu-bar menu, built from a [`Snapshot`], and what its items mean.
//!
//! Item ids carry their whole meaning (`svc:stop:api`), so a click is decoded
//! by [`Command::parse`] alone and the menu can be rebuilt freely in between.

use nomoreide_daemon_client::protocol::ServiceRuntimeState;
use tray_icon::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};

use super::poller::{ServiceRow, Snapshot, Verb};

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Command {
    OpenWindow,
    OpenBrowser,
    OpenUrl(String),
    ToggleLogin,
    StartDaemon,
    Service(Verb, String),
    Bundle(Verb, String),
    Reload,
    Quit,
    StopDaemonAndQuit,
}

fn verb(text: &str) -> Option<Verb> {
    match text {
        "start" => Some(Verb::Start),
        "stop" => Some(Verb::Stop),
        "restart" => Some(Verb::Restart),
        _ => None,
    }
}

fn verb_id(verb: Verb) -> &'static str {
    match verb {
        Verb::Start => "start",
        Verb::Stop => "stop",
        Verb::Restart => "restart",
    }
}

impl Command {
    pub(super) fn parse(id: &str) -> Option<Self> {
        Some(match id {
            "open" => Self::OpenWindow,
            "browser" => Self::OpenBrowser,
            "login" | "app-login" => Self::ToggleLogin,
            "daemon:start" => Self::StartDaemon,
            "reload" => Self::Reload,
            "quit" => Self::Quit,
            "daemon:stop-quit" => Self::StopDaemonAndQuit,
            _ => {
                let (kind, rest) = id.split_once(':')?;
                if kind == "url" {
                    return Some(Self::OpenUrl(rest.to_string()));
                }
                let (action, name) = rest.split_once(':')?;
                let action = verb(action)?;
                match kind {
                    "svc" => Self::Service(action, name.to_string()),
                    "bundle" => Self::Bundle(action, name.to_string()),
                    _ => return None,
                }
            }
        })
    }
}

fn glyph(state: ServiceRuntimeState) -> &'static str {
    match state {
        ServiceRuntimeState::Running => "●",
        ServiceRuntimeState::Starting | ServiceRuntimeState::Stopping => "◐",
        ServiceRuntimeState::Exited => "✕",
        ServiceRuntimeState::Stopped => "○",
    }
}

fn is_up(state: ServiceRuntimeState) -> bool {
    matches!(
        state,
        ServiceRuntimeState::Running | ServiceRuntimeState::Starting
    )
}

pub(super) fn service_label(row: &ServiceRow) -> String {
    match row.port {
        Some(port) => format!("{}  {}  :{port}", glyph(row.state), row.name),
        None => format!("{}  {}", glyph(row.state), row.name),
    }
}

pub(super) fn summary(snapshot: &Snapshot) -> String {
    if snapshot.url.is_none() {
        return match &snapshot.problem {
            Some(problem) => format!("Daemon unavailable: {problem}"),
            None => "Daemon is not running".to_string(),
        };
    }
    let running = snapshot
        .services
        .iter()
        .filter(|row| is_up(row.state))
        .count();
    match snapshot.services.len() {
        0 => "No services registered".to_string(),
        total => format!("{running} of {total} services running"),
    }
}

fn item(id: impl Into<String>, text: &str) -> MenuItem {
    MenuItem::with_id(id.into(), text, true, None)
}

fn service_menu(row: &ServiceRow) -> tray_icon::menu::Result<Submenu> {
    let id = |verb: Verb| format!("svc:{}:{}", verb_id(verb), row.name);
    let mut items: Vec<MenuItem> = if is_up(row.state) {
        vec![
            item(id(Verb::Stop), "Stop"),
            item(id(Verb::Restart), "Restart"),
        ]
    } else {
        vec![item(id(Verb::Start), "Start")]
    };
    if let (Some(port), true) = (row.port, row.state == ServiceRuntimeState::Running) {
        let url = format!("http://localhost:{port}");
        items.push(item(format!("url:{url}"), &format!("Open {url}")));
    }
    let refs: Vec<&dyn IsMenuItem> = items.iter().map(|i| i as &dyn IsMenuItem).collect();
    Submenu::with_items(service_label(row), true, &refs)
}

fn bundles_menu(bundles: &[String]) -> tray_icon::menu::Result<Submenu> {
    let menu = Submenu::new("Bundles", true);
    for name in bundles {
        menu.append(&Submenu::with_items(
            name,
            true,
            &[
                &item(format!("bundle:start:{name}"), "Start All"),
                &item(format!("bundle:stop:{name}"), "Stop All"),
            ],
        )?)?;
    }
    Ok(menu)
}

/// Up to this many services, the menu lists them all; past it, only the ones
/// doing something, with the full list one level down.
const INLINE_LIMIT: usize = 8;

/// Which services sit at the top of the menu, and the full list behind
/// "All Services" when there are too many to show. Someone with 25 registered
/// services cares about the two that are running and the one that crashed.
fn split_services(services: &[ServiceRow]) -> (Vec<&ServiceRow>, Option<&[ServiceRow]>) {
    if services.len() <= INLINE_LIMIT {
        return (services.iter().collect(), None);
    }
    let active = services
        .iter()
        .filter(|row| row.state != ServiceRuntimeState::Stopped)
        .collect();
    (active, Some(services))
}

pub(super) fn tray_menu(snapshot: &Snapshot, login: bool) -> tray_icon::menu::Result<Menu> {
    let menu = Menu::new();
    menu.append(&MenuItem::new(summary(snapshot), false, None))?;
    if snapshot.url.is_none() {
        menu.append(&item("daemon:start", "Start Daemon"))?;
    } else {
        let (shown, all) = split_services(&snapshot.services);
        if !shown.is_empty() || all.is_some() {
            menu.append(&PredefinedMenuItem::separator())?;
        }
        for row in shown {
            menu.append(&service_menu(row)?)?;
        }
        if let Some(all) = all {
            let submenu = Submenu::new(format!("All Services ({})", all.len()), true);
            for row in all {
                submenu.append(&service_menu(row)?)?;
            }
            menu.append(&submenu)?;
        }
        if !snapshot.bundles.is_empty() {
            menu.append(&bundles_menu(&snapshot.bundles)?)?;
        }
    }
    menu.append_items(&[
        &PredefinedMenuItem::separator(),
        &item("open", "Open NoMoreIDE"),
        &item("browser", "Open in Browser"),
        &PredefinedMenuItem::separator(),
        &CheckMenuItem::with_id("login", "Start at Login", true, login, None),
        &PredefinedMenuItem::separator(),
        &item("quit", "Quit Menu Bar App"),
    ])?;
    if snapshot.url.is_some() {
        menu.append(&item("daemon:stop-quit", "Stop Daemon and Quit"))?;
    }
    Ok(menu)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(name: &str, port: Option<u16>, state: ServiceRuntimeState) -> ServiceRow {
        ServiceRow {
            name: name.to_string(),
            port,
            state,
        }
    }

    #[test]
    fn ids_round_trip_including_names_with_colons() {
        assert_eq!(
            Command::parse("svc:stop:api:v2"),
            Some(Command::Service(Verb::Stop, "api:v2".into()))
        );
        assert_eq!(
            Command::parse("bundle:start:web"),
            Some(Command::Bundle(Verb::Start, "web".into()))
        );
        assert_eq!(
            Command::parse("url:http://localhost:3000"),
            Some(Command::OpenUrl("http://localhost:3000".into()))
        );
        assert_eq!(Command::parse("app-login"), Some(Command::ToggleLogin));
        assert_eq!(Command::parse("svc:explode:api"), None);
    }

    #[test]
    fn the_summary_counts_what_is_up() {
        let snapshot = Snapshot {
            url: Some("http://127.0.0.1:4317/".into()),
            services: vec![
                row("web", Some(3000), ServiceRuntimeState::Running),
                row("api", None, ServiceRuntimeState::Starting),
                row("worker", None, ServiceRuntimeState::Exited),
            ],
            ..Snapshot::default()
        };
        assert_eq!(summary(&snapshot), "2 of 3 services running");
        assert_eq!(summary(&Snapshot::default()), "Daemon is not running");
    }

    #[test]
    fn a_long_list_shows_only_what_is_doing_something() {
        let few = vec![row("web", None, ServiceRuntimeState::Stopped)];
        assert_eq!(split_services(&few), (vec![&few[0]], None));

        let mut many: Vec<ServiceRow> = (0..INLINE_LIMIT)
            .map(|i| row(&format!("idle{i}"), None, ServiceRuntimeState::Stopped))
            .collect();
        many.push(row("api", None, ServiceRuntimeState::Running));
        many.push(row("worker", None, ServiceRuntimeState::Exited));
        let (shown, all) = split_services(&many);
        let names: Vec<&str> = shown.iter().map(|row| row.name.as_str()).collect();
        assert_eq!(names, ["api", "worker"]);
        assert_eq!(all.map(<[ServiceRow]>::len), Some(INLINE_LIMIT + 2));
    }

    #[test]
    fn a_label_shows_state_name_and_port() {
        let label = service_label(&row("web", Some(3000), ServiceRuntimeState::Running));
        assert_eq!(label, "●  web  :3000");
    }
}
