#!/usr/bin/env python3
"""Seeded regression sweep for scripts/check-git-branch-parity.ts.

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

ROUTE = "crates/nomoreide-daemon/src/server/routes/git/writes.rs"
ROUTER = "crates/nomoreide-daemon/src/server/routes.rs"
BRANCHES = "crates/nomoreide-core/src/git_manager/branches.rs"

SEEDS = [
    # --- the router-wide rule this slice exposed ------------------------------
    ("a-wrong-method-is-a-405", ROUTER,
     r"""        .method_not_allowed_fallback(shell::serve)""",
     r"""        .method_not_allowed_fallback(crate::server::errors::method_not_allowed)""",
     "switch/wrong-method"),

    # --- switch ---------------------------------------------------------------
    ("switch-catches-its-own-failures", ROUTE,
     r"""    match GitManager::switch_branch(&cwd, &name).await {
        Ok(output) => Json(OutputEnvelope { ok: true, output }).into_response(),
        Err(reason) => error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()),
    }""",
     r"""    match GitManager::switch_branch(&cwd, &name).await {
        Ok(output) => Json(OutputEnvelope { ok: true, output }).into_response(),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }""",
     "switch/to-a-branch-that-does-not-exist"),
    ("switch-reports-a-missing-name-as-a-400", ROUTE,
     r"""        return error(StatusCode::INTERNAL_SERVER_ERROR, "name is required");""",
     r"""        return error(StatusCode::BAD_REQUEST, "name is required");""",
     "switch/missing-name"),
    ("switch-honours-the-repo-field", ROUTE,
     r"""    let cwd = state.workspace_cwd().await;
    match GitManager::switch_branch(&cwd, &name).await {""",
     r"""    let cwd = match resolve_repo_cwd(&state, form.get("repo").map(String::as_str)).await {
        Ok((cwd, _)) => cwd,
        Err(response) => return response,
    };
    match GitManager::switch_branch(&cwd, &name).await {""",
     "switch/repo-field-is-ignored"),
    ("a-blank-name-reaches-git", ROUTE,
     r"""        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{key} is required"))""",
     r"""        .map(str::to_string)
        .ok_or_else(|| format!("{key} is required"))""",
     "switch/blank-name"),
    ("a-remote-branch-is-switched-without-tracking", BRANCHES,
     r"""        if is_remote {
            exec::checked(cwd, &["switch", "--track", &name]).await""",
     r"""        if false {
            exec::checked(cwd, &["switch", "--track", &name]).await""",
     # Not switch/to-a-remote-only-branch: remote branches are listed with their
     # prefix, so a bare name never reaches --track at all.
     "switch/to-a-remote-tracking-ref"),

    # --- delete ---------------------------------------------------------------
    ("delete-lets-its-failures-escape", ROUTE,
     r"""    match GitManager::delete_branch(&cwd, &name).await {
        Ok(output) => Json(OutputEnvelope { ok: true, output }).into_response(),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }""",
     r"""    match GitManager::delete_branch(&cwd, &name).await {
        Ok(output) => Json(OutputEnvelope { ok: true, output }).into_response(),
        Err(reason) => error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()),
    }""",
     "delete/an-unmerged-branch"),
    ("delete-ignores-the-repo-field", ROUTE,
     r"""    let cwd = match resolve_repo_cwd(&state, form.get("repo").map(String::as_str)).await {
        Ok((cwd, _)) => cwd,
        Err(response) => return response,
    };
    let name = match required(&form, "name") {""",
     r"""    let cwd = state.workspace_cwd().await;
    let name = match required(&form, "name") {""",
     "delete/in-an-unknown-repo"),
    ("delete-reads-the-name-before-the-repo", ROUTE,
     r"""    let cwd = match resolve_repo_cwd(&state, form.get("repo").map(String::as_str)).await {
        Ok((cwd, _)) => cwd,
        Err(response) => return response,
    };
    let name = match required(&form, "name") {
        Ok(name) => name,
        Err(reason) => return error(StatusCode::BAD_REQUEST, &reason),
    };""",
     r"""    let name = match required(&form, "name") {
        Ok(name) => name,
        Err(reason) => return error(StatusCode::BAD_REQUEST, &reason),
    };
    let cwd = match resolve_repo_cwd(&state, form.get("repo").map(String::as_str)).await {
        Ok((cwd, _)) => cwd,
        Err(response) => return response,
    };""",
     # Not delete/in-an-unknown-repo: with a name present both orders answer the
     # same 404. Only a request that would fail *both* checks shows which ran.
     "delete/an-unknown-repo-and-no-name"),
    ("an-unmerged-branch-is-discarded", BRANCHES,
     r"""        exec::checked(cwd, &["branch", "-d", &name]).await""",
     r"""        exec::checked(cwd, &["branch", "-D", &name]).await""",
     "delete/an-unmerged-branch"),
    ("a-branch-name-is-not-validated", BRANCHES,
     r"""        let name = exec::validate_branch_ref(cwd, name, "branch").await?;
        exec::checked(cwd, &["branch", "-d", &name]).await""",
     r"""        exec::checked(cwd, &["branch", "-d", name]).await""",
     "delete/name-that-looks-like-a-flag"),
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
                 "scripts/check-git-branch-parity.ts", "./target/debug/nomoreide"],
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
