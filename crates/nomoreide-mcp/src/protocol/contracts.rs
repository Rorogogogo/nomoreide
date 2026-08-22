//! What each ported tool accepts, and how it refuses everything else.
//!
//! The reference implementation validates a tool's arguments with zod before
//! the tool runs, so the same request has to fail here in the same way — down
//! to the message an agent reads back. These contracts are therefore read from
//! the running reference rather than from its source: several of the wordings
//! below are not what the schema they mirror looks like it would produce.

use serde_json::{Map, Value};

/// The argument contract of a tool the native runtime serves itself. Unknown
/// keys are stripped rather than rejected, so only declared fields can fail.
pub(super) enum ArgumentContract {
    Empty,
    /// A single required non-empty `name`. The reference's `serviceNameSchema`
    /// and `bundleNameSchema` are the same shape, so they reject the same
    /// arguments with the same wording.
    RequiredName,
    /// `nomoreide_read_logs`: the same required `name` plus an optional
    /// `limit` in `(0, 1000]`. zod reports every field it rejected, in schema
    /// order, so this collects failures instead of returning the first.
    ServiceLogs,
    /// `nomoreide_timeline`: both fields optional — an absent `service` means
    /// every service rather than one named nothing.
    Timeline,
    /// `nomoreide_service_health`: one optional non-empty `service`. Absent
    /// asks about every registered service; present and empty is still a
    /// rejected name.
    OptionalService,
    /// `nomoreide_register_service`: eleven fields, every one but `name`
    /// optional. This is only the first of two gates — it decides whether the
    /// arguments are well-formed, and the executor then decides whether they
    /// describe a service of some kind. A field that clears this one can never
    /// fail the second on its type or its length, only by being missing.
    ServiceRegistration,
    /// `nomoreide_register_bundle`: a name and at least one non-empty member.
    /// Its second gate is strictly weaker than this one, so a bundle that
    /// reaches the executor always registers.
    BundleRegistration,
    /// `nomoreide_git_register_repository`: a name and a path, both required
    /// and non-empty. Whether the path is absolute and actually a worktree is
    /// the executor's question, not this one's — the reference asks it in
    /// `ConfigStore`, after zod has passed.
    RepositoryRegistration,
}

/// The reference's `z.number().int().positive().max(1000)`.
const LOG_LIMIT_MAX: f64 = 1000.0;
/// The reference's `z.number().int().positive().max(200).default(80)`.
const TIMELINE_LIMIT_MAX: f64 = 200.0;
/// The reference's `z.number().int().positive().max(65535)`.
const PORT_MAX: f64 = 65535.0;
/// The kinds of service the reference knows how to run.
const SERVICE_KINDS: &[&str] = &["local", "docker-compose", "ssh"];

impl ArgumentContract {
    pub(super) fn of(tool: &str) -> Option<Self> {
        match tool {
            "nomoreide_list_services" | "nomoreide_status" => Some(Self::Empty),
            "nomoreide_start_service"
            | "nomoreide_stop_service"
            | "nomoreide_restart_service"
            | "nomoreide_start_bundle"
            | "nomoreide_stop_bundle"
            | "nomoreide_service_context"
            | "nomoreide_git_select_repository" => Some(Self::RequiredName),
            "nomoreide_service_health" => Some(Self::OptionalService),
            "nomoreide_register_service" => Some(Self::ServiceRegistration),
            "nomoreide_register_bundle" => Some(Self::BundleRegistration),
            "nomoreide_read_logs" => Some(Self::ServiceLogs),
            "nomoreide_timeline" => Some(Self::Timeline),
            "nomoreide_git_register_repository" => Some(Self::RepositoryRegistration),
            _ => None,
        }
    }

    pub(super) fn validate(&self, arguments: &Map<String, Value>) -> Result<(), String> {
        match self {
            Self::Empty => Ok(()),
            Self::RequiredName => required_name(arguments).map_err(|failure| failure.join(", ")),
            Self::ServiceLogs => {
                let mut failures = required_name(arguments).err().unwrap_or_default();
                failures.extend(bounded_integer(arguments, "limit", LOG_LIMIT_MAX));
                collect(failures)
            }
            Self::Timeline => {
                let mut failures = optional_name(arguments, "service");
                failures.extend(bounded_integer(arguments, "limit", TIMELINE_LIMIT_MAX));
                collect(failures)
            }
            Self::OptionalService => collect(optional_name(arguments, "service")),
            Self::RepositoryRegistration => {
                let mut failures = required_name(arguments).err().unwrap_or_default();
                failures.extend(required_string(arguments, "path").err().unwrap_or_default());
                collect(failures)
            }
            // In the reference's own key order, which is the order it reports
            // failures in.
            Self::ServiceRegistration => {
                let mut failures = required_name(arguments).err().unwrap_or_default();
                failures.extend(enumerated(arguments, "kind", SERVICE_KINDS));
                failures.extend(optional_name(arguments, "command"));
                failures.extend(string_array(arguments, "args", ArrayShape::ANY));
                failures.extend(optional_name(arguments, "cwd"));
                failures.extend(bounded_integer(arguments, "port", PORT_MAX));
                failures.extend(string_map(arguments, "env"));
                failures.extend(optional_string(arguments, "description"));
                failures.extend(optional_name(arguments, "composeFile"));
                failures.extend(optional_name(arguments, "composeService"));
                failures.extend(optional_name(arguments, "host"));
                collect(failures)
            }
            Self::BundleRegistration => {
                let mut failures = required_name(arguments).err().unwrap_or_default();
                failures.extend(string_array(arguments, "services", ArrayShape::NAMES));
                collect(failures)
            }
        }
    }
}

fn collect(failures: Vec<String>) -> Result<(), String> {
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join(", "))
    }
}

fn required_name(arguments: &Map<String, Value>) -> Result<(), Vec<String>> {
    required_string(arguments, "name")
}

/// A required non-empty string under `key`, reported the way zod reports it.
fn required_string(arguments: &Map<String, Value>, key: &str) -> Result<(), Vec<String>> {
    let failure = match arguments.get(key) {
        None => format!("{key}: Required"),
        Some(Value::String(value)) if value.is_empty() => {
            format!("{key}: String must contain at least 1 character(s)")
        }
        Some(Value::String(_)) => return Ok(()),
        Some(other) => format!("{key}: Expected string, received {}", schema_type(other)),
    };
    Err(vec![failure])
}

/// An optional non-empty string. Absent is valid; present and empty is not,
/// because the reference asks for `.min(1)` either way.
fn optional_name(arguments: &Map<String, Value>, key: &str) -> Vec<String> {
    match arguments.get(key) {
        None => Vec::new(),
        Some(Value::String(value)) if value.is_empty() => {
            vec![format!(
                "{key}: String must contain at least 1 character(s)"
            )]
        }
        Some(Value::String(_)) => Vec::new(),
        Some(other) => vec![format!(
            "{key}: Expected string, received {}",
            schema_type(other)
        )],
    }
}

/// An optional positive integer with an inclusive upper bound.
///
/// A value of the wrong type fails on that alone, but a number is then checked
/// against all three of `int`, `positive`, and `max` — so `1000.5` reports both
/// that it is not an integer and that it is out of range, exactly as the
/// reference does. Integer-ness is a property of the value, not of how it was
/// written: the reference treats `1e20` as an integer, and so does this.
fn bounded_integer(arguments: &Map<String, Value>, key: &str, max: f64) -> Vec<String> {
    let Some(value) = arguments.get(key) else {
        return Vec::new();
    };
    let Some(number) = value.as_f64().filter(|_| value.is_number()) else {
        return vec![format!(
            "{key}: Expected number, received {}",
            schema_type(value)
        )];
    };
    let mut failures = Vec::new();
    if number.fract() != 0.0 {
        failures.push(format!("{key}: Expected integer, received float"));
    }
    if number <= 0.0 {
        failures.push(format!("{key}: Number must be greater than 0"));
    } else if number > max {
        failures.push(format!("{key}: Number must be less than or equal to {max}"));
    }
    failures
}

/// A plain optional string, with nothing said about its length.
fn optional_string(arguments: &Map<String, Value>, key: &str) -> Vec<String> {
    match arguments.get(key) {
        None | Some(Value::String(_)) => Vec::new(),
        Some(other) => vec![format!(
            "{key}: Expected string, received {}",
            schema_type(other)
        )],
    }
}

/// An optional member of a fixed set. A value of the wrong type is reported
/// differently from a string that is simply not one of the members — the
/// reference says "Invalid enum value" only when it had a string to compare.
fn enumerated(arguments: &Map<String, Value>, key: &str, members: &[&str]) -> Vec<String> {
    let expected = members
        .iter()
        .map(|member| format!("'{member}'"))
        .collect::<Vec<_>>()
        .join(" | ");
    match arguments.get(key) {
        None => Vec::new(),
        Some(Value::String(value)) if members.contains(&value.as_str()) => Vec::new(),
        Some(Value::String(value)) => vec![format!(
            "{key}: Invalid enum value. Expected {expected}, received '{value}'"
        )],
        Some(other) => vec![format!(
            "{key}: Expected {expected}, received {}",
            schema_type(other)
        )],
    }
}

/// What an array of strings has to satisfy beyond being one.
struct ArrayShape {
    /// Whether the array itself may be empty.
    allow_empty: bool,
    /// Whether an individual member may be the empty string.
    allow_empty_members: bool,
}

impl ArrayShape {
    /// `z.array(z.string())` — `args`, whose members are passed to a program
    /// verbatim and so may be anything a program accepts, empty included.
    const ANY: Self = Self {
        allow_empty: true,
        allow_empty_members: true,
    };
    /// `z.array(z.string().min(1)).min(1)` — a bundle's members, each of which
    /// has to name something.
    const NAMES: Self = Self {
        allow_empty: false,
        allow_empty_members: false,
    };
}

/// An optional array of strings. Every member is reported, not just the first,
/// and each is addressed by its index the way the reference addresses it.
fn string_array(arguments: &Map<String, Value>, key: &str, shape: ArrayShape) -> Vec<String> {
    let Some(value) = arguments.get(key) else {
        return if shape.allow_empty {
            Vec::new()
        } else {
            vec![format!("{key}: Required")]
        };
    };
    let Some(members) = value.as_array() else {
        return vec![format!(
            "{key}: Expected array, received {}",
            schema_type(value)
        )];
    };
    if members.is_empty() && !shape.allow_empty {
        return vec![format!("{key}: Array must contain at least 1 element(s)")];
    }
    members
        .iter()
        .enumerate()
        .filter_map(|(index, member)| match member {
            Value::String(member) if member.is_empty() && !shape.allow_empty_members => Some(
                format!("{key}.{index}: String must contain at least 1 character(s)"),
            ),
            Value::String(_) => None,
            other => Some(format!(
                "{key}.{index}: Expected string, received {}",
                schema_type(other)
            )),
        })
        .collect()
}

/// An optional map of string values, addressed by key.
///
/// The reference walks the map in insertion order; `serde_json` sorts object
/// keys, so two bad entries are reported alphabetically rather than as written.
/// Which entries are reported, and what is said about each, is the same.
fn string_map(arguments: &Map<String, Value>, key: &str) -> Vec<String> {
    let Some(value) = arguments.get(key) else {
        return Vec::new();
    };
    let Some(entries) = value.as_object() else {
        return vec![format!(
            "{key}: Expected object, received {}",
            schema_type(value)
        )];
    };
    entries
        .iter()
        .filter(|(_, value)| !value.is_string())
        .map(|(name, value)| {
            format!(
                "{key}.{name}: Expected string, received {}",
                schema_type(value)
            )
        })
        .collect()
}

fn schema_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}
