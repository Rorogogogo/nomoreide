#!/usr/bin/env python3
"""Seeded regression sweep for scripts/check-workflows-parity.ts.

Each seed makes one behavioural change to the Rust source, rebuilds, and expects
the gate to fail on a *named* case. A seed the gate does not catch is a hole in
the gate, not a success.

Most of the surface here is a **validator**, and a validator is the easiest
thing in this port to get plausibly wrong: every seed below produces a refusal,
so a gate that only checked `ok: false` would catch none of them. What has to
match is the prose zod prints, down to which issue code each failure gets — a
missing `op` is `invalid_type` on an enum, not on a string, and an unknown
`kind` collapses the whole step into one discriminator issue instead of
reporting its other fields. Those are the seeds that matter.

The rest cover the two places the route deliberately overrides the caller:
`builtin` is forced false before validation, and a body that did not parse is
handed to the schema as `{}` rather than refused.

Run it alone: it mutates tracked sources and restores them from an in-memory
backup, so a second cargo build racing it tests a binary that is one edit behind
its source. Killing it mid-run leaves a seed on disk.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ROUTE = "crates/nomoreide-daemon/src/server/routes/workflows.rs"
CORE = "crates/nomoreide-core/src/workflows.rs"
CONFIG = "crates/nomoreide-core/src/config.rs"

SEEDS = [
    # --- what the route overrides ---------------------------------------------
    ("a-fork-may-claim-to-be-builtin", ROUTE,
     r"""        object.insert("builtin".to_string(), Value::Bool(false));""",
     r"""        let _ = &object;""",
     "save/claiming-to-be-builtin"),
    ("an-unparseable-body-is-not-an-empty-one", ROUTE,
     r"""    let mut workflow = serde_json::from_slice::<Value>(&body).unwrap_or_else(|_| json!({}));""",
     r"""    let mut workflow =
        serde_json::from_slice::<Value>(&body).unwrap_or_else(|_| json!({ "id": "recovered" }));""",
     "save/a-body-that-is-not-json"),
    ("a-refusal-is-not-a-400", ROUTE,
     r"""    error(StatusCode::BAD_REQUEST, message)""",
     r"""    error(StatusCode::UNPROCESSABLE_ENTITY, message)""",
     "save/no-id"),
    ("a-deleted-id-is-not-trimmed", ROUTE,
     r"""    match state.config_store.remove_workflow(id.trim()).await {""",
     r"""    match state.config_store.remove_workflow(&id).await {""",
     "delete/an-id-with-spaces"),

    # --- the merge ------------------------------------------------------------
    ("a-fork-does-not-keep-the-template-position", CORE,
     r"""        .map(|builtin| {
            stored
                .iter()
                .find(|saved| id_of(saved) == id_of(builtin))
                .cloned()
                .unwrap_or_else(|| builtin.clone())
        })""",
     r"""        .map(|builtin| builtin.clone())""",
     "save/read-back-the-fork"),
    ("the-shipped-templates-are-not-checked", CORE,
     r"""    serde_json::from_str(BUILTIN_JSON).unwrap_or_default()""",
     r"""    let mut all: Vec<Value> = serde_json::from_str(BUILTIN_JSON).unwrap_or_default();
    all.reverse();
    all""",
     "list/the-templates"),
    ("saving-twice-keeps-both", CONFIG,
     r"""            .retain(|w| w.get("id").and_then(|v| v.as_str()).unwrap_or("") != id);
        config.workflows.push(workflow);""",
     r"""            .retain(|_| true);
        config.workflows.push(workflow);""",
     "save/replacing-itself"),

    # --- the validator --------------------------------------------------------
    ("a-blank-id-is-accepted", CORE,
     r"""            Some(Value::String(text)) if !text.is_empty() => {}
            Some(Value::String(_)) => {
                issues.push(ZodIssue::too_small_string(1, vec![Value::from(key)]));
            }""",
     r"""            Some(Value::String(_)) => {}""",
     "save/a-blank-id"),
    ("an-empty-step-list-is-accepted", CORE,
     r"""        Some(Value::Array(steps)) if !steps.is_empty() => {""",
     r"""        Some(Value::Array(steps)) => {""",
     "save/no-steps-at-all"),
    ("a-body-that-is-not-an-object-is-refused-as-one", CORE,
     r"""    let object = workflow.as_object().unwrap_or(&empty);""",
     r"""    let object = match workflow.as_object() {
        Some(object) => object,
        None => {
            let _ = &empty;
            return Err(report(&[ZodIssue::wrong_type(
                "object",
                type_name(workflow),
                vec![],
            )]));
        }
    };""",
     "save/a-body-that-is-an-array"),
    ("an-unknown-kind-is-not-a-discriminator", CORE,
     r"""    if !STEP_KINDS.contains(&kind) {""",
     r"""    if false && !STEP_KINDS.contains(&kind) {""",
     "save/a-step-kind-nobody-knows"),
    ("a-missing-op-is-reported-as-a-string", CORE,
     r"""                None => issues.push(ZodIssue::required_enum(&ACTIONS, at("op"))),""",
     r"""                None => issues.push(ZodIssue::required("string", at("op"))),""",
     "save/an-action-with-no-op"),
    ("a-verify-nobody-knows-is-accepted", CORE,
     r"""                if !VERIFICATIONS.contains(&verify) {""",
     r"""                if false && !VERIFICATIONS.contains(&verify) {""",
     "save/a-verify-nobody-knows"),
    ("a-gate-needs-no-message", CORE,
     r"""        _ => required("message", &mut issues),""",
     r"""        _ => {}""",
     "save/a-gate-with-no-message"),
]

GATE = ["node", "--import", "tsx",
        "scripts/check-workflows-parity.ts", "./target/debug/nomoreide"]


def read(path):
    with open(os.path.join(ROOT, path), encoding="utf-8") as handle:
        return handle.read()


def write(path, text):
    with open(os.path.join(ROOT, path), "w", encoding="utf-8") as handle:
        handle.write(text)


def cargo_is_busy():
    probe = subprocess.run(["cargo", "build", "-p", "nomoreide-cli", "--offline", "-q"],
                           cwd=ROOT, capture_output=True, text=True, timeout=20)
    return "Blocking waiting for file lock" in probe.stderr


def main():
    wanted = set(sys.argv[1:])
    seeds = [s for s in SEEDS if not wanted or s[0] in wanted]
    unknown = wanted - {s[0] for s in SEEDS}
    if unknown:
        print("no such seed: " + ", ".join(sorted(unknown)))
        return 2
    backups = {path: read(path) for path in {seed[1] for seed in seeds}}

    stale = [
        (name, backups[path].count(old))
        for name, path, old, _new, _expected in seeds
        if backups[path].count(old) != 1
    ]
    if stale:
        for name, count in stale:
            print(f"SEED-ANCHOR-STALE  {name}  (matches: {count})")
        print("\nFix the anchors before sweeping; nothing was changed.")
        return 2

    if cargo_is_busy():
        print("Another cargo build holds the target lock; a seeded sweep that races one")
        print("tests a binary that is one edit behind its source.")
        return 2

    results = []
    try:
        for name, path, old, new, expected in seeds:
            source = backups[path]
            write(path, source.replace(old, new, 1))
            build = subprocess.run(["cargo", "build", "-p", "nomoreide-cli"], cwd=ROOT, capture_output=True, text=True)
            if build.returncode != 0:
                results.append((name, "SEED-DID-NOT-COMPILE", build.stderr[-300:]))
                write(path, source)
                print(f"{'SEED-DID-NOT-COMPILE':24} {name}", flush=True)
                continue
            gate = subprocess.run(GATE, cwd=ROOT, capture_output=True, text=True)
            names = {line.split()[1] for line in gate.stdout.splitlines()
                     if line.startswith("FAIL ") and len(line.split()) > 1}
            if gate.returncode == 0:
                results.append((name, "GATE-DID-NOT-BITE", expected))
            elif expected in names:
                results.append((name, "caught", f"{len(names)} case(s), incl. {expected}"))
            else:
                results.append((name, "CAUGHT-WRONG-CASE", f"expected {expected}, got {sorted(names)[:3]}"))
            print(f"{results[-1][1]:24} {name}", flush=True)
            write(path, source)
    finally:
        for path, source in backups.items():
            write(path, source)
        subprocess.run(["cargo", "build", "-p", "nomoreide-cli"], cwd=ROOT, capture_output=True, text=True)

    print("\n=== sweep ===")
    for name, verdict, detail in results:
        print(f"{verdict:24} {name}  ({detail})")
    caught = sum(1 for _, verdict, _ in results if verdict == "caught")
    print(f"\ncaught {caught}/{len(results)}")
    return 0 if caught == len(results) else 1


# **Guarded on purpose.** Importing this file to reuse SEEDS -- to validate the
# anchors, say -- must not start a sweep.
if __name__ == "__main__":
    sys.exit(main())
