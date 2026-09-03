#!/usr/bin/env python3
"""Seeded regression sweep for the github-template parity gate."""
import subprocess, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TEMPLATE = "crates/nomoreide-daemon/src/server/routes/github/template.rs"
MANAGER = "crates/nomoreide-core/src/github_manager.rs"
COMPARE = "crates/nomoreide-core/src/git_manager/compare.rs"

SEEDS = [
    ("an-empty-default-branch-falls-through", TEMPLATE,
     '        .filter(|value| !value.is_null())',
     '        .filter(|value| !value.is_null() && value.as_str() != Some(""))',
     "template/empty-default-branch"),

    ("the-upstream-keeps-its-remote-prefix", TEMPLATE,
     '        .map(|upstream| upstream.strip_prefix("origin/").unwrap_or(upstream))',
     '        .map(|upstream| upstream)',
     "template/base-from-the-upstream"),

    ("the-fallback-base-is-not-main", TEMPLATE,
     'const FALLBACK_BASE: &str = "main";',
     'const FALLBACK_BASE: &str = "master";',
     "template/base-defaults-to-main"),

    ("the-whole-branch-path-becomes-the-title", TEMPLATE,
     '''    let leaf = head
        .split('/')
        .filter(|segment| !segment.is_empty())
        .next_back()
        .unwrap_or(head);''',
     "    let leaf = head;",
     "template/branch-name-with-separators"),

    # The previous seed here dropped the guard entirely, which was a no-op:
    # `to_uppercase` on ASCII punctuation returns the same character, so both
    # match arms produced the same string. This one widens the guard from ASCII
    # to Unicode instead -- the actual difference between the reference's
    # `/^\\w/` and a Unicode-aware rule.
    ("a-non-ascii-letter-is-capitalised", TEMPLATE,
     "        Some(first) if first.is_ascii_alphanumeric() || first == '_' => {",
     "        Some(first) if first.is_alphanumeric() || first == '_' => {",
     "template/branch-name-starting-outside-ascii"),

    ("the-title-comes-from-the-oldest-commit", TEMPLATE,
     "    let latest = commits\n        .last()",
     "    let latest = commits\n        .first()",
     "template/title-from-the-last-commit"),

    ("the-body-lists-the-oldest-commits", TEMPLATE,
     "        for commit in commits\n            .iter()\n"
     "            .skip(commits.len().saturating_sub(BODY_COMMITS))\n        {",
     "        for commit in commits.iter().take(BODY_COMMITS)\n        {",
     "template/more-than-the-body-lists"),

    ("the-body-lists-one-file-too-many", TEMPLATE,
     "        for file in files.iter().take(BODY_FILES) {",
     "        for file in files.iter().take(BODY_FILES + 1) {",
     "template/more-than-the-body-lists"),

    ("the-two-body-sections-run-together", TEMPLATE,
     '''        if !lines.is_empty() {
            lines.push(String::new());
        }''',
     "",
     "template/compared-by-github"),

    ("the-first-local-attempt-also-warns", TEMPLATE,
     "                if reference == remote {",
     "                if true {",
     "template/nothing-can-compare"),

    ("the-remote-ref-is-tried-first", TEMPLATE,
     "    for reference in [base, remote.as_str()] {",
     "    for reference in [remote.as_str(), base] {",
     "template/github-cannot-compare"),

    ("the-head-sha-is-the-first-commit", MANAGER,
     '''            head_sha: commits
                .last()''',
     '''            head_sha: commits
                .first()''',
     "template/compared-by-github"),

    ("a-commit-message-keeps-its-body", MANAGER,
     "        .split(['\\r', '\\n'])\n        .next()",
     "        .split(['\\r'])\n        .next()",
     "template/title-from-the-last-commit"),

    ("the-compare-refs-are-not-escaped", MANAGER,
     '''            "/compare/{}...{}",
            encode_uri_component(base),
            encode_uri_component(head)''',
     '''            "/compare/{}...{}",
            base,
            head''',
     "template/branch-name-with-separators"),

    ("a-missing-ahead-count-is-written-as-null", TEMPLATE,
     '''            if let Some(ahead_by) = summary.ahead_by {
                compare.insert("aheadBy".into(), ahead_by);
            }''',
     '''            compare.insert(
                "aheadBy".into(),
                summary.ahead_by.unwrap_or(Value::Null),
            );''',
     "template/compare-without-an-ahead-count"),

    ("a-rename-is-read-as-two-tokens", COMPARE,
     '''        let (path, step) = if letter == "R" || letter == "C" {
            (tokens.get(index + 2), 3)
        } else {
            (tokens.get(index + 1), 2)
        };''',
     "        let (path, step) = (tokens.get(index + 1), 2);",
     "template/local-compare-with-a-rename"),

    ("an-identical-branch-reports-one-commit-ahead", TEMPLATE,
     '    compare.insert("aheadBy".into(), json!(0));',
     '    compare.insert("aheadBy".into(), json!(1));',
     "template/head-is-the-base"),
]


def read(path):
    with open(os.path.join(ROOT, path)) as handle:
        return handle.read()


def write(path, text):
    with open(os.path.join(ROOT, path), "w") as handle:
        handle.write(text)


def cargo_is_busy():
    """Another build holds the target lock — see the api sweep for why this matters."""
    probe = subprocess.run(["cargo", "build", "-p", "nomoreide-cli", "--quiet"], cwd=ROOT,
                           capture_output=True, text=True, timeout=1800)
    return "Blocking waiting for file lock" in probe.stderr


def main():
    # An optional name filter, so a seed whose anchor or expectation changed can
    # be re-proven on its own instead of re-running the whole sweep.
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
                ["node", "--import", "tsx", "scripts/check-github-template-parity.ts",
                 "./target/debug/nomoreide"],
                cwd=ROOT, capture_output=True, text=True)
            names = {line.split()[1] for line in gate.stdout.splitlines() if line.startswith("FAIL ")}
            if gate.returncode == 0:
                results.append((name, "GATE-DID-NOT-BITE", expected))
            elif expected in names:
                results.append((name, "caught", f"{len(names)} case(s), incl. {expected}"))
            else:
                results.append((name, "CAUGHT-BY-ANOTHER-CASE", f"expected {expected}, got {sorted(names)[:4]}"))
            write(path, source)
            print(f"{results[-1][1]:24} {name}", flush=True)
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
# anchors, say -- must not start a sweep. Without the guard the import runs
# main(), which mutates the sources and leaves a seed behind if it is killed.
if __name__ == "__main__":
    sys.exit(main())
