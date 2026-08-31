//! Working-tree checkpoints, kept out of the branch namespace.
//!
//! A snapshot is a real commit — tree, parent, message — parked under
//! `refs/nomoreide/snapshots/` and reachable by nothing else. Taking one never
//! moves HEAD, never touches a branch, and never disturbs the index: the tree
//! is assembled in a scratch index file, so whatever the user had staged is
//! exactly what they still have staged afterwards.
//!
//! Restoring is here as well, and it is the one destructive operation in the
//! module. Two things keep it safe: it refuses any sha that is not itself a
//! snapshot, so no caller can check out an arbitrary commit through it, and it
//! takes a `pre-restore` snapshot first, so the state it overwrites is still
//! reachable afterwards. It stays a human-confirmed action in the dashboard and
//! is deliberately absent from the MCP surface, the same boundary `db_write`
//! draws against `db_peek`.

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

/// What a *blank* label becomes. The same word, but a different decision: this
/// one is about a caller who named nothing, not about a name with no ASCII in
/// it.
const FALLBACK_LABEL: &str = "snapshot";

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

/// One file's fate between a snapshot and now: `A` added since, `M` modified,
/// `D` deleted since.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SnapshotChange {
    pub status: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    /// The safety snapshot taken before anything was overwritten.
    pub pre_restore: Snapshot,
    /// How many files were written back out of the snapshot.
    pub restored_files: usize,
    /// Files created after the snapshot, which the restore removed.
    pub deleted_paths: Vec<String>,
}

pub struct SnapshotManager {
    cwd: String,
}

/// The tool's own identity, passed per command so no repository config changes.
///
/// A checkpoint nobody asked for should not turn up in `git log --author` as
/// something the user wrote.
fn identity() -> Vec<(&'static str, String)> {
    vec![
        ("GIT_AUTHOR_NAME", IDENTITY_NAME.to_string()),
        ("GIT_AUTHOR_EMAIL", IDENTITY_EMAIL.to_string()),
        ("GIT_COMMITTER_NAME", IDENTITY_NAME.to_string()),
        ("GIT_COMMITTER_EMAIL", IDENTITY_EMAIL.to_string()),
    ]
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
                // The label is everything after the third tab, rejoined —
                // the first three fields cannot contain one, so only a label
                // ever splits into more, and it is put back together rather
                // than truncated at the tab.
                let mut fields = line.splitn(4, '\t');
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
        let tree = self.capture_tree().await?;
        self.build(label, &tree).await
    }

    /// The working tree — tracked changes and untracked files alike, minus
    /// whatever `.gitignore` excludes — written out as a tree object.
    ///
    /// **Seeded from HEAD, not from nothing.** Starting empty would give the
    /// same tree for almost every repository, because `add -A` re-adds
    /// everything it can see; the difference is a file that is *tracked* and
    /// also ignored, which `add -A` will not stage but which HEAD already
    /// carries. Reading HEAD in first keeps that file in the snapshot, so
    /// restoring one does not quietly delete it.
    async fn capture_tree(&self) -> Result<String> {
        // A scratch index, so the real one is neither read nor written. Named
        // for the process so two captures at once cannot share it.
        let index = std::env::temp_dir().join(format!(
            "nomoreide-snapshot-{}-{}.index",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let scratch = [("GIT_INDEX_FILE", index.to_string_lossy().into_owned())];
        let result = self.write_tree(&scratch).await;
        // The scratch index is ours alone; its removal is not the caller's
        // problem and its failure is not their error.
        let _ = tokio::fs::remove_file(&index).await;
        result
    }

    async fn write_tree(&self, scratch: &[(&str, String)]) -> Result<String> {
        match self.head_sha().await {
            Some(head) => self.git(&["read-tree", &head], scratch).await?,
            None => self.git(&["read-tree", "--empty"], scratch).await?,
        };
        self.git(&["add", "-A"], scratch).await?;
        Ok(self.git(&["write-tree"], scratch).await?.trim().to_string())
    }

    /// An unborn HEAD is not a failure: a repository with no commits yet simply
    /// has no parent to hang a snapshot off.
    async fn head_sha(&self) -> Option<String> {
        self.git(&["rev-parse", "--verify", "HEAD"], &[])
            .await
            .ok()
            .map(|sha| sha.trim().to_string())
            .filter(|sha| !sha.is_empty())
    }

    async fn build(&self, label: &str, tree: &str) -> Result<Snapshot> {
        let parent = self.head_sha().await;
        let mut commit: Vec<&str> = vec!["commit-tree", tree];
        if let Some(parent) = parent.as_deref() {
            commit.extend(["-p", parent]);
        }
        commit.extend(["-m", label]);
        let sha = self.git(&commit, &identity()).await?.trim().to_string();

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

    /// What differs between a snapshot and the working tree as it stands now.
    ///
    /// The current side is captured the same way a snapshot is, so an untracked
    /// file counts as an addition rather than being invisible.
    pub async fn changed_files(&self, sha: &str) -> Result<Vec<SnapshotChange>> {
        let tree = self.capture_tree().await?;
        let raw = self
            .git(&["diff", "--no-renames", "--name-status", sha, &tree], &[])
            .await?;
        Ok(raw
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                // A path may contain a tab, and git does not quote one here, so
                // everything after the first field is the path.
                let mut fields = line.splitn(2, '\t');
                SnapshotChange {
                    status: fields.next().unwrap_or_default().to_string(),
                    path: fields.next().unwrap_or_default().to_string(),
                }
            })
            .collect())
    }

    /// The patch between a snapshot and the working tree, optionally for one
    /// path. Returned as git wrote it — this is read by a diff viewer.
    pub async fn diff(&self, sha: &str, path: Option<&str>) -> Result<String> {
        let tree = self.capture_tree().await?;
        let mut args: Vec<&str> = vec!["diff", "--no-renames", sha, &tree];
        if let Some(path) = path {
            args.extend(["--", path]);
        }
        self.git(&args, &[]).await
    }

    /// Put the working tree back to a snapshot.
    ///
    /// Reversible by construction: a `pre-restore` snapshot is taken first, and
    /// it doubles as the *current* side of the comparison that decides what to
    /// change — so the same capture both records the state being overwritten
    /// and says which files to overwrite.
    ///
    /// **Additions are deleted by hand.** `git restore` only writes files the
    /// source tree has; a file created after the snapshot is not in it and
    /// would simply survive, leaving a "restored" tree that is not the snapshot.
    pub async fn restore(&self, sha: &str) -> Result<RestoreResult> {
        let target = self.find(sha).await?;
        let pre_restore = self
            .snapshot(&format!("pre-restore ({})", target.label))
            .await?;
        let changes = self
            .git(
                &[
                    "diff",
                    "--no-renames",
                    "--name-status",
                    sha,
                    &pre_restore.sha,
                ],
                &[],
            )
            .await?;

        let mut deleted_paths = Vec::new();
        let mut restored_files = 0usize;
        for line in changes.lines().filter(|line| !line.trim().is_empty()) {
            let mut fields = line.splitn(2, '\t');
            let status = fields.next().unwrap_or_default();
            let path = fields.next().unwrap_or_default().to_string();
            if status == "A" {
                self.remove_worktree_file(&path).await?;
                deleted_paths.push(path);
            } else {
                restored_files += 1;
            }
        }
        if restored_files > 0 {
            // `--worktree` only, so the user's index survives a restore the same
            // way it survives a snapshot.
            self.git(&["restore", "--source", sha, "--worktree", "--", ":/"], &[])
                .await?;
        }
        Ok(RestoreResult {
            pre_restore,
            restored_files,
            deleted_paths,
        })
    }

    /// Drop one snapshot's ref. The commit object is left for git to collect.
    pub async fn delete(&self, sha: &str) -> Result<()> {
        let target = self.find(sha).await?;
        // Compare-and-swap on the old value, so a ref that moved underneath us
        // is not deleted on the strength of a stale read.
        self.git(&["update-ref", "-d", &target.reference, sha], &[])
            .await?;
        Ok(())
    }

    /// Relabel a snapshot.
    ///
    /// A commit object is immutable, so the message is rewritten onto a *new*
    /// object carrying the same tree, parents and dates, and the ref is moved to
    /// it. The ref name keeps the old slug: it encodes when the snapshot was
    /// taken, which relabelling does not change.
    pub async fn rename(&self, sha: &str, label: &str) -> Result<Snapshot> {
        let target = self.find(sha).await?;
        let cleaned = match label.trim() {
            "" => FALLBACK_LABEL,
            trimmed => trimmed,
        };
        let tree = self
            .git(&["rev-parse", &format!("{sha}^{{tree}}")], &[])
            .await?
            .trim()
            .to_string();
        let listed = self
            .git(&["rev-list", "--parents", "-n", "1", sha], &[])
            .await?;
        // The first field is the commit itself; the rest are its parents.
        let parents: Vec<String> = listed
            .split_whitespace()
            .skip(1)
            .map(str::to_string)
            .collect();
        let author_date = self
            .git(&["show", "-s", "--format=%aI", sha], &[])
            .await?
            .trim()
            .to_string();
        let committer_date = self
            .git(&["show", "-s", "--format=%cI", sha], &[])
            .await?
            .trim()
            .to_string();

        let mut commit: Vec<&str> = vec!["commit-tree", &tree];
        for parent in &parents {
            commit.extend(["-p", parent.as_str()]);
        }
        commit.extend(["-m", cleaned]);
        let mut environment = identity();
        environment.push(("GIT_AUTHOR_DATE", author_date));
        environment.push(("GIT_COMMITTER_DATE", committer_date));
        let new_sha = self.git(&commit, &environment).await?.trim().to_string();

        self.git(&["update-ref", &target.reference, &new_sha, sha], &[])
            .await?;
        Ok(Snapshot {
            reference: target.reference,
            sha: new_sha,
            created_at: target.created_at,
            label: cleaned.to_string(),
        })
    }

    /// Resolve a sha to the snapshot it names, refusing anything outside the
    /// namespace. **This is the guard**: every operation that changes or
    /// overwrites something goes through it, so a caller can only ever name a
    /// commit this module made.
    async fn find(&self, sha: &str) -> Result<Snapshot> {
        match self
            .list()
            .await?
            .into_iter()
            .find(|snapshot| snapshot.sha == sha)
        {
            Some(snapshot) => Ok(snapshot),
            None => bail!("Not a nomoreide snapshot: {sha}"),
        }
    }

    /// Delete one file the restore decided was added after the snapshot.
    ///
    /// The containment check is belt-and-braces — the paths come from git's own
    /// diff and are repository-relative — but a delete driven by a path from
    /// anywhere is worth guarding whether or not today's caller can reach it.
    async fn remove_worktree_file(&self, path: &str) -> Result<()> {
        let root = std::path::Path::new(&self.cwd);
        let absolute = root.join(path);
        if !absolute.starts_with(root) || absolute == root {
            bail!("Refusing to delete outside the repository: {path}");
        }
        // A file that is already gone is a restore that has nothing to undo.
        if let Err(error) = tokio::fs::remove_file(&absolute).await {
            if error.kind() != std::io::ErrorKind::NotFound {
                bail!("{}", error);
            }
        }
        Ok(())
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
