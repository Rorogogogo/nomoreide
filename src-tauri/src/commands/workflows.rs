use tauri::State;
use serde_json::Value;
use crate::AppState;

/// The Phase-1 starter set — the same built-in templates the Node backend ships
/// (`src/core/workflows.ts`). These are plain data, not hardcoded UI, so a user
/// can fork/edit one into their own saved workflow. Kept byte-for-byte in sync
/// with the TS `BUILTIN_WORKFLOWS`; if you change one, change both.
const BUILTIN_WORKFLOWS_JSON: &str = r#"[
  {
    "id": "commit-push",
    "name": "Commit & push",
    "description": "Pause for approval, make one AI-written commit, then pause again before pushing.",
    "builtin": true,
    "steps": [
      {
        "kind": "agent",
        "id": "commit-message",
        "title": "Generate commit message",
        "isolated": true,
        "prompt": "Stage my changes with `nomoreide_git_stage` (skip anything that looks like a secret, e.g. `.env`), inspect the staged diff once with `nomoreide_git_staged_diff`, then write one conventional-commit message — a `<type>: concise title` line (feat/fix/refactor/chore/docs/test) plus a few short bullets of what changed. Do NOT commit. Reply with ONLY the commit message you recommend."
      },
      { "kind": "gate", "id": "gate-commit", "title": "Approve commit", "message": "Stage the current changes and create one AI-written commit?" },
      { "kind": "action", "id": "commit", "title": "Commit with approved message", "op": "commit" },
      { "kind": "gate", "id": "gate-push", "title": "Approve push", "message": "Push to the remote?" },
      { "kind": "action", "id": "push", "title": "Push", "op": "push" }
    ]
  },
  {
    "id": "ship-it",
    "name": "Ship it",
    "description": "Approve the AI commit, push, then use quick AI turns to open and squash-merge the PR.",
    "builtin": true,
    "steps": [
      { "kind": "action", "id": "assert-pr-branch", "title": "Check PR branch", "op": "assert-pr-branch" },
      {
        "kind": "agent",
        "id": "commit-message",
        "title": "Generate commit message",
        "isolated": true,
        "prompt": "Stage my changes with `nomoreide_git_stage` (skip anything that looks like a secret, e.g. `.env`), inspect the staged diff once with `nomoreide_git_staged_diff`, then write one conventional-commit message — a `<type>: concise title` line (feat/fix/refactor/chore/docs/test) plus a few short bullets of what changed. Do NOT commit. Reply with ONLY the commit message you recommend."
      },
      { "kind": "gate", "id": "gate-commit", "title": "Approve commit", "message": "Stage the current changes and create one AI-written commit?" },
      { "kind": "action", "id": "commit", "title": "Commit with approved message", "op": "commit" },
      { "kind": "gate", "id": "gate-push", "title": "Approve push", "message": "Push and open a PR?" },
      { "kind": "action", "id": "push", "title": "Push", "op": "push" },
      {
        "kind": "agent",
        "id": "open-pr",
        "title": "Open a PR",
        "isolated": true,
        "prompt": "Open a PR for the current branch into `main` using the `nomoreide_github_create_pr` tool. Title = the latest commit subject; for the body, list the commits via `nomoreide_git_log`. Do NOT read file diffs. Reply with just the PR number and URL."
      },
      { "kind": "gate", "id": "gate-merge", "title": "Approve merge", "message": "Squash-merge the pull request?" },
      {
        "kind": "agent",
        "id": "merge",
        "title": "Squash-merge",
        "isolated": true,
        "prompt": "Squash-merge the open pull request for the current branch. First call `nomoreide_git_status` for the branch name, then `nomoreide_github_list_prs` to find its open PR, then merge it with `nomoreide_github_merge_pr`. Don't analyze anything else — just find it and merge. Reply with one line."
      },
      { "kind": "action", "id": "checkout-default-and-pull", "title": "Return to default branch", "op": "checkout-default-and-pull" }
    ]
  },
  {
    "id": "file-issue",
    "name": "File an issue from these changes",
    "description": "One quick AI turn drafts a short issue from your file list, then files it on approval.",
    "builtin": true,
    "steps": [
      {
        "kind": "agent",
        "id": "draft",
        "title": "Draft a short issue",
        "prompt": "Draft a SHORT GitHub issue (a title + a 2–3 line body) from the list of changed files only — call `nomoreide_git_status` for the file list. Do NOT read file diffs or analyze the changes. Show me the draft; don't file it."
      },
      { "kind": "gate", "id": "gate-file", "title": "Approve filing", "message": "File this issue on GitHub?" },
      {
        "kind": "agent",
        "id": "create",
        "title": "File the issue",
        "prompt": "Create the GitHub issue you just drafted using the `nomoreide_github_create_issue` tool. Reply with just the issue number and URL."
      }
    ]
  }
]"#;

fn builtin_workflows() -> Vec<Value> {
    serde_json::from_str(BUILTIN_WORKFLOWS_JSON).expect("builtin workflows JSON is valid")
}

fn workflow_id(w: &Value) -> Option<&str> {
    w.get("id").and_then(Value::as_str)
}

/// Merge the built-in templates with the user's saved workflows. A stored
/// workflow whose id matches a built-in *replaces* it (a fork/edit); everything
/// else is appended. Built-ins come first. Mirrors Node `listWorkflows`.
fn merge_workflows(stored: &[Value]) -> Vec<Value> {
    let builtins = builtin_workflows();
    let builtin_ids: Vec<String> = builtins
        .iter()
        .filter_map(|w| workflow_id(w).map(String::from))
        .collect();

    let mut merged: Vec<Value> = builtins
        .into_iter()
        .map(|builtin| {
            let id = workflow_id(&builtin).map(String::from);
            stored
                .iter()
                .find(|w| workflow_id(w).map(String::from) == id)
                .cloned()
                .unwrap_or(builtin)
        })
        .collect();

    let extras = stored.iter().filter(|w| {
        workflow_id(w).map_or(true, |id| !builtin_ids.iter().any(|b| b == id))
    });
    merged.extend(extras.cloned());
    merged
}

#[tauri::command]
pub async fn list_workflows(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    Ok(merge_workflows(&config.workflows))
}

#[tauri::command]
pub async fn save_workflow(
    state: State<'_, AppState>,
    workflow: Value,
) -> Result<Vec<Value>, String> {
    let config = state.config_store.save_workflow(workflow).await.map_err(|e| e.to_string())?;
    Ok(merge_workflows(&config.workflows))
}

#[tauri::command]
pub async fn delete_workflow(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<Value>, String> {
    let config = state.config_store.remove_workflow(&id).await.map_err(|e| e.to_string())?;
    Ok(merge_workflows(&config.workflows))
}
