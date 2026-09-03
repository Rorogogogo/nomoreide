#!/usr/bin/env python3
"""Seeded regression sweep for scripts/check-fs-directories-parity.ts.

Each seed makes one behavioural change to the Rust source, rebuilds, and expects
the gate to fail on a *named* case. A seed the gate does not catch is a hole in
the gate, not a success.

There is no accent level to seed. It would never decide anything — an accented
character's code point is always above its base, so for any two names that tie
on the folded primary the code-point tiebreak already orders them the way the
accent would. A seed that neutralised it changed no order at all, which is what
retired it.

The **case** level has no seed. It only decides between two names that are
equal through the accent level — which means two names differing in case alone,
and those cannot both exist on the case-insensitive filesystem this runs on.
The level is kept because it is right on a case-sensitive one; it simply cannot
be observed from here.

Most of these are about **order**, because order is the part of a listing that
is wrong silently. `localeCompare` is not byte order: it folds case, folds
accents, and sorts punctuation before digits before letters. Each of those four
is a separate seed, aimed at the one fixture directory whose names were chosen
to break a naive comparison. A sort that got any of them wrong would still
return every entry, still round-trip through the picker, and still look
plausible in a screenshot.

The rest cover what a listing omits — two directory names and, by default, every
file — and the fact that a failed read is not handled at all.

Run it alone: it mutates tracked sources and restores them from an in-memory
backup, so a second cargo build racing it tests a binary that is one edit behind
its source. Killing it mid-run leaves a seed on disk.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

CORE = "crates/nomoreide-core/src/directories.rs"
ROUTE = "crates/nomoreide-daemon/src/server/routes/fs_directories.rs"

SEEDS = [
    # --- order ----------------------------------------------------------------
    ("folders-are-not-first", CORE,
     r"""    entries.sort_by(|left, right| match (left.is_dir, right.is_dir) {
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        _ => locale_compare(&left.name, &right.name),
    });""",
     r"""    entries.sort_by(|left, right| locale_compare(&left.name, &right.name));""",
     "browse/with-files"),
    ("sorting-is-byte-order", CORE,
     r"""pub fn locale_compare(left: &str, right: &str) -> Ordering {
    for level in 0..2 {""",
     r"""pub fn locale_compare(left: &str, right: &str) -> Ordering {
    if true {
        return left.cmp(right);
    }
    for level in 0..2 {""",
     "browse/a-directory"),
    ("case-is-significant-at-the-primary-level", CORE,
     r"""                    (1, base.to_lowercase().next().unwrap_or(base) as u32)""",
     r"""                    (1, base as u32)""",
     "browse/a-directory"),
    ("accents-are-not-folded", CORE,
     r"""fn fold(character: char) -> char {
    match character {""",
     r"""fn fold(character: char) -> char {
    if true {
        return character;
    }
    match character {""",
     "browse/a-directory"),
    ("punctuation-sorts-after-letters", CORE,
     r"""                    (0, punctuation_rank(base))""",
     r"""                    (2, punctuation_rank(base))""",
     "browse/a-directory"),
    # The one pair the code-point order gets wrong: `_under` before `.hidden`.
    ("punctuation-sorts-by-code-point", CORE,
     r"""    match ORDER.iter().position(|entry| *entry == character) {
        Some(index) => index as u32,""",
     r"""    match ORDER.iter().position(|_| false) {
        Some(index) => index as u32,""",
     "browse/a-directory"),
    ("a-null-byte-is-not-caught-before-the-filesystem", CORE,
     r"""    if text.contains('\0') {""",
     r"""    if false && text.contains('\0') {""",
     "browse/a-null-byte"),

    # --- what is omitted -------------------------------------------------------
    ("dot-git-is-listed", CORE,
     r"""const IGNORED: [&str; 2] = [".git", "node_modules"];""",
     r"""const IGNORED: [&str; 2] = ["node_modules", "node_modules"];""",
     "browse/a-directory"),
    ("node-modules-is-listed", CORE,
     r"""            if IGNORED.contains(&name.as_str()) {
                continue;
            }""",
     r"""            if name == ".git" {
                continue;
            }""",
     "browse/a-directory"),
    ("the-skip-applies-inside-the-skipped-name", CORE,
     r"""        let is_dir = kind.is_dir();
        if is_dir {""",
     r"""        let is_dir = kind.is_dir();
        if resolved.to_string_lossy().contains("node_modules") {
            continue;
        }
        if is_dir {""",
     "browse/inside-node-modules"),
    ("files-is-truthy-rather-than-one", ROUTE,
     r"""    let include_files = query.get("files").map(String::as_str) == Some("1");""",
     r"""    let include_files = query.get("files").is_some();""",
     "browse/files-is-true"),
    ("a-symlink-counts-as-a-file", CORE,
     r"""        } else if !(include_files && kind.is_file()) {""",
     r"""        } else if !include_files {""",
     "browse/with-files"),

    # --- how a path is resolved ------------------------------------------------
    ("a-blank-path-is-not-the-cwd", ROUTE,
     r"""    let requested = query
        .get("path")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or(&cwd);""",
     r"""    let requested = query.get("path").map(String::as_str).unwrap_or(&cwd);""",
     "browse/a-blank-path"),
    ("a-dot-dot-segment-is-not-folded", CORE,
     r"""            Component::ParentDir => {
                out.pop();
            }""",
     r"""            Component::ParentDir => {
                out.push("..");
            }""",
     "browse/a-dot-dot-segment"),
    ("the-root-is-not-its-own-parent", CORE,
     r"""    path.parent()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| path.to_string_lossy().to_string())""",
     r"""    path.parent()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default()""",
     "browse/the-filesystem-root-parent"),

    # --- failures ---------------------------------------------------------------
    ("a-failed-read-is-a-400", ROUTE,
     r"""        Err(reason) => error(StatusCode::INTERNAL_SERVER_ERROR, &reason),""",
     r"""        Err(reason) => error(StatusCode::BAD_REQUEST, &reason),""",
     "browse/a-directory-that-is-not-there"),
    ("a-missing-directory-says-something-else", CORE,
     r"""    format!("{code}: {reason}, scandir '{}'", path.to_string_lossy())""",
     r"""    format!("{code}: {reason}, readdir '{}'", path.to_string_lossy())""",
     "browse/a-directory-that-is-not-there"),
    ("a-file-is-reported-as-missing", CORE,
     r"""        std::io::ErrorKind::NotADirectory => "ENOTDIR",""",
     r"""        std::io::ErrorKind::NotADirectory => "ENOENT",""",
     "browse/a-file-rather-than-a-directory"),
]

GATE = ["node", "--import", "tsx",
        "scripts/check-fs-directories-parity.ts", "./target/debug/nomoreide"]


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
