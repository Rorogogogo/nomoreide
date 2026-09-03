#!/usr/bin/env python3
"""Seeded regression sweep for scripts/check-log-sources-parity.ts.

Each seed makes one behavioural change to the Rust source, rebuilds, and expects
the gate to fail on a *named* case. A seed the gate does not catch is a hole in
the gate, not a success.

Three clusters.

**Which status a failure gets.** The slice has three error vocabularies over one
form — an unwrapped 500, a caught 400, and a read failure that is a *200* with
`ok: false` — and every seed here swaps one for another. None of them changes
whether the request failed, only how, which is exactly the kind of divergence a
gate that checked `ok` alone would sleep through.

**Reproducing Node.** `Command failed: <argv>\\n<stderr>` for a non-zero exit;
one trailing newline dropped rather than kept as an empty line; `Number()` over
`lines`, floored. Each is seeded against the case that shows it.

**The filters.** `grep` is case-insensitive and falls back to a literal when it
does not compile; `level: warn` keeps error-looking lines too; a file tail is one
stream, so the error pattern is also what makes a line render red.

An unrecognised `level` is dropped twice — once when the query is parsed and
again by the filter, which falls through for anything that is not `warn` or
`error`. Neither guard is reachable through the other, so neither can be
seeded; the reference has the same redundant pair.

Two things here have **no seed**, for the same reason in both cases — no case can
observe them. `clamp_lines` guards against a non-positive count that
`parse_log_query` has already dropped, so neither guard is reachable through the
other (the reference has the same redundant pair). And the journald and docker
argv builders are never invoked: neither `journalctl` nor a docker daemon exists
on the machines this runs on, so a read is the same "not found" on both sides.
Unit tests cover the argv; a black-box diff cannot.

Run it alone: it mutates tracked sources and restores them from an in-memory
backup, so a second cargo build racing it tests a binary that is one edit behind
its source. Killing it mid-run leaves a seed on disk.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

CORE = "crates/nomoreide-core/src/log_sources.rs"
ROUTE = "crates/nomoreide-daemon/src/server/routes/log_sources.rs"
CONFIG = "crates/nomoreide-core/src/config.rs"

SEEDS = [
    # --- which status a failure gets ------------------------------------------
    ("a-missing-name-is-a-400", ROUTE,
     r"""        Err(reason) => return error(StatusCode::INTERNAL_SERVER_ERROR, &reason),
    };
    let kind = match required(&form, "kind") {""",
     r"""        Err(reason) => return error(StatusCode::BAD_REQUEST, &reason),
    };
    let kind = match required(&form, "kind") {""",
     "register/nothing-at-all"),
    ("an-unknown-kind-is-a-400", ROUTE,
     r"""        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!(
                "Unsupported log source kind \"{kind}\". Use one of: {}.",""",
     r"""        return error(
            StatusCode::BAD_REQUEST,
            &format!(
                "Unsupported log source kind \"{kind}\". Use one of: {}.",""",
     "register/an-unknown-kind"),
    ("a-schema-refusal-is-a-500", ROUTE,
     r"""    if let Err(reason) = validate_log_source(&definition) {
        return error(StatusCode::BAD_REQUEST, &reason);
    }""",
     r"""    if let Err(reason) = validate_log_source(&definition) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, &reason);
    }""",
     "register/a-file-without-a-path"),
    ("an-unknown-source-is-not-a-404", ROUTE,
     r"""        return error(
            StatusCode::NOT_FOUND,
            &format!("Unknown log source \"{name}\"."),
        );""",
     r"""        return error(
            StatusCode::BAD_REQUEST,
            &format!("Unknown log source \"{name}\"."),
        );""",
     "logs/an-unknown-source"),
    ("a-failed-read-is-a-500", ROUTE,
     r"""        Err(reason) => Json(json!({ "ok": false, "error": reason })).into_response(),""",
     r"""        Err(reason) => error(StatusCode::INTERNAL_SERVER_ERROR, &reason),""",
     "logs/a-file-that-is-not-there"),

    # --- the form -------------------------------------------------------------
    ("a-driver-does-not-return-early", ROUTE,
     r"""        Some("journald") => {
            if missing(&source.unit) {
                issues.push(ZodIssue::custom("journald log source requires a unit."));
            }
        }""",
     r"""        Some("journald") => {
            if missing(&source.unit) {
                issues.push(ZodIssue::custom("journald log source requires a unit."));
            }
            if missing(&source.path) {
                issues.push(ZodIssue::custom("File log source requires a path."));
            }
        }""",
     "register/a-journald-source"),
    ("a-blank-optional-is-kept", ROUTE,
     r"""fn optional(form: &HashMap<String, String>, key: &str) -> Option<String> {
    form.get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}""",
     r"""fn optional(form: &HashMap<String, String>, key: &str) -> Option<String> {
    form.get(key).cloned()
}""",
     "register/a-file-with-a-blank-path"),
    ("a-delete-trims-its-name", ROUTE,
     r"""    match state.config_store.remove_log_source(&name).await {""",
     r"""    match state.config_store.remove_log_source(name.trim()).await {""",
     "delete/a-padded-name"),
    ("a-registration-does-not-move-to-the-end", CONFIG,
     r"""        config.log_sources.retain(|s| s.name != source.name);
        config.log_sources.push(source);""",
     r"""        config.log_sources.retain(|s| s.name != source.name);
        config.log_sources.insert(0, source);""",
     "register/replaced-read-back"),

    # --- reproducing Node ------------------------------------------------------
    ("a-trailing-newline-starts-an-empty-line", CORE,
     r"""    let text = output.strip_suffix('\n').unwrap_or(output);""",
     r"""    let text = output;""",
     "logs/a-file-source"),
    ("a-blank-line-is-dropped", CORE,
     r"""    text.split('\n')
        .map(|line| LogSourceEntry {""",
     r"""    text.split('\n')
        .filter(|line| !line.is_empty())
        .map(|line| LogSourceEntry {""",
     "logs/a-file-source"),
    ("a-command-failure-is-not-nodes-wording", CORE,
     r"""        return Err(format!("Command failed: {}\n{stderr}", argv.join(" ")));""",
     r"""        return Err(stderr);""",
     "logs/a-command-that-fails"),
    ("a-commands-stderr-is-stdout", CORE,
     r"""            let mut entries = to_entries(&source.name, &stdout, "stdout");
            entries.extend(to_entries(&source.name, &stderr, "stderr"));
            Ok(tail(apply_client_filters(entries, query), count))
        }
    }
}""",
     r"""            let mut entries = to_entries(&source.name, &stdout, "stdout");
            entries.extend(to_entries(&source.name, &stderr, "stdout"));
            Ok(tail(apply_client_filters(entries, query), count))
        }
    }
}""",
     "logs/a-command-that-writes-to-stderr"),
    ("a-fractional-line-count-rounds-up", CORE,
     r"""    (lines.floor() as u32).min(MAX_LINES)""",
     r"""    (lines.ceil() as u32).min(MAX_LINES)""",
     "logs/fractional-lines"),
    ("the-default-is-not-five-hundred", CORE,
     r"""const DEFAULT_LINES: u32 = 500;""",
     r"""const DEFAULT_LINES: u32 = 250;""",
     "logs/the-default-is-five-hundred"),
    ("the-ceiling-is-not-five-thousand", CORE,
     r"""const MAX_LINES: u32 = 5_000;""",
     r"""const MAX_LINES: u32 = 4_000;""",
     "logs/lines-above-the-ceiling"),
    ("an-unreadable-line-count-is-not-the-default", CORE,
     r"""    trimmed.parse::<f64>().unwrap_or(f64::NAN)""",
     r"""    trimmed.parse::<f64>().unwrap_or(1.0)""",
     "logs/lines-that-are-not-a-number"),

    # --- the filters -----------------------------------------------------------
    ("an-error-line-is-not-reflagged", CORE,
     r"""            stream: if default_stream == "stdout" && error_pattern().is_match(line) {""",
     r"""            stream: if false && default_stream == "stdout" && error_pattern().is_match(line) {""",
     "logs/level-error"),
    ("warn-does-not-include-errors", CORE,
     r"""        Some("warn") => result.retain(|entry| {
            entry.stream == "stderr"
                || error_pattern().is_match(&entry.text)
                || warn_pattern().is_match(&entry.text)
        }),""",
     r"""        Some("warn") => result.retain(|entry| warn_pattern().is_match(&entry.text)),""",
     "logs/level-warn"),
    ("the-warn-pattern-is-narrower", CORE,
     r"""        RegexBuilder::new(r"\b(warn|warning|deprecated)\b")""",
     r"""        RegexBuilder::new(r"\b(warn|deprecated)\b")""",
     "logs/level-warn"),
    ("grep-is-case-sensitive", CORE,
     r"""fn compile_grep(term: &str) -> Regex {
    RegexBuilder::new(term)
        .case_insensitive(true)""",
     r"""fn compile_grep(term: &str) -> Regex {
    RegexBuilder::new(term)
        .case_insensitive(false)""",
     "logs/grep-is-case-insensitive"),
    ("grep-does-not-fall-back-to-a-literal", CORE,
     r"""            RegexBuilder::new(&regex::escape(term))""",
     r"""            RegexBuilder::new(&regex::escape("\u{0}no such line\u{0}"))""",
     "logs/grep-that-is-not-a-regex"),
]

GATE = ["node", "--import", "tsx",
        "scripts/check-log-sources-parity.ts", "./target/debug/nomoreide"]


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
