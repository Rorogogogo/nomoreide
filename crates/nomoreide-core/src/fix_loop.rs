//! Turn an error-inbox incident into one agent task whose result is reviewable.
//!
//! The Rust half of `src/core/fix-loop.ts`. It chains three features that were
//! previously chained by hand: it builds the repro bundle, checkpoints the
//! working tree, and records an agent session pinned to that checkpoint — so
//! whatever the in-dock agent edits afterwards shows up in Agent → Changes with
//! a button that puts the tree back.
//!
//! **The snapshot is taken here rather than by the recording wrapper** because
//! the in-dock agent runs the vendor's CLI directly and never passes through
//! NoMoreIDE's MCP. Nothing else would capture the pre-fix state.
//!
//! Everything after the bundle is best-effort. A directory that is not a
//! repository, a git that will not run, a session file that cannot be written:
//! none of them stop the fix. They only cost the reviewable change-set, and a
//! fix a person can still make by hand beats a refusal.

use crate::agent_sessions::{save_agent_session, AgentSession};
use crate::repro_bundle::ReproBundle;
use crate::snapshot_manager::SnapshotManager;
use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use std::path::Path;

/// How many snapshots survive a prune. Enough to walk back through a session's
/// worth of fixes, few enough that the ref namespace stays readable.
const SNAPSHOT_KEEP: usize = 50;
/// Base-36 digits of randomness in a session id.
const SUFFIX: usize = 6;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixPreparation {
    /// The recorded session. The change-set and restore endpoints key off it.
    pub session_id: String,
    /// The repro bundle wrapped in a fix instruction, for the dock.
    pub prompt: String,
    /// Where the snapshot was taken, which is where the agent will edit.
    pub repo_path: String,
    /// Absent when the repository could not be checkpointed — see the module
    /// note.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_sha: Option<String>,
}

/// Prepare the fix for an already-built bundle.
///
/// The bundle is passed in rather than built here so the caller resolves the
/// incident once — and so a missing incident is answered as a 404 before any of
/// this runs.
pub async fn prepare(
    bundle: &ReproBundle,
    repo_path: &str,
    sessions_path: &Path,
) -> FixPreparation {
    let started_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut session = AgentSession {
        id: session_id(),
        label: snapshot_label(&bundle.markdown),
        provider: None,
        repo_path: repo_path.to_string(),
        snapshot_sha: None,
        snapshot_ref: None,
        started_at: started_at.clone(),
        last_tool_at: started_at,
        tool_count: 0,
    };

    let manager = SnapshotManager::new(repo_path);
    let label = session.label.as_deref().unwrap_or("Fix reported incident");
    if let Ok(snapshot) = manager.snapshot(label).await {
        session.snapshot_sha = Some(snapshot.sha.clone());
        session.snapshot_ref = Some(snapshot.reference.clone());
        let _ = manager.prune(SNAPSHOT_KEEP).await;
    }

    let session_id = session.id.clone();
    let snapshot_sha = session.snapshot_sha.clone();
    let _ = save_agent_session(sessions_path, session);

    FixPreparation {
        session_id,
        prompt: fix_prompt(&bundle.markdown),
        repo_path: repo_path.to_string(),
        snapshot_sha,
    }
}

/// The bundle's first heading is the user's error prompt, so it makes a much
/// better restore-point name than the internal random session identifier.
fn snapshot_label(markdown: &str) -> Option<String> {
    let heading = markdown
        .lines()
        .find_map(|line| line.trim().strip_prefix("# Bug report: "))?
        .trim();
    if heading.is_empty() {
        return None;
    }
    Some(format!(
        "Fix: {}",
        heading.chars().take(72).collect::<String>()
    ))
}

/// `s-<millis in base 36>-<six random base-36 digits>`, the reference's
/// spelling. The clock half orders sessions; the random half keeps two started
/// in the same millisecond apart.
fn session_id() -> String {
    let millis = Utc::now().timestamp_millis().max(0) as u128;
    format!(
        "s-{}-{}",
        base36(millis, 1),
        base36(random_suffix(), SUFFIX)
    )
}

/// Six base-36 digits' worth of randomness, and no more.
///
/// The reference takes them off the front of `Math.random().toString(36)`, so
/// the *width* is the format — an id with a longer tail is a different id shape
/// to anything that stores or matches one. The gate cannot see this (its
/// normalizer masks the whole suffix), so the width is held by a unit test.
fn random_suffix() -> u128 {
    uuid::Uuid::new_v4().as_u128() % 36u128.pow(SUFFIX as u32)
}

/// `value` in base 36, at least `width` digits, least-significant last.
fn base36(mut value: u128, width: usize) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    while out.len() < width {
        out.push(b'0');
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// The instruction the bundle is pasted into.
///
/// It says the edits are snapshotted because they are, and because an agent
/// told its work is reversible makes the smaller change.
pub fn fix_prompt(markdown: &str) -> String {
    [
        "A bug was detected in this workspace. Below is an automatically assembled repro bundle: the error, the affected file's diff, recent logs, the service's runtime state, and its environment with secrets masked.",
        "",
        "Investigate the root cause and apply the smallest change that resolves it. When you are done, briefly summarize what you changed and why. Your edits are snapshotted, so they can be reviewed and reverted as a single change-set.",
        "",
        "---",
        "",
        markdown,
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_id_is_a_clock_and_six_random_digits() {
        let id = session_id();
        let mut parts = id.split('-');
        assert_eq!(parts.next(), Some("s"));
        let clock = parts.next().expect("a clock half");
        let suffix = parts.next().expect("a random half");
        assert_eq!(parts.next(), None, "exactly three parts: {id}");
        assert_eq!(suffix.len(), SUFFIX, "the suffix width is the format: {id}");
        for half in [clock, suffix] {
            assert!(
                half.bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit()),
                "base 36 is lowercase: {id}"
            );
        }
        assert_ne!(session_id(), id, "two ids in a row differ");
    }

    #[test]
    fn base36_pads_to_its_width_and_never_past_it() {
        assert_eq!(base36(0, 6), "000000");
        assert_eq!(base36(35, 6), "00000z");
        assert_eq!(base36(36, 1), "10");
        assert_eq!(base36(1, 1), "1");
    }

    #[test]
    fn the_fix_prompt_ends_with_the_bundle_it_wraps() {
        let prompt = fix_prompt("# Bug report: x");
        assert!(prompt.starts_with("A bug was detected in this workspace."));
        assert!(prompt.ends_with("\n---\n\n# Bug report: x"));
    }

    #[test]
    fn snapshot_names_use_the_prompt_heading_instead_of_the_session_id() {
        assert_eq!(
            snapshot_label("# Bug report: API returns 500\n\n## Error"),
            Some("Fix: API returns 500".to_string())
        );
        assert_eq!(snapshot_label("# Bug report:   \n"), None);
    }
}
