#!/usr/bin/env python3
"""Seeded regression sweep for the github-api parity gate."""
import subprocess, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
API = "crates/nomoreide-daemon/src/server/routes/github/api.rs"
QUERY = "crates/nomoreide-daemon/src/server/query.rs"
MANAGER = "crates/nomoreide-core/src/github_manager.rs"
ROUTES = "crates/nomoreide-daemon/src/server/routes.rs"

SEEDS = [
    ("json-does-not-declare-its-charset", ROUTES,
     "    if response.headers().get(CONTENT_TYPE) == Some(&BARE) {",
     "    if false {",
     "prs/default-query"),

    ("page-takes-rusts-own-infinity", QUERY,
     '''    if digits
        .chars()
        .any(|character| matches!(character, 'i' | 'I' | 'n' | 'N'))
    {
        return f64::NAN;
    }
''',
     "",
     "prs/page-rust-infinity"),

    ("page-zero-is-kept", QUERY,
     "    if parsed == 0.0 || parsed.is_nan() {",
     "    if parsed.is_nan() {",
     "prs/page-zero"),

    ("a-whole-page-prints-as-a-float", QUERY,
     '        return format!("{number:.0}");',
     '        return format!("{number:?}");',
     "prs/default-query"),

    ("the-default-state-is-not-open", API,
     '            _ => "open",',
     '            _ => "all",',
     "prs/default-query"),

    ("a-blank-state-is-forwarded", API,
     "            Some(state) if !state.is_empty() => state,",
     "            Some(state) => state,",
     "prs/blank-state"),

    ("an-unknown-merge-method-is-forwarded", API,
     '        Some(method @ ("merge" | "squash" | "rebase")) => method,',
     '        Some(method) => method,',
     "prs/merge-unknown-method"),

    ("an-empty-commit-title-is-sent", MANAGER,
     "        if let Some(title) = commit_title.filter(|value| !value.is_empty()) {",
     "        if let Some(title) = commit_title {",
     "prs/merge-with-an-empty-commit-title"),

    ("a-missing-pr-body-is-sent-as-null", MANAGER,
     '''        if let Some(body) = body {
            payload.insert("body".into(), json!(body));
        }
        payload.insert("head".into(), json!(head));''',
     '''        payload.insert("body".into(), json!(body));
        payload.insert("head".into(), json!(head));''',
     "prs/create-without-a-body"),

    ("a-missing-issue-body-is-sent-as-null", MANAGER,
     '''        payload.insert("title".into(), json!(title));
        if let Some(body) = body {
            payload.insert("body".into(), json!(body));
        }
        self.send(''',
     '''        payload.insert("title".into(), json!(title));
        payload.insert("body".into(), json!(body));
        self.send(''',
     "issues/create-without-a-body"),

    ("any-draft-value-counts-as-a-draft", API,
     '            body.get("draft") == Some(&Value::Bool(true)),',
     '            !matches!(body.get("draft"), None | Some(Value::Null) | Some(Value::Bool(false))),',
     "prs/create-draft-is-a-string"),

    ("fields-are-not-trimmed", API,
     '''    string_field(body, key)
        .unwrap_or_default()
        .trim()
        .to_string()''',
     "    string_field(body, key).unwrap_or_default().to_string()",
     "prs/create-blank-after-trimming"),

    ("pull-requests-are-not-filtered-out-of-issues", MANAGER,
     '            .filter(|issue| !has_content(issue.get("pull_request")))\n',
     "",
     "issues/default"),

    ("a-null-pull-request-marker-filters-the-issue-out", MANAGER,
     '            .filter(|issue| !has_content(issue.get("pull_request")))',
     '            .filter(|issue| issue.get("pull_request").is_none())',
     "issues/default"),

    ("a-short-sha-is-accepted", API,
     "    (4..=64).contains(&value.len())",
     "    (1..=64).contains(&value.len())",
     "ci/too-short"),

    ("an-uppercase-sha-is-accepted", API,
     "            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))",
     "            .all(|byte| byte.is_ascii_hexdigit())",
     "ci/uppercase"),

    ("a-non-numeric-path-reaches-the-handler", API,
     "    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {",
     "    if value.is_empty() {",
     "prs/get-not-a-number"),

    ("a-missing-envelope-field-becomes-an-empty-list", API,
     '''    if let Some(value) = value {
        answer.insert(name.to_string(), value);
    }''',
     '    answer.insert(name.to_string(), value.unwrap_or_else(|| Value::Array(vec![])));',
     "runs/jobs-without-a-jobs-key"),

    ("a-head-without-a-sha-asks-after-the-empty-commit", MANAGER,
     '            sha.unwrap_or("undefined")',
     '            sha.unwrap_or("")',
     "prs/review-head-without-a-sha"),

    ("branches-lose-their-commit-wrapper", MANAGER,
     '                out.insert("commit".into(), Value::Object(sha));',
     '                out.insert("commit".into(), commit.clone());',
     "branches/connected"),

    ("a-file-with-no-patch-reports-null", MANAGER,
     '''                for key in ["status", "additions", "deletions", "changes", "patch", "blob_url"] {
                    copy(&mut out, file, key);
                }''',
     '''                for key in ["status", "additions", "deletions", "changes", "patch", "blob_url"] {
                    out.insert(key.into(), file.get(key).cloned().unwrap_or(Value::Null));
                }''',
     "prs/review"),

    # `nullish` collapses "absent" and "null" into the same answer on purpose —
    # that *is* `?? null` — so the two are not meant to be distinguishable. What
    # has to bite is that the collapse happens at all.
    ("a-default-branch-is-not-collapsed-to-null", API,
     "        Some(Value::Null) | None => Value::Null,",
     "        Some(Value::Null) | None => Value::Bool(false),",
     "branches/no-default-branch"),

    ("an-empty-branch-filter-is-forwarded", API,
     '    let branch = query.branch.as_deref().filter(|branch| !branch.is_empty());',
     '    let branch = query.branch.as_deref();',
     "runs/empty-branch"),
]


def read(path):
    with open(os.path.join(ROOT, path)) as handle:
        return handle.read()


def write(path, text):
    with open(os.path.join(ROOT, path), "w") as handle:
        handle.write(text)


def cargo_is_busy():
    """Another build holds the target lock.

    Seeding rewrites source and rebuilds, so a concurrent `cargo build` — or a
    gate run of my own — turns every result into a race: the binary under test
    may be one edit behind the source, and a pass or a fail then means nothing.
    Refuse rather than produce a verdict that cannot be trusted.
    """
    lock = os.path.join(ROOT, "target", "debug", ".cargo-lock")
    probe = subprocess.run(["cargo", "build", "-p", "nomoreide-cli", "--quiet"], cwd=ROOT,
                           capture_output=True, text=True, timeout=900)
    return "Blocking waiting for file lock" in probe.stderr or not os.path.exists(lock)


def main():
    backups = {path: read(path) for path in {seed[1] for seed in SEEDS}}

    # Every anchor, up front. rustfmt reflows code between the day a seed is
    # written and the day it runs, and a seed whose anchor has moved reports
    # "not unique" an hour into a sweep rather than in the first second.
    stale = [
        (name, backups[path].count(old))
        for name, path, old, _new, _expected in SEEDS
        if backups[path].count(old) != 1
    ]
    if stale:
        for name, count in stale:
            print(f"SEED-ANCHOR-STALE  {name}  (matches: {count})")
        print("\nFix the anchors before sweeping; nothing was changed.")
        return 2

    if cargo_is_busy():
        print("Another cargo build holds the target lock. Wait for it to finish:")
        print("a seeded sweep that races a build tests the wrong binary.")
        return 2
    results = []
    try:
        for name, path, old, new, expected in SEEDS:
            source = backups[path]
            if source.count(old) != 1:
                results.append((name, "SEED-NOT-UNIQUE", source.count(old)))
                print(f"{'SEED-NOT-UNIQUE':24} {name}", flush=True)
                continue
            write(path, source.replace(old, new, 1))
            build = subprocess.run(["cargo", "build", "-p", "nomoreide-cli"], cwd=ROOT, capture_output=True, text=True)
            if build.returncode != 0:
                results.append((name, "SEED-DID-NOT-COMPILE", build.stderr[-300:]))
                write(path, source)
                print(f"{'SEED-DID-NOT-COMPILE':24} {name}", flush=True)
                continue
            gate = subprocess.run(
                ["node", "--import", "tsx", "scripts/check-github-api-parity.ts",
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
