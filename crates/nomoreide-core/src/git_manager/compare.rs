//! Comparing a branch with the base it would be merged into.
//!
//! Used to fill in a pull-request template before the branch has been pushed,
//! which is why this is a *local* comparison: GitHub cannot compare a branch it
//! has never seen, and that is the common case at the moment someone opens the
//! "new pull request" screen.

use super::exec;
use super::types::{GitCompareCommit, GitCompareFile, GitCompareSummary};
use super::GitManager;
use anyhow::Result;

impl GitManager {
    /// What `HEAD` adds on top of `base_ref`.
    ///
    /// All four reads are issued together and the first failure is the answer,
    /// because the caller uses this as much to ask *"does this ref exist"* as
    /// to ask what changed — a base that is not there fails every one of them.
    ///
    /// Note the two different range spellings: the commit list is `base..HEAD`,
    /// everything on this branch and not on the base, while the file list is
    /// `base...HEAD`, the changes since the two diverged. A branch whose base
    /// has moved on would otherwise report the base's own new files as its own.
    pub async fn compare_with_base(cwd: &str, base_ref: &str) -> Result<GitCompareSummary> {
        let base = exec::require_name(base_ref, "base branch")?;
        let commits_range = format!("{base}..HEAD");
        let files_range = format!("{base}...HEAD");
        let count_args = ["rev-list", "--count", commits_range.as_str()];
        let log_args = [
            "log",
            "--reverse",
            "--pretty=format:%H%x09%s",
            commits_range.as_str(),
        ];
        let files_args = ["diff", "--name-status", "-z", files_range.as_str()];
        let (head_sha, count, log, files) = tokio::join!(
            exec::checked(cwd, &["rev-parse", "HEAD"]),
            exec::checked(cwd, &count_args),
            exec::checked(cwd, &log_args),
            exec::checked(cwd, &files_args),
        );

        Ok(GitCompareSummary {
            // A count git could not produce is zero, not a failure: the number
            // is decoration beside a list that is itself authoritative.
            ahead_by: count?.trim().parse::<i32>().unwrap_or(0),
            head_sha: head_sha?.trim().to_string(),
            commits: parse_log(&log?),
            files: parse_name_status(&files?),
        })
    }
}

/// One commit per line, sha and subject separated by a tab. A line without a
/// sha is dropped rather than reported as a commit with no identity.
fn parse_log(output: &str) -> Vec<GitCompareCommit> {
    output
        .split('\n')
        .filter(|line| !line.is_empty())
        .map(|line| {
            let (sha, message) = line.split_once('\t').unwrap_or((line, ""));
            GitCompareCommit {
                sha: sha.to_string(),
                message: message.to_string(),
            }
        })
        .filter(|commit| !commit.sha.is_empty())
        .collect()
}

/// `--name-status -z`: NUL-separated tokens, a status followed by its path.
///
/// A rename or a copy is three tokens, not two — status, old path, new path —
/// and it is the *new* path that is reported. Reading it as two would put the
/// old path in the list and then read the new path as the next status.
fn parse_name_status(output: &str) -> Vec<GitCompareFile> {
    let tokens: Vec<&str> = output
        .split('\0')
        .filter(|token| !token.is_empty())
        .collect();
    let mut files = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let status = tokens[index];
        let letter = status
            .chars()
            .next()
            .map(|first| first.to_ascii_uppercase().to_string())
            .unwrap_or_default();
        let (path, step) = if letter == "R" || letter == "C" {
            (tokens.get(index + 2), 3)
        } else {
            (tokens.get(index + 1), 2)
        };
        if let Some(path) = path.filter(|path| !path.is_empty()) {
            files.push(GitCompareFile {
                path: path.to_string(),
                // An empty status keeps whatever git wrote, which is what the
                // reference falls back to.
                status: if letter.is_empty() {
                    status.to_string()
                } else {
                    letter
                },
            });
        }
        index += step;
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rename_reports_its_new_path() {
        let files = parse_name_status("R100\0src/old.ts\0src/new.ts\0M\0src/app.ts\0");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "src/new.ts");
        assert_eq!(files[0].status, "R");
        assert_eq!(files[1].path, "src/app.ts");
        assert_eq!(files[1].status, "M");
    }

    #[test]
    fn a_log_line_without_a_sha_is_dropped() {
        let commits = parse_log("abc\tFirst\n\n\tNo sha\ndef\tSecond");
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].message, "First");
        assert_eq!(commits[1].sha, "def");
    }

    /// A subject containing a tab keeps everything after the first one.
    #[test]
    fn only_the_first_tab_separates() {
        let commits = parse_log("abc\tSubject\twith a tab");
        assert_eq!(commits[0].message, "Subject\twith a tab");
    }
}
