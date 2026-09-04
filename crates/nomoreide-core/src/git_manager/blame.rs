//! Who last touched each line, for the file viewer's gutter.
//!
//! Read-safe by construction: `git blame` reads history and writes nothing, so
//! it belongs here rather than in `nomoreide-actions`.
//!
//! The porcelain format is parsed rather than a `--pretty` line format, and
//! that is not fussiness. A commit summary can contain anything a person typed
//! — tabs, quotes, a delimiter you picked — and every custom format eventually
//! meets a commit that breaks it. Porcelain is the one output git documents as
//! machine-readable, and it is length-prefixed by structure rather than by
//! separator.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::exec;
use super::GitManager;

/// One line's provenance, as the gutter shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBlameLine {
    /// One-based, the way an editor's gutter counts.
    pub line: u32,
    /// The full hash. Abbreviating is the caller's decision, not the store's.
    pub commit: String,
    pub author: String,
    /// Seconds since the epoch, UTC. Rendering a date is a locale question and
    /// belongs where the locale is known.
    pub author_time: i64,
    pub summary: String,
    /// Whether this line is not yet committed.
    ///
    /// Git spells it as an all-zero hash, which would otherwise render as a
    /// real-looking commit that resolves to nothing.
    pub uncommitted: bool,
}

const UNCOMMITTED: &str = "0000000000000000000000000000000000000000";

impl GitManager {
    /// Blame one file at the working tree.
    ///
    /// `--` before the path so a file named like a revision is still a file.
    /// `-w` ignores whitespace-only changes, because a reformatting commit
    /// claiming authorship of a whole file is the single most common way blame
    /// stops being useful.
    pub async fn blame(cwd: &str, path: &str) -> Result<Vec<GitBlameLine>> {
        let raw = exec::checked(cwd, &["blame", "--porcelain", "-w", "--", path]).await?;
        Ok(parse_porcelain(&raw))
    }
}

/// Parse `git blame --porcelain`.
///
/// The format repeats a header line — `<sha> <orig-line> <final-line> [count]`
/// — then key/value lines, then the source line prefixed with a tab. Commit
/// metadata appears **once per commit**, on its first appearance, and later
/// lines from the same commit carry the header alone. So the details are
/// remembered per sha; a parser that reads them only from the current block
/// leaves every repeated commit blank, which looks like blame losing authors
/// halfway down a file.
fn parse_porcelain(raw: &str) -> Vec<GitBlameLine> {
    #[derive(Default, Clone)]
    struct Details {
        author: String,
        author_time: i64,
        summary: String,
    }

    let mut known: HashMap<String, Details> = HashMap::new();
    let mut lines = Vec::new();
    let mut commit: Option<String> = None;
    let mut final_line: u32 = 0;
    let mut pending = Details::default();

    for entry in raw.lines() {
        if let Some(rest) = entry.strip_prefix('\t') {
            // The source line closes the block: everything gathered above
            // describes exactly this one.
            let _ = rest;
            let Some(sha) = commit.take() else {
                continue;
            };
            let details = if pending.author.is_empty() && pending.summary.is_empty() {
                known.get(&sha).cloned().unwrap_or_default()
            } else {
                known.insert(sha.clone(), pending.clone());
                pending.clone()
            };
            lines.push(GitBlameLine {
                line: final_line,
                uncommitted: sha == UNCOMMITTED,
                commit: sha,
                author: details.author,
                author_time: details.author_time,
                summary: details.summary,
            });
            pending = Details::default();
            continue;
        }

        if let Some(value) = entry.strip_prefix("author ") {
            pending.author = value.to_string();
        } else if let Some(value) = entry.strip_prefix("author-time ") {
            pending.author_time = value.trim().parse().unwrap_or(0);
        } else if let Some(value) = entry.strip_prefix("summary ") {
            pending.summary = value.to_string();
        } else if !entry.starts_with(|character: char| character.is_whitespace()) {
            // A header: `<sha> <orig> <final> [count]`. Anything else beginning
            // in column zero — `filename`, `previous`, `boundary` — is metadata
            // this gutter does not show, and falls through untouched.
            let mut parts = entry.split(' ');
            let Some(sha) = parts.next() else { continue };
            if sha.len() != 40 || !sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                continue;
            }
            let _orig = parts.next();
            final_line = parts
                .next()
                .and_then(|value| value.parse().ok())
                .unwrap_or(0);
            commit = Some(sha.to_string());
        }
    }

    lines
}

#[cfg(test)]
mod tests {
    use super::parse_porcelain;

    /// Metadata appears once per commit; later lines carry the header alone.
    /// A parser that forgets is one that blanks every repeated author.
    #[test]
    fn remembers_commit_details_across_repeated_shas() {
        let raw = concat!(
            "1111111111111111111111111111111111111111 1 1 2\n",
            "author Ada Lovelace\n",
            "author-time 1700000000\n",
            "summary Add the parser\n",
            "filename src/lib.rs\n",
            "\tfirst line\n",
            "1111111111111111111111111111111111111111 2 2\n",
            "\tsecond line\n",
        );

        let blamed = parse_porcelain(raw);

        assert_eq!(blamed.len(), 2);
        assert_eq!(blamed[1].line, 2);
        assert_eq!(blamed[1].author, "Ada Lovelace");
        assert_eq!(blamed[1].summary, "Add the parser");
        assert_eq!(blamed[1].author_time, 1_700_000_000);
    }

    /// A summary is whatever somebody typed, tabs and all. Only the leading tab
    /// marks a source line, so a summary containing one must not end the block.
    #[test]
    fn a_summary_is_not_mistaken_for_a_source_line() {
        let raw = concat!(
            "2222222222222222222222222222222222222222 1 1 1\n",
            "author Grace Hopper\n",
            "author-time 1700000001\n",
            "summary fix: align\tthe columns\n",
            "\tcode here\n",
        );

        let blamed = parse_porcelain(raw);

        assert_eq!(blamed.len(), 1);
        assert_eq!(blamed[0].summary, "fix: align\tthe columns");
    }

    /// Not-yet-committed lines come back as an all-zero sha, which would
    /// otherwise render as a real commit that resolves to nothing.
    #[test]
    fn marks_uncommitted_lines() {
        let raw = concat!(
            "0000000000000000000000000000000000000000 1 1 1\n",
            "author Not Committed Yet\n",
            "author-time 1700000002\n",
            "summary Version of foo.rs from foo.rs\n",
            "\tdraft\n",
        );

        let blamed = parse_porcelain(raw);

        assert!(blamed[0].uncommitted);
    }

    /// A file git has never seen produces nothing, not a panic.
    #[test]
    fn empty_output_is_empty_blame() {
        assert!(parse_porcelain("").is_empty());
    }

    /// Line numbers come from the *final* column, so a file whose lines moved
    /// still lands each entry on the row the reader is looking at.
    #[test]
    fn uses_the_final_line_number() {
        let raw = concat!(
            "3333333333333333333333333333333333333333 7 42 1\n",
            "author Alan Turing\n",
            "author-time 1700000003\n",
            "summary Move it\n",
            "\tmoved line\n",
        );

        assert_eq!(parse_porcelain(raw)[0].line, 42);
    }
}
