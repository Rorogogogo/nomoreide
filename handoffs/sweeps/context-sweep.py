#!/usr/bin/env python3
"""Seeded regression sweep for scripts/check-context-parity.ts.

Each seed makes one behavioural change to the Rust source, rebuilds, and expects
the gate to fail on a *named* case. A seed the gate does not catch is a hole in
the gate, not a success.

Three clusters, and they fail for different reasons:

- **The listing's shape.** Half of what the page shows is not stored anywhere —
  it is rebuilt from config, the error inbox and the transcript readers on every
  request. Seeds here change what a derived row *says*, which is only visible
  because the gate compares derived ref ids rather than redacting them.
- **The filters.** `kinds` silently drops what it does not recognise, the
  project filter has to match a note's whole `projectPaths` list as well as a
  derived item's single one, and the ordering is `localeCompare` rather than
  byte order. Each is a seed, and each needed a case written for it on purpose.
- **The note schemas.** A create and an update differ in three ways that look
  like oversights and are not: the arrays are optional on one and required on
  the other, `sourceKey` is accepted on one and refused on the other, and the
  revision is a precondition rather than a field.

Run it alone: it mutates tracked sources and restores them from an in-memory
backup, so a second cargo build racing it tests a binary that is one edit behind
its source. Killing it mid-run leaves a seed on disk.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _runner import run_sweep, select  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

CORE = "crates/nomoreide-core/src/context_snapshot.rs"
LIB = "crates/nomoreide-core/src/context_library.rs"
ROUTE = "crates/nomoreide-daemon/src/server/routes/context.rs"
#: Shared with the terminal slice, so a seed here proves the sharing too.
QUERY = "crates/nomoreide-daemon/src/server/routes/query.rs"

GATE_SCRIPT = "scripts/check-context-parity.ts"

#: Gate runs go in parallel; builds cannot. See handoffs/sweeps/_runner.py.
WORKERS = 3

SEEDS = [
    # --- ordering -------------------------------------------------------------
    ("the-listing-is-ordered-by-bytes", CORE,
     """    items.sort_by(|left, right| locale_cmp(&left.item().title, &right.item().title));""",
     """    items.sort_by(|left, right| left.item().title.cmp(&right.item().title));""",
     "create/the-listing-afterwards"),
    ("case-ties-go-the-other-way", CORE,
     """        Ordering::Equal => right.cmp(left),""",
     """        Ordering::Equal => left.cmp(right),""",
     "create/the-listing-afterwards"),
    ("the-listing-is-not-ordered", CORE,
     """    items.sort_by(|left, right| locale_cmp(&left.item().title, &right.item().title));""",
     """""",
     "create/the-listing-afterwards"),

    # --- the filters ----------------------------------------------------------
    # RETIRED -- `an-unknown-kind-is-kept`.
    #
    # Dropping an unrecognised kind and keeping it are the same answer, because
    # no item ever *has* the unrecognised kind: `kinds=widget` filters to the
    # empty set either way, and `kinds=note,widget` selects notes either way.
    # The filter is worth keeping -- it is what stops a typo from being carried
    # into the query -- but nothing a request can ask distinguishes the two.
    ("a-blank-kinds-means-every-kind", ROUTE,
     """        kinds: query_value(uri, "kinds").map(|raw| {""",
     """        kinds: query_value(uri, "kinds").filter(|raw| !raw.is_empty()).map(|raw| {""",
     "filter/a-blank-kinds"),
    ("a-repeated-kinds-takes-the-last", QUERY,
     """    uri.query()?.split('&').find_map(|pair| {""",
     """    uri.query()?.split('&').collect::<Vec<_>>().into_iter().rev().find_map(|pair| {""",
     "filter/repeated-kinds"),
    ("a-note-project-list-is-ignored", CORE,
     """            entry.item().project_path.as_deref() == Some(project)
                || entry.project_paths().iter().any(|path| path == project)""",
     """            entry.item().project_path.as_deref() == Some(project)""",
     "filter/the-other-project-path"),
    ("the-query-is-case-sensitive", CORE,
     """                .any(|value| value.to_lowercase().contains(&needle))""",
     """                .any(|value| value.contains(&needle))""",
     "filter/a-query-that-matches-a-tag"),
    ("the-query-does-not-read-tags", CORE,
     """                .chain(item.tags.iter().map(String::as_str))""",
     """""",
     "filter/a-query-that-matches-a-tag"),
    ("a-query-is-not-trimmed", CORE,
     """    if let Some(needle) = query.q.as_deref().map(str::trim).filter(|q| !q.is_empty()) {""",
     """    if let Some(needle) = query.q.as_deref().filter(|q| !q.is_empty()) {""",
     "filter/a-whitespace-query"),

    # --- derived rows ---------------------------------------------------------
    ("a-service-ref-drops-its-project", CORE,
     """                    id: format!(
                        "{}:{}",
                        project_path.as_deref().unwrap_or("workspace"),
                        service.name
                    ),""",
     """                    id: service.name.clone(),""",
     "list/empty"),
    ("a-service-with-no-project-is-not-defaulted", CORE,
     """                        project_path.as_deref().unwrap_or("workspace"),""",
     """                        project_path.as_deref().unwrap_or_default(),""",
     "list/empty"),
    ("a-service-kind-is-not-defaulted", CORE,
     """                    service.kind.as_deref().unwrap_or("local"),""",
     """                    service.kind.as_deref().unwrap_or_default(),""",
     "list/empty"),
    ("a-project-excerpt-is-always-its-path", CORE,
     """                excerpt: Some(match repository.active_worktree_path.as_deref() {
                    Some(worktree) => format!("Active worktree: {worktree}"),
                    None => repository.path.clone(),
                }),""",
     """                excerpt: Some(repository.path.clone()),""",
     "list/empty"),
    ("a-project-is-not-listed", CORE,
     """    if query.includes("project") {""",
     """    if false {""",
     "list/empty"),
    ("a-derived-item-is-editable", CORE,
     """                pinned: false,
                editable: false,
            });
        }
    }

    if query.includes("service") {""",
     """                pinned: false,
                editable: true,
            });
        }
    }

    if query.includes("service") {""",
     "list/empty"),

    # --- pinning --------------------------------------------------------------
    ("a-pin-is-not-reflected-in-the-listing", CORE,
     """            entry.item_mut().pinned = pinned;""",
     """            entry.item_mut().pinned = false;""",
     "pins/the-listing-afterwards"),
    ("a-pin-matches-on-id-alone", CORE,
     """fn ref_key(reference: &ContextRef) -> String {
    format!("{}:{}", reference.kind, reference.id)
}""",
     """fn ref_key(reference: &ContextRef) -> String {
    reference.id.clone()
}""",
     "pins/the-listing-under-the-wrong-kind"),
    ("an-unknown-pin-kind-is-accepted", ROUTE,
     """            let kind = object.get("kind")?.as_str()?;
            if !CONTEXT_KINDS.contains(&kind) {
                return None;
            }""",
     """            let kind = object.get("kind")?.as_str()?;""",
     "pins/an-unknown-kind"),
    ("a-pin-ref-tolerates-an-extra-key", ROUTE,
     """            if object.keys().any(|key| key != "kind" && key != "id") {
                return None;
            }""",
     """""",
     "pins/a-ref-with-an-extra-key"),

    # --- the note schemas -----------------------------------------------------
    ("a-create-tolerates-an-unknown-key", ROUTE,
     """    if object.keys().any(|key| !KEYS.contains(&key.as_str())) {
        return None;
    }
    Some(CreateContextNote {""",
     """    Some(CreateContextNote {""",
     "create/an-unknown-key"),
    ("a-title-is-not-trimmed", ROUTE,
     """fn bounded(value: &Value, min: usize, max: usize) -> Option<String> {
    let text = value.as_str()?.trim();""",
     """fn bounded(value: &Value, min: usize, max: usize) -> Option<String> {
    let text = value.as_str()?;""",
     "create/a-blank-title"),
    ("a-blank-title-is-accepted", ROUTE,
     """        title: bounded(object.get("title")?, 1, 120)?,
        body: match object.get("body") {""",
     """        title: bounded(object.get("title")?, 0, 120)?,
        body: match object.get("body") {""",
     "create/a-blank-title"),
    ("a-long-title-is-accepted", ROUTE,
     """        title: bounded(object.get("title")?, 1, 120)?,
        body: match object.get("body") {""",
     """        title: bounded(object.get("title")?, 1, 1_200)?,
        body: match object.get("body") {""",
     "create/a-title-that-is-too-long"),
    ("a-tag-may-be-blank", ROUTE,
     """        .map(|entry| bounded(entry, 1, max_length))""",
     """        .map(|entry| bounded(entry, 0, max_length))""",
     "create/a-blank-tag"),
    ("too-many-tags-are-accepted", ROUTE,
     """    if entries.len() > max_items {
        return None;
    }""",
     """""",
     "create/too-many-tags"),
    ("an-update-array-is-optional", ROUTE,
     """        project_paths: string_list(Some(object.get("projectPaths")?), 50, 2_000)?,""",
     """        project_paths: string_list(object.get("projectPaths"), 50, 2_000)?,""",
     "update/without-project-paths"),
    ("an-update-accepts-a-source-key", ROUTE,
     """    const KEYS: &[&str] = &[
        "title",
        "body",
        "projectPaths",
        "tags",
        "aliases",
        "revision",
    ];""",
     """    const KEYS: &[&str] = &[
        "title",
        "body",
        "projectPaths",
        "tags",
        "aliases",
        "revision",
        "sourceKey",
    ];""",
     "update/a-source-key"),
    ("a-revision-may-be-uppercase", ROUTE,
     """            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))""",
     """            .all(|byte| byte.is_ascii_hexdigit()))""",
     "update/an-uppercase-revision"),
    ("a-revision-is-any-string", ROUTE,
     """    (text.len() == 64""",
     """    (!text.is_empty()""",
     "update/a-revision-that-is-short-hex"),
    ("a-delete-tolerates-an-unknown-key", ROUTE,
     """    if object.keys().any(|key| key != "revision") {
        return None;
    }""",
     """""",
     "delete/an-unknown-key"),

    # --- the note id ----------------------------------------------------------
    ("a-short-id-is-accepted", ROUTE,
     """    if !(8..=100).contains(&length)""",
     """    if !(1..=100).contains(&length)""",
     "read/an-id-that-is-too-short"),
    ("an-underscore-is-an-id-character", ROUTE,
     """            .all(|character| character.is_ascii_alphanumeric() || character == '-')""",
     """            .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_')""",
     "read/an-id-with-an-underscore"),
    ("a-bad-escape-is-passed-through", ROUTE,
     """            if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return None;
            }""",
     """            if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                decoded.push(b'%');
                index += 1;
                continue;
            }""",
     "read/an-id-that-is-badly-encoded"),
    ("a-conflict-carries-no-note", ROUTE,
     """    if !message.starts_with("This note changed outside NoMoreIDE") {
        return context_failure(message);
    }""",
     """    if true {
        return context_failure(message);
    }""",
     "update/a-stale-revision"),
    ("a-missing-note-is-a-400", ROUTE,
     """        Ok(Err(message)) if message == "Context note not found." => {""",
     """        Ok(Err(message)) if message == "not reachable" => {""",
     "read/an-unknown-note"),

    # --- the graph ------------------------------------------------------------
    ("the-graph-is-not-pinned-first", CORE,
     """        right
            .pinned
            .cmp(&left.pinned)
            .then_with(|| kind_priority(&left.kind).cmp(&kind_priority(&right.kind)))""",
     """        kind_priority(&left.kind).cmp(&kind_priority(&right.kind))""",
     "filter/the-whole-graph"),
    ("the-graph-kind-order-is-the-enum-order", CORE,
     """        .map(|position| match position {
            // note, project, service, file, incident, session → the graph wants
            // project, service, note, incident, session, file.
            0 => 2,
            1 => 0,
            2 => 1,
            3 => 5,
            4 => 3,
            _ => 4,
        })""",
     """""",
     "filter/the-whole-graph"),
    ("an-ambiguous-wiki-link-resolves", CORE,
     """        Some(matches) if matches.len() == 1 => Some(matches[0]),""",
     """        Some(matches) if !matches.is_empty() => Some(matches[0]),""",
     "filter/the-whole-graph"),
    ("a-wiki-link-is-case-sensitive", CORE,
     """    match lookup.get(&target.to_lowercase()) {""",
     """    match lookup.get(target) {""",
     "filter/the-whole-graph"),
    ("a-note-draws-no-project-edge", CORE,
     """        for project_path in &note.project_paths {""",
     """        for project_path in &Vec::<String>::new() {""",
     "filter/the-whole-graph"),

    # --- the preview ----------------------------------------------------------
    # `projectPath` reaches the route and is dropped, because this core's
    # `preview` takes no such argument. These two seeds are what will tell us
    # whether that gap is observable at all -- if neither bites, the reference's
    # project marking is unreachable from this endpoint and the gap is only a
    # gap on paper.
    ("a-preview-refuses-a-project-path", ROUTE,
     """        match object.get("projectPath") {
            None => None,
            Some(value) => Some(bounded(value, 1, 2_000)?),
        },""",
     """        match object.get("projectPath") {
            None => None,
            Some(_) => return None,
        },""",
     "preview/scoped-to-its-own-project"),
    ("a-preview-resolves-nothing", ROUTE,
     """        ContextLibrary::default().preview(&attachment, &items)""",
     """        ContextLibrary::default().preview(&attachment, &[])""",
     "preview/scoped-to-a-registered-project"),
    ("a-preview-resolves-to-plain-items", ROUTE,
     """                        .and_then(|entry| serde_json::to_value(entry).ok())""",
     """                        .and_then(|_| None)""",
     "preview/one-note"),
    ("a-preview-is-scoped-to-the-page", ROUTE,
     """    let (listing, _) = match snapshot_for(&state, &ContextQuery::default()).await {""",
     """    let (listing, _) = match snapshot_for(&state, &ContextQuery { kinds: Some(vec!["note".to_string()]), ..Default::default() }).await {""",
     "preview/scoped-to-a-registered-project"),

    # --- diagnostics ----------------------------------------------------------
    ("a-duplicate-note-is-listed", LIB,
     """            notes
                .iter()
                .filter(|note| counts.get(&note.item.context_ref.id) == Some(&1))
                .cloned()
                .collect(),""",
     """            notes.clone(),""",
     "duplicate/the-listing"),
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
