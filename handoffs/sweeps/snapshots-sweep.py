#!/usr/bin/env python3
"""Seeded regression sweep for scripts/check-snapshots-parity.ts.

Each seed makes one behavioural change to the Rust source, rebuilds, and expects
the gate to fail on a *named* case. A seed the gate does not catch is a hole in
the gate, not a success.

Three clusters. The **capture** decides what a snapshot actually contains, and
gets it wrong quietly: a tree missing a file still commits, still lists, still
diffs, and only loses the file when someone restores. The **namespace guard**
decides whether `restore` can be pointed at an arbitrary commit, which is the
one place this module can destroy work it did not create. The **route** is the
usual vocabulary — which status, which wording, which field trimmed.

Several plausible seeds are deliberately absent because nothing can observe
them from the API:

  * *Dates are not preserved by a rename.* `createdAt` is a timestamp and is
    redacted on both sides, so a rename that lost the original dates reads
    identically to one that kept them.
  * *A rename drops the parents.* No endpoint reports a snapshot's ancestry,
    and the diff endpoints compare trees.
  * *A delete is not compare-and-swap.* The CAS only matters when the ref moved
    between the read and the delete, which a single-threaded gate cannot stage.
  * *`git restore` runs even when nothing was restored.* Restoring a tree that
    already matches writes nothing, so the extra command has no effect.
  * *`changed_files` splits its path at a tab.* Git quotes a path containing
    one, so a literal tab never reaches the splitter.

Run it alone: it mutates tracked sources and restores them from an in-memory
backup, so a second cargo build racing it tests a binary that is one edit behind
its source. Killing it mid-run leaves a seed on disk.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _runner import read, run_sweep, select  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

CORE = "crates/nomoreide-core/src/snapshot_manager.rs"
ROUTE = "crates/nomoreide-daemon/src/server/routes/snapshots.rs"

GATE_SCRIPT = "scripts/check-snapshots-parity.ts"

#: Gate runs go in parallel; builds cannot. See handoffs/sweeps/_runner.py.
WORKERS = 3

SEEDS = [
    # --- what a snapshot contains ---------------------------------------------
    ("the-capture-is-seeded-from-nothing", CORE,
     """        match self.head_sha().await {
            Some(head) => self.git(&["read-tree", &head], scratch).await?,
            None => self.git(&["read-tree", "--empty"], scratch).await?,
        };""",
     """        self.git(&["read-tree", "--empty"], scratch).await?;""",
     "files/after-deleting-a-tracked-but-ignored-file"),
    ("the-capture-leaves-untracked-files-out", CORE,
     """        self.git(&["add", "-A"], scratch).await?;""",
     """        self.git(&["add", "-u"], scratch).await?;""",
     "files/after-an-addition"),
    ("the-capture-includes-ignored-files", CORE,
     """        self.git(&["add", "-A"], scratch).await?;""",
     """        self.git(&["add", "-A", "-f"], scratch).await?;""",
     "files/an-ignored-file-is-not-listed"),

    # --- the listing ----------------------------------------------------------
    ("the-listing-is-oldest-first", CORE,
     """                &["for-each-ref", "--sort=-refname", LIST_FORMAT, REF_PREFIX],""",
     """                &["for-each-ref", "--sort=refname", LIST_FORMAT, REF_PREFIX],""",
     "list/after-several"),
    ("a-tab-truncates-the-label", CORE,
     """                let mut fields = line.splitn(4, '\\t');""",
     """                let mut fields = line.split('\\t');""",
     "list/after-several"),
    ("a-prune-keeps-nothing", ROUTE,
     """    if let Err(reason) = manager.prune(DEFAULT_KEEP).await {""",
     """    if let Err(reason) = manager.prune(0).await {""",
     "list/after-several"),

    # --- the namespace guard --------------------------------------------------
    ("any-commit-is-a-snapshot", CORE,
     """        match self
            .list()
            .await?
            .into_iter()
            .find(|snapshot| snapshot.sha == sha)
        {
            Some(snapshot) => Ok(snapshot),
            None => bail!("Not a nomoreide snapshot: {sha}"),
        }""",
     """        match self
            .list()
            .await?
            .into_iter()
            .find(|snapshot| snapshot.sha == sha)
        {
            Some(snapshot) => Ok(snapshot),
            None => Ok(Snapshot {
                reference: format!("{REF_PREFIX}/0-unknown"),
                sha: sha.to_string(),
                created_at: String::new(),
                label: String::new(),
            }),
        }""",
     "guard/a-sha-that-does-not-exist"),

    # --- relabelling ----------------------------------------------------------
    ("a-rename-reports-the-old-sha", CORE,
     """        Ok(Snapshot {
            reference: target.reference,
            sha: new_sha,""",
     """        Ok(Snapshot {
            reference: target.reference,
            sha: sha.to_string(),""",
     "rename/the-reported-sha-is-still-a-snapshot"),
    ("a-rename-makes-a-new-ref-name", CORE,
     """        self.git(&["update-ref", &target.reference, &new_sha, sha], &[])
            .await?;""",
     """        let target = Snapshot {
            reference: format!("{REF_PREFIX}/{}-{}", Utc::now().timestamp_millis(), slug(cleaned)),
            ..target
        };
        self.git(&["update-ref", "-d", &target.reference], &[]).await.ok();
        self.git(&["update-ref", &target.reference, &new_sha], &[])
            .await?;""",
     "rename/the-listing-afterwards"),
    # RETIRED -- `a-rename-does-not-trim-its-label`.
    #
    # The route trims the label and then `SnapshotManager::rename` trims it
    # again before writing the commit message, so removing the route's trim
    # changes nothing that reaches disk. It is not a gate hole: there is no
    # request that can tell the two versions apart, because the second trim is
    # the one that decides. Trimming twice is worth keeping -- the route's trim
    # is what makes its own emptiness check right -- but only one of them is
    # observable and a seed can only aim at that one (`a-blank-rename-label-is-
    # defaulted`, which is caught).
    ("a-blank-rename-label-is-defaulted", ROUTE,
     """    if label.is_empty() {
        return error(StatusCode::BAD_REQUEST, "A label is required");
    }""",
     """    let label = if label.is_empty() {
        "snapshot".to_string()
    } else {
        label
    };""",
     "rename/a-blank-label"),

    # --- restoring ------------------------------------------------------------
    ("a-restore-takes-no-pre-restore-snapshot", CORE,
     """        let pre_restore = self
            .snapshot(&format!("pre-restore ({})", target.label))
            .await?;""",
     """        let pre_restore = Snapshot {
            reference: String::new(),
            sha: self.capture_tree().await?,
            created_at: String::new(),
            label: String::new(),
        };""",
     "restore/the-listing-afterwards"),
    ("a-restore-leaves-additions-behind", CORE,
     """            if status == "A" {
                self.remove_worktree_file(&path).await?;
                deleted_paths.push(path);""",
     """            if status == "A" {
                deleted_paths.push(path);""",
     "restore/what-the-tree-looks-like-now"),
    ("a-restore-counts-additions-as-restored", CORE,
     """            if status == "A" {""",
     """            if status == "D" {""",
     "restore/a-snapshot"),
    ("a-restore-writes-the-index-too", CORE,
     """            self.git(&["restore", "--source", sha, "--worktree", "--", ":/"], &[])""",
     """            self.git(&["restore", "--source", sha, "--staged", "--worktree", "--", ":/"], &[])""",
     "restore/the-repository-status-afterwards"),
    ("a-restore-result-is-nested", ROUTE,
     """        Ok(result) => {
            let mut envelope = json!({ "ok": true });""",
     """        Ok(result) => {
            let mut envelope = json!({ "ok": true, "result": &result });""",
     "restore/a-snapshot"),

    # --- the diff -------------------------------------------------------------
    ("the-diff-ignores-its-path", CORE,
     """        if let Some(path) = path {
            args.extend(["--", path]);
        }""",
     """        if let Some(_path) = path {}""",
     "diff/one-path"),
    ("a-blank-diff-path-is-passed-through", ROUTE,
     """    let path = query
        .get("path")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());""",
     """    let path = query.get("path").map(String::as_str);""",
     "diff/a-blank-path"),
    ("the-diff-is-json", ROUTE,
     """        Ok(patch) => (
            [(
                axum::http::header::CONTENT_TYPE,
                "text/plain; charset=utf-8",
            )],
            patch,
        )
            .into_response(),""",
     """        Ok(patch) => Json(json!({ "ok": true, "diff": patch })).into_response(),""",
     "diff/everything"),

    # --- the sha guard --------------------------------------------------------
    ("a-sha-is-decoded-before-it-is-judged", ROUTE,
     """    (!segment.is_empty()).then(|| segment.to_string())""",
     """    (!segment.is_empty()).then(|| crate::server::body::percent_decode(segment))""",
     "guard/a-percent-encoded-sha"),
    ("the-sha-guard-is-case-sensitive", ROUTE,
     """    (4..=40).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit())""",
     """    (4..=40).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())""",
     "guard/an-uppercase-sha"),
    ("a-short-sha-is-accepted", ROUTE,
     """    (4..=40).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit())""",
     """    (1..=40).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit())""",
     "guard/a-sha-that-is-too-short"),
    ("a-long-sha-is-accepted", ROUTE,
     """    (4..=40).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit())""",
     """    (4..=64).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit())""",
     "guard/a-sha-that-is-too-long"),
    ("an-unusable-sha-is-a-404", ROUTE,
     """        Err(reason) => return error(StatusCode::BAD_REQUEST, reason),
    };
    match manager_for(&state).await.changed_files(&sha).await {""",
     """        Err(reason) => return error(StatusCode::NOT_FOUND, reason),
    };
    match manager_for(&state).await.changed_files(&sha).await {""",
     "guard/a-sha-that-is-not-hexadecimal"),

    # --- taking one -----------------------------------------------------------
    ("a-blank-label-is-refused", ROUTE,
     """    let label = payload
        .get("label")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .unwrap_or(DEFAULT_LABEL)
        .to_string();""",
     """    let label = match payload.get("label").and_then(Value::as_str).map(str::trim) {
        Some("") | None => return error(StatusCode::BAD_REQUEST, "A label is required"),
        Some(label) => label.to_string(),
    };""",
     "create/a-blank-label"),
    ("a-label-is-not-trimmed", ROUTE,
     """        .map(str::trim)
        .filter(|label| !label.is_empty())
        .unwrap_or(DEFAULT_LABEL)""",
     """        .filter(|label| !label.trim().is_empty())
        .unwrap_or(DEFAULT_LABEL)""",
     "create/a-label"),
    ("a-numeric-label-is-stringified", ROUTE,
     """    let label = payload
        .get("label")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|label| !label.is_empty())""",
     """    let rendered = payload.get("label").map(|value| match value.as_str() {
        Some(text) => text.to_string(),
        None => value.to_string(),
    });
    let label = rendered
        .as_deref()
        .map(str::trim)
        .filter(|label| !label.is_empty())""",
     "create/a-label-that-is-a-number"),
    ("a-failure-is-a-500", ROUTE,
     """        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}

/// The patch, as text.""",
     """        Err(reason) => error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()),
    }
}

/// The patch, as text.""",
     "guard/an-uppercase-sha"),
]


def main():
    seeds, complaint = select(SEEDS, sys.argv[1:])
    if complaint:
        print(complaint)
        return 2
    return run_sweep(ROOT, seeds, GATE_SCRIPT, workers=WORKERS)


# **Guarded on purpose.** Importing this file to reuse SEEDS -- to validate the
# anchors, say -- must not start a sweep.
if __name__ == "__main__":
    sys.exit(main())
