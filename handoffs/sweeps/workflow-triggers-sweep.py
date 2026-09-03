#!/usr/bin/env python3
"""Seeded regression sweep for scripts/check-workflow-triggers-parity.ts.

Each seed makes one behavioural change to the Rust source, rebuilds, and expects
the gate to fail on a *named* case. A seed the gate does not catch is a hole in
the gate, not a success.

Nearly all of this is one schema, so most seeds change one rule in it. The
interesting ones are about the **enum**, which fails in three different shapes
depending on how it was wrong, and about **what is stored** — the parsed record
rather than the body, which is why an unknown key survives validation and then
disappears.

No seed targets the pending queue's *contents*: nothing in a gate fires a
trigger, so both sides report an empty queue whatever the code does. The seeds
there cover the routes' shapes — the shadowed static path, the status an
acknowledgement carries — and nothing about a queue with something in it.

Run it alone: it mutates tracked sources and restores them from an in-memory
backup, so a second cargo build racing it tests a binary that is one edit behind
its source. Killing it mid-run leaves a seed on disk.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _runner import read, run_sweep, select  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

CORE = "crates/nomoreide-core/src/workflow_triggers.rs"
ROUTE = "crates/nomoreide-daemon/src/server/routes/workflow_triggers.rs"
CONFIG = "crates/nomoreide-core/src/config.rs"

GATE_SCRIPT = "scripts/check-workflow-triggers-parity.ts"

#: Gate runs go in parallel; builds cannot. See handoffs/sweeps/_runner.py.
WORKERS = 3

SEEDS = [
    # --- the schema's rules ---------------------------------------------------
    ("a-blank-string-is-accepted", CORE,
     """            if text.is_empty() {
                issues.push(ZodIssue::too_small_string(1, vec![Value::from(key)]));
            }""",
     """            if false {
                issues.push(ZodIssue::too_small_string(1, vec![Value::from(key)]));
            }""",
     "save/a-blank-id"),
    ("a-missing-field-is-not-required", CORE,
     """        None => {
            issues.push(ZodIssue::required("string", vec![Value::from(key)]));
            None
        }""",
     """        None => None,""",
     "save/an-empty-body"),
    ("the-fields-are-checked-in-a-different-order", CORE,
     """    let id = required_string(fields, "id", &mut issues);
    let workflow_id = required_string(fields, "workflowId", &mut issues);
    let event = trigger_event(fields, &mut issues);""",
     """    let event = trigger_event(fields, &mut issues);
    let id = required_string(fields, "id", &mut issues);
    let workflow_id = required_string(fields, "workflowId", &mut issues);""",
     "save/every-field-wrong"),
    ("the-issues-do-not-accumulate", CORE,
     """    if !issues.is_empty() {
        return Err(report(&issues));
    }""",
     """    if !issues.is_empty() {
        return Err(report(&issues[..1]));
    }""",
     "save/every-field-wrong"),

    # --- the enum's three shapes ----------------------------------------------
    ("an-unknown-option-is-a-type-error", CORE,
     """            issues.push(ZodIssue::bad_enum(
                text,
                TRIGGER_EVENTS,
                vec![Value::from("event")],
            ));""",
     """            issues.push(ZodIssue::wrong_enum_type(
                TRIGGER_EVENTS,
                "string",
                vec![Value::from("event")],
            ));
            let _ = text;""",
     "save/an-event-that-is-not-an-option"),
    ("a-non-string-option-is-quoted-back", CORE,
     """            issues.push(ZodIssue::wrong_enum_type(
                TRIGGER_EVENTS,
                type_name(other),
                vec![Value::from("event")],
            ));""",
     """            issues.push(ZodIssue::bad_enum(
                &other.to_string(),
                TRIGGER_EVENTS,
                vec![Value::from("event")],
            ));""",
     "save/an-event-that-is-a-number"),
    ("a-missing-enum-names-a-type", CORE,
     """            issues.push(ZodIssue::required_enum(
                TRIGGER_EVENTS,
                vec![Value::from("event")],
            ));""",
     """            issues.push(ZodIssue::required("string", vec![Value::from("event")]));""",
     "save/an-empty-body"),

    # --- defaults and optionals -----------------------------------------------
    ("enabled-defaults-to-false", ROUTE,
     """    let trigger = match workflow_trigger(&payload) {""",
     """    let trigger = match workflow_trigger(&payload).map(|mut t| {
        if payload.get("enabled").is_none() {
            t.enabled = false;
        }
        t
    }) {""",
     "save/the-minimum"),
    ("auto-run-defaults-to-true", ROUTE,
     """    let trigger = match workflow_trigger(&payload) {""",
     """    let trigger = match workflow_trigger(&payload).map(|mut t| {
        if payload.get("autoRun").is_none() {
            t.auto_run = true;
        }
        t
    }) {""",
     "save/the-minimum"),
    ("a-boolean-is-coerced-rather-than-checked", CORE,
     """        Some(Value::Bool(flag)) => *flag,
        Some(other) => {
            issues.push(ZodIssue::wrong_type(
                "boolean",
                type_name(other),
                vec![Value::from(key)],
            ));
            default
        }""",
     """        Some(Value::Bool(flag)) => *flag,
        Some(other) => {
            let _ = issues;
            !matches!(other, Value::Null)
        }""",
     "save/an-enabled-that-is-a-string"),
    ("an-absent-filter-becomes-empty", CORE,
     """        None => None,
        Some(Value::String(text)) => Some(text.clone()),""",
     """        None => Some(String::new()),
        Some(Value::String(text)) => Some(text.clone()),""",
     "save/the-config-so-far"),
    ("a-null-optional-is-treated-as-absent", CORE,
     """        None => None,
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
}""",
     """        None | Some(Value::Null) => None,
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
}""",
     "save/a-filter-that-is-null"),

    # --- a body that is not an object -----------------------------------------
    ("a-non-object-body-reports-its-fields", CORE,
     """        return Err(report(&[ZodIssue::wrong_type(
            "object",
            type_name(body),
            Vec::new(),
        )]));""",
     """        return Err(report(&[
            ZodIssue::required("string", vec![Value::from("id")]),
            ZodIssue::required("string", vec![Value::from("workflowId")]),
        ]));""",
     "save/a-body-that-is-an-array"),

    # --- the route ------------------------------------------------------------
    ("the-body-is-stored-rather-than-the-record", ROUTE,
     """    let stored = match serde_json::to_value(&trigger) {
        Ok(value) => value,
        Err(reason) => return error(StatusCode::BAD_REQUEST, &reason.to_string()),
    };""",
     """    let stored = payload.clone();
    let _ = &trigger;""",
     "save/an-unknown-key"),
    ("a-schema-refusal-is-a-422", ROUTE,
     """        Err(report) => return error(StatusCode::BAD_REQUEST, &report),""",
     """        Err(report) => return error(StatusCode::UNPROCESSABLE_ENTITY, &report),""",
     "save/an-empty-body"),
    # RETIRED -- `a-delete-does-not-trim-its-id`.
    #
    # `ConfigStore::remove_workflow_trigger` trims the id itself, so trimming
    # again at the route is a no-op no request can observe. Same shape as the
    # retired `a-rename-does-not-trim-its-label` in the snapshots sweep: two
    # trims, only the inner one decides.
    ("a-delete-does-not-decode-its-id", ROUTE,
     """    (!segment.is_empty()).then(|| percent_decode(segment))""",
     """    (!segment.is_empty()).then(|| segment.to_string())""",
     "delete/an-encoded-id"),
    ("the-pending-path-is-not-shadowed", ROUTE,
     """            get(pending).fallback(shadowed_trigger_id),""",
     """            get(pending).fallback(method_not_allowed),""",
     "pending/deleting-the-queue-path"),
    ("an-acknowledgement-is-a-200", ROUTE,
     """    (StatusCode::NOT_FOUND, Json(json!({ "ok": false }))).into_response()""",
     """    Json(json!({ "ok": true })).into_response()""",
     "pending/acknowledging-nothing"),
    ("the-queue-is-not-a-list", ROUTE,
     """    Json(json!({ "ok": true, "pending": [] })).into_response()""",
     """    Json(json!({ "ok": true, "pending": {} })).into_response()""",
     "pending/the-queue"),

    # --- what the config store does -------------------------------------------
    ("a-save-does-not-replace", CONFIG,
     """        config
            .workflow_triggers
            .retain(|t| t.get("id").and_then(|v| v.as_str()).unwrap_or("") != id);
        config.workflow_triggers.push(trigger);""",
     """        config.workflow_triggers.push(trigger);""",
     "save/the-same-id-again"),
    ("a-save-replaces-in-place", CONFIG,
     """        config.workflow_triggers.push(trigger);
        self.save(&config).await?;
        Ok(config)
    }

    /// Drop a trigger.""",
     """        config.workflow_triggers.insert(0, trigger);
        self.save(&config).await?;
        Ok(config)
    }

    /// Drop a trigger.""",
     "save/the-same-id-again"),
    ("a-trigger-is-matched-by-its-workflow", CONFIG,
     """        let id = trigger
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        config
            .workflow_triggers""",
     """        let id = trigger
            .get("workflowId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        config
            .workflow_triggers""",
     "save/the-same-id-again"),
    ("a-delete-of-an-unknown-id-fails", CONFIG,
     """        let id = id.trim();
        let mut config = self.load().await?;
        config
            .workflow_triggers
            .retain(|t| t.get("id").and_then(|v| v.as_str()).unwrap_or("") != id);""",
     """        let id = id.trim();
        let mut config = self.load().await?;
        let before = config.workflow_triggers.len();
        config
            .workflow_triggers
            .retain(|t| t.get("id").and_then(|v| v.as_str()).unwrap_or("") != id);
        if config.workflow_triggers.len() == before {
            anyhow::bail!("Trigger \\"{id}\\" is not registered.");
        }""",
     "delete/an-id-that-is-not-there"),
]


def main():
    seeds, complaint = select(SEEDS, sys.argv[1:])
    if complaint:
        print(complaint)
        return 2
    return run_sweep(ROOT, seeds, GATE_SCRIPT, workers=WORKERS)


# **Guarded on purpose.** Importing this file to reuse SEEDS -- to validate the
# anchors, say -- must not start a sweep.
if __name__ == "__main__":
    sys.exit(main())
