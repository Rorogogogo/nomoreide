#!/usr/bin/env python3
"""Seeded regression sweep for scripts/check-service-files-parity.ts.

Each seed makes one behavioural change to the Rust source, rebuilds, and expects
the gate to fail on a *named* case. A seed the gate does not catch is a hole in
the gate, not a success.

Three clusters.

**Which files count.** `format_from_name` is three regexes rewritten by hand,
and the fixture plants a `config.json` and a `readme.md` next to the real ones
precisely so a rule that got looser is visible. The walk that finds them is
bounded by depth and by an ignore list, and it sorts each directory before
descending — without that last part two runtimes disagree on nothing more than
what order the OS handed back.

**Staying inside the service directory.** `..`, an absolute path, and a null
byte are each refused, in both the read/write route and the browse route, and
the two refusals are worded differently. Seeds relax each check separately.

**Writing.** An `.env` file is merged and everything else is replaced; JSON is
parsed first and YAML deliberately is not. `parse_env_entries` refuses five
different ways and every one of them escapes as a 500, so each gets a seed.

Two branches here have **no seed**, both because nothing outside can reach them.
`parse_env_entries` refuses a payload that is neither an object nor an array,
and `read_json_object` has already turned every such body into `{}` — an array
reaches the *next* check and is refused for a different reason, which is what
the `put/env-a-body-that-is-an-array` case pins. The per-directory sort inside
the config-file walk is the other: the whole result is sorted by relative path
at the end, so that sort only decides which files survive the 200-file cap, and
observing it would need a fixture of more than 200 config files.

One thing here has **no seed and no coverage**: the staleness half of
`/api/services/:name/env/runtime`. Nothing is stale unless the service is
running, the gate never starts one, and doing so would put two unequal
timestamps (`startedAt`, `modifiedAt`) into the diff. Closing it means teaching
the gate to erase timestamps, not adding a seed.

Run it alone: it mutates tracked sources and restores them from an in-memory
backup, so a second cargo build racing it tests a binary that is one edit behind
its source. Killing it mid-run leaves a seed on disk.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ROUTE = "crates/nomoreide-daemon/src/server/routes/service_files.rs"
FILES = "crates/nomoreide-core/src/config_files.rs"

SEEDS = [
    # --- which files count -----------------------------------------------------
    ("an-env-suffix-is-not-recognised", FILES,
     r"""    if name == ".env" || name.starts_with(".env.") {""",
     r"""    if name == ".env" {""",
     "file/env-with-a-suffix"),
    ("the-json-rule-is-looser", FILES,
     r"""        if stem == "appsettings" || (stem.starts_with("appsettings.") && stem.len() > 12) {""",
     r"""        if stem == "appsettings" || stem == "config" {""",
     "file/unsupported-name"),
    ("only-one-yaml-extension-is-recognised", FILES,
     r"""    for suffix in [".yaml", ".yml"] {""",
     r"""    for suffix in [".yaml"] {""",
     "file/yaml"),
    ("the-walk-has-no-depth-limit", FILES,
     r"""                if ignored.contains(name.as_str()) || depth + 1 > MAX_DEPTH {""",
     r"""                if ignored.contains(name.as_str()) {""",
     "config-files/detect"),
    ("the-walk-ignores-nothing", FILES,
     r"""fn ignored_dirs() -> HashSet<&'static str> {""",
     r"""fn ignored_dirs() -> HashSet<&'static str> {
    if true {
        return HashSet::new();
    }""",
     "config-files/detect"),
    ("a-browse-listing-does-not-group-by-kind", FILES,
     r"""    items.sort_by(|a, b| a.kind.cmp(b.kind).then(a.name.cmp(&b.name)));""",
     r"""    items.sort_by(|a, b| a.name.cmp(&b.name));""",
     "browse/root"),

    # --- staying inside --------------------------------------------------------
    ("a-file-path-may-climb-out", FILES,
     r"""    if relative == ".." || relative.starts_with("../") || Path::new(&relative).is_absolute() {
        return Err(ConfigFilePathError(
            "Config file must live inside the service directory.".to_string(),
        ));
    }""",
     r"""    let _ = &relative;""",
     "file/climbing-out"),
    ("a-null-byte-in-a-path-is-not-caught", FILES,
     r"""    if requested.is_empty() || requested.contains('\0') {""",
     r"""    if requested.is_empty() {""",
     "file/a-null-byte"),
    ("a-browse-path-may-climb-out", FILES,
     r"""        Some(relative)
            if relative != ".."
                && !relative.starts_with("../")
                && !Path::new(&relative).is_absolute() =>
        {
            Ok(candidate.to_path_buf())
        }""",
     r"""        Some(_) => Ok(candidate.to_path_buf()),""",
     "browse/climbing-out"),
    ("the-two-refusals-are-worded-alike", FILES,
     r"""        _ => Err(ConfigFilePathError(
            "Path must live inside the service directory.".to_string(),
        )),""",
     r"""        _ => Err(ConfigFilePathError(
            "Config file must live inside the service directory.".to_string(),
        )),""",
     "browse/climbing-out"),

    # --- the route's statuses --------------------------------------------------
    ("an-unregistered-service-is-a-400", ROUTE,
     r"""        return Err(error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Service \"{name}\" not found."),
        ));""",
     r"""        return Err(error(
            StatusCode::BAD_REQUEST,
            &format!("Service \"{name}\" not found."),
        ));""",
     "config-files/unregistered-service"),
    ("a-browse-refusal-is-a-500", ROUTE,
     r"""        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),""",
     r"""        Err(reason) => error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()),""",
     "browse/climbing-out"),
    ("a-missing-path-is-worded-differently", ROUTE,
     r"""        return error(StatusCode::BAD_REQUEST, "path is required");""",
     r"""        return error(StatusCode::BAD_REQUEST, "A path is required.");""",
     "file/no-path"),
    ("an-env-write-refusal-is-a-400", ROUTE,
     r"""            // Unwrapped in the reference, so it escapes as a 500.
            Err(reason) => return error(StatusCode::INTERNAL_SERVER_ERROR, &reason),""",
     r"""            Err(reason) => return error(StatusCode::BAD_REQUEST, &reason),""",
     "put/env-entries-that-are-not-a-list"),
    ("content-must-be-a-string-is-a-500", ROUTE,
     r"""        return error(StatusCode::BAD_REQUEST, "content must be a string");""",
     r"""        return error(StatusCode::INTERNAL_SERVER_ERROR, "content must be a string");""",
     "put/json-content-is-not-a-string"),

    # --- writing ---------------------------------------------------------------
    ("an-env-write-replaces-rather-than-merges", ROUTE,
     r"""        let merged = env_file::merge_entries(&existing.unwrap_or_default(), &entries);""",
     r"""        let merged = env_file::merge_entries(&Vec::new(), &entries);""",
     # The *response* cannot see this. `merge_entries` replaces the whole pair
     # set with what was submitted and keeps only the comments and blank lines,
     # so dropping the existing base changes nothing a caller reads back — it
     # loses the comments. The byte census is what catches it, which is what
     # the census is for.
     "files/on-disk"),
    ("json-is-not-validated", ROUTE,
     r"""        if let Err(reason) = crate::server::js_json::parse(content) {""",
     r"""        if let Err(reason) = crate::server::js_json::parse("{}") {""",
     "put/json-invalid"),
    ("yaml-is-validated-too", ROUTE,
     r"""    if file.format == ConfigFileFormat::Json {""",
     r"""    if file.format != ConfigFileFormat::Env {""",
     "put/yaml-is-not-validated"),
    ("missing-directories-are-not-created", ROUTE,
     r"""    if let Some(parent) = std::path::Path::new(&file.path).parent() {
        if tokio::fs::create_dir_all(parent).await.is_err() {""",
     r"""    if let Some(parent) = std::path::Path::new(&file.path).parent().filter(|_| false) {
        if tokio::fs::create_dir_all(parent).await.is_err() {""",
     "put/creates-missing-directories"),

    # --- the five ways an entry list is refused --------------------------------
    ("an-entry-that-is-not-an-object-is-accepted", ROUTE,
     r"""        if !item.is_object() {
            return Err("each entry must be { key, value }.".to_string());
        }""",
     r"""        let _ = &item;""",
     "put/env-an-entry-that-is-not-an-object"),
    ("an-env-key-may-not-carry-a-dot", ROUTE,
     r"""        && characters.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')""",
     r"""        && characters.all(|c| c.is_ascii_alphanumeric() || c == '_')""",
     "put/env-a-dotted-key"),
    ("a-missing-key-is-rendered-differently", ROUTE,
     r"""                .unwrap_or_else(|| "undefined".to_string());""",
     r"""                .unwrap_or_else(|| "null".to_string());""",
     "put/env-a-key-that-is-missing"),
    ("a-value-that-is-not-a-string-is-accepted", ROUTE,
     r"""        let Some(value) = item.get("value").and_then(Value::as_str) else {
            return Err(format!("value for \"{key}\" must be a string."));
        };""",
     r"""        let value = item.get("value").and_then(Value::as_str).unwrap_or_default();""",
     "put/env-a-value-that-is-not-a-string"),
    ("a-duplicate-env-key-is-accepted", ROUTE,
     r"""        if seen.contains(&key) {
            return Err(format!("duplicate env key: {key}"));
        }""",
     r"""        let _ = &seen;""",
     "put/env-a-duplicate-key"),
]

GATE = ["node", "--import", "tsx",
        "scripts/check-service-files-parity.ts", "./target/debug/nomoreide"]


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
