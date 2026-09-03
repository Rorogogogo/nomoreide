#!/usr/bin/env python3
"""Seeded regression sweep for scripts/check-database-export-parity.ts.

Each seed makes one behavioural change to the Rust source, rebuilds, and expects
the gate to fail on a *named* case. A seed the gate does not catch is a hole in
the gate, not a success.

Two guards in the export path have **no seed here**, because SQLite cannot
reach them and no fixture can stand up the engine that could:

  * Negative zero. SQLite normalises `-0.0` to `0.0` on storage, so a negative
    zero never reaches the formatter through this route. `js_number`'s handling
    of it is defended by a unit test in `db/export.rs` instead.
  * The refusal to export an object that is neither table, view, nor
    materialized view. SQLite's catalog lists only tables and views, so there is
    no object of another kind to refuse. Postgres has functions and sequences;
    a gate that needed a Postgres server would be testing the server.

Run it alone: it mutates tracked sources and restores them from an in-memory
backup, so a second cargo build racing it tests a binary that is one edit behind
its source. Killing it mid-run leaves a seed on disk -- for an untracked file
git cannot restore it, so check before trusting the next gate run.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ROUTE = "crates/nomoreide-daemon/src/server/routes/database_catalog.rs"
EXPORT = "crates/nomoreide-core/src/db/export.rs"

SEEDS = [
    # --- the CSV rules --------------------------------------------------------
    ("a-cell-is-never-quoted", EXPORT,
     r"""    if text.contains([',', '"', '\r', '\n']) {""",
     r"""    if false {""",
     "export/csv"),
    ("a-quote-inside-is-not-doubled", EXPORT,
     r"""        format!("\"{}\"", text.replace('"', "\"\""))""",
     r"""        format!("\"{text}\"")""",
     "export/csv"),
    ("a-formula-is-left-alone", EXPORT,
     r"""    let dangerous = from_string""",
     r"""    let dangerous = false && from_string""",
     "export/csv"),
    ("a-number-can-be-a-formula-too", EXPORT,
     r"""    let dangerous = from_string
        && (text.starts_with(['\t', '\r']) || text.trim_start().starts_with(['=', '+', '-', '@']));""",
     r"""    let dangerous =
        text.starts_with(['\t', '\r']) || text.trim_start().starts_with(['=', '+', '-', '@']);
    let _ = from_string;""",
     "export/numbers-csv"),
    ("only-a-leading-equals-is-dangerous", EXPORT,
     r"""        && (text.starts_with(['\t', '\r']) || text.trim_start().starts_with(['=', '+', '-', '@']));""",
     r"""        && text.trim_start().starts_with('=');""",
     "export/csv"),
    ("rows-end-with-a-newline-alone", EXPORT,
     r"""    format!("{}\r\n", cells.collect::<Vec<_>>().join(","))""",
     r"""    format!("{}\n", cells.collect::<Vec<_>>().join(","))""",
     "export/csv"),

    # --- the JSON document ----------------------------------------------------
    ("the-json-document-ends-without-a-newline", EXPORT,
     r"""            ExportFormat::Json => "]\n".to_string(),""",
     r"""            ExportFormat::Json => "]".to_string(),""",
     "export/empty-table-json"),
    ("every-json-row-is-preceded-by-a-comma", EXPORT,
     r"""                let separator = if self.first_json_row { "" } else { "," };""",
     r"""                let separator = ",";""",
     "export/json"),

    # --- how a number is spelled ----------------------------------------------
    ("a-whole-float-keeps-its-point", EXPORT,
     r"""    if number.fract() == 0.0 && number.abs() < 1e21 {
        return format!("{number:.0}");""",
     r"""    if false {
        return format!("{number:.0}");""",
     "export/numbers-csv"),
    ("the-exponent-starts-earlier", EXPORT,
     r"""    if number.fract() == 0.0 && number.abs() < 1e21 {""",
     r"""    if number.fract() == 0.0 && number.abs() < 1e15 {""",
     "export/numbers-csv"),

    # --- masking --------------------------------------------------------------
    ("an-export-is-a-way-around-the-masking", EXPORT,
     r"""                let value = if is_sensitive_preview_column(&column) && !value.is_null() {""",
     r"""                let value = if false {""",
     "export/csv"),

    # --- the file's name ------------------------------------------------------
    ("the-filename-keeps-every-character", EXPORT,
     r"""        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {""",
     r"""        if true {""",
     "export/filename-from-an-odd-connection-name"),
    ("the-disposition-has-one-spelling", EXPORT,
     r'''        "attachment; filename=\"{ascii}\"; filename*=UTF-8''{}",
        percent_encode(filename)
    )''',
     r'''        "attachment; filename=\"{ascii}\"{}",
        String::new()
    )''',
     "export/csv"),

    # --- the format parameter -------------------------------------------------
    ("the-format-is-matched-loosely", EXPORT,
     r"""        match value {
            "csv" => Some(Self::Csv),""",
     r"""        match value.to_ascii_lowercase().as_str() {
            "csv" => Some(Self::Csv),""",
     "export/format-wrong-case"),
    ("a-missing-format-is-csv", ROUTE,
     r"""        Some(format) => format,
        None => return error(StatusCode::BAD_REQUEST, "format must be csv or json"),""",
     r"""        Some(format) => format,
        None => db::ExportFormat::Csv,""",
     "export/missing-format"),

    # --- the response headers -------------------------------------------------
    ("the-two-formats-share-a-content-type", EXPORT,
     r"""            Self::Csv => "text/csv; charset=utf-8",""",
     r"""            Self::Csv => "application/json; charset=utf-8",""",
     "export/csv"),
    ("a-download-of-live-data-is-cacheable", ROUTE,
     r"""            (header::CACHE_CONTROL, "no-store".to_string()),""",
     r"""            (header::CACHE_CONTROL, "max-age=60".to_string()),""",
     "export/csv"),
    ("the-content-type-may-be-sniffed", ROUTE,
     r"""                "nosniff".to_string(),""",
     r"""                "".to_string(),""",
     "export/csv"),

    # --- which rows, in which order -------------------------------------------
    ("the-primary-key-orders-the-other-way", EXPORT,
     r"""    } else {
        primary_keys
    };""",
     r"""    } else {
        primary_keys
            .iter()
            .map(|column| format!("{column} DESC"))
            .collect()
    };""",
     "export/composite-key-table-csv"),
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
                 "scripts/check-database-export-parity.ts", "./target/debug/nomoreide"],
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
