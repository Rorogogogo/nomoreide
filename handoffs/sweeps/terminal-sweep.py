#!/usr/bin/env python3
"""Seeded regression sweep for scripts/check-terminal-parity.ts.

Each seed makes one behavioural change to the Rust source, rebuilds, and expects
the gate to fail on a *named* case. A seed the gate does not catch is a hole in
the gate, not a success.

Three clusters here, and they fail for different reasons:

- **The two id rules.** The action routes refuse `/` and `\\` and cap at 200; the
  rename and close route allows both and caps at 1000. Seeds that unify them
  are the ones most likely to slip through a gate that only ever sends ordinary
  ids, so several send ids that pass exactly one rule.
- **The three size checks.** A prompt is measured against the body cap, then
  against the prompt cap in *bytes*, then by the paste encoder. Two answer 413
  with the same words from different places, so a seed that deletes one is
  invisible unless the gate sends something that only that one refuses.
- **The transcripts listing**, which resolves its repository path itself rather
  than through `selected_git_cwd`. A seed that reuses the shared helper is the
  single most plausible mistake in the whole slice, and it changes the scoped
  listing from one repository's sessions to another's.

Run it alone: it mutates tracked sources and restores them from an in-memory
backup, so a second cargo build racing it tests a binary that is one edit behind
its source. Killing it mid-run leaves a seed on disk.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _runner import run_sweep, select  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ROUTE = "crates/nomoreide-daemon/src/server/routes/terminal.rs"
CORE = "crates/nomoreide-core/src/agent_transcripts.rs"

GATE_SCRIPT = "scripts/check-terminal-parity.ts"

#: Gate runs go in parallel; builds cannot. See handoffs/sweeps/_runner.py.
WORKERS = 3

SEEDS = [
    # --- the header guard -----------------------------------------------------
    ("the-header-is-not-required", ROUTE,
     """        return Err((
            StatusCode::FORBIDDEN,
            "Terminal control header is required.",
        ));""",
     """        if false {
            return Err((
                StatusCode::FORBIDDEN,
                "Terminal control header is required.",
            ));
        }""",
     "insert/without-the-header"),
    ("any-header-value-passes", ROUTE,
     """        .and_then(|value| value.to_str().ok())
        != Some("1")""",
     """        .and_then(|value| value.to_str().ok())
        .is_none()""",
     "insert/with-the-wrong-header-value"),
    ("the-id-is-checked-before-the-header", ROUTE,
     """    if headers
        .get(TERMINAL_CONTROL_HEADER)
        .and_then(|value| value.to_str().ok())
        != Some("1")
    {
        return Err((
            StatusCode::FORBIDDEN,
            "Terminal control header is required.",
        ));
    }
    session_id(uri)
        .filter(|id| is_action_id(id))
        .ok_or((StatusCode::BAD_REQUEST, "Invalid terminal session id."))""",
     """    let id = session_id(uri)
        .filter(|id| is_action_id(id))
        .ok_or((StatusCode::BAD_REQUEST, "Invalid terminal session id."))?;
    if headers
        .get(TERMINAL_CONTROL_HEADER)
        .and_then(|value| value.to_str().ok())
        != Some("1")
    {
        return Err((
            StatusCode::FORBIDDEN,
            "Terminal control header is required.",
        ));
    }
    Ok(id)""",
     "insert/a-bad-id-without-the-header"),

    # --- the two id rules -----------------------------------------------------
    ("the-action-rule-allows-a-slash", ROUTE,
     """        && !id.contains('/')
        && !id.contains('\\\\')""",
     """        && !id.contains('\\\\')""",
     "insert/an-id-with-a-slash"),
    ("the-existing-rule-refuses-a-slash", ROUTE,
     """fn is_existing_id(id: &str) -> bool {
    !id.is_empty() && utf16_len(id) <= 1_000 && !has_control_characters(id)
}""",
     """fn is_existing_id(id: &str) -> bool {
    !id.is_empty() && utf16_len(id) <= 1_000 && !has_control_characters(id) && !id.contains('/')
}""",
     "rename/an-id-with-a-slash"),
    ("a-control-character-is-allowed", ROUTE,
     """fn has_control_characters(value: &str) -> bool {
    value.chars().any(|character| {
        let code = character as u32;
        code <= 31 || code == 127
    })
}""",
     """fn has_control_characters(_value: &str) -> bool {
    false
}""",
     "rename/an-id-with-a-control-character"),
    ("a-bad-escape-is-passed-through", ROUTE,
     """            if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return None;
            }""",
     """            if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                decoded.push(b'%');
                index += 1;
                continue;
            }""",
     "rename/an-id-that-is-badly-encoded"),
    ("the-id-is-not-decoded", ROUTE,
     """fn session_id(uri: &Uri) -> Option<String> {
    let raw = uri.path().split('/').nth(4)?;""",
     """fn session_id(uri: &Uri) -> Option<String> {
    let raw = uri.path().split('/').nth(4)?;
    if true {
        return Some(raw.to_string());
    }""",
     "rename/an-id-with-a-slash"),

    # --- the three size checks ------------------------------------------------
    ("the-body-cap-is-gone", ROUTE,
     """    if body.len() > MAX_INSERT_PROMPT_BODY_BYTES {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "Agent prompt is too large.");
    }""",
     """""",
     "insert/a-body-over-the-cap-that-is-not-a-prompt"),
    ("the-prompt-cap-is-gone", ROUTE,
     """    if prompt.len() > MAX_AGENT_PROMPT_BYTES {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "Agent prompt is too large.");
    }""",
     """""",
     "insert/a-prompt-over-the-prompt-cap"),
    ("the-prompt-cap-counts-characters", ROUTE,
     """    if prompt.len() > MAX_AGENT_PROMPT_BYTES {""",
     """    if prompt.chars().count() > MAX_AGENT_PROMPT_BYTES {""",
     "insert/a-prompt-that-is-multibyte"),
    ("an-oversized-prompt-is-a-400", ROUTE,
     """    if prompt.len() > MAX_AGENT_PROMPT_BYTES {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "Agent prompt is too large.");""",
     """    if prompt.len() > MAX_AGENT_PROMPT_BYTES {
        return error(StatusCode::BAD_REQUEST, "Agent prompt is too large.");""",
     "insert/a-prompt-over-the-prompt-cap"),
    ("the-paste-encoder-is-not-consulted", ROUTE,
     """    if let Err(reason) = encode_agent_prompt_paste(&prompt) {
        return error(StatusCode::BAD_REQUEST, &reason);
    }""",
     """""",
     "insert/a-prompt-that-submits"),

    # --- the insert schema ----------------------------------------------------
    ("an-empty-prompt-is-accepted", ROUTE,
     """    (!prompt.is_empty()).then(|| prompt.to_string())""",
     """    Some(prompt.to_string())""",
     "insert/an-empty-prompt"),
    ("an-unknown-key-is-tolerated", ROUTE,
     """    if object.keys().any(|key| key != "prompt") {
        return None;
    }""",
     """""",
     "insert/an-unknown-key"),
    ("a-prompt-may-be-any-type", ROUTE,
     """    let prompt = object.get("prompt")?.as_str()?;""",
     """    let prompt = object
        .get("prompt")
        .map(|value| value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string()))?;
    let prompt = prompt.as_str();""",
     "insert/a-prompt-that-is-a-number"),

    # --- renaming -------------------------------------------------------------
    ("a-label-is-not-trimmed", ROUTE,
     """    let label = object.get("label")?.as_str()?.trim();""",
     """    let label = object.get("label")?.as_str()?;""",
     "rename/a-session"),
    ("a-label-is-bounded-before-it-is-trimmed", ROUTE,
     """    let label = object.get("label")?.as_str()?.trim();
    (!label.is_empty() && utf16_len(label) <= 60).then(|| label.to_string())""",
     """    let raw = object.get("label")?.as_str()?;
    let label = raw.trim();
    (!label.is_empty() && utf16_len(raw) <= 60).then(|| label.to_string())""",
     "rename/a-long-label-with-padding"),
    ("a-long-label-is-truncated", ROUTE,
     """    (!label.is_empty() && utf16_len(label) <= 60).then(|| label.to_string())""",
     """    (!label.is_empty()).then(|| label.chars().take(60).collect::<String>())""",
     "rename/a-label-that-is-too-long"),
    ("a-rename-tolerates-an-unknown-key", ROUTE,
     """    if object.keys().any(|key| key != "label") {
        return None;
    }""",
     """""",
     "rename/an-unknown-key"),
    ("an-unknown-rename-is-a-409", ROUTE,
     """fn session_failure(message: String) -> Response {
    let status = if message.starts_with("Unknown terminal session:") {""",
     """fn session_failure(message: String) -> Response {
    let status = if message.starts_with("No such terminal session:") {""",
     "rename/an-unknown-session"),
    ("a-rename-needs-the-control-header", ROUTE,
     """async fn rename(State(state): State<AppState>, uri: Uri, body: Bytes) -> Response {
    let id = match existing_id(&uri) {""",
     """async fn rename(State(state): State<AppState>, headers: HeaderMap, uri: Uri, body: Bytes) -> Response {
    if headers.get(TERMINAL_CONTROL_HEADER).is_none() {
        return error(StatusCode::FORBIDDEN, "Terminal control header is required.");
    }
    let id = match existing_id(&uri) {""",
     "rename/a-session"),

    # --- closing --------------------------------------------------------------
    ("closing-an-unknown-session-succeeds", ROUTE,
     """    let known = manager
        .list_sessions()
        .iter()
        .any(|session| session.id == id);""",
     """    let known = true;""",
     "close/an-unknown-session"),
    ("a-close-does-not-answer-the-listing", ROUTE,
     """        sessions: manager.list_sessions().into_iter().map(wire).collect(),""",
     """        sessions: Vec::new(),""",
     "close/a-session"),
    ("an-unknown-close-is-a-404", ROUTE,
     """    Json(TerminalSessionsEnvelope {
        ok: closed,
        sessions: manager.list_sessions().into_iter().map(wire).collect(),
    })
    .into_response()""",
     """    if !closed {
        return error(StatusCode::NOT_FOUND, "Unknown terminal session");
    }
    Json(TerminalSessionsEnvelope {
        ok: closed,
        sessions: manager.list_sessions().into_iter().map(wire).collect(),
    })
    .into_response()""",
     "close/an-unknown-session"),

    # --- method handling ------------------------------------------------------
    ("an-action-route-falls-to-the-shell", ROUTE,
     """            post(insert_prompt)
                .fallback(method_not_allowed)""",
     """            post(insert_prompt)""",
     "insert/wrong-method"),
    ("transcripts-answer-405", ROUTE,
     """        .route("/api/terminal/transcripts", get(transcripts))""",
     """        .route(
            "/api/terminal/transcripts",
            get(transcripts).fallback(method_not_allowed),
        )""",
     "transcripts/wrong-method"),
    ("the-rename-route-falls-to-the-shell", ROUTE,
     """            patch(rename).delete(close).fallback(method_not_allowed),""",
     """            patch(rename).delete(close),""",
     "rename/wrong-method"),

    # --- transcripts ----------------------------------------------------------
    ("the-repository-path-comes-from-the-shared-helper", ROUTE,
     """    match nomoreide_core::config::selected_git_repository(&config) {
        Some(repository) => repository
            .active_worktree_path
            .clone()
            .unwrap_or_else(|| repository.path.clone()),
        None => fallback,
    }""",
     """    nomoreide_core::config::selected_git_cwd(&config, &fallback).await""",
     "transcripts/the-selected-repository"),
    ("the-worktree-path-is-ignored", ROUTE,
     """        Some(repository) => repository
            .active_worktree_path
            .clone()
            .unwrap_or_else(|| repository.path.clone()),""",
     """        Some(repository) => repository.path.clone(),""",
     "transcripts/the-selected-repository"),
    ("any-scope-widens-the-listing", ROUTE,
     """    let repo_path = if query_value(&uri, "scope").as_deref() == Some("all") {""",
     """    let repo_path = if query_value(&uri, "scope").is_some() {""",
     "transcripts/an-unknown-scope"),
    ("a-repeated-scope-takes-the-last", ROUTE,
     """    uri.query()?.split('&').find_map(|pair| {""",
     """    uri.query()?.split('&').collect::<Vec<_>>().into_iter().rev().find_map(|pair| {""",
     "transcripts/a-repeated-scope"),
    ("codex-home-is-not-read-from-the-environment", CORE,
     """    let codex = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));""",
     """    let codex = home.join(".codex");""",
     "transcripts/every-scope"),
    ("a-sidechain-turn-becomes-the-title", CORE,
     """            && entry.get("isSidechain").and_then(Value::as_bool) != Some(true)""",
     """""",
     "transcripts/every-scope"),
    ("an-injected-turn-becomes-the-title", CORE,
     """    if trimmed.is_empty()
        || trimmed.starts_with('<')
        || trimmed.starts_with("# AGENTS.md instructions for ")
    {
        return None;
    }""",
     """    if trimmed.is_empty() {
        return None;
    }""",
     "transcripts/every-scope"),
    ("a-title-is-not-collapsed", CORE,
     """    let collapsed = trimmed.split_whitespace().collect::<Vec<_>>().join(" ");""",
     """    let collapsed = trimmed.to_string();""",
     "transcripts/every-scope"),
    ("a-duplicate-session-is-listed-twice", CORE,
     """    dedupe_by_session(&mut claude);""",
     """""",
     "transcripts/every-scope"),
    ("the-oldest-copy-of-a-session-wins", CORE,
     """    claude.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));""",
     """    claude.sort_by(|left, right| left.updated_at.cmp(&right.updated_at));""",
     "transcripts/every-scope"),
    ("a-codex-subagent-thread-is-listed", CORE,
     """            if is_codex_subagent_thread(payload) {
                return None;
            }""",
     """""",
     "transcripts/every-scope"),
    ("the-directory-match-is-exact", CORE,
     """            .map_or(true, |expected| path_key(name) == *expected)""",
     """            .map_or(true, |expected| name == expected)""",
     "transcripts/the-selected-repository"),
    ("the-body-cwd-is-not-confirmed", CORE,
     """                if repo_path.map_or(true, |expected| transcript.cwd == expected) {
                    claude.push(transcript);
                }""",
     """                claude.push(transcript);""",
     "transcripts/the-selected-repository"),
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
