#!/usr/bin/env python3
"""Seeded regression sweep for scripts/check-service-register-parity.ts.

Each seed makes one behavioural change to the Rust source, rebuilds, and expects
the gate to fail on a *named* case. A seed the gate does not catch is a hole in
the gate, not a success.

This slice has **two error vocabularies over one form**, and the seeds mostly
exist to keep them apart. `env` and `args` arrive as JSON text and are parsed by
the route, which refuses in its own words with a 400. Everything else is read
into an object that the union validator judges, and *that* refusal escapes
unwrapped as a 500 carrying zod's report. Swapping either status, or borrowing
the other's wording, is invisible unless a case pins both.

Between the two sits a third thing that is neither: the route reads a handful of
required fields itself, before the schema, and which ones depends on the kind it
thinks it is building. A form with nothing in it therefore says `name is
required` rather than producing a three-armed report about every field.

The `test` route seeds are about reproducing Node: a spawn failure is reported
as `spawn <program> <ERRNO>`, argv bypasses the shell, and the service's own
`.env` is layered *under* the caller's `env` rather than over it.

Run it alone: it mutates tracked sources and restores them from an in-memory
backup, so a second cargo build racing it tests a binary that is one edit behind
its source. Killing it mid-run leaves a seed on disk.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ROUTE = "crates/nomoreide-daemon/src/server/routes/service_register.rs"
TEST = "crates/nomoreide-core/src/service_test.rs"
DEFN = "crates/nomoreide-core/src/service_definition.rs"

SEEDS = [
    # --- the route's own form vocabulary --------------------------------------
    ("a-form-refusal-is-not-a-400", ROUTE,
     r"""        // A ConfigValidationError in the reference, which its dispatcher
        // answers with a 400.
        Err(reason) => return error(StatusCode::BAD_REQUEST, &reason),""",
     r"""        Err(reason) => return error(StatusCode::INTERNAL_SERVER_ERROR, &reason),""",
     "register/env-that-is-not-json"),
    ("env-that-is-an-array-is-accepted", ROUTE,
     r"""    let Some(map) = value.as_object() else {
        return Err("env must be a JSON object.".to_string());
    };""",
     r"""    let empty = serde_json::Map::new();
    let map = value.as_object().unwrap_or(&empty);""",
     "register/env-that-is-an-array"),
    ("an-env-name-may-carry-a-dot", ROUTE,
     r"""        && characters.all(|c| c.is_ascii_alphanumeric() || c == '_')""",
     r"""        && characters.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')""",
     "register/env-with-a-dotted-name"),
    ("an-env-value-need-not-be-a-string", ROUTE,
     r"""        if !entry.is_string() {
            return Err(format!("Environment variable \"{key}\" must be a string."));
        }""",
     r"""        let _ = &entry;""",
     "register/env-with-a-non-string-value"),
    ("args-may-hold-a-number", ROUTE,
     r"""    if !list.iter().all(Value::is_string) {
        return Err(message.to_string());
    }""",
     r"""    let _ = &list;""",
     "register/args-holding-a-number"),
    ("a-null-byte-in-args-is-not-caught", ROUTE,
     r"""    if list
        .iter()
        .any(|entry| entry.as_str().is_some_and(|text| text.contains('\0')))
    {
        return Err("args contain an invalid null byte.".to_string());
    }""",
     r"""    let _ = &list;""",
     "register/a-null-byte-in-args"),

    # --- what the route reads before the schema -------------------------------
    ("a-missing-name-is-worded-differently", ROUTE,
     r"""        return error(StatusCode::INTERNAL_SERVER_ERROR, "name is required");""",
     r"""        return error(StatusCode::INTERNAL_SERVER_ERROR, "Service name is required");""",
     "register/nothing-at-all"),
    ("an-unknown-kind-is-not-dropped", ROUTE,
     r"""        .filter(|value| *value == "docker-compose" || *value == "ssh")""",
     r"""        .filter(|value| !value.is_empty())""",
     "register/an-unknown-kind"),
    ("a-blank-port-is-read-as-a-number", ROUTE,
     r"""    if let Some(raw) = form
        .get("port")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        match raw.parse::<u64>() {""",
     r"""    if let Some(raw) = form.get("port").map(|value| value.trim()) {
        match raw.parse::<u64>() {""",
     "register/a-blank-port"),
    ("an-unreadable-port-is-dropped", ROUTE,
     r"""            Err(_) => {
                arguments.insert("port".to_string(), Value::from("NaN"));
            }""",
     r"""            Err(_) => {}""",
     "register/an-unreadable-port"),
    ("a-self-reference-is-kept-as-a-dependency", ROUTE,
     r"""        .filter(|value| !value.is_empty() && *value != name)""",
     r"""        .filter(|value| !value.is_empty())""",
     "register/local-with-everything"),
    ("the-required-fields-ignore-the-kind", ROUTE,
     r"""    let required: &[&str] = match arguments.get("kind").and_then(Value::as_str) {
        Some("docker-compose") => &["cwd", "composeService"],
        Some("ssh") => &["host", "cwd", "command"],
        _ => &["command", "cwd"],
    };""",
     r"""    let required: &[&str] = &["command", "cwd"];""",
     "register/compose-without-a-service"),
    ("a-required-field-is-reported-as-a-400", ROUTE,
     r"""            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("{field} is required"),
            );""",
     r"""            return error(StatusCode::BAD_REQUEST, &format!("{field} is required"));""",
     "register/local-without-a-command"),
    ("a-schema-refusal-is-a-400", ROUTE,
     r"""        Err(report) => return error(StatusCode::INTERNAL_SERVER_ERROR, &report),""",
     r"""        Err(report) => return error(StatusCode::BAD_REQUEST, &report),""",
     "register/an-ssh-command-with-a-null-byte"),
    ("a-compose-field-never-reaches-the-schema", ROUTE,
     r"""        ("composeService", "composeService"),""",
     r"""        ("composeService", "composeServiceIgnored"),""",
     "register/compose"),
    ("depends-on-is-not-stored", ROUTE,
     r"""    definition.depends_on = arguments.get("dependsOn").map(|value| {""",
     r"""    definition.depends_on = None.map(|value: &Value| {""",
     "register/local-with-everything"),

    # --- the union validator ---------------------------------------------------
    # The arms all check the port *first*, so an unreadable port and a missing
    # field are reported in that order. Only a case that fails twice can see it.
    ("the-port-is-checked-last-rather-than-first", DEFN,
     r"""const SSH_CHECKS: &[Check] = &[
    Check::Port,
    Check::Kind,""",
     r"""const SSH_CHECKS: &[Check] = &[
    Check::Kind,""",
     "register/an-unreadable-port-and-a-null-byte"),

    # --- the command tester ----------------------------------------------------
    ("a-tester-refusal-is-a-400", ROUTE,
     r"""        return error(StatusCode::INTERNAL_SERVER_ERROR, "command is required");""",
     r"""        return error(StatusCode::BAD_REQUEST, "command is required");""",
     "test/no-command"),
    ("the-dotenv-is-not-read", TEST,
     r"""    let file_env: HashMap<String, String> = env_file::read(format!("{}/.env", request.cwd))""",
     r"""    let file_env: HashMap<String, String> = env_file::read(format!("{}/.env.none", request.cwd))""",
     "test/the-dotenv-is-read"),
    ("the-dotenv-wins-over-the-caller", TEST,
     r"""    for (key, value) in file_env {
        command.env(key, value);
    }
    for (key, value) in request.env.iter().flatten() {
        command.env(key, value);
    }""",
     r"""    for (key, value) in request.env.iter().flatten() {
        command.env(key, value);
    }
    for (key, value) in file_env {
        command.env(key, value);
    }""",
     "test/the-caller-wins-over-the-dotenv"),
    ("argv-goes-through-a-shell", TEST,
     r"""    let mut command = match &request.args {
        Some(args) => {
            let mut command = Command::new(&request.command);
            command.args(args);
            command
        }""",
     r"""    let mut command = match &request.args {
        Some(args) => {
            let mut command = Command::new("/bin/sh");
            command
                .arg("-c")
                .arg(format!("{} {}", request.command, args.join(" ")));
            command
        }""",
     "test/argv-does-not-reach-a-shell"),
    ("a-spawn-failure-is-not-nodes-wording", TEST,
     r"""        .map_err(|error| format!("spawn {program} {}", errno_name(&error)))""",
     r"""        .map_err(|error| format!("{error}"))""",
     "test/a-cwd-that-is-not-there"),
    ("a-tester-timeout-is-shorter", TEST,
     r"""const TIMEOUT: Duration = Duration::from_millis(2500);""",
     r"""const TIMEOUT: Duration = Duration::from_millis(1);""",
     "test/a-command-that-prints"),
]

GATE = ["node", "--import", "tsx",
        "scripts/check-service-register-parity.ts", "./target/debug/nomoreide"]


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
