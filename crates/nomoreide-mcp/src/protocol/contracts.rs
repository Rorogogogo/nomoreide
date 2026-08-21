//! What each ported tool accepts, and how it refuses everything else.
//!
//! The reference implementation validates a tool's arguments with zod before
//! the tool runs, so the same request has to fail here in the same way — down
//! to the message an agent reads back. These contracts are therefore read from
//! the running reference rather than from its source: several of the wordings
//! below are not what the schema they mirror looks like it would produce.

use serde_json::{Map, Value};

/// The argument contract of a tool the native runtime serves itself.
///
/// The reference implementation validates arguments with zod before a tool
/// runs, so the same request has to fail here in the same way — including the
/// message an agent reads back. Unknown keys are stripped rather than
/// rejected, so only declared fields can fail.
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
}

/// The reference's `z.number().int().positive().max(1000)`.
const LOG_LIMIT_MAX: f64 = 1000.0;
/// The reference's `z.number().int().positive().max(200).default(80)`.
const TIMELINE_LIMIT_MAX: f64 = 200.0;

impl ArgumentContract {
    pub(super) fn of(tool: &str) -> Option<Self> {
        match tool {
            "nomoreide_list_services" | "nomoreide_status" => Some(Self::Empty),
            "nomoreide_start_service"
            | "nomoreide_stop_service"
            | "nomoreide_restart_service"
            | "nomoreide_start_bundle"
            | "nomoreide_stop_bundle"
            | "nomoreide_service_context" => Some(Self::RequiredName),
            "nomoreide_service_health" => Some(Self::OptionalService),
            "nomoreide_read_logs" => Some(Self::ServiceLogs),
            "nomoreide_timeline" => Some(Self::Timeline),
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
    let failure = match arguments.get("name") {
        None => "name: Required".to_string(),
        Some(Value::String(name)) if name.is_empty() => {
            "name: String must contain at least 1 character(s)".to_string()
        }
        Some(Value::String(_)) => return Ok(()),
        Some(other) => format!("name: Expected string, received {}", schema_type(other)),
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
