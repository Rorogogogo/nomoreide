//! What a "connect" terminal runs for a registered service.
//!
//! The caller only ever names a service; the command is derived here. That is
//! what stops the endpoint behind it from being talked into running an
//! arbitrary program.

use super::agent::default_terminal_shell;
use super::spawn::TerminalSpawnSpec;
use crate::config::ServiceDef;
use std::ffi::OsString;

/// How a service is reached, once its definition has been read.
pub enum ServiceTerminal {
    /// An interactive shell in the service's own directory, an `ssh -t` into
    /// its host, or a `docker compose exec` in its project.
    Spawn(Box<TerminalSpawnSpec>),
    /// The definition names a kind it has no way to reach — an ssh service
    /// with no host, a compose service with no service name.
    Unreachable(String),
}

/// Build the spawn for a service tab.
///
pub fn resolve_service_terminal(
    service: &ServiceDef,
    id: String,
    fallback_cwd: &str,
) -> ServiceTerminal {
    match service.effective_kind() {
        "ssh" => {
            let Some(host) = service.host.as_ref().filter(|host| !host.is_empty()) else {
                return ServiceTerminal::Unreachable("SSH service is missing a host.".to_string());
            };
            let remote = match service.cwd.as_deref() {
                Some(cwd) => format!("cd {} 2>/dev/null; exec \"$SHELL\" -l", single_quote(cwd)),
                None => "exec \"$SHELL\" -l".to_string(),
            };
            ServiceTerminal::Spawn(Box::new(TerminalSpawnSpec {
                id,
                service_name: Some(service.name.clone()),
                cwd: fallback_cwd.to_string(),
                shell: OsString::from("ssh"),
                args: vec!["-t".to_string(), host.clone(), remote],
                env: Vec::new(),
                label: Some(service.name.clone()),
                kind: Some("service".to_string()),
                provider: None,
            }))
        }
        "docker-compose" => {
            let Some(compose_service) = service
                .compose_service
                .as_ref()
                .filter(|name| !name.is_empty())
            else {
                return ServiceTerminal::Unreachable(
                    "Docker service is missing a compose service name.".to_string(),
                );
            };
            let mut args = vec!["compose".to_string()];
            if let Some(file) = service.compose_file.as_deref() {
                args.push("-f".to_string());
                args.push(file.to_string());
            }
            args.push("exec".to_string());
            args.push(compose_service.clone());
            args.push("sh".to_string());
            ServiceTerminal::Spawn(Box::new(TerminalSpawnSpec {
                id,
                service_name: Some(service.name.clone()),
                cwd: service
                    .cwd
                    .clone()
                    .unwrap_or_else(|| fallback_cwd.to_string()),
                shell: OsString::from("docker"),
                args,
                env: Vec::new(),
                label: Some(service.name.clone()),
                kind: Some("service".to_string()),
                provider: None,
            }))
        }
        _ => ServiceTerminal::Spawn(Box::new(TerminalSpawnSpec {
            id,
            service_name: Some(service.name.clone()),
            cwd: service
                .cwd
                .clone()
                .unwrap_or_else(|| fallback_cwd.to_string()),
            shell: default_terminal_shell(),
            args: Vec::new(),
            env: service_terminal_env(service),
            label: Some(service.name.clone()),
            kind: Some("service".to_string()),
            provider: None,
        })),
    }
}

/// The environment a local service contributes to its own shell. A remote or
/// containerised service gets none: the assignments would apply to the client
/// side of the connection rather than to the shell the user is looking at.
///
/// Sorted, because a `HashMap` has no order of its own and an argv that changed
/// between two identical runs would be untestable.
pub fn service_terminal_env(service: &ServiceDef) -> Vec<(String, String)> {
    if service.effective_kind() != "local" {
        return Vec::new();
    }
    let mut pairs: Vec<(String, String)> = service
        .env
        .clone()
        .unwrap_or_default()
        .into_iter()
        .collect();
    pairs.sort_by(|left, right| left.0.cmp(&right.0));
    pairs
}

/// Single-quote a value for interpolation into a remote shell command.
fn single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service(kind: &str) -> ServiceDef {
        ServiceDef {
            name: "api".to_string(),
            kind: Some(kind.to_string()),
            command: None,
            args: None,
            cwd: None,
            port: None,
            description: None,
            project_path: None,
            env: None,
            test: None,
            depends_on: None,
            compose_file: None,
            compose_service: None,
            host: None,
        }
    }

    #[test]
    fn an_ssh_service_without_a_host_is_unreachable() {
        assert!(matches!(
            resolve_service_terminal(&service("ssh"), "svc:api".to_string(), "/tmp"),
            ServiceTerminal::Unreachable(message) if message.contains("missing a host")
        ));
    }

    #[test]
    fn a_remote_directory_is_quoted_into_the_login_shell() {
        let mut definition = service("ssh");
        definition.host = Some("build-host".to_string());
        definition.cwd = Some("/srv/it's here".to_string());
        let ServiceTerminal::Spawn(spec) =
            resolve_service_terminal(&definition, "svc:api".to_string(), "/tmp")
        else {
            panic!("an ssh service with a host is reachable");
        };
        assert_eq!(
            spec.args[2],
            r#"cd '/srv/it'\''s here' 2>/dev/null; exec "$SHELL" -l"#
        );
    }

    #[test]
    fn a_compose_file_is_only_passed_when_the_definition_names_one() {
        let mut definition = service("docker-compose");
        definition.compose_service = Some("web".to_string());
        let ServiceTerminal::Spawn(spec) =
            resolve_service_terminal(&definition, "svc:api".to_string(), "/tmp")
        else {
            panic!("a compose service naming its service is reachable");
        };
        assert_eq!(spec.args, ["compose", "exec", "web", "sh"]);

        definition.compose_file = Some("stack.yml".to_string());
        let ServiceTerminal::Spawn(spec) =
            resolve_service_terminal(&definition, "svc:api".to_string(), "/tmp")
        else {
            panic!("a compose service naming its service is reachable");
        };
        assert_eq!(
            spec.args,
            ["compose", "-f", "stack.yml", "exec", "web", "sh"]
        );
    }

    #[test]
    fn only_a_local_service_contributes_its_environment() {
        let mut definition = service("local");
        definition.env = Some(std::collections::HashMap::from([(
            "PORT".to_string(),
            "3000".to_string(),
        )]));
        assert_eq!(service_terminal_env(&definition).len(), 1);
        definition.kind = Some("ssh".to_string());
        assert!(service_terminal_env(&definition).is_empty());
    }
}
