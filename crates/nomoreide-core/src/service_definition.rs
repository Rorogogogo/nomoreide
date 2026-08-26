//! Reading a service definition out of loosely-typed arguments, and refusing
//! one that describes nothing runnable.
//!
//! This mirrors the reference's `serviceSchema`, which is a **union** of three
//! arms — local, docker-compose, ssh. A caller can satisfy every field on its
//! own and still describe no service of any kind, which is why a refusal here
//! is shaped like the validator's own report rather than a sentence: it has to
//! say which of the three readings it tried and what each one was missing.
//!
//! It lives in core because two surfaces need the same answer: the MCP
//! registration tool and the dashboard's `POST /api/services`. The HTTP route
//! reaches it with a map it built from a form, which is the same shape the tool
//! receives, so both get the same report for the same mistake.

use serde::Serialize;
use serde_json::{Map, Value};

use crate::config::ServiceDef;

/// The three readings of a service definition, in the order the reference
/// tries them. A definition that satisfies more than one is the first: a local
/// service that also carries a `composeService` is local, and the compose field
/// is dropped rather than kept as a field nothing will read.
#[derive(Clone, Copy)]
enum Arm {
    Local,
    DockerCompose,
    Ssh,
}

/// One thing an arm requires, in the order the arm declares it — which is the
/// order its failures are reported in.
enum Check {
    /// The port, which lives on the shared base rather than on any arm — so it
    /// is checked before the arm's own fields, and reported in every arm.
    Port,
    /// The arm's `kind`. Only `local` may leave it out.
    Kind,
    /// A field that has to be there.
    Required(&'static str),
    /// `ssh`'s command: required, and refused outright if it carries a null
    /// byte, which a remote shell would read as the end of it.
    SshCommand,
    /// `local`'s argv, each member of which is refused for the same reason.
    Args,
    /// The environment map, whose keys have to look like environment names.
    Env,
}

const LOCAL_CHECKS: &[Check] = &[
    Check::Port,
    Check::Kind,
    Check::Required("command"),
    Check::Args,
    Check::Required("cwd"),
    Check::Env,
];
const COMPOSE_CHECKS: &[Check] = &[
    Check::Port,
    Check::Kind,
    Check::Required("cwd"),
    Check::Required("composeService"),
];
const SSH_CHECKS: &[Check] = &[
    Check::Port,
    Check::Kind,
    Check::Required("host"),
    Check::Required("cwd"),
    Check::SshCommand,
    Check::Env,
];

impl Arm {
    const ALL: [Arm; 3] = [Arm::Local, Arm::DockerCompose, Arm::Ssh];

    fn literal(self) -> &'static str {
        match self {
            Arm::Local => "local",
            Arm::DockerCompose => "docker-compose",
            Arm::Ssh => "ssh",
        }
    }

    fn checks(self) -> &'static [Check] {
        match self {
            Arm::Local => LOCAL_CHECKS,
            Arm::DockerCompose => COMPOSE_CHECKS,
            Arm::Ssh => SSH_CHECKS,
        }
    }

    fn failures(self, arguments: &Map<String, Value>) -> Vec<Issue> {
        self.checks()
            .iter()
            .flat_map(|check| match check {
                Check::Port => port_failure(arguments).into_iter().collect::<Vec<_>>(),
                Check::Kind => self.kind_failure(arguments).into_iter().collect::<Vec<_>>(),
                Check::Required(key) => missing(arguments, key).into_iter().collect(),
                Check::SshCommand => match string(arguments, "command") {
                    None => vec![Issue::missing("command")],
                    Some(command) if command.contains('\0') => vec![Issue::custom(
                        "SSH command contains invalid null byte.",
                        vec![Value::from("command")],
                    )],
                    Some(_) => Vec::new(),
                },
                Check::Args => arguments
                    .get("args")
                    .and_then(Value::as_array)
                    .map(|members| {
                        members
                            .iter()
                            .enumerate()
                            .filter(|(_, member)| {
                                member.as_str().is_some_and(|text| text.contains('\0'))
                            })
                            .map(|(index, _)| {
                                // The reference attaches no message to this
                                // refinement, so zod supplies its own.
                                Issue::custom("Invalid input", vec!["args".into(), index.into()])
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                Check::Env => environment_failure(arguments).into_iter().collect(),
            })
            .collect()
    }

    /// An absent `kind` is only ever the local arm's; the other two name
    /// themselves. The reference reports what it received alongside what it
    /// wanted, and says nothing about a value that was never sent.
    fn kind_failure(self, arguments: &Map<String, Value>) -> Option<Issue> {
        let kind = string(arguments, "kind");
        match kind {
            None if matches!(self, Arm::Local) => None,
            Some(kind) if kind == self.literal() => None,
            other => Some(Issue::Literal(LiteralIssue {
                received: other.map(str::to_string),
                code: "invalid_literal",
                expected: self.literal(),
                path: vec![Value::from("kind")],
                message: format!("Invalid literal value, expected \"{}\"", self.literal()),
            })),
        }
    }

    /// The definition this arm reads out of the arguments, carrying only the
    /// fields it knows about. Everything else is dropped, so a compose service
    /// never stores a `command` nothing would run.
    fn build(self, arguments: &Map<String, Value>) -> ServiceDef {
        let base = ServiceDef {
            name: string(arguments, "name").unwrap_or_default().to_string(),
            kind: string(arguments, "kind").map(str::to_string),
            command: None,
            args: None,
            cwd: string(arguments, "cwd").map(str::to_string),
            port: arguments
                .get("port")
                .and_then(Value::as_u64)
                .and_then(|port| u16::try_from(port).ok()),
            description: string(arguments, "description").map(str::to_string),
            project_path: None,
            env: None,
            test: None,
            depends_on: None,
            compose_file: None,
            compose_service: None,
            host: None,
        };
        match self {
            Arm::Local => ServiceDef {
                command: string(arguments, "command").map(str::to_string),
                args: arguments.get("args").map(|_| strings(arguments, "args")),
                env: environment(arguments),
                ..base
            },
            Arm::DockerCompose => ServiceDef {
                compose_file: string(arguments, "composeFile").map(str::to_string),
                compose_service: string(arguments, "composeService").map(str::to_string),
                ..base
            },
            Arm::Ssh => ServiceDef {
                host: string(arguments, "host").map(str::to_string),
                command: string(arguments, "command").map(str::to_string),
                env: environment(arguments),
                ..base
            },
        }
    }
}

pub fn service_definition(arguments: &Map<String, Value>) -> Result<ServiceDef, String> {
    let mut rejected = Vec::new();
    for arm in Arm::ALL {
        let failures = arm.failures(arguments);
        if failures.is_empty() {
            return Ok(arm.build(arguments));
        }
        rejected.push(failures);
    }
    // An arm whose only complaint is a refinement did read the arguments as its
    // own kind of service — it just does not accept these ones. Saying so is
    // more use than listing what all three arms would have wanted, so the
    // reference reports the first such arm alone.
    let issues = rejected
        .iter()
        .find(|failures| failures.iter().all(Issue::is_refinement))
        .cloned()
        .unwrap_or_else(|| {
            vec![Issue::Union(UnionIssue {
                code: "invalid_union",
                union_errors: rejected
                    .iter()
                    .map(|issues| ZodErrorView {
                        issues: issues.clone(),
                        name: "ZodError",
                    })
                    .collect(),
                path: Vec::new(),
                message: "Invalid input",
            })]
        });
    // The report is pretty-printed because it is shown to a person: the
    // reference hands back zod's own multi-line rendering, and a single line of
    // JSON would be a different thing to read.
    Err(serde_json::to_string_pretty(&issues).map_err(|error| error.to_string())?)
}

/// A `port` that is present but is not a number the schema could accept.
///
/// The sentinel is a *string* `"NaN"`, because JSON cannot carry the value
/// itself: whoever builds these arguments out of a form has no other way to say
/// "the caller typed something, and it was not a number".
fn port_failure(arguments: &Map<String, Value>) -> Option<Issue> {
    match arguments.get("port") {
        None => None,
        Some(Value::Number(_)) => None,
        Some(_) => Some(Issue::unreadable_port()),
    }
}

fn missing(arguments: &Map<String, Value>, key: &'static str) -> Option<Issue> {
    string(arguments, key)
        .is_none()
        .then(|| Issue::missing(key))
}

/// One rejected key condemns the whole map: the reference refines the map, not
/// its entries, so the report names `env` rather than the key that failed.
fn environment_failure(arguments: &Map<String, Value>) -> Option<Issue> {
    let entries = arguments.get("env")?.as_object()?;
    entries
        .keys()
        .any(|key| !is_environment_name(key))
        .then(|| {
            Issue::custom(
                "Environment variable names must use letters, numbers, and underscores.",
                vec![Value::from("env")],
            )
        })
}

/// The reference's `/^[A-Za-z_][A-Za-z0-9_]*$/`.
fn is_environment_name(key: &str) -> bool {
    let mut characters = key.chars();
    characters
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && characters.all(|rest| rest.is_ascii_alphanumeric() || rest == '_')
}

fn environment(
    arguments: &Map<String, Value>,
) -> Option<std::collections::HashMap<String, String>> {
    let entries = arguments.get("env")?.as_object()?;
    Some(
        entries
            .iter()
            .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_string())))
            .collect(),
    )
}

pub fn string<'a>(arguments: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    arguments.get(key).and_then(Value::as_str)
}

pub fn strings(arguments: &Map<String, Value>, key: &str) -> Vec<String> {
    arguments
        .get(key)
        .and_then(Value::as_array)
        .map(|members| {
            members
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// One entry of the validator's report, in the shape and the key order the
/// reference's own validator serializes it in.
#[derive(Clone, Serialize)]
#[serde(untagged)]
enum Issue {
    Literal(LiteralIssue),
    Missing(MissingIssue),
    Custom(CustomIssue),
    Union(UnionIssue),
}

impl Issue {
    fn missing(key: &'static str) -> Self {
        Issue::Missing(MissingIssue {
            code: "invalid_type",
            expected: "string",
            received: "undefined",
            path: vec![Value::from(key)],
            message: "Required",
        })
    }

    /// A port that arrived as something no number could be read from. The
    /// reference gets `NaN` out of `Number(...)` and zod names that state
    /// exactly, so the report says `received: "nan"` rather than "string".
    fn unreadable_port() -> Self {
        Issue::Missing(MissingIssue {
            code: "invalid_type",
            expected: "number",
            received: "nan",
            path: vec![Value::from("port")],
            message: "Expected number, received nan",
        })
    }

    fn custom(message: &str, path: Vec<Value>) -> Self {
        Issue::Custom(CustomIssue {
            code: "custom",
            message: message.to_string(),
            path,
        })
    }

    /// Whether this is a rule the arm applies to a field it did understand,
    /// rather than a field it never found.
    fn is_refinement(&self) -> bool {
        matches!(self, Issue::Custom(_))
    }
}

#[derive(Clone, Serialize)]
struct LiteralIssue {
    /// Omitted rather than reported as null when nothing was sent, because the
    /// reference has nothing to put here and drops the key.
    #[serde(skip_serializing_if = "Option::is_none")]
    received: Option<String>,
    code: &'static str,
    expected: &'static str,
    path: Vec<Value>,
    message: String,
}

#[derive(Clone, Serialize)]
struct MissingIssue {
    code: &'static str,
    expected: &'static str,
    received: &'static str,
    path: Vec<Value>,
    message: &'static str,
}

#[derive(Clone, Serialize)]
struct CustomIssue {
    code: &'static str,
    message: String,
    path: Vec<Value>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UnionIssue {
    code: &'static str,
    union_errors: Vec<ZodErrorView>,
    path: Vec<Value>,
    message: &'static str,
}

#[derive(Clone, Serialize)]
struct ZodErrorView {
    issues: Vec<Issue>,
    name: &'static str,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn definition(arguments: Value) -> Result<ServiceDef, Value> {
        service_definition(arguments.as_object().unwrap())
            .map_err(|report| serde_json::from_str(&report).expect("the report must be JSON"))
    }

    #[test]
    fn a_local_service_keeps_only_the_fields_a_local_service_has() {
        let service = definition(json!({
            "name": "api",
            "command": "npm run dev",
            "args": ["--port", "3000"],
            "cwd": "/srv/api",
            "port": 3000,
            "env": { "TOKEN": "secret" },
            "description": "the api",
            "composeService": "postgres",
            "host": "box"
        }))
        .unwrap();
        assert_eq!(service.command.as_deref(), Some("npm run dev"));
        assert_eq!(service.args.unwrap(), vec!["--port", "3000"]);
        assert_eq!(service.env.unwrap()["TOKEN"], "secret");
        assert_eq!(service.port, Some(3000));
        // Not fields of a local service, so not stored on one.
        assert_eq!(service.compose_service, None);
        assert_eq!(service.host, None);
        // Absent rather than filled in: the reference stores what it was told.
        assert_eq!(service.kind, None);
    }

    #[test]
    fn the_named_kind_decides_which_reading_wins() {
        let compose = definition(json!({
            "name": "db",
            "kind": "docker-compose",
            "cwd": "/srv/db",
            "composeFile": "docker-compose.yml",
            "composeService": "postgres",
            "command": "ignored",
            "env": { "TOKEN": "secret" }
        }))
        .unwrap();
        assert_eq!(compose.compose_service.as_deref(), Some("postgres"));
        assert_eq!(compose.command, None);
        assert_eq!(compose.env, None);

        let ssh = definition(json!({
            "name": "remote",
            "kind": "ssh",
            "host": "box",
            "cwd": "/srv",
            "command": "./run",
            "args": ["ignored"]
        }))
        .unwrap();
        assert_eq!(ssh.host.as_deref(), Some("box"));
        assert_eq!(ssh.command.as_deref(), Some("./run"));
        assert_eq!(ssh.args, None);
    }

    #[test]
    fn nothing_runnable_reports_what_all_three_readings_wanted() {
        let report = definition(json!({ "name": "api" })).unwrap_err();
        assert_eq!(report[0]["code"], "invalid_union");
        assert_eq!(report[0]["message"], "Invalid input");
        assert_eq!(report[0]["path"], json!([]));
        let readings = report[0]["unionErrors"].as_array().unwrap();
        assert_eq!(readings.len(), 3);
        assert_eq!(readings[0]["name"], "ZodError");
        // The local reading needs no `kind`, so it complains only about what it
        // could not find.
        assert_eq!(
            readings[0]["issues"],
            json!([
                {
                    "code": "invalid_type",
                    "expected": "string",
                    "received": "undefined",
                    "path": ["command"],
                    "message": "Required"
                },
                {
                    "code": "invalid_type",
                    "expected": "string",
                    "received": "undefined",
                    "path": ["cwd"],
                    "message": "Required"
                }
            ])
        );
        // Nothing was sent for `kind`, so nothing is reported as received.
        assert_eq!(
            readings[1]["issues"][0],
            json!({
                "code": "invalid_literal",
                "expected": "docker-compose",
                "path": ["kind"],
                "message": "Invalid literal value, expected \"docker-compose\""
            })
        );
    }

    /// A `kind` that was sent is quoted back, ahead of everything else the
    /// reading has to say.
    #[test]
    fn a_named_kind_is_reported_back_to_the_readings_that_refuse_it() {
        let report = definition(json!({
            "name": "api",
            "kind": "ssh",
            "cwd": "/srv",
            "command": "./run"
        }))
        .unwrap_err();
        let readings = report[0]["unionErrors"].as_array().unwrap();
        assert_eq!(
            readings[0]["issues"][0],
            json!({
                "received": "ssh",
                "code": "invalid_literal",
                "expected": "local",
                "path": ["kind"],
                "message": "Invalid literal value, expected \"local\""
            })
        );
        // The ssh reading understood the kind and only wants its host.
        assert_eq!(
            readings[2]["issues"],
            json!([{
                "code": "invalid_type",
                "expected": "string",
                "received": "undefined",
                "path": ["host"],
                "message": "Required"
            }])
        );
    }

    /// A reading that recognised the service and merely rejected a value is
    /// reported alone: listing what the other two wanted would bury the one
    /// thing the caller has to change.
    #[test]
    fn a_rejected_value_is_reported_without_the_readings_that_never_applied() {
        let report = definition(json!({
            "name": "api",
            "command": "npm run dev",
            "cwd": "/srv/api",
            "env": { "1BAD": "value" }
        }))
        .unwrap_err();
        assert_eq!(
            report,
            json!([{
                "code": "custom",
                "message": "Environment variable names must use letters, numbers, and underscores.",
                "path": ["env"]
            }])
        );

        let arg = definition(json!({
            "name": "api",
            "command": "npm run dev",
            "cwd": "/srv/api",
            "args": ["fine", "trunc\u{0}ated"]
        }))
        .unwrap_err();
        assert_eq!(arg[0]["path"], json!(["args", 1]));
        assert_eq!(arg[0]["message"], "Invalid input");

        let ssh = definition(json!({
            "name": "remote",
            "kind": "ssh",
            "host": "box",
            "cwd": "/srv",
            "command": "trunc\u{0}ated"
        }))
        .unwrap_err();
        assert_eq!(
            ssh,
            json!([{
                "code": "custom",
                "message": "SSH command contains invalid null byte.",
                "path": ["command"]
            }])
        );
    }

    #[test]
    fn environment_names_are_the_ones_a_shell_would_accept() {
        for name in ["TOKEN", "_private", "a1", "_", "MIXED_case_9"] {
            assert!(is_environment_name(name), "{name}");
        }
        for name in ["", "1BAD", "with-dash", "with space", "dot.ted", "é"] {
            assert!(!is_environment_name(name), "{name}");
        }
    }
}
