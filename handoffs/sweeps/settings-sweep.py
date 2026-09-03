#!/usr/bin/env python3
"""Seeded regression sweep for scripts/check-settings-parity.ts.

Each seed makes one behavioural change to the Rust source, rebuilds, and expects
the gate to fail on a *named* case. A seed the gate does not catch is a hole in
the gate, not a success.

Three clusters.

**Scoping.** `projectPath` is matched against the registered repositories
*exactly*, after canonicalisation. Seeds turn the exact match into a prefix
match (which would hand a nested directory the repository's settings) and drop
the extra check writes make that the path is a real directory rather than a
link. Both of those read as harmless relaxations and neither is.

**The two validators.** Global terminal settings and project preferences are
separate schemas that happen to look alike, so each is seeded on its own. What
has to match is the prose zod prints: a fractional number is `not_an_integer`,
not `too_small`, and an unknown key is reported at the depth it was found.

**Merging.** A patch merges into what is stored and a reset clears it; the two
`read-back` cases are the only thing standing between those and a store that
silently replaces or silently keeps.

One behaviour deliberately has no seed: `revalidated()` re-resolves the scope
after the body has been read, and no case in the gate can observe it, because
observing it means swapping the directory mid-request. It is a narrowing of a
race, not a behaviour a black-box diff can reach.

Run it alone: it mutates tracked sources and restores them from an in-memory
backup, so a second cargo build racing it tests a binary that is one edit behind
its source. Killing it mid-run leaves a seed on disk.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ROUTE = "crates/nomoreide-daemon/src/server/routes/settings.rs"
SETTINGS = "crates/nomoreide-core/src/app_settings.rs"
CONFIG = "crates/nomoreide-core/src/config.rs"

SEEDS = [
    # --- scoping --------------------------------------------------------------
    ("a-nested-directory-is-in-scope", ROUTE,
     r"""        if registered != canonical {
            continue;
        }""",
     r"""        if !canonical.starts_with(&registered) {
            continue;
        }""",
     "read/a-directory-inside-the-repo"),
    ("a-write-may-go-through-a-link", ROUTE,
     r"""        if for_write {
            require_direct_directory(&requested, &repository.path).await?;
        }""",
     r"""        if for_write && false {
            require_direct_directory(&requested, &repository.path).await?;
        }""",
     "project/through-a-symlink"),
    ("a-blank-project-path-is-not-caught-early", ROUTE,
     r"""    if requested.is_empty() {
        return Err(refuse("projectPath must not be empty."));
    }""",
     r"""    if requested.is_empty() && false {
        return Err(refuse("projectPath must not be empty."));
    }""",
     "read/with-a-blank-project"),
    ("a-path-that-is-not-there-reports-the-wrong-refusal", ROUTE,
     r"""        return Err(refuse(
            "projectPath must be an existing registered repository.",
        ));""",
     r"""        return Err(refuse(
            "projectPath must exactly match a registered repository.",
        ));""",
     "read/with-a-project-that-is-not-there"),
    ("no-project-is-not-the-defaults", ROUTE,
     r"""        None => default_preferences(),""",
     r"""        None => serde_json::json!({}),""",
     "read/without-a-project"),
    ("a-refusal-is-not-a-400", ROUTE,
     r"""    error(StatusCode::BAD_REQUEST, message)""",
     r"""    error(StatusCode::UNPROCESSABLE_ENTITY, message)""",
     "project/no-project-path"),

    # --- the body -------------------------------------------------------------
    ("an-empty-body-is-a-refusal", ROUTE,
     r"""    if raw.is_empty() {
        return Ok(json!({}));
    }""",
     r"""    if raw.is_empty() {
        return Err("Request body must be valid JSON.");
    }""",
     "global/an-empty-body"),
    ("a-body-that-is-not-an-object-is-accepted", ROUTE,
     r"""    if !value.is_object() {
        return Err("Request body must be a JSON object.");
    }""",
     r"""    if !value.is_object() && false {
        return Err("Request body must be a JSON object.");
    }""",
     "global/a-body-that-is-an-array"),

    # --- the project preferences schema ---------------------------------------
    ("an-unknown-group-is-accepted", ROUTE,
     r"""    if !unknown.is_empty() {
        return Err(report(&[ZodIssue::unrecognized_keys(unknown, Vec::new())]));
    }

    let mut issues = Vec::new();
    for group in groups {""",
     r"""    let _ = &unknown;

    let mut issues = Vec::new();
    for group in groups {""",
     "project/a-top-level-key-nobody-knows"),
    ("an-unknown-key-in-a-group-is-accepted", ROUTE,
     r"""        if !unknown.is_empty() {
            return Err(report(&[ZodIssue::unrecognized_keys(
                unknown,
                vec![json!(group)],
            )]));
        }""",
     r"""        let _ = &unknown;""",
     "project/a-key-nobody-knows"),
    ("a-result-limit-is-not-bounded", ROUTE,
     r"""                issues.extend(nomoreide_core::app_settings::bounded(
                    value, 10, 5_000, path,
                ));""",
     r"""                issues.extend(nomoreide_core::app_settings::bounded(
                    value, 1, 5_000_000, path,
                ));""",
     "project/a-result-limit-below-the-floor"),
    ("a-project-boolean-is-not-type-checked", ROUTE,
     r"""            } else if !value.is_boolean() {
                issues.push(ZodIssue::wrong_type("boolean", type_name(value), path));
            }""",
     r"""            } else if false {
                issues.push(ZodIssue::wrong_type("boolean", type_name(value), path));
            }""",
     "project/a-boolean-that-is-a-string"),

    # --- the global terminal schema -------------------------------------------
    ("a-font-size-is-not-bounded", SETTINGS,
     r"""            "fontSize" => issues.extend(bounded(value, 10, 24, path)),""",
     r"""            "fontSize" => issues.extend(bounded(value, 1, 240, path)),""",
     "global/a-font-that-is-too-small"),
    ("a-scrollback-is-not-bounded", SETTINGS,
     r"""            "scrollback" => issues.extend(bounded(value, 500, 100_000, path)),""",
     r"""            "scrollback" => issues.extend(bounded(value, 1, 100_000, path)),""",
     "global/a-scrollback-below-the-floor"),
    ("a-fractional-number-is-reported-as-too-small", SETTINGS,
     r"""    if number.fract() != 0.0 {
        return vec![ZodIssue::not_an_integer(path)];
    }""",
     r"""    if number.fract() != 0.0 {
        return vec![ZodIssue::too_small(minimum, path)];
    }""",
     "global/a-font-that-is-not-an-integer"),
    ("a-cursor-style-is-not-checked", SETTINGS,
     r"""        Some(text) if options.contains(&text) => Vec::new(),
        Some(text) => vec![ZodIssue::bad_enum(text, options, path)],""",
     r"""        Some(_) => Vec::new(),""",
     "global/a-cursor-that-is-not-one-of-the-three"),
    ("an-unknown-terminal-key-is-accepted", SETTINGS,
     r"""    if !unknown.is_empty() {
        return Err(report(&[ZodIssue::unrecognized_keys(
            unknown,
            vec![json!("terminal")],
        )]));
    }""",
     r"""    let _ = &unknown;""",
     "global/a-key-nobody-knows"),

    # --- merging and resetting --------------------------------------------------
    ("a-global-patch-replaces-rather-than-merges", SETTINGS,
     r"""        let mut settings = self.load().await?;""",
     r"""        let mut settings = AppSettings::default();""",
     "global/another-field-keeps-the-first"),
    ("a-global-reset-keeps-what-was-stored", SETTINGS,
     r"""        let settings = AppSettings::default();
        self.persist(&settings).await?;""",
     r"""        let settings = self.load().await?;
        self.persist(&settings).await?;""",
     "reset/global-read-back"),
    ("a-project-patch-replaces-rather-than-merges", CONFIG,
     r"""        let mut current = config
            .preferences
            .clone()
            .unwrap_or_else(default_preferences);""",
     r"""        let mut current = serde_json::json!({});""",
     "project/read-back"),
    ("a-project-reset-does-not-clear-the-key", CONFIG,
     r"""        config.preferences = None;
        self.save(&config).await?;""",
     r"""        self.save(&config).await?;""",
     "reset/project-read-back"),
]

GATE = ["node", "--import", "tsx",
        "scripts/check-settings-parity.ts", "./target/debug/nomoreide"]


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
