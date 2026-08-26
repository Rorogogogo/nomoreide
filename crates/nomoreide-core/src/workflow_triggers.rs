//! Binding an event to a workflow.
//!
//! A trigger says "when this happens, run that". It is a small record and the
//! whole of it is validation: the schema is six fields, two of which carry
//! defaults, and a body that fails it is handed back the validator's own report
//! rather than a sentence.
//!
//! **Unknown keys are dropped, not refused.** The reference's schema is a plain
//! object rather than a strict one, so a body carrying extra fields validates
//! and stores only the six — which is also why what is *stored* is the parsed
//! record and never the body as it arrived.
//!
//! Only the configured bindings live here. The queue of runs a fired trigger
//! produces is the trigger manager's, and it is not served yet.

use crate::zod_report::{report, type_name, ZodIssue};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The events a trigger can bind to, in the order the enum declares them —
/// which is the order a refusal lists them in.
pub const TRIGGER_EVENTS: &[&str] = &["error-incident", "service-crash", "ci-failure"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowTrigger {
    pub id: String,
    pub workflow_id: String,
    pub event: String,
    pub enabled: bool,
    /// Absent rather than empty when the trigger matches everything: the field
    /// is optional in the schema, and an optional field that was not sent is
    /// left out of the parsed record entirely.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter: Option<String>,
    pub auto_run: bool,
}

/// Read a trigger out of a request body, reporting failures the way the
/// reference's validator reports them.
///
/// Issues come in **shape order** — id, workflowId, event, enabled, filter,
/// autoRun — and they accumulate: a body that gets three fields wrong is told
/// about all three.
pub fn workflow_trigger(body: &Value) -> Result<WorkflowTrigger, String> {
    let Some(fields) = body.as_object() else {
        // The object type itself is wrong, so none of its fields are reached.
        return Err(report(&[ZodIssue::wrong_type(
            "object",
            type_name(body),
            Vec::new(),
        )]));
    };

    let mut issues = Vec::new();
    let id = required_string(fields, "id", &mut issues);
    let workflow_id = required_string(fields, "workflowId", &mut issues);
    let event = trigger_event(fields, &mut issues);
    let enabled = flag(fields, "enabled", true, &mut issues);
    let filter = optional_string(fields, "filter", &mut issues);
    let auto_run = flag(fields, "autoRun", false, &mut issues);

    if !issues.is_empty() {
        return Err(report(&issues));
    }
    Ok(WorkflowTrigger {
        id: id.unwrap_or_default(),
        workflow_id: workflow_id.unwrap_or_default(),
        event: event.unwrap_or_default(),
        enabled,
        filter,
        auto_run,
    })
}

/// `z.string().min(1)`: absent is `Required`, present-but-not-a-string names
/// the type it got, and an empty one is a length complaint.
fn required_string(
    fields: &Map<String, Value>,
    key: &'static str,
    issues: &mut Vec<ZodIssue>,
) -> Option<String> {
    match fields.get(key) {
        None => {
            issues.push(ZodIssue::required("string", vec![Value::from(key)]));
            None
        }
        Some(Value::String(text)) => {
            if text.is_empty() {
                issues.push(ZodIssue::too_small_string(1, vec![Value::from(key)]));
            }
            Some(text.clone())
        }
        Some(other) => {
            issues.push(ZodIssue::wrong_type(
                "string",
                type_name(other),
                vec![Value::from(key)],
            ));
            None
        }
    }
}

/// `z.string().optional()`: absent is fine and stays absent.
fn optional_string(
    fields: &Map<String, Value>,
    key: &'static str,
    issues: &mut Vec<ZodIssue>,
) -> Option<String> {
    match fields.get(key) {
        // `undefined` and a missing key are the same thing to the validator,
        // and JSON's `null` is neither — it is a value of the wrong type.
        None => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(other) => {
            issues.push(ZodIssue::wrong_type(
                "string",
                type_name(other),
                vec![Value::from(key)],
            ));
            None
        }
    }
}

/// `z.boolean().default(...)`: a missing field is the default, and anything
/// that is not a boolean is refused rather than coerced.
fn flag(
    fields: &Map<String, Value>,
    key: &'static str,
    default: bool,
    issues: &mut Vec<ZodIssue>,
) -> bool {
    match fields.get(key) {
        None => default,
        Some(Value::Bool(flag)) => *flag,
        Some(other) => {
            issues.push(ZodIssue::wrong_type(
                "boolean",
                type_name(other),
                vec![Value::from(key)],
            ));
            default
        }
    }
}

/// The event enum, whose two failure shapes differ: a *missing* one lists the
/// options where a type name would go, and a *wrong* one reports what it got.
fn trigger_event(fields: &Map<String, Value>, issues: &mut Vec<ZodIssue>) -> Option<String> {
    match fields.get("event") {
        None => {
            issues.push(ZodIssue::required_enum(
                TRIGGER_EVENTS,
                vec![Value::from("event")],
            ));
            None
        }
        Some(Value::String(text)) if TRIGGER_EVENTS.contains(&text.as_str()) => Some(text.clone()),
        Some(Value::String(text)) => {
            issues.push(ZodIssue::bad_enum(
                text,
                TRIGGER_EVENTS,
                vec![Value::from("event")],
            ));
            None
        }
        Some(other) => {
            // Not a string at all, so zod cannot quote what it received as one:
            // it reports the option list against the type it saw.
            issues.push(ZodIssue::wrong_enum_type(
                TRIGGER_EVENTS,
                type_name(other),
                vec![Value::from("event")],
            ));
            None
        }
    }
}
