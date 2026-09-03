#!/usr/bin/env python3
"""Seeded regression sweep for scripts/check-database-writes-parity.ts.

Each seed makes one behavioural change to the Rust source, rebuilds, and expects
the gate to fail on a *named* case. A seed the gate does not catch is a hole in
the gate, not a success.

Run it alone: it mutates tracked sources and restores them from an in-memory
backup, so a second cargo build racing it tests a binary that is one edit behind
its source. Killing it mid-run leaves a seed on disk -- for an untracked file
git cannot restore it, so check before trusting the next gate run.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ROUTE = "crates/nomoreide-daemon/src/server/routes/database_write.rs"
ACTIONS = "crates/nomoreide-actions/src/db.rs"
SQL = "crates/nomoreide-core/src/db/sql.rs"
ENGINE = "crates/nomoreide-core/src/db/engine.rs"

SEEDS = [
    # --- the lock, which is the whole point of the file ----------------------
    ("a-locked-connection-still-writes", ROUTE,
     '''    if database.write_unlocked != Some(true) {''',
     '''    if false {''',
     "execute/locked-connection-refuses"),
    ("any-write-unlocked-value-unlocks", ROUTE,
     '''    if database.write_unlocked != Some(true) {''',
     '''    if database.write_unlocked.is_none() {''',
     "execute/relocked-connection-refuses"),

    # --- the order the two routes check things in ----------------------------
    ("execute-reads-the-statement-before-the-lock", ROUTE,
     '''    let database = match unlocked_connection(&state, &uri).await {
        Ok(database) => database,
        Err(response) => return response,
    };

    // A read is run as a read''',
     '''    if db::is_read_statement(&sql) {
        return error(StatusCode::BAD_REQUEST, "seeded: read before lock");
    }
    let database = match unlocked_connection(&state, &uri).await {
        Ok(database) => database,
        Err(response) => return response,
    };

    // A read is run as a read''',
     "execute/locked-connection-with-a-read"),

    # --- reads versus writes --------------------------------------------------
    ("a-read-is-run-as-a-write", ROUTE,
     '''    let outcome = if db::is_read_statement(&sql) {''',
     '''    let outcome = if false {''',
     "execute/a-read-statement"),
    ("a-write-is-run-as-a-read", ROUTE,
     '''    let outcome = if db::is_read_statement(&sql) {''',
     '''    let outcome = if true {''',
     "execute/preview"),
    ("a-preview-commits", ROUTE,
     '''    let commit = form.get("mode").map(String::as_str) == Some("commit");''',
     '''    let commit = form.get("mode").map(String::as_str) != Some("never");''',
     "fixture/rows-on-disk"),

    # --- only the first statement runs ---------------------------------------
    ("every-statement-runs", ROUTE,
     '''    let sql = db::first_statement(&sql).trim().to_string();''',
     '''    let sql = sql.trim().to_string();''',
     "execute/two-statements"),
    ("a-semicolon-in-a-literal-ends-the-statement", SQL,
     '''                b'\\'' => state = Inside::Single,''',
     '''                b'\\'' => {}''',
     "execute/semicolon-inside-a-literal"),

    # --- what the database said ----------------------------------------------
    ("the-drivers-framing-is-reported", ENGINE,
     """        sqlx::Error::Database(failure) => failure.message().to_string(),""",
     """        sqlx::Error::Database(failure) => sqlx::Error::Database(failure).to_string(),""",
     "execute/unknown-table"),

    # --- the delete's two-sided confirmation ---------------------------------
    ("a-commit-needs-no-confirmed-count", ACTIONS,
     '''    let Some(expected) = expected else {
        return Err("A confirmed preview count is required before deleting rows.".to_string());
    };''',
     '''    let Some(expected) = expected else {
        return Ok(());
    };''',
     "delete/commit"),
    ("the-confirmed-count-is-not-checked-against-the-selection", ACTIONS,
     '''    if expected != keys as u64 {''',
     '''    if false {
        let _ = keys;''',
     "delete/expected-rows-disagree"),
    ("the-confirmed-count-is-not-checked-against-the-rows", ACTIONS,
     '''        if affected != expected {''',
     '''        if false {''',
     "delete/expected-rows-agree-but-a-row-is-missing"),
    ("a-preview-is-confirmed-too", ACTIONS,
     '''    if !commit {
        return Ok(());
    }''',
     '''    if false {
        return Ok(());
    }''',
     "delete/preview"),

    # --- the tuples ----------------------------------------------------------
    ("more-than-a-hundred-rows-go-at-once", ACTIONS,
     '''const MAX_DELETE_ROWS: usize = 100;''',
     '''const MAX_DELETE_ROWS: usize = 500;''',
     "delete/one-hundred-and-one-tuples"),
    ("an-empty-selection-is-a-cap-problem", ACTIONS,
     '''    if keys.is_empty() {
        return Err("At least one primary-key tuple is required.".to_string());
    }''',
     '''    if false {
        return Err("At least one primary-key tuple is required.".to_string());
    }''',
     "delete/no-tuples"),
    ("a-duplicate-tuple-is-accepted", ACTIONS,
     '''        if !tuples.insert(tuple) {
            return Err(format!("Primary-key tuple {position} is a duplicate."));
        }''',
     '''        tuples.insert(tuple);''',
     "delete/duplicate-tuples"),
    ("a-masked-value-deletes-a-row", ACTIONS,
     '''                Value::String(value) if value == "\\u{2022}\\u{2022}\\u{2022}\\u{2022}" => {''',
     '''                Value::String(value) if value == "never-matches-anything" => {''',
     "delete/masked-value-in-a-tuple"),
    # Caught by the *extra*-column case, not the partial one: a tuple missing a
    # column still fails the per-column lookup below with the same sentence, so
    # removing the length check only lets a tuple carrying extra columns
    # through.
    ("a-tuple-with-extra-columns-is-accepted", ACTIONS,
     '''        if key.len() != primary_keys.len()
            || key
                .keys()
                .any(|name| !expected_names.contains(name.as_str()))
        {''',
     '''        if false {''',
     "delete/extra-column-in-tuple"),
    ("a-table-without-a-primary-key-can-be-deleted-from", ACTIONS,
     '''    if primary_keys.is_empty() {''',
     '''    if false {''',
     "delete/table-without-a-primary-key"),
    ("a-view-can-be-deleted-from", ROUTE,
     '''    if object.kind != "table" {''',
     '''    if false {''',
     "delete/view"),

    # --- the form -------------------------------------------------------------
    ("an-unknown-mode-is-a-preview", ROUTE,
     '''    if mode != "preview" && mode != "commit" {''',
     '''    if false {''',
     "delete/unknown-mode"),
    ("malformed-tuples-report-the-parsers-words", ROUTE,
     '''    let Ok(parsed) = js_json::parse(&raw_tuples) else {
        return error(StatusCode::BAD_REQUEST, "tuples must be a valid JSON array");
    };''',
     '''    let parsed = match js_json::parse(&raw_tuples) {
        Ok(parsed) => parsed,
        Err(message) => return error(StatusCode::BAD_REQUEST, &message),
    };''',
     "delete/tuples-are-not-json"),
    ("the-tuples-are-parsed-after-the-lock", ROUTE,
     '''    let raw_tuples = match required(&form, "tuples") {''',
     '''    if let Err(response) = unlocked_connection(&state, &uri).await {
        return response;
    }
    let raw_tuples = match required(&form, "tuples") {''',
     "delete/locked-connection-with-bad-tuples"),
    ("a-missing-statement-is-a-400", ROUTE,
     '''        None => return error(StatusCode::INTERNAL_SERVER_ERROR, "sql is required"),''',
     '''        None => return error(StatusCode::BAD_REQUEST, "sql is required"),''',
     "execute/missing-sql"),
]


def read(path):
    with open(os.path.join(ROOT, path)) as handle:
        return handle.read()


def write(path, text):
    with open(os.path.join(ROOT, path), "w") as handle:
        handle.write(text)


def cargo_is_busy():
    probe = subprocess.run(["cargo", "build", "-p", "nomoreide-cli", "--quiet"], cwd=ROOT,
                           capture_output=True, text=True, timeout=1800)
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
            gate = subprocess.run(
                ["node", "--import", "tsx",
                 "scripts/check-database-writes-parity.ts", "./target/debug/nomoreide"],
                cwd=ROOT, capture_output=True, text=True)
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
