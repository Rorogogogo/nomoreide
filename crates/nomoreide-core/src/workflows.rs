//! User-owned git/GitHub workflows: the shipped templates, and the shape a
//! saved one has to have.
//!
//! A workflow is an ordered list of steps a runner walks. The runner is
//! **client-side** — this module owns the shape and the templates, and nothing
//! here executes anything.
//!
//! The templates live in `workflows.json` beside this file rather than in Rust
//! literals. They are plain data that has to stay byte-identical to the
//! reference's, and a JSON file can be diffed against it; a page of nested
//! struct literals cannot.

use serde_json::Value;

use crate::zod_report::{report, type_name, ZodIssue};

const BUILTIN_JSON: &str = include_str!("workflows.json");

pub fn builtin_workflows() -> Vec<Value> {
    serde_json::from_str(BUILTIN_JSON).unwrap_or_default()
}

/// The templates with the user's saved workflows folded in.
///
/// A stored workflow whose id matches a built-in **replaces** it — that is what
/// forking a template means — and keeps the built-in's position, so the list
/// does not reorder itself when someone edits one. Anything else is appended.
pub fn list_workflows(stored: &[Value]) -> Vec<Value> {
    let id_of = |workflow: &Value| {
        workflow
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let builtins = builtin_workflows();
    let mut merged: Vec<Value> = builtins
        .iter()
        .map(|builtin| {
            stored
                .iter()
                .find(|saved| id_of(saved) == id_of(builtin))
                .cloned()
                .unwrap_or_else(|| builtin.clone())
        })
        .collect();
    merged.extend(
        stored
            .iter()
            .filter(|saved| {
                !builtins
                    .iter()
                    .any(|builtin| id_of(builtin) == id_of(saved))
            })
            .cloned(),
    );
    merged
}

const STEP_KINDS: [&str; 3] = ["action", "agent", "gate"];
const ACTIONS: [&str; 4] = [
    "push",
    "commit",
    "assert-pr-branch",
    "checkout-default-and-pull",
];
const VERIFICATIONS: [&str; 2] = ["committed", "pushed"];

/// Validate a workflow the way the reference's schema does, and report a
/// failure the way zod reports one.
///
/// The step list is a **discriminated union on `kind`**, so a step whose kind
/// is not one of the three is reported as a bad discriminator rather than as
/// three parallel failures — which is the one place this differs from the
/// service definition's union, and why the two are not one helper.
pub fn validate_workflow(workflow: &Value) -> Result<(), String> {
    let mut issues = Vec::new();
    // A body that is not an object is not refused as one: zod reads its fields,
    // finds none, and reports each required key as missing. So an array, a
    // string, and a body that did not parse at all all say the same thing.
    let empty = serde_json::Map::new();
    let object = workflow.as_object().unwrap_or(&empty);
    for key in ["id", "name"] {
        match object.get(key) {
            Some(Value::String(text)) if !text.is_empty() => {}
            Some(Value::String(_)) => {
                issues.push(ZodIssue::too_small_string(1, vec![Value::from(key)]));
            }
            None => issues.push(ZodIssue::required("string", vec![Value::from(key)])),
            Some(other) => issues.push(ZodIssue::wrong_type(
                "string",
                type_name(other),
                vec![Value::from(key)],
            )),
        }
    }
    match object.get("steps") {
        Some(Value::Array(steps)) if !steps.is_empty() => {
            for (index, step) in steps.iter().enumerate() {
                issues.extend(step_issues(step, index));
            }
        }
        Some(Value::Array(_)) => {
            issues.push(ZodIssue::too_small_array(1, vec![Value::from("steps")]));
        }
        None => issues.push(ZodIssue::required("array", vec![Value::from("steps")])),
        Some(other) => issues.push(ZodIssue::wrong_type(
            "array",
            type_name(other),
            vec![Value::from("steps")],
        )),
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(report(&issues))
    }
}

fn step_issues(step: &Value, index: usize) -> Vec<ZodIssue> {
    let at = |key: &str| vec![Value::from("steps"), Value::from(index), Value::from(key)];
    let Some(object) = step.as_object() else {
        return vec![ZodIssue::bad_discriminator(
            &STEP_KINDS,
            vec![
                Value::from("steps"),
                Value::from(index),
                Value::from("kind"),
            ],
        )];
    };
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !STEP_KINDS.contains(&kind) {
        return vec![ZodIssue::bad_discriminator(
            &STEP_KINDS,
            vec![
                Value::from("steps"),
                Value::from(index),
                Value::from("kind"),
            ],
        )];
    }

    let mut issues = Vec::new();
    let required = |key: &str, issues: &mut Vec<ZodIssue>| match object.get(key) {
        Some(Value::String(text)) if !text.is_empty() => {}
        Some(Value::String(_)) => issues.push(ZodIssue::too_small_string(1, at(key))),
        None => issues.push(ZodIssue::required("string", at(key))),
        Some(other) => issues.push(ZodIssue::wrong_type("string", type_name(other), at(key))),
    };
    required("id", &mut issues);
    required("title", &mut issues);
    match kind {
        "action" => {
            let op = object.get("op").and_then(Value::as_str);
            match op {
                Some(op) if ACTIONS.contains(&op) => {}
                Some(op) => issues.push(ZodIssue::bad_enum(op, &ACTIONS, at("op"))),
                None => issues.push(ZodIssue::required_enum(&ACTIONS, at("op"))),
            }
        }
        "agent" => {
            required("prompt", &mut issues);
            if let Some(verify) = object.get("verify").and_then(Value::as_str) {
                if !VERIFICATIONS.contains(&verify) {
                    issues.push(ZodIssue::bad_enum(verify, &VERIFICATIONS, at("verify")));
                }
            }
        }
        _ => required("message", &mut issues),
    }
    issues
}
