//! Working-tree checkpoints, kept out of the branch namespace.
//!
//! A snapshot is a real commit — tree, parent, message — parked under
//! `refs/nomoreide/snapshots/` and reachable by nothing else. Taking one never
//! moves HEAD, never touches a branch, and never disturbs the index: the tree
//! is assembled in a scratch index file, so whatever the user had staged is
//! exactly what they still have staged afterwards.
//!
//! Only reading and creating live here. Restoring a snapshot overwrites work,
//! so it stays a human-confirmed action in the dashboard, the same boundary
//! `db_write` draws against `db_peek`.

use anyhow::{bail, Result};
use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use tokio::process::Command;

const REF_PREFIX: &str = "refs/nomoreide/snapshots";
const IDENTITY_NAME: &str = "nomoreide";
const IDENTITY_EMAIL: &str = "nomoreide@localhost";

/// How many snapshots survive a prune. Old checkpoints are worth less than the
/// repository staying small, and fifty is several days of them.
pub const DEFAULT_KEEP: usize = 50;

/// The longest a label's slug may be in a ref name.
const SLUG_MAX: usize = 40;

/// What a label with nothing nameable in it becomes.
const FALLBACK_SLUG: &str = "snapshot";

/// The format `list` asks git for: tab-separated so a label with spaces in it
/// survives, and sorted by ref name, which — because every name begins with the
/// millisecond it was taken — is newest first.
const LIST_FORMAT: &str =
    "--format=%(refname)%09%(objectname)%09%(creatordate:iso-strict)%09%(subject)";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[serde(rename = "ref")]
    pub reference: String,
    pub sha: String,
    pub created_at: String,
    pub label: String,
}

pub struct SnapshotManager {
    cwd: String,
}

impl SnapshotManager {
    pub fn new(cwd: impl Into<String>) -> Self {
        Self { cwd: cwd.into() }
    }

    /// Every snapshot in this repository, newest first.
    pub async fn list(&self) -> Result<Vec<Snapshot>> {
        let raw = self
            .git(
                &["for-each-ref", "--sort=-refname", LIST_FORMAT, REF_PREFIX],
                &[],
            )
            .await?;
        Ok(raw
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| {
                // Split rather than split-with-limit, matching the reference: a
                // tab inside a subject truncates the label there in both.
                let mut fields = line.split('\t');
                Snapshot {
                    reference: fields.next().unwrap_or_default().to_string(),
                    sha: fields.next().unwrap_or_default().to_string(),
                    created_at: fields.next().unwrap_or_default().to_string(),
                    label: fields.next().unwrap_or_default().to_string(),
                }
            })
            .collect())
    }

    /// Checkpoint the working tree — tracked changes and untracked files alike,
    /// minus whatever `.gitignore` excludes.
    pub async fn snapshot(&self, label: &str) -> Result<Snapshot> {
        // A scratch index, so the real one is neither read nor written. Named
        // for the process so two snapshots at once cannot share it.
        let index = std::env::temp_dir().join(format!(
            "nomoreide-snapshot-{}-{}.index",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let scratch = [("GIT_INDEX_FILE", index.to_string_lossy().into_owned())];
        let result = self.build(label, &scratch).await;
        // The scratch index is ours alone; its removal is not the caller's
        // problem and its failure is not their error.
        let _ = tokio::fs::remove_file(&index).await;
        result
    }

    async fn build(&self, label: &str, scratch: &[(&str, String)]) -> Result<Snapshot> {
        self.git(&["read-tree", "--empty"], scratch).await?;
        self.git(&["add", "-A"], scratch).await?;
        let tree = self.git(&["write-tree"], scratch).await?.trim().to_string();

        // An unborn HEAD is not a failure: the first snapshot in a repository
        // with no commits yet simply has no parent.
        let parent = self
            .git(&["rev-parse", "HEAD"], scratch)
            .await
            .ok()
            .map(|sha| sha.trim().to_string())
            .filter(|sha| !sha.is_empty());

        let mut commit: Vec<&str> = vec!["commit-tree", &tree];
        if let Some(parent) = parent.as_deref() {
            commit.extend(["-p", parent]);
        }
        commit.extend(["-m", label]);
        // The identity is the tool's, not the user's: a checkpoint nobody asked
        // for should not appear in `git log --author` as something they wrote.
        // Passed per command, so no repository config changes.
        let identity = [
            ("GIT_AUTHOR_NAME", IDENTITY_NAME.to_string()),
            ("GIT_AUTHOR_EMAIL", IDENTITY_EMAIL.to_string()),
            ("GIT_COMMITTER_NAME", IDENTITY_NAME.to_string()),
            ("GIT_COMMITTER_EMAIL", IDENTITY_EMAIL.to_string()),
        ];
        let sha = self.git(&commit, &identity).await?.trim().to_string();

        let reference = format!(
            "{REF_PREFIX}/{}-{}",
            Utc::now().timestamp_millis(),
            slug(label)
        );
        self.git(&["update-ref", &reference, &sha], &[]).await?;

        Ok(Snapshot {
            reference,
            sha,
            created_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            label: label.to_string(),
        })
    }

    /// Drop all but the newest `keep` snapshots. Returns how many went.
    pub async fn prune(&self, keep: usize) -> Result<usize> {
        let all = self.list().await?;
        let stale = all.into_iter().skip(keep).collect::<Vec<_>>();
        for snapshot in &stale {
            self.git(&["update-ref", "-d", &snapshot.reference], &[])
                .await?;
        }
        Ok(stale.len())
    }

    /// Run git, reporting a failure the way Node's `execFile` does: the command
    /// that failed, then what git said. That is the wording an agent already
    /// sees from this tool, and it names the command, which the trimmed-stderr
    /// wording used elsewhere does not.
    async fn git(&self, args: &[&str], env: &[(&str, String)]) -> Result<String> {
        let mut command = Command::new("git");
        command.args(args).current_dir(&self.cwd);
        for (key, value) in env {
            command.env(key, value);
        }
        let output = match command.output().await {
            Ok(output) => output,
            Err(error) => bail!("{}", spawn_failure(&error)),
        };
        if !output.status.success() {
            bail!(
                "Command failed: git {}\n{}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}

/// How Node names a spawn that never happened — the errno, not prose. A `cwd`
/// that does not exist and a missing `git` are the same failure to the kernel.
fn spawn_failure(error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => "spawn git ENOENT".to_string(),
        std::io::ErrorKind::PermissionDenied => "spawn git EACCES".to_string(),
        _ => format!("spawn git failed: {error}"),
    }
}

/// The part of a ref name that comes from the label.
///
/// Lowercased, with every run of anything else collapsed to a single dash and
/// the dashes trimmed off the ends — and only then cut to length, so a slug may
/// legitimately end in a dash where the cut fell. A label with no ASCII letter
/// or digit anywhere in it has nothing to name a ref after, and becomes
/// `snapshot`.
fn slug(label: &str) -> String {
    let mut collapsed = String::with_capacity(label.len());
    let mut in_run = false;
    for character in label.to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            collapsed.push(character);
            in_run = false;
        } else if !in_run {
            collapsed.push('-');
            in_run = true;
        }
    }
    let cut: String = collapsed.trim_matches('-').chars().take(SLUG_MAX).collect();
    if cut.is_empty() {
        FALLBACK_SLUG.to_string()
    } else {
        cut
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_lowercases_and_collapses() {
        assert_eq!(slug("feature/branch .. label~1"), "feature-branch-label-1");
        assert_eq!(slug("UPPER Case"), "upper-case");
        assert_eq!(slug("a--b"), "a-b");
        assert_eq!(slug("  spaced  out  "), "spaced-out");
        assert_eq!(slug("dot.dot"), "dot-dot");
    }

    #[test]
    fn slug_falls_back_when_nothing_is_nameable() {
        assert_eq!(slug("üñî ✅ 快照"), FALLBACK_SLUG);
        assert_eq!(slug("!!!"), FALLBACK_SLUG);
        assert_eq!(slug("@"), FALLBACK_SLUG);
    }

    #[test]
    fn slug_keeps_what_survives_a_partly_unnameable_label() {
        assert_eq!(slug("Ünïcödé only"), "n-c-d-only");
        assert_eq!(slug("快照 42"), "42");
        assert_eq!(slug("abc üñî def"), "abc-def");
    }

    /// The cut happens after trimming, so the last character may be a dash —
    /// which is the one place a slug does not look trimmed.
    #[test]
    fn slug_is_cut_after_it_is_trimmed() {
        assert_eq!(
            slug(&format!("{} tail", "a".repeat(39))),
            format!("{}-", "a".repeat(39))
        );
        assert_eq!(slug(&format!("{}BBBB", "a".repeat(40))), "a".repeat(40));
        assert_eq!(
            slug(&format!("{}  bb", "a".repeat(38))),
            format!("{}-b", "a".repeat(38))
        );
    }
}
