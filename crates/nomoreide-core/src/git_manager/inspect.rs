//! Reading the repository: working-tree status, diffs, history, branches.

use super::exec;
use super::types::{GitBranch, GitCommit, GitFileStatus, GitLogEntry, GitStatus};
use super::GitManager;
use anyhow::{anyhow, Context, Result};

const LOCAL_PREFIX: &str = "refs/heads/";
const REMOTE_PREFIX: &str = "refs/remotes/";

/// What [`GitManager::tracking_status`] answers. Zeros stand for "no upstream",
/// which is why it is not a `Result`.
#[derive(Default)]
struct TrackingStatus {
    upstream: Option<String>,
    ahead: i32,
    behind: i32,
}

/// One porcelain line. The two status letters are read by position, and a line
/// too short to hold them reads as spaces rather than panicking — git does not
/// emit such a line, but a read tool that can be crashed by one is worse than
/// one that shrugs.
///
/// Porcelain quotes a path that needs it and reports a rename as "old -> new".
/// Neither is unpicked, because the reference hands both through as written.
fn status_file(line: &str) -> GitFileStatus {
    let letter = |column: usize| line.chars().nth(column).unwrap_or(' ').to_string();
    GitFileStatus {
        index: letter(0),
        working_tree: letter(1),
        path: line.chars().skip(3).collect(),
    }
}

/// One line of `branch --all --format=%(refname)%09%(HEAD)%09%(upstream:short)`.
fn branch_entry(line: &str) -> GitBranch {
    let mut columns = line.split('\t');
    let ref_name = columns.next().unwrap_or_default();
    let head = columns.next().unwrap_or_default();
    let upstream = columns.next().unwrap_or_default();
    let remote = ref_name.starts_with(REMOTE_PREFIX);
    let prefix = if remote { REMOTE_PREFIX } else { LOCAL_PREFIX };
    GitBranch {
        name: ref_name
            .strip_prefix(prefix)
            .unwrap_or(ref_name)
            .to_string(),
        current: head == "*",
        remote,
        upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
    }
}

/// One line of `log --pretty=format:%H%x09%s`. A subject containing a tab is
/// cut at it, which is what splitting on tabs means in the reference too.
fn log_entry(line: &str) -> GitLogEntry {
    let mut columns = line.split('\t');
    GitLogEntry {
        hash: columns.next().unwrap_or_default().to_string(),
        subject: columns.next().unwrap_or_default().to_string(),
    }
}

impl GitManager {
    pub async fn status(cwd: &str) -> Result<GitStatus> {
        // `--show-current` rather than `rev-parse --abbrev-ref HEAD`: a
        // detached HEAD is on no branch, and the reference says so with an
        // empty name instead of naming a branch called "HEAD".
        let branch = exec::checked(cwd, &["branch", "--show-current"]).await?;
        let porcelain =
            exec::checked(cwd, &["status", "--porcelain=v1", "--untracked-files=all"]).await?;
        let tracking = Self::tracking_status(cwd).await;

        Ok(GitStatus {
            branch: branch.trim().to_string(),
            upstream: tracking.upstream,
            ahead: tracking.ahead,
            behind: tracking.behind,
            files: porcelain
                .lines()
                .filter(|line| !line.is_empty())
                .map(status_file)
                .collect(),
        })
    }

    /// How far the current branch is ahead of and behind its upstream. A branch
    /// that tracks nothing, or a repository with no commits, answers zeros
    /// rather than failing — the question is optional, unlike the two reads
    /// above it.
    async fn tracking_status(cwd: &str) -> TrackingStatus {
        let upstream = exec::checked(
            cwd,
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ],
        )
        .await
        .unwrap_or_default()
        .trim()
        .to_string();
        if upstream.is_empty() {
            return TrackingStatus::default();
        }

        // `<upstream>...HEAD` with --left-right counts: left = behind, right = ahead.
        let counts = exec::checked(
            cwd,
            &[
                "rev-list",
                "--left-right",
                "--count",
                &format!("{upstream}...HEAD"),
            ],
        )
        .await
        .unwrap_or_default();
        let mut columns = counts.split_whitespace();
        let behind = columns.next().and_then(|value| value.parse().ok());
        let ahead = columns.next().and_then(|value| value.parse().ok());
        TrackingStatus {
            upstream: Some(upstream),
            ahead: ahead.unwrap_or(0),
            behind: behind.unwrap_or(0),
        }
    }

    pub async fn diff(cwd: &str, file: Option<&str>) -> Result<String> {
        match file {
            Some(file) => exec::checked(cwd, &["diff", "--", file]).await,
            None => exec::checked(cwd, &["diff"]).await,
        }
    }

    pub async fn staged_diff(cwd: &str, file: Option<&str>) -> Result<String> {
        match file {
            Some(file) => exec::checked(cwd, &["diff", "--cached", "--", file]).await,
            None => exec::checked(cwd, &["diff", "--cached"]).await,
        }
    }

    /// The newest `limit` commits, hash and subject only.
    pub async fn log(cwd: &str, limit: u32) -> Result<Vec<GitLogEntry>> {
        let raw = exec::checked(
            cwd,
            &["log", &format!("-{limit}"), "--pretty=format:%H%x09%s"],
        )
        .await?;
        Ok(raw
            .lines()
            .filter(|line| !line.is_empty())
            .map(log_entry)
            .collect())
    }

    /// The diff to show for one file, chosen by its status pair rather than by
    /// probing: an untracked file has no blob to diff against and gets a
    /// synthesized one, an unstaged change outranks a staged one (the working
    /// tree is what the user is looking at), and a staged-only change falls
    /// back to `--cached`.
    ///
    /// The status pair is what makes this correct. Probing "staged first, else
    /// unstaged" — which is what this used to do — shows the *staged* diff for
    /// a file that has both, hiding the edit the user just made.
    pub async fn file_diff_for_status(cwd: &str, file: &GitFileStatus) -> Result<String> {
        if file.index == "?" && file.working_tree == "?" {
            return Self::untracked_diff(cwd, &file.path).await;
        }
        if !file.working_tree.trim().is_empty() {
            return Self::diff(cwd, Some(&file.path)).await;
        }
        if !file.index.trim().is_empty() {
            return Self::staged_diff(cwd, Some(&file.path)).await;
        }
        Self::diff(cwd, Some(&file.path)).await
    }

    /// A unified diff for a file git has never seen, synthesized against
    /// `/dev/null` — `git diff` reports nothing for an untracked path, so
    /// without this the UI shows an empty panel for a brand-new file.
    async fn untracked_diff(cwd: &str, path: &str) -> Result<String> {
        let full = std::path::Path::new(cwd).join(path);
        let content = tokio::fs::read_to_string(&full)
            .await
            .with_context(|| format!("Failed to read untracked file {path}"))?;

        let lines: Vec<&str> = content.split('\n').collect();
        let has_trailing_newline = lines.last() == Some(&"");
        let content_lines = if has_trailing_newline {
            &lines[..lines.len() - 1]
        } else {
            &lines[..]
        };
        // An empty file still reports one line of hunk length, matching the
        // reference's `Math.max(contentLines.length, 1)`.
        let hunk_length = content_lines.len().max(1);

        let mut out = vec![
            format!("diff --git a/{path} b/{path}"),
            "new file mode 100644".to_string(),
            "index 0000000..0000000".to_string(),
            "--- /dev/null".to_string(),
            format!("+++ b/{path}"),
            format!("@@ -0,0 +1,{hunk_length} @@"),
        ];
        out.extend(content_lines.iter().map(|line| format!("+{line}")));
        if !has_trailing_newline {
            out.push("\\ No newline at end of file".to_string());
        }
        Ok(format!("{}\n", out.join("\n")))
    }

    pub async fn graph(cwd: &str, limit: usize) -> Result<Vec<GitCommit>> {
        let fmt = "%H\x1f%h\x1f%s\x1f%an\x1f%ae\x1f%aI\x1f%D\x1f%P";
        let limit_str = limit.to_string();
        let raw = exec::output(
            cwd,
            &["log", &format!("-{limit_str}"), &format!("--format={fmt}")],
        )
        .await?;

        let commits = raw
            .lines()
            .filter(|l| !l.is_empty())
            .map(|line| {
                let parts: Vec<&str> = line.split('\x1f').collect();
                GitCommit {
                    hash: parts.first().copied().unwrap_or("").to_string(),
                    short_hash: parts.get(1).copied().unwrap_or("").to_string(),
                    subject: parts.get(2).copied().unwrap_or("").to_string(),
                    author: parts.get(3).copied().unwrap_or("").to_string(),
                    email: parts.get(4).copied().unwrap_or("").to_string(),
                    date: parts.get(5).copied().unwrap_or("").to_string(),
                    refs: parts
                        .get(6)
                        .copied()
                        .unwrap_or("")
                        .split(", ")
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .collect(),
                    parents: parts
                        .get(7)
                        .copied()
                        .unwrap_or("")
                        .split_whitespace()
                        .map(str::to_string)
                        .collect(),
                }
            })
            .collect();

        Ok(commits)
    }

    pub async fn commit_diff(cwd: &str, hash: &str, file: Option<&str>) -> Result<String> {
        let hash = validate_hash(hash)?;
        // `--format=` suppresses the commit message header — without it `git
        // show` prints "commit <hash>\nAuthor: ...\nDate: ...\n\n  <subject>"
        // ahead of the patch, and a caller wanting only the diff gets both.
        // `git show` (rather than `diff <sha>^..<sha>`) is what handles a root
        // commit gracefully, since it has no parent to diff against.
        let mut args = vec!["show", "--patch", "--format=", &hash];
        if let Some(f) = file {
            args.push("--");
            args.push(f);
        }
        exec::output(cwd, &args).await
    }

    pub async fn commit_files(cwd: &str, hash: &str) -> Result<Vec<GitFileStatus>> {
        let hash = validate_hash(hash)?;
        // NUL-separated name-status, matching the Node GitManager. The UI needs
        // the change letter (A/M/D/R/C) per file, not just paths — without it
        // `file.index` is undefined client-side and the commit file list crashes.
        let raw = exec::output(cwd, &["show", "--name-status", "--format=", "-z", &hash]).await?;
        let tokens: Vec<&str> = raw.split('\0').filter(|t| !t.is_empty()).collect();

        let mut files = Vec::new();
        let mut i = 0;
        while i < tokens.len() {
            let letter = tokens[i].chars().next().unwrap_or(' ').to_ascii_uppercase();
            if letter == 'R' || letter == 'C' {
                // rename/copy: STATUS \0 OLD \0 NEW
                if let Some(new_path) = tokens.get(i + 2) {
                    files.push(GitFileStatus {
                        path: new_path.to_string(),
                        index: letter.to_string(),
                        working_tree: " ".to_string(),
                    });
                }
                i += 3;
            } else {
                // regular: STATUS \0 PATH
                if let Some(path) = tokens.get(i + 1) {
                    files.push(GitFileStatus {
                        path: path.to_string(),
                        index: letter.to_string(),
                        working_tree: " ".to_string(),
                    });
                }
                i += 2;
            }
        }
        Ok(files)
    }

    pub async fn branches(cwd: &str) -> Result<Vec<GitBranch>> {
        // One `--all` read rather than a local and a remote one: it is what
        // marks the current branch and names each upstream, and it keeps the
        // order the reference reports.
        let raw = exec::checked(
            cwd,
            &[
                "branch",
                "--all",
                "--format=%(refname)%09%(HEAD)%09%(upstream:short)",
            ],
        )
        .await?;
        Ok(raw
            .lines()
            .filter(|line| !line.is_empty())
            .map(branch_entry)
            // `origin/HEAD` is a pointer at another branch in this list, not a
            // branch of its own, so it would only be a duplicate to switch to.
            .filter(|branch| !branch.name.is_empty() && !branch.name.ends_with("/HEAD"))
            .collect())
    }

    /// The working tree's top level. Unlike the remote read below this one
    /// propagates git's complaint, so a directory that is not a repository is
    /// named as that rather than as a repository missing a remote.
    pub async fn root(cwd: &str) -> Result<String> {
        Ok(exec::checked(cwd, &["rev-parse", "--show-toplevel"])
            .await?
            .trim()
            .to_string())
    }

    pub async fn remote_url(cwd: &str, remote: &str) -> Result<Option<String>> {
        let url = exec::checked(cwd, &["remote", "get-url", remote])
            .await
            .unwrap_or_default();
        let trimmed = url.trim();
        Ok(if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_porcelain_line_is_read_by_position() {
        let modified = status_file(" M src/main.rs");
        assert_eq!(modified.index, " ");
        assert_eq!(modified.working_tree, "M");
        assert_eq!(modified.path, "src/main.rs");

        // A rename and a quoted path both reach the caller as git wrote them.
        assert_eq!(
            status_file("R  old.txt -> new.txt").path,
            "old.txt -> new.txt"
        );
        assert_eq!(
            status_file("?? \"with space.txt\"").path,
            "\"with space.txt\""
        );
    }

    #[test]
    fn a_line_too_short_to_hold_the_letters_reads_as_spaces() {
        // git emits no such line; a read tool that panicked on one would take
        // the whole MCP server down with it.
        for line in ["", "M", " M", "?? "] {
            let file = status_file(line);
            assert!(file.path.is_empty(), "{line:?} -> {file:?}");
            assert_eq!(file.index.chars().count(), 1);
            assert_eq!(file.working_tree.chars().count(), 1);
        }
        assert_eq!(status_file("").index, " ");
        assert_eq!(status_file("M").working_tree, " ");
    }

    #[test]
    fn a_branch_line_names_the_branch_without_its_ref_prefix() {
        let current = branch_entry("refs/heads/main\t*\torigin/main");
        assert_eq!(current.name, "main");
        assert!(current.current);
        assert!(!current.remote);
        assert_eq!(current.upstream.as_deref(), Some("origin/main"));

        // No upstream column at all, which is what an untracked branch reports.
        let plain = branch_entry("refs/heads/feature/x\t\t");
        assert_eq!(plain.name, "feature/x");
        assert!(!plain.current);
        assert_eq!(plain.upstream, None);

        let remote = branch_entry("refs/remotes/origin/main\t\t");
        assert_eq!(remote.name, "origin/main");
        assert!(remote.remote);
    }

    #[test]
    fn a_log_line_splits_the_hash_from_the_subject() {
        let entry = log_entry("c4c2c82787efc2a6909ae760fc6ff49bb8ce300d\tfix: name the service");
        assert_eq!(entry.hash, "c4c2c82787efc2a6909ae760fc6ff49bb8ce300d");
        assert_eq!(entry.subject, "fix: name the service");
        // An empty subject is still two columns, not one.
        assert_eq!(log_entry("abc\t").subject, "");
    }

    /// The shapes cross to MCP clients and to the desktop app unchanged, so
    /// what is absent has to stay absent rather than becoming an explicit null.
    #[test]
    fn an_absent_upstream_is_an_absent_key() {
        let status = GitStatus {
            branch: "main".into(),
            upstream: None,
            ahead: 0,
            behind: 0,
            files: vec![status_file(" M keep.txt")],
        };
        let rendered = serde_json::to_string(&status).unwrap();
        assert_eq!(
            rendered,
            "{\"branch\":\"main\",\"ahead\":0,\"behind\":0,\
             \"files\":[{\"path\":\"keep.txt\",\"index\":\" \",\"workingTree\":\"M\"}]}"
        );
        assert_eq!(
            serde_json::to_string(&branch_entry("refs/heads/feature/x\t\t")).unwrap(),
            "{\"name\":\"feature/x\",\"current\":false,\"remote\":false}"
        );
    }
}

/// A commit hash reaches `git show` as a raw argv entry, so anything starting
/// with `-` would otherwise be read as a flag rather than a ref — this is
/// what stands between an HTTP query parameter and argument injection. The
/// pattern matches the reference's `validateHash` exactly: 4 to 64 hex
/// characters, which accepts an abbreviated hash as well as a full one.
fn validate_hash(hash: &str) -> Result<String> {
    let trimmed = hash.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("commit is required"));
    }
    let valid =
        trimmed.len() >= 4 && trimmed.len() <= 64 && trimmed.chars().all(|c| c.is_ascii_hexdigit());
    if !valid {
        return Err(anyhow!("invalid commit hash"));
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod validate_hash_tests {
    use super::*;

    #[test]
    fn accepts_hex_hashes_within_length_bounds() {
        assert_eq!(validate_hash("abcd").unwrap(), "abcd");
        assert_eq!(
            validate_hash("a".repeat(64).as_str()).unwrap(),
            "a".repeat(64)
        );
        assert_eq!(validate_hash("ABCD1234").unwrap(), "ABCD1234");
    }

    #[test]
    fn trims_surrounding_whitespace() {
        assert_eq!(validate_hash("  abcd  ").unwrap(), "abcd");
    }

    #[test]
    fn refuses_anything_shorter_than_four_hex_characters() {
        assert!(validate_hash("abc").is_err());
        assert!(validate_hash("").is_err());
        assert!(validate_hash("   ").is_err());
    }

    #[test]
    fn refuses_more_than_sixty_four_characters() {
        assert!(validate_hash("a".repeat(65).as_str()).is_err());
    }

    #[test]
    fn refuses_non_hex_characters() {
        assert!(validate_hash("xyz1").is_err());
        assert!(validate_hash("main").is_err());
    }

    /// The exact hazard: an argument-injection attempt must be refused before
    /// it ever reaches argv, not merely fail to look like a real ref.
    #[test]
    fn refuses_a_flag_shaped_value() {
        assert!(validate_hash("--upload-pack=evil").is_err());
        assert!(validate_hash("-h").is_err());
    }
}

#[cfg(test)]
mod file_diff_tests {
    use super::*;
    use uuid::Uuid;

    async fn repository() -> String {
        let root = std::env::temp_dir().join(format!("nomoreide-git-diff-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let cwd = root.to_string_lossy().into_owned();
        exec::checked(&cwd, &["init", "--quiet"]).await.unwrap();
        exec::checked(&cwd, &["config", "user.email", "t@example.com"])
            .await
            .unwrap();
        exec::checked(&cwd, &["config", "user.name", "T"])
            .await
            .unwrap();
        cwd
    }

    fn status_of(path: &str, index: &str, working_tree: &str) -> GitFileStatus {
        GitFileStatus {
            path: path.to_string(),
            index: index.to_string(),
            working_tree: working_tree.to_string(),
        }
    }

    /// A file with *both* a staged and an unstaged change must show the
    /// unstaged one — the working tree is what the user is looking at. The
    /// previous implementation probed staged-first and got this backwards.
    #[tokio::test]
    async fn an_unstaged_change_outranks_a_staged_one() {
        let cwd = repository().await;
        let path = std::path::Path::new(&cwd).join("a.txt");
        tokio::fs::write(&path, "original\n").await.unwrap();
        exec::checked(&cwd, &["add", "-A"]).await.unwrap();
        exec::checked(&cwd, &["commit", "--quiet", "-m", "first"])
            .await
            .unwrap();

        tokio::fs::write(&path, "staged\n").await.unwrap();
        exec::checked(&cwd, &["add", "-A"]).await.unwrap();
        tokio::fs::write(&path, "unstaged\n").await.unwrap();

        let diff = GitManager::file_diff_for_status(&cwd, &status_of("a.txt", "M", "M"))
            .await
            .unwrap();
        assert!(
            diff.contains("+unstaged"),
            "expected the working-tree diff, got:\n{diff}"
        );
        assert!(!diff.contains("+staged"));
        tokio::fs::remove_dir_all(&cwd).await.ok();
    }

    #[tokio::test]
    async fn a_staged_only_change_uses_the_cached_diff() {
        let cwd = repository().await;
        let path = std::path::Path::new(&cwd).join("a.txt");
        tokio::fs::write(&path, "original\n").await.unwrap();
        exec::checked(&cwd, &["add", "-A"]).await.unwrap();
        exec::checked(&cwd, &["commit", "--quiet", "-m", "first"])
            .await
            .unwrap();

        tokio::fs::write(&path, "staged\n").await.unwrap();
        exec::checked(&cwd, &["add", "-A"]).await.unwrap();

        let diff = GitManager::file_diff_for_status(&cwd, &status_of("a.txt", "M", " "))
            .await
            .unwrap();
        assert!(
            diff.contains("+staged"),
            "expected the staged diff, got:\n{diff}"
        );
        tokio::fs::remove_dir_all(&cwd).await.ok();
    }

    /// `git diff` reports nothing for an untracked path, so the diff is
    /// synthesized against /dev/null instead of coming back empty.
    #[tokio::test]
    async fn an_untracked_file_gets_a_synthesized_diff() {
        let cwd = repository().await;
        tokio::fs::write(
            std::path::Path::new(&cwd).join("new.txt"),
            "line one\nline two\n",
        )
        .await
        .unwrap();

        let diff = GitManager::file_diff_for_status(&cwd, &status_of("new.txt", "?", "?"))
            .await
            .unwrap();
        assert_eq!(
            diff,
            "diff --git a/new.txt b/new.txt\n\
             new file mode 100644\n\
             index 0000000..0000000\n\
             --- /dev/null\n\
             +++ b/new.txt\n\
             @@ -0,0 +1,2 @@\n\
             +line one\n\
             +line two\n"
        );
        tokio::fs::remove_dir_all(&cwd).await.ok();
    }

    #[tokio::test]
    async fn an_untracked_file_without_a_trailing_newline_is_marked() {
        let cwd = repository().await;
        tokio::fs::write(std::path::Path::new(&cwd).join("new.txt"), "no newline")
            .await
            .unwrap();

        let diff = GitManager::file_diff_for_status(&cwd, &status_of("new.txt", "?", "?"))
            .await
            .unwrap();
        assert!(diff.contains("@@ -0,0 +1,1 @@"));
        assert!(
            diff.ends_with("+no newline\n\\ No newline at end of file\n"),
            "got:\n{diff}"
        );
        tokio::fs::remove_dir_all(&cwd).await.ok();
    }

    /// An empty untracked file still reports a hunk length of 1, matching the
    /// reference's `Math.max(contentLines.length, 1)`.
    #[tokio::test]
    async fn an_empty_untracked_file_still_reports_one_hunk_line() {
        let cwd = repository().await;
        tokio::fs::write(std::path::Path::new(&cwd).join("empty.txt"), "")
            .await
            .unwrap();

        let diff = GitManager::file_diff_for_status(&cwd, &status_of("empty.txt", "?", "?"))
            .await
            .unwrap();
        assert!(diff.contains("@@ -0,0 +1,1 @@"), "got:\n{diff}");
        tokio::fs::remove_dir_all(&cwd).await.ok();
    }
}
