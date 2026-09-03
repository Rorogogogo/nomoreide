#!/usr/bin/env python3
"""Seeded regression sweep for scripts/check-database-connections-parity.ts.

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

DB = "crates/nomoreide-core/src/db/mod.rs"
ENV = "crates/nomoreide-core/src/env_file.rs"
ROUTE = "crates/nomoreide-daemon/src/server/routes/database.rs"
CONFIG = "crates/nomoreide-core/src/config.rs"

SEEDS = [
    # --- masking ------------------------------------------------------------
    ("the-query-string-keeps-its-secrets", DB,
     "            mask_sensitive_query(&mut parsed);",
     "            // seeded: no query masking",
     "list/seeded"),
    ("only-the-password-field-is-a-secret", DB,
     '    if lower.contains("password") || lower.contains("passwd") || lower.contains("secret")\n        || lower.contains("token")\n    {\n        return true;\n    }',
     '    if lower.contains("password") {\n        return true;\n    }',
     "list/seeded"),
    ("a-camel-cased-key-is-not-matched", DB,
     "    let lower = key.to_ascii_lowercase();",
     "    let lower = key.to_string();",
     "list/seeded"),
    ("api-key-needs-its-separator", DB,
     "        let rest = match rest.first() {\n            Some(b'_') | Some(b'-') => &rest[1..],\n            _ => rest,\n        };",
     "        let rest = &rest[..];",
     "list/seeded"),
    ("the-masked-edges-are-three-characters", DB,
     "    const KEPT_EDGE: usize = 4;",
     "    const KEPT_EDGE: usize = 3;",
     "list/seeded"),
    ("an-eight-character-url-shows-its-edges", DB,
     "            if characters.len() <= KEPT_EDGE * 2 {",
     "            if characters.len() < KEPT_EDGE * 2 {",
     "list/seeded"),

    # --- engine detection ----------------------------------------------------
    ("mariadb-is-not-mysql", DB,
     '    if lower.starts_with("mysql://") || lower.starts_with("mariadb://") {',
     '    if lower.starts_with("mysql://") {',
     "detect/seeded"),
    ("a-file-url-is-not-sqlite", DB,
     '    if let Some(rest) = lower.strip_prefix("file:") {',
     '    if let Some(rest) = lower.strip_prefix("file-never-matches:") {',
     "detect/seeded"),
    ("a-bare-path-is-not-sqlite", DB,
     '    if [".db", ".sqlite", ".sqlite3"]\n        .iter()\n        .any(|ext| lower.ends_with(ext))\n    {\n        return Some("sqlite");\n    }',
     '    if false {\n        return Some("sqlite");\n    }',
     "detect/seeded"),

    # --- detection scan ------------------------------------------------------
    ("the-same-connection-is-offered-twice", DB,
     '            if !seen.insert(format!("{engine}:{}", entry.value)) {\n                continue;\n            }',
     '            seen.insert(format!("{engine}:{}", entry.value));',
     "detect/seeded"),
    ("detection-hands-back-a-masked-url", DB,
     "                masked_url: mask_url(engine, &entry.value),\n                url: entry.value,",
     "                masked_url: mask_url(engine, &entry.value),\n                url: mask_url(engine, &entry.value),",
     "detect/seeded"),

    # --- env parsing ---------------------------------------------------------
    ("a-double-quoted-value-keeps-its-quotes", ENV,
     '        if first == \'"\' && last == \'"\' {',
     '        if false {',
     "detect/seeded"),
    ("a-single-quoted-value-keeps-its-quotes", ENV,
     "        if first == '\\'' && last == '\\'' {",
     "        if false {",
     "detect/seeded"),

    # --- password merge ------------------------------------------------------
    ("an-edit-wipes-the-stored-password", DB,
     "    let decoded = percent_decode(password);\n    if next.set_password(Some(&decoded)).is_err() {\n        return next_url.to_string();\n    }\n    next.to_string()",
     "    let _ = password;\n    next_url.to_string()",
     "list/after-password-merge"),
    ("a-supplied-password-loses-to-the-stored-one", DB,
     '    if next.password().is_some_and(|value| !value.is_empty()) {\n        return next_url.to_string();\n    }',
     "    // seeded: the stored password always wins",
     # Only the stored config can show this one. Both passwords are non-empty,
     # so the listing masks each to the same `****` -- which is the mask working,
     # not the gate failing to look.
     "config/on-disk"),
    # No seed for the `engine == "sqlite"` early return in
    # `merge_stored_password`. It cannot change an outcome: a SQLite connection
    # string is a bare filesystem path, which `Url::parse` rejects, and the
    # parse failure returns the same string the guard returns. The guard stays
    # because it mirrors the reference and states the intent; a seed claiming
    # the gate can see it would be a seed that always misses.

    # --- the form ------------------------------------------------------------
    ("a-required-value-is-not-trimmed", ROUTE,
     '    form.get(key)\n        .map(|value| value.trim())\n        .filter(|value| !value.is_empty())\n        .map(str::to_string)\n        .ok_or_else(|| format!("{key} is required"))',
     '    form.get(key)\n        .map(|value| value.as_str())\n        .filter(|value| !value.is_empty())\n        .map(str::to_string)\n        .ok_or_else(|| format!("{key} is required"))',
     "list/after-whitespace-register"),
    ("a-blank-optional-value-is-kept", ROUTE,
     "fn optional(form: &std::collections::HashMap<String, String>, key: &str) -> Option<String> {\n    form.get(key)\n        .map(|value| value.trim())\n        .filter(|value| !value.is_empty())",
     "fn optional(form: &std::collections::HashMap<String, String>, key: &str) -> Option<String> {\n    form.get(key)\n        .map(|value| value.trim())",
     "list/after-blank-project-path"),
    ("the-engine-name-is-case-insensitive", ROUTE,
     "        .find(|engine| **engine == value)",
     "        .find(|engine| engine.eq_ignore_ascii_case(value))",
     "register/engine-wrong-case"),
    ("a-missing-field-is-a-bad-request", ROUTE,
     "    error(StatusCode::INTERNAL_SERVER_ERROR, message)",
     "    error(StatusCode::BAD_REQUEST, message)",
     "register/no-name"),
    ("anything-truthy-unlocks-writes", ROUTE,
     '        Ok(value) => value == "true",',
     '        Ok(value) => !value.is_empty(),',
     "write-access/truthy-but-not-true"),
    ("an-edit-relocks-the-connection", ROUTE,
     "        write_unlocked: existing.and_then(|existing| existing.write_unlocked),",
     "        write_unlocked: None,",
     "list/after-unlock-carry"),
    ("an-edit-keeps-the-old-project-path", ROUTE,
     '        write_unlocked: existing.and_then(|existing| existing.write_unlocked),\n'
     '        project_path: optional(&form, "projectPath"),',
     '        write_unlocked: existing.as_ref().and_then(|existing| existing.write_unlocked),\n'
     '        project_path: optional(&form, "projectPath")\n'
     '            .or_else(|| existing.and_then(|existing| existing.project_path)),',
     "list/after-project-path-cleared"),
    ("the-name-is-decoded-twice", ROUTE,
     "    Some(percent_decode(segment))",
     "    Some(percent_decode(&percent_decode(segment)))",
     # Removing a name that is not registered still answers `{ ok: true }`, so
     # the decode is only visible in what the next listing still contains.
     "list/after-removals"),
    ("a-static-path-shadows-the-name", ROUTE,
     '            get(detect).delete(remove).fallback(method_not_allowed),',
     "            get(detect).fallback(method_not_allowed),",
     "remove/shadowed-by-detect"),

    # --- config --------------------------------------------------------------
    ("unlocking-an-unknown-connection-succeeds", CONFIG,
     '        let Some(database) = config.databases.iter_mut().find(|d| d.name == name) else {\n            return Err(anyhow::anyhow!(\n                "Database connection \\"{name}\\" is not registered."\n            ));\n        };\n        database.write_unlocked = Some(unlocked);',
     "        if let Some(database) = config.databases.iter_mut().find(|d| d.name == name) {\n            database.write_unlocked = Some(unlocked);\n        }",
     "write-access/unknown-connection"),
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
                 "scripts/check-database-connections-parity.ts", "./target/debug/nomoreide"],
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
