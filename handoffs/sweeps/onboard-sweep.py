#!/usr/bin/env python3
"""Seeded regression sweep for scripts/check-onboard-parity.ts.

Each seed makes one behavioural change to the Rust source, rebuilds, and expects
the gate to fail on a *named* case. A seed the gate does not catch is a hole in
the gate, not a success.

One seed is deliberately absent. *A relative path is not made absolute* cannot
be observed through this guard: a relative `cwd` resolves against the daemon's
own directory, which is never inside the onboarding directory, so the guard
refuses it whether or not it was resolved first. The absolutization stays
because it is what makes the helper a faithful `path.resolve` for any other
caller — it simply cannot decide this route's answer.

Two clusters. The first is the **containment guard**, which is the security-
relevant half of this slice: it decides whether a browser can name a path
outside the onboarding directory and have a service registered to run there. Its
rules are textual and quirky — a `..` segment that escapes, a directory whose
name merely begins with `..`, the root itself — and every one of them is
seedable by loosening the guard in a different direction.

The second is the **validator's dirty/aborted split**, which decides whether a
refusal is reported as one arm's issues or as the three-armed union. Nothing
about the wording changes when that goes wrong; only the shape does, and only
for a caller reading the report.

Run it alone: it mutates tracked sources and restores them from an in-memory
backup, so a second cargo build racing it tests a binary that is one edit behind
its source. Killing it mid-run leaves a seed on disk.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _runner import read, run_sweep, select  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ONBOARD = "crates/nomoreide-core/src/repo_onboard.rs"
ROUTE = "crates/nomoreide-daemon/src/server/routes/onboard.rs"
SCHEMA = "crates/nomoreide-core/src/service_definition.rs"

GATE_SCRIPT = "scripts/check-onboard-parity.ts"

#: Gate runs go in parallel; builds cannot. See handoffs/sweeps/_runner.py.
#: This gate holds a port, and reads which one from `NMI_GATE_HELD_PORT`, so
#: three of them at once do not meet each other.
WORKERS = 3

SEEDS = [
    # --- the containment guard ------------------------------------------------
    ("the-guard-accepts-anything", ONBOARD,
     """    let resolved = node_resolve(path);""",
     """    if true {
        return true;
    }
    let resolved = node_resolve(path);""",
     "register/a-cwd-outside-the-repos-dir"),
    ("the-guard-is-a-prefix-test", ONBOARD,
     """    let relative = node_relative(&node_resolve(&root.to_string_lossy()), &resolved);
    if relative.is_empty() {
        return false;
    }
    !relative.starts_with("..") && !resolved.contains('\\0')""",
     """    resolved.starts_with(&*root.to_string_lossy()) && !resolved.contains('\\0')""",
     # Not the escaping case: `<repos>/demo-app/../../../workspace` resolves
     # *outside* the root, so a prefix test refuses it for the same reason the
     # real guard does. What a prefix test gets wrong is the path that is inside
     # by prefix and refused by the string check.
     "register/a-cwd-named-dot-dot-something"),
    ("the-repos-dir-itself-is-accepted", ONBOARD,
     """    if relative.is_empty() {
        return false;
    }""",
     """    if relative.is_empty() {
        return true;
    }""",
     "register/the-repos-dir-itself"),
    ("a-null-byte-is-accepted", ONBOARD,
     """    !relative.starts_with("..") && !resolved.contains('\\0')""",
     """    !relative.starts_with("..")""",
     "register/a-cwd-with-a-null-byte"),
    ("the-escape-check-is-structural", ONBOARD,
     """    !relative.starts_with("..") && !resolved.contains('\\0')""",
     """    relative.split('/').next() != Some("..") && !resolved.contains('\\0')""",
     "register/a-cwd-named-dot-dot-something"),
    ("dot-dot-is-not-popped", ONBOARD,
     """            ".." => {
                segments.pop();
            }""",
     """            ".." => {
                segments.push("..");
            }""",
     "register/a-cwd-that-escapes-with-dot-dot"),

    # --- the scan route -------------------------------------------------------
    ("a-blank-url-is-not-trimmed", ROUTE,
     """        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    if url.is_empty() {""",
     """        .unwrap_or_default()
        .to_string();
    if url.is_empty() {""",
     "scan/a-blank-url"),
    ("a-missing-url-is-a-422", ROUTE,
     """        return error(StatusCode::BAD_REQUEST, "url is required");""",
     """        return error(StatusCode::UNPROCESSABLE_ENTITY, "url is required");""",
     "scan/no-url"),
    ("a-clone-failure-is-a-500", ROUTE,
     """        Err(reason) => return error(StatusCode::UNPROCESSABLE_ENTITY, &reason.to_string()),
    };
    let profile = match scan_repo(&cloned.clone_path).await {""",
     """        Err(reason) => {
            return error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string())
        }
    };
    let profile = match scan_repo(&cloned.clone_path).await {""",
     "scan/a-directory-that-is-not-a-repository"),
    ("the-scan-reads-the-wrong-path", ROUTE,
     """    let profile = match scan_repo(&cloned.clone_path).await {""",
     """    let profile = match scan_repo(&cloned.name).await {""",
     "scan/a-repository"),
    ("a-non-empty-destination-is-overwritten", ONBOARD,
     """    if is_non_empty_dir(&clone_path).await? {""",
     """    if false {""",
     "scan/the-same-repository-again"),

    # --- the register route ---------------------------------------------------
    ("a-name-that-is-not-a-string-is-accepted", ROUTE,
     """    let (Some(_), Some(cwd)) = (
        payload.get("name").and_then(Value::as_str),
        payload.get("cwd").and_then(Value::as_str),
    ) else {""",
     """    let (Some(_), Some(cwd)) = (
        payload.get("name"),
        payload.get("cwd").and_then(Value::as_str),
    ) else {""",
     "register/a-name-that-is-a-number"),
    ("a-refusal-from-the-schema-is-a-400", ROUTE,
     """        Err(report) => return error(StatusCode::UNPROCESSABLE_ENTITY, &report),""",
     """        Err(report) => return error(StatusCode::BAD_REQUEST, &report),""",
     "register/a-blank-name"),
    ("an-ssh-kind-is-carried", ROUTE,
     """    if text("kind") == Some("docker-compose") {""",
     """    if let Some(kind) = text("kind").filter(|kind| *kind == "ssh") {
        arguments.insert("kind".to_string(), json!(kind));
        if let Some(host) = text("host") {
            arguments.insert("host".to_string(), json!(host));
        }
    }
    if text("kind") == Some("docker-compose") {""",
     "register/an-ssh-kind-with-a-command"),
    ("a-string-port-is-carried", ROUTE,
     """    if let Some(port) = payload.get("port").filter(|value| value.is_number()) {""",
     """    if let Some(port) = payload.get("port").filter(|value| !value.is_null()) {""",
     "register/a-port-that-is-a-string"),
    ("a-description-is-not-trimmed", ROUTE,
     """    if let Some(description) = text("description")
        .map(str::trim)
        .filter(|value| !value.is_empty())""",
     """    if let Some(description) = text("description").filter(|value| !value.is_empty())""",
     "register/a-local-service"),
    ("a-name-is-trimmed", ROUTE,
     """    arguments.insert("name".to_string(), json!(text("name").unwrap_or_default()));""",
     """    arguments.insert(
        "name".to_string(),
        json!(text("name").unwrap_or_default().trim()),
    );""",
     # Not `a-blank-name`: `""` trimmed is still `""`. Only a name that is
     # *only* whitespace is registered by the reference and refused once
     # trimmed.
     "register/a-name-that-is-only-spaces"),
    ("the-git-repository-is-registered-under-another-name", ROUTE,
     """            name: name.clone(),
            path: cwd.to_string(),""",
     """            name: format!("{name}-repo"),
            path: cwd.to_string(),""",
     "register/the-config-so-far"),
    ("a-bad-database-engine-is-stored", ROUTE,
     """    if !matches!(engine, "postgres" | "mysql" | "sqlite") {
        return None;
    }""",
     """    if false {
        return None;
    }""",
     "register/the-config-after-the-databases"),
    ("a-database-url-is-not-trimmed", ROUTE,
     """        url: url.trim().to_string(),""",
     """        url: url.to_string(),""",
     "register/the-config-after-the-databases"),
    ("start-is-truthy-rather-than-true", ROUTE,
     """    let started = if payload.get("start") == Some(&Value::Bool(true)) {""",
     """    let started = if payload.get("start").is_some_and(|value| value != &Value::Bool(false)) {""",
     "register/start-is-a-string"),
    ("a-port-conflict-is-a-409", ROUTE,
     """            Err(failure) => {
                return error(StatusCode::UNPROCESSABLE_ENTITY, &mutation_message(failure))
            }""",
     """            Err(failure) => return crate::server::errors::service_mutation_error(failure),""",
     "register/a-start-that-conflicts"),
    ("the-answer-is-re-read-after-the-best-effort-writes", ROUTE,
     """    let view = serde_json::to_value(config.public_view()).unwrap_or_else(|_| json!({}));""",
     """    let config = state.config_store.load().await.unwrap_or(config);
    let view = serde_json::to_value(config.public_view()).unwrap_or_else(|_| json!({}));""",
     "register/with-a-database"),

    # --- the validator's rules, reachable only from here ----------------------
    ("a-blank-name-is-accepted", SCHEMA,
     """        Some(Value::String(name)) if name.is_empty() => Some(Issue::Bound(BoundIssue {""",
     """        Some(Value::String(name)) if false && name.is_empty() => Some(Issue::Bound(BoundIssue {""",
     "register/a-blank-name"),
    ("a-port-above-the-range-is-accepted", SCHEMA,
     """    if number > 65535.0 {""",
     """    if false {""",
     "register/a-port-out-of-range"),
    ("a-float-port-is-accepted", SCHEMA,
     """    if number.fract() != 0.0 {""",
     """    if false {""",
     "register/a-port-that-is-a-float"),
    ("a-port-of-zero-is-accepted", SCHEMA,
     """    if number <= 0.0 {""",
     """    if number < 0.0 {""",
     "register/a-port-that-is-zero"),
    ("the-numeric-checks-stop-at-the-first", SCHEMA,
     """    if number <= 0.0 {
        issues.push(Issue::Bound(BoundIssue {""",
     """    if issues.is_empty() && number <= 0.0 {
        issues.push(Issue::Bound(BoundIssue {""",
     "register/a-port-that-is-a-negative-float"),
    ("an-env-value-is-not-typed", SCHEMA,
     """        .filter(|(_, value)| !value.is_string())""",
     """        .filter(|(_, _value)| false)""",
     "register/an-env-value-that-is-a-number"),
    ("an-env-value-does-not-stop-the-key-rule", SCHEMA,
     """    if !bad_values.is_empty() {
        return bad_values;
    }""",
     """    let mut bad_values = bad_values;""",
     "register/an-env-with-a-bad-key-and-a-bad-value"),
    ("a-bound-failure-is-not-dirty", SCHEMA,
     """            Issue::Custom(_) | Issue::Bound(_) => true,""",
     """            Issue::Custom(_) => true,
            Issue::Bound(_) => false,""",
     "register/a-blank-name"),
    ("a-float-port-is-not-dirty", SCHEMA,
     """            Issue::Typed(issue) => issue.expected == "integer",""",
     """            Issue::Typed(_) => false,""",
     "register/a-port-that-is-a-float"),
    # Aimed at the **compose** arm, not the local one. The case that reports a
    # flat two-issue report is `kind: docker-compose`, and the arm reported is
    # whichever one went dirty without aborting — which is that one. Seeding the
    # local arm changed an arm the case never reads.
    ("the-name-is-checked-after-the-port", SCHEMA,
     """const COMPOSE_CHECKS: &[Check] = &[
    Check::Name,
    Check::Port,""",
     """const COMPOSE_CHECKS: &[Check] = &[
    Check::Port,
    Check::Name,""",
     "register/a-blank-name-and-no-command"),
    ("a-check-message-is-serialized-last", SCHEMA,
     """            message: Some("Expected integer, received float".to_string()),
            path: vec![Value::from("port")],
            trailing_message: None,""",
     """            message: None,
            path: vec![Value::from("port")],
            trailing_message: Some("Expected integer, received float".to_string()),""",
     "register/a-port-that-is-a-float"),
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
