#!/usr/bin/env python3
"""Seeded regression sweep for scripts/check-database-catalog-parity.ts.

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

ROUTE = "crates/nomoreide-daemon/src/server/routes/database_catalog.rs"
JSON_ERR = "crates/nomoreide-daemon/src/server/js_json.rs"
BODY = "crates/nomoreide-daemon/src/server/body.rs"
PEEK = "crates/nomoreide-core/src/db/peek.rs"
ROWS = "crates/nomoreide-core/src/db/rows.rs"
CATALOG = "crates/nomoreide-core/src/db/catalog.rs"
SQL = "crates/nomoreide-core/src/db/sql.rs"
ENGINE = "crates/nomoreide-core/src/db/engine.rs"

SEEDS = [
    # --- the route's own refusals --------------------------------------------
    ("a-missing-query-param-is-not-refused", ROUTE,
     '''    let schema = match require_param(&uri, "schema") {
        Ok(schema) => schema,
        Err(message) => return error(StatusCode::BAD_REQUEST, &message),
    };''',
     '''    let schema = parse_query(&uri).remove("schema").unwrap_or_default();''',
     "objects/missing-schema"),
    ("an-empty-query-param-counts-as-given", ROUTE,
     '''        .remove(key)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{key} query param is required"))''',
     '''        .remove(key)
        .ok_or_else(|| format!("{key} query param is required"))''',
     "objects/empty-schema"),
    ("a-refusal-from-the-driver-is-a-400", ROUTE,
     '''fn throw(message: &str) -> Response {
    error(StatusCode::INTERNAL_SERVER_ERROR, message)
}''',
     '''fn throw(message: &str) -> Response {
    error(StatusCode::BAD_REQUEST, message)
}''',
     "capabilities/unknown-connection"),
    ("a-missing-row-cap-is-zero-rather-than-a-hundred", ROUTE,
     '''    let limit = js_number_or(params.get("limit").map(String::as_str), 100.0) as i64;''',
     '''    let limit = js_number(params.get("limit").map(String::as_str)) as i64;''',
     "catalog-rows/limit-not-a-number"),
    ("a-zero-row-cap-is-taken-literally", ROUTE,
     '''    if parsed.is_finite() && parsed > 0.0 {''',
     '''    if parsed.is_finite() && parsed >= 0.0 {''',
     "rows/limit-zero"),
    ("the-named-table-route-masks-like-the-browser", ROUTE,
     '''        db::peek_sample(&database, &table, limit, offset)
            .await
            .map(|sample| merge(json!({ "ok": true }), sample))''',
     '''        db::sample_object(&database, &table, Some(limit), Some(offset), None)
            .await
            .map(|rows| merge(json!({ "ok": true }), json!(rows)))''',
     "rows/keeps-secret-columns"),
    ("an-unreadable-sort-direction-is-ignored", ROUTE,
     '''        if direction != "asc" && direction != "desc" {
            return Err("sortDirection must be asc or desc".to_string());
        }''',
     '''        let _ = direction;''',
     "sort/invalid-direction"),
    ("a-column-with-no-direction-sorts-descending", ROUTE,
     '''            direction: if direction.map(String::as_str) == Some("desc") {
                "desc".to_string()
            } else {
                "asc".to_string()
            },''',
     '''            direction: if direction.map(String::as_str) == Some("asc") {
                "asc".to_string()
            } else {
                "desc".to_string()
            },''',
     "sort/column-without-direction"),
    ("a-json-object-passes-for-a-filter-list", ROUTE,
     '''            if !parsed.is_array() {
                return Err("filters must be a JSON array".to_string());
            }''',
     '''            if false {
                return Err("filters must be a JSON array".to_string());
            }''',
     "filters/json-but-not-array"),
    ("bad-sql-is-a-server-error", ROUTE,
     '''        Err(reason) => error(StatusCode::BAD_REQUEST, &reason),
    }
}''',
     '''        Err(reason) => throw(&reason),
    }
}''',
     "query/syntax-error"),
    ("a-blank-statement-is-a-statement", ROUTE,
     '''    let sql = match form
        .get("sql")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())''',
     '''    let sql = match form
        .get("sql")
        .map(|value| value.as_str())
        .filter(|value| !value.is_empty())''',
     "query/blank-sql"),
    ("a-connection-name-is-not-decoded", ROUTE,
     '''    Some(percent_decode(segment))
}''',
     '''    Some(segment.to_string())
}''',
     "capabilities/encoded-name"),

    # --- reading the query string --------------------------------------------
    ("a-repeated-query-param-keeps-its-last-value", BODY,
     '''        form.entry(percent_decode(key))
            .or_insert_with(|| percent_decode(value));''',
     '''        form.insert(percent_decode(key), percent_decode(value));''',
     "objects/repeated-schema-param"),

    # --- V8's JSON diagnostics ------------------------------------------------
    ("an-unterminated-string-is-just-an-early-end", JSON_ERR,
     '''    if text.starts_with("EOF while parsing a string") {''',
     '''    if false {''',
     "filters/unterminated-string"),
    ("content-after-a-value-is-an-unexpected-token", JSON_ERR,
     '''    if text.starts_with("trailing characters") {''',
     '''    if false {''',
     "filters/trailing-junk"),
    ("a-long-document-is-quoted-whole", JSON_ERR,
     '''    if chars.len() <= 20 {''',
     '''    if chars.len() <= 100 {''',
     "filters/long-junk"),
    ("the-snippet-window-is-five-characters", JSON_ERR,
     '''    let start = position.saturating_sub(10);
    let end = (position + 10).min(chars.len());''',
     '''    let start = position.saturating_sub(5);
    let end = (position + 5).min(chars.len());''',
     "filters/junk-late-in-a-long-document"),

    # --- the statement a caller wrote ----------------------------------------
    ("a-trailing-semicolon-reaches-the-engine", PEEK,
     '''    let trimmed = trimmed.strip_suffix(';').unwrap_or(trimmed).trim();''',
     '''    let trimmed = trimmed;''',
     "query/trailing-semicolon"),
    ("every-trailing-semicolon-is-dropped", PEEK,
     '''    let trimmed = trimmed.strip_suffix(';').unwrap_or(trimmed).trim();''',
     '''    let trimmed = trimmed.trim_end_matches(';').trim();''',
     "query/two-trailing-semicolons"),

    # --- the row caps ---------------------------------------------------------
    ("a-named-table-has-no-row-cap", PEEK,
     '''    let limit = limit.clamp(1, 5_000);
    let offset = offset.max(0);''',
     '''    let offset = offset.max(0);''',
     "rows/limit-above-cap"),
    ("the-browsers-row-cap-is-unbounded", ROWS,
     '''    let limit = limit.unwrap_or(100).clamp(1, 5_000);''',
     '''    let limit = limit.unwrap_or(100).max(1);''',
     "catalog-rows/limit-above-cap"),
    ("a-negative-offset-pages-backwards", ROWS,
     '''    let offset = offset.unwrap_or(0).max(0);''',
     '''    let offset = offset.unwrap_or(0);''',
     "catalog-rows/offset-negative"),

    # --- the opaque key -------------------------------------------------------
    ("a-malformed-key-says-it-is-malformed", CATALOG,
     '''        .ok_or_else(|| NO_SUCH_OBJECT.to_string())?;''',
     '''        .ok_or_else(|| "Invalid database object key".to_string())?;''',
     "catalog-rows/undecodable-key"),
    ("a-key-naming-an-unknown-schema-says-so", CATALOG,
     '''    if !schemas_for(database).await?.contains(&identity.schema) {
        return Err(NO_SUCH_OBJECT.to_string());
    }
    objects_for(database, &identity.schema)''',
     '''    objects_for(database, &identity.schema)''',
     "details/key-naming-an-unknown-schema"),
    ("an-unknown-schema-holds-an-error", PEEK,
     '''        return Ok(Vec::new());
    }
    objects_for(database, schema).await''',
     '''        return Err("Schema was not found in the live catalog".to_string());
    }
    objects_for(database, schema).await''',
     "objects/unknown-schema"),

    # --- the shapes -----------------------------------------------------------
    ("a-schema-is-a-bare-name", ROUTE,
     '''                "schemas": schemas
                    .into_iter()
                    .map(|name| json!({ "name": name }))
                    .collect::<Vec<_>>(),''',
     '''                "schemas": schemas,''',
     "schemas/sqlite"),
    ("a-sqlite-table-has-no-schema", ROWS,
     '''            "schema": object.schema,''',
     '''            "schema": if object.schema == "main" { Value::Null } else { json!(object.schema) },''',
     "catalog-rows/default-limit"),
    ("a-primary-key-is-sampled-as-text", ROWS,
     '''        .map(|column| quote_identifier(&column.name, &database.engine))''',
     '''        .map(|column| if column.primary_key {
            let q = quote_identifier(&column.name, &database.engine);
            format!("CAST({q} AS TEXT) AS {q}")
        } else {
            quote_identifier(&column.name, &database.engine)
        })''',
     "catalog-rows/default-limit"),
    ("bytes-are-a-human-label", ENGINE,
     '''fn bytes_value(bytes: &[u8]) -> Value {
    Value::Object(''',
     '''fn bytes_value(bytes: &[u8]) -> Value {
    return Value::String(format!("<blob {} bytes>", bytes.len()));
    #[allow(unreachable_code)]
    Value::Object(''',
     "catalog-rows/every-storage-class"),
    ("a-secret-looking-column-is-shown", SQL,
     '''pub fn is_sensitive_preview_column(column: &str) -> bool {''',
     '''pub fn is_sensitive_preview_column(column: &str) -> bool {
    if true {
        return false;
    }''',
     "catalog-rows/masks-secret-columns"),

    # --- the browser's controls ----------------------------------------------
    ("a-like-wildcard-in-a-value-is-a-wildcard", ROWS,
     '''                        value = value
                            .replace('!', "!!")
                            .replace('%', "!%")
                            .replace('_', "!_");''',
     '''                        value = value;''',
     "filters/contains-percent"),
    ("nine-filters-are-supported", ROWS,
     '''    if query.filters.len() > 8 {''',
     '''    if query.filters.len() > 9 {''',
     "filters/too-many"),
    # Caught by a *filtered* read rather than a sorted one: SQLite serves
    # `author_id = 1` from `books_author_idx (author_id, pages DESC)` and hands
    # the rows back in index order, so without the primary key appended they
    # arrive newest-first. A sorted read would not show it -- ties there fall
    # back to rowid, which is already the primary key.
    ("paging-is-not-stabilised-by-the-primary-key", ROWS,
     '''    for column in columns.iter().filter(|column| column.primary_key) {
        if !order.iter().any(|(name, _)| name == &column.name) {
            order.push((column.name.clone(), "ASC"));
        }
    }''',
     '''    let _ = &columns;''',
     "filters/eq"),
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
                 "scripts/check-database-catalog-parity.ts", "./target/debug/nomoreide"],
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
