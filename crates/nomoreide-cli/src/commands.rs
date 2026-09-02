//! The Rust half of `src/cli/commands.ts` — everything `runCli` dispatches.
//!
//! Two contracts here are worth more than they look:
//!
//! * **The exit code is part of the interface.** The reference answers `1` for
//!   a caller's mistake (bad usage, an invalid config, a setup conflict) and
//!   `2` for anything else, and scripts branch on the difference. [`CliError`]
//!   below is that distinction and nothing else.
//! * **Output goes to the stream the reference chose.** Results are stdout;
//!   the single error line is stderr. A command that printed its refusal to
//!   stdout would still "work" interactively and quietly corrupt every
//!   pipeline that reads it.

use std::collections::HashMap;

use nomoreide_core::config::{is_config_validation_error, BundleDef, ConfigStore, ServiceDef};
use nomoreide_daemon_client::{DaemonClient, DaemonClientError, RuntimePaths, ServiceAction};

use crate::flags::{parse_flags, Flags};

pub const USAGE: &str = "Usage: nomoreide [mcp|setup|tui|web|daemon|git|db|agents|profile|remote|list|logs|start|stop|restart|add]";

/// A failure on its way to an exit code.
pub enum CliError {
    /// The caller got the command wrong, or handed over something the config
    /// layer refuses. Exit 1.
    Usage(String),
    /// Everything else — a daemon that would not answer, a filesystem that
    /// would not write. Exit 2.
    Failure(String),
    /// Exit 1 with nothing on stderr: the command ran, printed its report, and
    /// the report's verdict is "no". `agents doctor` is the only one — the
    /// reference returns 1 from the body rather than throwing, so nothing is
    /// printed to stderr on the way out.
    Silent,
}

impl CliError {
    pub fn usage(message: impl Into<String>) -> Self {
        Self::Usage(message.into())
    }

    fn code(&self) -> u8 {
        match self {
            Self::Usage(_) | Self::Silent => 1,
            Self::Failure(_) => 2,
        }
    }

    /// The exit code, for callers outside [`run`] — `tui` reports its own.
    pub fn exit_code(&self) -> u8 {
        self.code()
    }

    /// The stderr line, for the same callers.
    pub fn message_text(&self) -> Option<&str> {
        self.message()
    }

    fn message(&self) -> Option<&str> {
        match self {
            Self::Usage(message) | Self::Failure(message) => Some(message),
            Self::Silent => None,
        }
    }
}

/// Anything from the core layer, sorted into the reference's two buckets.
///
/// `ConfigValidationError` is the reference's own class and lands on exit 1;
/// every other core failure is exit 2. `is_config_validation_error` is how the
/// Rust side recognises the same condition through `anyhow`.
impl From<anyhow::Error> for CliError {
    fn from(error: anyhow::Error) -> Self {
        let message = format!("{error}");
        if is_config_validation_error(&error) {
            Self::Usage(message)
        } else {
            Self::Failure(message)
        }
    }
}

pub type CliResult = Result<(), CliError>;

/// Run one CLI invocation and return its exit code.
pub async fn run(args: &[String], paths: &RuntimePaths, port: u16) -> u8 {
    match dispatch(args, paths, port).await {
        Ok(()) => 0,
        Err(error) => {
            if let Some(message) = error.message() {
                eprintln!("{message}");
            }
            error.code()
        }
    }
}

async fn dispatch(args: &[String], paths: &RuntimePaths, port: u16) -> CliResult {
    let command = args.first().map(String::as_str);
    let subcommand = args.get(1).map(String::as_str);
    let rest = args.get(2..).unwrap_or(&[]).to_vec();
    let store = ConfigStore::new(ConfigStore::default_path());

    match (command, subcommand) {
        (Some("git"), _) => crate::git::run(subcommand, &rest, &store).await,
        (Some("agents"), _) => crate::agents::run(subcommand, &rest),
        (Some("db"), _) => crate::database::run(subcommand, &rest, &store).await,
        (Some("profile"), _) => crate::profile::run(subcommand, &rest).await,
        (Some("remote"), _) => crate::remote::run(subcommand, &rest).await,
        (Some("add"), Some("service")) => add_service(&store, &rest).await,
        (Some("add"), Some("bundle")) => add_bundle(&store, &rest).await,
        (Some("list"), _) => list(&store).await,
        (Some("logs"), _) => logs(subcommand, paths, port).await,
        (Some(command @ ("start" | "stop" | "restart")), _) => {
            service_action(command, subcommand, &store, paths, port).await
        }
        _ => Err(CliError::usage(USAGE)),
    }
}

// ---------------------------------------------------------------- add

async fn add_service(store: &ConfigStore, rest: &[String]) -> CliResult {
    let name = rest
        .first()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| CliError::usage("service name is required"))?;
    // The name is positional, so flags start one argument later — the
    // reference slices before parsing rather than filtering after.
    let flags = parse_flags(rest.get(1..).unwrap_or(&[]));

    let kind = flags.nullish("kind").unwrap_or("local").to_string();
    // `flags.port ? Number(...) : undefined` — a *truthy* test, so `--port=`
    // means "no port" rather than port zero.
    let port = flags.truthy("port").map(js_number_to_port).transpose()?;
    let description = flags.nullish("description").map(str::to_string);
    let env = flags
        .nullish("env")
        .map(|value| parse_string_map_flag(value, "--env"))
        .transpose()?;
    let args = flags
        .nullish("args")
        .map(|value| parse_string_array_flag(value, "--args"))
        .transpose()?;

    let service = match kind.as_str() {
        "docker-compose" => {
            let compose_service = flags
                .truthy("composeService")
                .ok_or_else(|| CliError::usage("--compose-service is required"))?;
            ServiceDef {
                name: name.clone(),
                kind: Some("docker-compose".into()),
                cwd: Some(flag_or_cwd(&flags, "cwd")),
                compose_file: flags.nullish("composeFile").map(str::to_string),
                compose_service: Some(compose_service.to_string()),
                port,
                description,
                ..blank_service()
            }
        }
        "ssh" => {
            // Checked in the reference's order — host, then command, then cwd
            // — because a caller who omitted all three should be told about
            // the same one both runtimes name first.
            let host = flags
                .truthy("host")
                .ok_or_else(|| CliError::usage("--host is required"))?;
            let command = flags
                .truthy("command")
                .ok_or_else(|| CliError::usage("--command is required"))?;
            // `--cwd` is required here rather than defaulting to the local
            // working directory: the path is on the remote host, and this
            // machine's cwd means nothing there.
            let cwd = flags
                .truthy("cwd")
                .ok_or_else(|| CliError::usage("--cwd is required"))?;
            ServiceDef {
                name: name.clone(),
                kind: Some("ssh".into()),
                host: Some(host.to_string()),
                cwd: Some(cwd.to_string()),
                command: Some(command.to_string()),
                env,
                port,
                description,
                ..blank_service()
            }
        }
        _ => ServiceDef {
            name: name.clone(),
            command: Some(
                flags
                    .truthy("command")
                    .ok_or_else(|| CliError::usage("--command is required"))?
                    .to_string(),
            ),
            args,
            cwd: Some(flag_or_cwd(&flags, "cwd")),
            port,
            env,
            description,
            ..blank_service()
        },
    };

    store.register_service(service).await?;
    println!("Registered service {name}");
    Ok(())
}

async fn add_bundle(store: &ConfigStore, rest: &[String]) -> CliResult {
    let name = rest
        .first()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| CliError::usage("bundle name is required"))?;
    let services: Vec<String> = rest.get(1..).unwrap_or(&[]).to_vec();
    if services.is_empty() {
        return Err(CliError::usage("at least one service is required"));
    }
    store
        .register_bundle(
            BundleDef {
                name: name.clone(),
                services,
            },
            None,
        )
        .await?;
    println!("Registered bundle {name}");
    Ok(())
}

// ---------------------------------------------------------------- list

async fn list(store: &ConfigStore) -> CliResult {
    let config = store.load().await?;
    println!("Services");
    for service in &config.services {
        // A compose or ssh service has no `command`, and the reference prints
        // the JavaScript interpolation of `undefined` rather than skipping the
        // column. Reproduced literally: the column count is what a script
        // splitting on tabs depends on.
        println!(
            "{}\t{}\t{}\t{}",
            service.name,
            service
                .port
                .map_or_else(|| "-".to_string(), |port| port.to_string()),
            service.command.as_deref().unwrap_or("undefined"),
            service.cwd.as_deref().unwrap_or("undefined"),
        );
    }
    println!("Bundles");
    for bundle in &config.bundles {
        println!("{}\t{}", bundle.name, bundle.services.join(","));
    }
    Ok(())
}

// ---------------------------------------------------------------- daemon-backed

async fn logs(name: Option<&str>, paths: &RuntimePaths, port: u16) -> CliResult {
    let name = name
        .filter(|name| !name.is_empty())
        .ok_or_else(|| CliError::usage("service name is required"))?;
    let client = connect(paths, port).await?;
    let entries = client.logs(name, 200).await.map_err(daemon_failure)?;
    for entry in entries {
        println!("{}\t{}\t{}", entry.timestamp, entry.stream, entry.text);
    }
    Ok(())
}

async fn service_action(
    command: &str,
    name: Option<&str>,
    store: &ConfigStore,
    paths: &RuntimePaths,
    port: u16,
) -> CliResult {
    let name = name
        .filter(|name| !name.is_empty())
        .ok_or_else(|| CliError::usage("service or bundle name is required"))?;
    // Whether the name is a bundle is a config question, asked before the
    // daemon is contacted — the same order the reference uses, so a name that
    // is neither fails as a service rather than as a bundle.
    let config = store.load().await?;
    let is_bundle = config.bundles.iter().any(|bundle| bundle.name == name);
    let client = connect(paths, port).await?;

    // The `_value` methods hand back the daemon's own document rather than a
    // struct round-trip, so key order survives and so does an explicit
    // `"exitCode": null` — the reference prints what the daemon said, and this
    // is printed straight into a pipeline.
    let answer = match (command, is_bundle) {
        ("start", true) => client.bundle_action_value(name, ServiceAction::Start).await,
        ("start", false) => {
            client
                .service_action_value(name, ServiceAction::Start)
                .await
        }
        ("stop", true) => client.bundle_action_value(name, ServiceAction::Stop).await,
        ("stop", false) => client.service_action_value(name, ServiceAction::Stop).await,
        // `restart` has no bundle branch in the reference: restarting a bundle
        // name restarts the *service* of that name, and fails if there is
        // none. Kept, rather than quietly improved.
        (_, _) => {
            client
                .service_action_value(name, ServiceAction::Restart)
                .await
        }
    }
    .map_err(daemon_failure)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&answer).unwrap_or_else(|_| "null".into())
    );
    Ok(())
}

async fn connect(paths: &RuntimePaths, port: u16) -> Result<DaemonClient, CliError> {
    DaemonClient::discover(paths, port, env!("CARGO_PKG_VERSION"))
        .await
        .map_err(daemon_failure)
}

/// A daemon refusal, reported the way the reference reports it: the daemon's
/// own sentence and nothing else.
///
/// `DaemonClientError`'s `Display` prefixes the transport detail — "daemon
/// mutation failed (500 Internal Server Error): ..." — which is right for a
/// log and wrong here. The user asked to start a service and the answer is
/// `Service "x" is not registered.`; the status code in front of it is noise
/// they cannot act on.
fn daemon_failure(error: DaemonClientError) -> CliError {
    CliError::Failure(match error {
        DaemonClientError::Mutation(api) => api.message.clone(),
        DaemonClientError::Http { message, .. } => message,
        other => other.to_string(),
    })
}

// ---------------------------------------------------------------- helpers

/// Every optional field of a `ServiceDef` left empty, so each branch above
/// spells out only the fields it actually sets.
fn blank_service() -> ServiceDef {
    ServiceDef {
        name: String::new(),
        kind: None,
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

fn flag_or_cwd(flags: &Flags, name: &str) -> String {
    match flags.nullish(name) {
        Some(value) => value.to_string(),
        None => std::env::current_dir()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

/// `Number(flags.port)` in the reference, which accepts anything JS accepts
/// and hands the result to the config schema. A value the schema rejects comes
/// back as a validation error — exit 1 — so this only has to refuse what
/// cannot become a port number at all.
fn js_number_to_port(value: &str) -> Result<u16, CliError> {
    let number = nomoreide_core::js_number::parse(value);
    if number.is_nan() || number.fract() != 0.0 || number < 0.0 || number > f64::from(u16::MAX) {
        // The reference hands `NaN` to the config schema and lets Zod refuse
        // it, which is exit 1 — a caller's mistake, not a runtime failure.
        return Err(CliError::usage(
            "service.port must be an integer between 0 and 65535",
        ));
    }
    Ok(number as u16)
}

fn parse_string_array_flag(value: &str, name: &str) -> Result<Vec<String>, CliError> {
    let parsed: serde_json::Value = serde_json::from_str(value)
        .map_err(|_| CliError::usage(format!("{name} must be a JSON array of strings")))?;
    let items = parsed
        .as_array()
        .filter(|items| items.iter().all(serde_json::Value::is_string))
        .ok_or_else(|| CliError::usage(format!("{name} must be a JSON array of strings")))?;
    Ok(items
        .iter()
        .filter_map(|item| item.as_str().map(str::to_string))
        .collect())
}

fn parse_string_map_flag(value: &str, name: &str) -> Result<HashMap<String, String>, CliError> {
    let parsed: serde_json::Value = serde_json::from_str(value)
        .map_err(|_| CliError::usage(format!("{name} must be a JSON object with string values")))?;
    let entries = parsed
        .as_object()
        .filter(|entries| entries.values().all(serde_json::Value::is_string))
        .ok_or_else(|| {
            CliError::usage(format!("{name} must be a JSON object with string values"))
        })?;
    Ok(entries
        .iter()
        .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_string())))
        .collect())
}
