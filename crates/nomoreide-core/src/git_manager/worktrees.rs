//! Worktree listing and management.
//!
//! Removal refuses on the primary worktree, a locked one, or one with
//! uncommitted work, so nothing here can lose changes.
//!
//! Failures here read differently from the rest of this module, and
//! deliberately so: the reference runs these commands through Node's
//! `execFile` and lets its error through untouched, where every other read
//! goes through a wrapper that re-throws git's stderr alone. See
//! [`command_failed`].

use super::exec;
use super::types::GitWorktree;
use super::GitManager;
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use tokio::process::Command;

const HEADS_PREFIX: &str = "refs/heads/";

impl GitManager {
    pub async fn worktrees(cwd: &str) -> Result<Vec<GitWorktree>> {
        // `-z` so a path or a lock reason containing a newline cannot be read
        // as the start of another record.
        let raw = run(cwd, &["worktree", "list", "--porcelain", "-z"]).await?;
        let mut worktrees = Vec::new();
        for (index, record) in raw.split("\0\0").enumerate() {
            let fields: Vec<&str> = record.split('\0').filter(|f| !f.is_empty()).collect();
            if !fields.iter().any(|field| field.starts_with("worktree ")) {
                continue;
            }
            let value = |key: &str| field_value(&fields, key);
            let Some(path) = value("worktree") else {
                continue;
            };
            let bare = fields.contains(&"bare");
            worktrees.push(GitWorktree {
                head: value("HEAD").unwrap_or_default(),
                branch: value("branch").map(|branch| {
                    branch
                        .strip_prefix(HEADS_PREFIX)
                        .unwrap_or(&branch)
                        .to_string()
                }),
                bare,
                detached: fields.contains(&"detached"),
                locked: has_field(&fields, "locked"),
                locked_reason: value("locked"),
                prunable: has_field(&fields, "prunable"),
                prunable_reason: value("prunable"),
                created_at: created_at(&path).await,
                // git lists the repository's own worktree first.
                primary: index == 0,
                // A bare repository has no working tree to be dirty.
                dirty: !bare && is_dirty(&path).await,
                path,
            });
        }
        Ok(worktrees)
    }

    /// Add a worktree under the managed root, at `<root>/<project>/<branch>`.
    ///
    /// `project_name` names the folder the worktrees of one repository are
    /// grouped under; without one the repository's own folder name is used.
    pub async fn create_worktree(
        cwd: &str,
        project_name: Option<&str>,
        branch: &str,
        create_branch: bool,
        base_ref: Option<&str>,
    ) -> Result<GitWorktree> {
        let branch = branch.trim();
        if branch.is_empty() || branch.starts_with('-') || branch.contains('\0') {
            anyhow::bail!("A valid branch name is required.");
        }
        let project = project_name
            .map(str::to_string)
            .filter(|name| !name.trim().is_empty())
            .or_else(|| {
                Path::new(cwd)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
            })
            .unwrap_or_default();
        let destination = default_worktrees_dir()?
            .join(safe_segment(&project)?)
            .join(safe_segment(branch)?);
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let destination = destination.to_string_lossy().into_owned();

        let base = base_ref
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("HEAD");
        let args: Vec<&str> = if create_branch {
            vec!["worktree", "add", "-b", branch, &destination, base]
        } else {
            vec!["worktree", "add", &destination, branch]
        };
        run(cwd, &args).await?;

        // Compared canonically: on macOS the managed root is under a symlinked
        // `/var`, and git reports the resolved path, so the string git prints
        // is never the string this function built.
        find_by_path(cwd, &destination).await?.with_context(|| {
            format!("Git created the worktree but it could not be found: {destination}")
        })
    }

    pub async fn remove_worktree(cwd: &str, path: &str) -> Result<()> {
        let worktree = find_by_path(cwd, path)
            .await?
            .context("Unknown worktree.")?;
        if worktree.primary {
            anyhow::bail!("The primary worktree cannot be removed.");
        }
        if worktree.locked {
            anyhow::bail!("Unlock this worktree before removing it.");
        }
        if worktree.dirty {
            anyhow::bail!("Commit, stash, or discard this worktree's changes before removing it.");
        }
        run(cwd, &["worktree", "remove", &worktree.path]).await?;
        Ok(())
    }

    pub async fn prune_worktrees(cwd: &str) -> Result<()> {
        run(cwd, &["worktree", "prune"]).await?;
        Ok(())
    }
}

/// The worktree of `cwd`'s repository at `path`, if `path` is one of them.
///
/// Public because selecting a worktree has to answer the same question, and
/// answering it by comparing strings is what gets it wrong.
pub async fn worktree_at(cwd: &str, path: &str) -> Result<Option<GitWorktree>> {
    find_by_path(cwd, path).await
}

async fn find_by_path(cwd: &str, path: &str) -> Result<Option<GitWorktree>> {
    let target = canonical(path).await;
    let worktrees = GitManager::worktrees(cwd).await?;
    for worktree in worktrees {
        if canonical(&worktree.path).await == target {
            return Ok(Some(worktree));
        }
    }
    Ok(None)
}

/// Where managed worktrees are kept. `NOMOREIDE_WORKTREES_DIR` overrides the
/// default; an empty or blank value is no override at all.
pub fn default_worktrees_dir() -> Result<PathBuf> {
    if let Some(override_path) = std::env::var("NOMOREIDE_WORKTREES_DIR")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return Ok(PathBuf::from(override_path));
    }
    let home = std::env::var("HOME")
        .ok()
        .filter(|home| !home.is_empty())
        .context("Could not resolve the managed worktrees directory")?;
    Ok(PathBuf::from(home).join(".nomoreide").join("worktrees"))
}

/// Resolve symlinks, falling back to the path as given when it does not exist
/// — two paths that cannot be resolved still compare equal to themselves.
async fn canonical(path: &str) -> PathBuf {
    tokio::fs::canonicalize(path)
        .await
        .unwrap_or_else(|_| PathBuf::from(path))
}

/// The value of a porcelain field: everything after the key, trimmed. A field
/// that is only the key (`locked` with no reason) has no value.
fn field_value(fields: &[&str], key: &str) -> Option<String> {
    fields
        .iter()
        .find(|field| **field == key || field.starts_with(&format!("{key} ")))
        .map(|field| field[key.len()..].trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Whether a flag is present at all, with or without a value after it.
fn has_field(fields: &[&str], key: &str) -> bool {
    fields
        .iter()
        .any(|field| *field == key || field.starts_with(&format!("{key} ")))
}

/// Creation time in epoch milliseconds, as a fraction — the reference reports
/// `birthtimeMs` unrounded, and a whole number here would differ in the last
/// digits from the same file's time there.
async fn created_at(path: &str) -> Option<f64> {
    let created = tokio::fs::metadata(path).await.ok()?.created().ok()?;
    let millis = created
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs_f64()
        * 1000.0;
    (millis.is_finite() && millis > 0.0).then_some(millis)
}

/// A worktree with anything at all in its working tree, staged or not. A
/// directory git cannot read is reported clean rather than failing the listing.
async fn is_dirty(path: &str) -> bool {
    !exec::output(path, &["status", "--porcelain=v1", "--untracked-files=all"])
        .await
        .unwrap_or_default()
        .is_empty()
}

/// Run git, returning stdout, and report a failure the way the reference does.
async fn run(cwd: &str, args: &[&str]) -> Result<String> {
    let output = match Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
    {
        Ok(output) => output,
        // The reference does not wrap a spawn failure either — an `execFile`
        // that never started rejects with the errno alone.
        Err(error) => anyhow::bail!("{}", exec::spawn_failure(&error)),
    };
    if !output.status.success() {
        anyhow::bail!(
            "{}",
            command_failed(args, &String::from_utf8_lossy(&output.stderr))
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Node's own `execFile` rejection text: the command line that failed, then
/// what it wrote to stderr, verbatim — trailing newline and all.
///
/// The reference reaches for `execFile` directly here rather than through the
/// wrapper the reads use, so its worktree errors carry this prefix while a
/// failing `git status` carries only git's `fatal:`. Reproducing that is the
/// difference between an agent reading the same sentence from both runtimes
/// and reading two.
fn command_failed(args: &[&str], stderr: &str) -> String {
    format!("Command failed: git {}\n{stderr}", args.join(" "))
}

/// Fold a project or branch name down to one safe path segment. Rejects the
/// results that would escape the managed root rather than sanitizing them into
/// something surprising.
fn safe_segment(value: &str) -> Result<String> {
    let normalized: String = value
        .trim()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '-'
            }
        })
        .collect();
    // git's own separator runs collapse: "a//b" is one dash there, not two.
    let mut collapsed = String::with_capacity(normalized.len());
    for character in normalized.chars() {
        if character == '-' && collapsed.ends_with('-') {
            continue;
        }
        collapsed.push(character);
    }
    let collapsed = collapsed.trim_matches('-').to_string();
    if collapsed.is_empty() || collapsed == "." || collapsed == ".." {
        anyhow::bail!("Could not derive a safe worktree folder name.");
    }
    Ok(collapsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_everything_into_a_single_path_segment() {
        assert_eq!(safe_segment("feature/login").unwrap(), "feature-login");
        assert_eq!(safe_segment("  spaced name ").unwrap(), "spaced-name");
        // A run of unsafe characters collapses to one dash, the way the
        // reference's single regex replacement does.
        assert_eq!(safe_segment("My Project!").unwrap(), "My-Project");
        assert_eq!(safe_segment("a///b").unwrap(), "a-b");
    }

    #[test]
    fn traversal_cannot_survive_as_a_separator_or_as_a_bare_dot_dot() {
        // Dots are legal in a folder name, so they are kept — what makes this
        // safe is that no separator can, leaving one segment that is not "..".
        assert_eq!(safe_segment("../../etc").unwrap(), "..-..-etc");
        assert!(!safe_segment("../../etc").unwrap().contains('/'));
        assert!(safe_segment("..").is_err());
    }

    #[test]
    fn refuses_names_that_leave_nothing_safe() {
        for value in ["", "   ", "/", "..", ".", "///", "!!!"] {
            assert!(
                safe_segment(value).is_err(),
                "expected {value:?} to be refused"
            );
        }
    }

    #[test]
    fn a_porcelain_field_is_everything_after_its_key() {
        let fields = vec![
            "worktree /repos/demo",
            "HEAD 7921131f",
            "branch refs/heads/main",
            "locked",
        ];
        assert_eq!(
            field_value(&fields, "worktree").as_deref(),
            Some("/repos/demo")
        );
        assert_eq!(
            field_value(&fields, "branch").as_deref(),
            Some("refs/heads/main")
        );
        // Locked with no reason given: the flag is set, the reason is not.
        assert!(has_field(&fields, "locked"));
        assert_eq!(field_value(&fields, "locked"), None);
        // A key that is only a prefix of a field is not that field.
        assert_eq!(field_value(&fields, "bran"), None);
        assert!(!has_field(&fields, "prunable"));
    }

    /// The wrapper is the difference between an agent reading one sentence
    /// from both runtimes and reading two, so it is asserted literally.
    #[test]
    fn a_failure_reads_as_the_command_line_then_git_s_own_words() {
        assert_eq!(
            command_failed(
                &["worktree", "list", "--porcelain", "-z"],
                "fatal: not a git repository (or any of the parent directories): .git\n"
            ),
            "Command failed: git worktree list --porcelain -z\n\
             fatal: not a git repository (or any of the parent directories): .git\n"
        );
    }
}
