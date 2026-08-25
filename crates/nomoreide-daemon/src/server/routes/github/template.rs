//! The pull-request template: everything the "new pull request" screen needs
//! filled in before anyone types.
//!
//! The widest route in this domain, and the one most defined by what it does
//! when things do not work. It reads the local repository, asks GitHub about
//! the repository and about a branch comparison, falls back to two *local*
//! comparisons when GitHub cannot help — which is the common case, because the
//! branch has usually not been pushed yet — looks up the head commit's CI, and
//! writes a title and a body out of whatever it managed to collect.
//!
//! **Nothing here fails.** Every step that does not work pushes a sentence onto
//! `warnings` and the screen still opens, because a template is a starting
//! point: a user who can see "could not reach GitHub" beside a half-filled form
//! can finish it by hand, where an error page leaves them with nothing.

use crate::server::app::AppState;
use crate::server::errors::error;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use nomoreide_core::git_manager::{GitCompareSummary, GitManager, GitStatus};
use nomoreide_core::github_context::require_github_context;
use nomoreide_core::github_manager::GithubManager;
use serde_json::{json, Map, Value};

/// How many commits the suggested body lists, and how many files.
const BODY_COMMITS: usize = 10;
const BODY_FILES: usize = 20;

/// The base to propose when nothing else names one.
const FALLBACK_BASE: &str = "main";

pub(super) fn routes() -> Router<AppState> {
    Router::new().route("/api/github/pr-template", get(pr_template))
}

async fn pr_template(State(state): State<AppState>) -> Response {
    let cwd = state.workspace_cwd().await;
    let context = match require_github_context(&state.config_store, &cwd).await {
        Ok(context) => context,
        Err(reason) => return error(StatusCode::BAD_REQUEST, &reason.to_string()),
    };
    let template = build(&cwd, &context.manager).await;
    Json(json!({ "ok": true, "template": template })).into_response()
}

async fn build(cwd: &str, manager: &GithubManager) -> Value {
    let mut warnings: Vec<String> = Vec::new();

    // Sequential, not concurrent: the reference awaits these one after the
    // other, so the local read always happens before the network one and the
    // two warnings can only ever appear in this order.
    let status = match GitManager::status(cwd).await {
        Ok(status) => Some(status),
        Err(reason) => {
            warnings.push(format!("Could not read local Git status: {reason}"));
            None
        }
    };
    let repository = match manager.repo_info().await {
        Ok(repository) => Some(repository),
        Err(reason) => {
            warnings.push(format!(
                "Could not read GitHub repository metadata: {}",
                reason.message
            ));
            None
        }
    };

    let head = status
        .as_ref()
        .map(|status| status.branch.clone())
        .unwrap_or_default();
    if head.is_empty() {
        warnings.push(
            "Current branch could not be detected. Enter the head branch manually.".to_string(),
        );
    }

    let base = base_branch(repository.as_ref(), status.as_ref());
    let mut compare = empty_compare(&base, &head);
    if !base.is_empty() && !head.is_empty() && base != head {
        compare = compare_summary(cwd, manager, &base, &head, &mut warnings).await;
    } else if !head.is_empty() && base == head {
        warnings.push(
            "The current branch matches the base branch. Choose a feature branch before creating a PR."
                .to_string(),
        );
    }

    // Only a comparison that found commits has a head to ask about.
    let head_sha = compare
        .get("headSha")
        .and_then(Value::as_str)
        .filter(|sha| !sha.is_empty())
        .map(str::to_string);
    if let Some(sha) = head_sha {
        match manager.commit_checks(Some(&sha)).await {
            Ok(ci) => {
                compare.insert("ciStatus".into(), json!(ci));
            }
            Err(reason) => {
                warnings.push(format!("Could not read head CI status: {}", reason.message))
            }
        }
    }

    let commits = compare
        .get("commits")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    json!({
        "repository": repository,
        // Empty is "unknown", not a branch named "".
        "currentBranch": (!head.is_empty()).then(|| head.clone()),
        "suggestedBase": base,
        "base": base,
        "head": head,
        "title": suggest_title(&head, &commits),
        "body": suggest_body(&compare),
        "draft": false,
        "compare": Value::Object(compare),
        "warnings": warnings,
    })
}

/// Which branch this one would be merged into: GitHub's default branch, else
/// whatever the local branch tracks, else `main`.
///
/// `??` at each step, so a `default_branch` GitHub sent as an empty string is
/// *kept* — it is a value, however unhelpful — while a null or a missing one
/// falls through to the upstream.
fn base_branch(repository: Option<&Value>, status: Option<&GitStatus>) -> String {
    if let Some(default) = repository
        .and_then(|repository| repository.get("default_branch"))
        .filter(|value| !value.is_null())
    {
        return default.as_str().unwrap_or_default().to_string();
    }
    status
        .and_then(|status| status.upstream.as_deref())
        .filter(|upstream| !upstream.is_empty())
        .map(|upstream| upstream.strip_prefix("origin/").unwrap_or(upstream))
        .filter(|base| !base.is_empty())
        .unwrap_or(FALLBACK_BASE)
        .to_string()
}

/// The comparison, from GitHub if it can, from this machine if it cannot.
///
/// Three attempts in order: GitHub, the local base, and the local
/// `origin/<base>`. Only the *last* local failure is reported — a repository
/// that has `origin/main` but no local `main` is perfectly normal, and warning
/// about the first attempt would be noise on a screen that opened fine.
async fn compare_summary(
    cwd: &str,
    manager: &GithubManager,
    base: &str,
    head: &str,
    warnings: &mut Vec<String>,
) -> Map<String, Value> {
    match manager.compare_branches(base, head).await {
        Ok(summary) => {
            let mut compare = Map::new();
            compare.insert("base".into(), json!(base));
            compare.insert("head".into(), json!(head));
            if let Some(ahead_by) = summary.ahead_by {
                compare.insert("aheadBy".into(), ahead_by);
            }
            compare.insert("headSha".into(), json!(summary.head_sha));
            compare.insert("commits".into(), json!(summary.commits));
            compare.insert("files".into(), json!(summary.files));
            return compare;
        }
        Err(reason) => warnings.push(format!(
            "Could not compare pushed GitHub branches: {}",
            reason.message
        )),
    }

    let remote = format!("origin/{base}");
    for reference in [base, remote.as_str()] {
        match GitManager::compare_with_base(cwd, reference).await {
            Ok(summary) => return local_compare(base, head, &summary),
            Err(reason) => {
                if reference == remote {
                    warnings.push(format!(
                        "Could not compare local branch with {base}: {reason}"
                    ));
                }
            }
        }
    }
    empty_compare(base, head)
}

fn local_compare(base: &str, head: &str, summary: &GitCompareSummary) -> Map<String, Value> {
    let mut compare = Map::new();
    compare.insert("base".into(), json!(base));
    compare.insert("head".into(), json!(head));
    compare.insert("aheadBy".into(), json!(summary.ahead_by));
    compare.insert("headSha".into(), json!(summary.head_sha));
    compare.insert("commits".into(), json!(summary.commits));
    compare.insert("files".into(), json!(summary.files));
    compare
}

fn empty_compare(base: &str, head: &str) -> Map<String, Value> {
    let mut compare = Map::new();
    compare.insert("base".into(), json!(base));
    compare.insert("head".into(), json!(head));
    compare.insert("aheadBy".into(), json!(0));
    compare.insert("headSha".into(), Value::Null);
    compare.insert("commits".into(), json!([]));
    compare.insert("files".into(), json!([]));
    compare
}

/// The title to propose: the newest commit's subject, else the branch name
/// read as a sentence.
fn suggest_title(head: &str, commits: &[Value]) -> String {
    let latest = commits
        .last()
        .and_then(|commit| commit.get("message"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|message| !message.is_empty());
    match latest {
        Some(message) => message.to_string(),
        None => branch_title(head),
    }
}

/// `feat/add_the-thing` reads as `Add the thing`.
///
/// Only the leaf of the path, because the prefix is a convention rather than a
/// description. Capitalisation touches the first character only when it is a
/// word character — the reference's `^\w` — so a branch starting with
/// punctuation is left as it is rather than having the punctuation "capitalised".
fn branch_title(head: &str) -> String {
    let leaf = head
        .split('/')
        .filter(|segment| !segment.is_empty())
        .next_back()
        .unwrap_or(head);
    let spaced: String = leaf
        .chars()
        .map(|character| {
            if character == '-' || character == '_' {
                ' '
            } else {
                character
            }
        })
        .collect();
    let collapsed = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut characters = collapsed.chars();
    match characters.next() {
        // **ASCII on purpose.** The reference capitalises through `/^\w/`, and
        // JavaScript's `\w` is `[A-Za-z0-9_]` — it does not match a letter
        // outside ASCII. A branch named `emeraude` with an accent therefore
        // keeps its lowercase first letter there, and must keep it here;
        // `is_alphanumeric` is Unicode-aware and would capitalise it.
        Some(first) if first.is_ascii_alphanumeric() || first == '_' => {
            first.to_uppercase().collect::<String>() + characters.as_str()
        }
        _ => collapsed,
    }
}

/// The body to propose: what is in the branch, as a checklist someone can edit
/// down rather than a blank box they have to fill.
fn suggest_body(compare: &Map<String, Value>) -> String {
    let commits = compare
        .get("commits")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let files = compare
        .get("files")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();

    let mut lines: Vec<String> = Vec::new();
    if !commits.is_empty() {
        lines.push("## Commits".to_string());
        // The *newest* ten: a long branch's recent work says more about it
        // than where it started.
        for commit in commits
            .iter()
            .skip(commits.len().saturating_sub(BODY_COMMITS))
        {
            lines.push(format!("- {}", text(commit.get("message"))));
        }
    }
    if !files.is_empty() {
        if !lines.is_empty() {
            lines.push(String::new());
        }
        lines.push("## Changed files".to_string());
        for file in files.iter().take(BODY_FILES) {
            lines.push(format!(
                "- {} {}",
                text(file.get("status")),
                text(file.get("path"))
            ));
        }
        if files.len() > BODY_FILES {
            lines.push(format!("- {} more files", files.len() - BODY_FILES));
        }
    }
    lines.join("\n")
}

/// A field rendered into prose the way a template literal renders it: a string
/// as itself, anything else as its JSON spelling, and a missing one as
/// "undefined".
fn text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(value) => value.to_string(),
        None => "undefined".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_branch_name_becomes_a_sentence() {
        assert_eq!(branch_title("feat/add_the-thing"), "Add the thing");
        assert_eq!(branch_title("123-fix"), "123 fix");
        assert_eq!(branch_title("+odd-name"), "+odd name");
        assert_eq!(branch_title(""), "");
        assert_eq!(branch_title("a//b"), "B");
    }
}
