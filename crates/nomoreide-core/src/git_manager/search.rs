//! Find a file by name, and find a string inside the files — the two searches
//! an editor puts behind Cmd+P and Cmd+Shift+F.
//!
//! Both walk [`super::GitManager::list_tracked_files`] rather than the
//! filesystem. That is the safety property, not an optimisation: `ls-files`
//! already answers with what the repository tracks, so `node_modules`, build
//! output, and anything `.gitignore` names are excluded by construction, and
//! neither search can enumerate a path the repository does not own.
//!
//! Every result is bounded. A one-character query against a large repository
//! matches nearly everything, so the caps below are what keep the answer a
//! response rather than a memory profile — and each cap reports itself through
//! `truncated`, so the UI can say "showing the first N" instead of quietly
//! lying about how much matched.

use super::types::{ContentMatch, ContentSearchResult, FileContentMatches, FileNameMatch};
use super::GitManager;
use anyhow::Result;
use regex::{Regex, RegexBuilder};
use std::path::Path;
use tokio::task::JoinSet;

/// Files past this are not searched. A file this large in a tracked repository
/// is a fixture or a bundle, and scanning it costs more than the hit is worth.
const MAX_FILE_BYTES: u64 = 2_000_000;

/// Matches kept per file. A generated file can match thousands of times; past
/// this the file itself is the finding, not the individual lines.
const MAX_MATCHES_PER_FILE: usize = 100;

/// How much of a matching line is returned. A minified bundle is one line, and
/// no viewer wants a megabyte of it to show a hit at column 900,000.
const MAX_LINE_CHARS: usize = 500;

/// How many files are read at once. Content search is dominated by small reads,
/// so a handful in flight hides the latency without flooding the file table.
const READ_CONCURRENCY: usize = 16;

/// What to look for and how, as an editor's find panel would put it.
#[derive(Debug, Clone)]
pub struct ContentSearchOptions {
    /// Treat `query` as a regular expression instead of literal text.
    pub regex: bool,
    /// Match case exactly. The find panel's `Aa` toggle.
    pub case_sensitive: bool,
    /// Require a word boundary either side. The find panel's whole-word toggle.
    pub whole_word: bool,
    /// A glob limiting which paths are searched — `src/**/*.rs`, `*.md`. Empty
    /// searches everything. The find panel's "files to include".
    pub include: String,
    /// Stop after this many matches in total.
    pub limit: usize,
}

impl Default for ContentSearchOptions {
    fn default() -> Self {
        Self {
            regex: false,
            case_sensitive: false,
            whole_word: false,
            include: String::new(),
            limit: 500,
        }
    }
}

impl GitManager {
    /// Rank tracked paths against a fuzzy query, best first.
    ///
    /// The match is a subsequence, the way an editor's file palette works:
    /// `gmr` finds `git_manager/rank.rs`. Scoring is [`score_path`]; ties break
    /// on the shorter path, then alphabetically, so the same query always
    /// answers in the same order.
    pub async fn search_files(cwd: &str, query: &str, limit: usize) -> Result<Vec<FileNameMatch>> {
        let paths = Self::list_tracked_files(cwd).await?;
        let needle = query.trim();

        // No query is not an error — it is the palette's opening state, which
        // lists the repository rather than nothing.
        if needle.is_empty() {
            let mut listed: Vec<String> = paths;
            listed.sort();
            return Ok(listed
                .into_iter()
                .take(limit)
                .map(|path| FileNameMatch {
                    path,
                    score: 0,
                    positions: Vec::new(),
                })
                .collect());
        }

        let mut matches: Vec<FileNameMatch> = paths
            .into_iter()
            .filter_map(|path| {
                score_path(&path, needle).map(|(score, positions)| FileNameMatch {
                    path,
                    score,
                    positions,
                })
            })
            .collect();

        matches.sort_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then(a.path.len().cmp(&b.path.len()))
                .then(a.path.cmp(&b.path))
        });
        matches.truncate(limit);
        Ok(matches)
    }

    /// Search the contents of every tracked file, grouped by file.
    ///
    /// Binary files are skipped by the same test the rest of this module uses —
    /// a NUL byte in the contents — so an image never arrives as mojibake.
    pub async fn search_content(
        cwd: &str,
        query: &str,
        options: &ContentSearchOptions,
    ) -> Result<ContentSearchResult> {
        let needle = query.trim();
        if needle.is_empty() {
            anyhow::bail!("query is required");
        }
        let pattern = build_pattern(needle, options)?;
        let include = compile_include(&options.include)?;

        let paths: Vec<String> = Self::list_tracked_files(cwd)
            .await?
            .into_iter()
            // `is_none_or` would read better but postdates the workspace MSRV.
            .filter(|path| include.as_ref().map_or(true, |glob| glob.is_match(path)))
            .collect();

        // Chunked rather than task-per-file: the work is one small read plus a
        // scan, and a task per file in a large repository costs more to
        // schedule than it saves.
        let chunk_size = paths.len().div_ceil(READ_CONCURRENCY).max(1);
        let mut workers = JoinSet::new();
        for chunk in paths.chunks(chunk_size) {
            let chunk: Vec<String> = chunk.to_vec();
            let root = cwd.to_string();
            let pattern = pattern.clone();
            workers.spawn(async move { scan_chunk(&root, &chunk, &pattern).await });
        }

        let mut files: Vec<FileContentMatches> = Vec::new();
        while let Some(finished) = workers.join_next().await {
            // A panicking worker loses its chunk, not the search. The count
            // reported below is of what was actually scanned either way.
            if let Ok(found) = finished {
                files.extend(found);
            }
        }

        // The workers finish in whatever order the scheduler returns them, so
        // the order is restored here rather than left to the run.
        files.sort_by(|a, b| a.path.cmp(&b.path));

        let total_matches: usize = files.iter().map(|file| file.matches.len()).sum();
        let mut kept = 0usize;
        let mut truncated = total_matches > options.limit;
        files.retain_mut(|file| {
            if kept >= options.limit {
                return false;
            }
            let room = options.limit - kept;
            if file.matches.len() > room {
                file.matches.truncate(room);
                truncated = true;
            }
            kept += file.matches.len();
            true
        });
        if files.iter().any(|file| file.truncated) {
            truncated = true;
        }

        Ok(ContentSearchResult {
            files,
            total_matches: kept,
            truncated,
        })
    }
}

/// Search one worker's slice of the repository.
async fn scan_chunk(cwd: &str, paths: &[String], pattern: &Regex) -> Vec<FileContentMatches> {
    let mut found = Vec::new();
    for path in paths {
        let full = Path::new(cwd).join(path);
        let Ok(meta) = tokio::fs::metadata(&full).await else {
            continue;
        };
        // A tracked path can be a submodule directory, and a stale index entry
        // can name a file that is no longer there. Neither is an error here.
        if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let Ok(bytes) = tokio::fs::read(&full).await else {
            continue;
        };
        if bytes.contains(&0) {
            continue; // binary
        }
        let Ok(text) = String::from_utf8(bytes) else {
            continue;
        };
        if let Some(file) = scan_text(path, &text, pattern) {
            found.push(file);
        }
    }
    found
}

/// Collect the matching lines of one file. Returns `None` when nothing matched,
/// so a file with no hits never reaches the result.
fn scan_text(path: &str, text: &str, pattern: &Regex) -> Option<FileContentMatches> {
    let mut matches: Vec<ContentMatch> = Vec::new();
    let mut truncated = false;

    for (index, line) in text.lines().enumerate() {
        for found in pattern.find_iter(line) {
            if matches.len() >= MAX_MATCHES_PER_FILE {
                truncated = true;
                break;
            }
            // Byte offsets from `regex` become character offsets, because the
            // consumer indexes the string it was given, not its UTF-8 bytes.
            let start = line[..found.start()].chars().count();
            let end = start + found.as_str().chars().count();
            matches.push(ContentMatch {
                line: index + 1,
                text: clip(line),
                start,
                end,
            });
        }
        if truncated {
            break;
        }
    }

    if matches.is_empty() {
        return None;
    }
    Some(FileContentMatches {
        path: path.to_string(),
        matches,
        truncated,
    })
}

/// Cut a line to [`MAX_LINE_CHARS`] on a character boundary.
fn clip(line: &str) -> String {
    if line.chars().count() <= MAX_LINE_CHARS {
        return line.to_string();
    }
    line.chars().take(MAX_LINE_CHARS).collect()
}

/// Turn the panel's toggles into one regular expression.
///
/// A malformed pattern is the user's own typing, not a fault — it surfaces as
/// the message `regex` produced so the panel can show what is wrong with it.
fn build_pattern(query: &str, options: &ContentSearchOptions) -> Result<Regex> {
    let base = if options.regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    let source = if options.whole_word {
        format!(r"\b(?:{base})\b")
    } else {
        base
    };
    RegexBuilder::new(&source)
        .case_insensitive(!options.case_sensitive)
        .build()
        .map_err(|error| anyhow::anyhow!("Invalid search pattern: {error}"))
}

/// Compile a "files to include" glob into a whole-path regular expression.
///
/// Supports the three forms an editor's include box actually receives: `*`
/// within a segment, `**` across segments, and `?` for one character. A bare
/// pattern with no separator (`*.rs`) is matched against any segment, because
/// that is what someone typing it means — not "only at the repository root".
fn compile_include(include: &str) -> Result<Option<Regex>> {
    let trimmed = include.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let mut source = String::from("^");
    if !trimmed.contains('/') {
        source.push_str("(?:.*/)?");
    }
    let mut chars = trimmed.chars().peekable();
    while let Some(character) = chars.next() {
        match character {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    // `**/` spans whole segments, including none of them.
                    if chars.peek() == Some(&'/') {
                        chars.next();
                    }
                    source.push_str("(?:.*/)?");
                } else {
                    source.push_str("[^/]*");
                }
            }
            '?' => source.push_str("[^/]"),
            other => source.push_str(&regex::escape(&other.to_string())),
        }
    }
    source.push('$');

    RegexBuilder::new(&source)
        .build()
        .map(Some)
        .map_err(|error| anyhow::anyhow!("Invalid include pattern: {error}"))
}

/// Score one path against a fuzzy query, or `None` when it does not match.
///
/// The ranking answers the question the palette is really being asked — "which
/// file did you mean" — so it rewards, in order: the query appearing whole in
/// the file name, appearing whole anywhere in the path, then a scattered
/// subsequence. Within a subsequence, adjacent characters and characters that
/// begin a word or a path segment score higher, which is what makes `gmr`
/// prefer `git_manager/rank.rs` over a path that merely contains those letters.
///
/// The returned positions are character offsets into `path`, for highlighting.
fn score_path(path: &str, query: &str) -> Option<(i32, Vec<usize>)> {
    let haystack: Vec<char> = path.chars().collect();
    let lowered: Vec<char> = path.to_lowercase().chars().collect();
    let needle: Vec<char> = query.to_lowercase().chars().collect();
    if needle.is_empty() || needle.len() > lowered.len() {
        return None;
    }

    // The file name starts after the last separator; a hit inside it counts for
    // more than a hit in a directory the user did not type.
    let name_start = path
        .rfind('/')
        .map_or(0, |index| path[..=index].chars().count());

    if let Some(start) = contiguous_at(&lowered, &needle, name_start) {
        let positions: Vec<usize> = (start..start + needle.len()).collect();
        let exact_name = start == name_start && start + needle.len() == lowered.len();
        return Some((if exact_name { 1000 } else { 800 }, positions));
    }
    if let Some(start) = contiguous_at(&lowered, &needle, 0) {
        let positions: Vec<usize> = (start..start + needle.len()).collect();
        return Some((600, positions));
    }

    // Subsequence. Greedy left-to-right is enough for ranking and is what keeps
    // this linear in the path length.
    let mut positions = Vec::with_capacity(needle.len());
    let mut score = 0i32;
    let mut cursor = 0usize;
    let mut previous: Option<usize> = None;
    for wanted in &needle {
        let found = lowered[cursor..].iter().position(|c| c == wanted)? + cursor;
        score += 10;
        if previous == Some(found.wrapping_sub(1)) {
            score += 15; // adjacent to the last match
        }
        if found >= name_start {
            score += 12; // inside the file name
        }
        if is_boundary(&haystack, found) {
            score += 20; // starts a segment or a word
        }
        positions.push(found);
        previous = Some(found);
        cursor = found + 1;
    }

    // A short path that spent little of itself on the match is the better
    // answer, so distance from the start is a small penalty.
    score -= (haystack.len() as i32) / 20;
    Some((score.max(1), positions))
}

/// Where `needle` appears whole in `haystack` at or after `from`.
fn contiguous_at(haystack: &[char], needle: &[char], from: usize) -> Option<usize> {
    if needle.len() > haystack.len() {
        return None;
    }
    (from..=haystack.len() - needle.len())
        .find(|&start| &haystack[start..start + needle.len()] == needle)
}

/// Does the character at `index` begin a path segment or a word?
fn is_boundary(haystack: &[char], index: usize) -> bool {
    if index == 0 {
        return true;
    }
    let previous = haystack[index - 1];
    if previous == '/' || previous == '_' || previous == '-' || previous == '.' {
        return true;
    }
    // camelCase: a capital after a lower-case letter starts a word.
    previous.is_lowercase() && haystack[index].is_uppercase()
}

#[cfg(test)]
mod tests {
    use super::super::exec;
    use super::*;
    use uuid::Uuid;

    fn options() -> ContentSearchOptions {
        ContentSearchOptions::default()
    }

    fn scan(text: &str, query: &str, options: &ContentSearchOptions) -> Vec<ContentMatch> {
        let pattern = build_pattern(query, options).unwrap();
        scan_text("file.txt", text, &pattern)
            .map(|file| file.matches)
            .unwrap_or_default()
    }

    #[test]
    fn ranks_a_file_name_hit_above_a_directory_hit() {
        let (name, _) = score_path("src/other/config.ts", "config").unwrap();
        let (directory, _) = score_path("src/config/other.ts", "config").unwrap();
        assert!(name > directory, "{name} should beat {directory}");
    }

    #[test]
    fn matches_initials_across_segments() {
        let (score, positions) = score_path("git_manager/rank.rs", "gmr").unwrap();
        assert!(score > 0);
        assert_eq!(positions.len(), 3);
    }

    #[test]
    fn rejects_a_path_missing_a_query_character() {
        assert!(score_path("src/index.ts", "zzz").is_none());
    }

    #[test]
    fn reports_positions_as_character_offsets() {
        // A multi-byte character before the hit would shift a byte offset.
        let matches = scan("héllo world", "world", &options());
        assert_eq!(matches[0].start, 6);
        assert_eq!(matches[0].end, 11);
    }

    #[test]
    fn is_case_insensitive_until_asked_otherwise() {
        assert_eq!(scan("Widget\nwidget", "widget", &options()).len(), 2);
        let sensitive = ContentSearchOptions {
            case_sensitive: true,
            ..options()
        };
        assert_eq!(scan("Widget\nwidget", "widget", &sensitive).len(), 1);
    }

    #[test]
    fn treats_the_query_as_literal_unless_regex_is_set() {
        assert!(scan("a.b\naxb", "a.b", &options()).len() == 1);
        let regex = ContentSearchOptions {
            regex: true,
            ..options()
        };
        assert_eq!(scan("a.b\naxb", "a.b", &regex).len(), 2);
    }

    #[test]
    fn whole_word_ignores_a_substring_hit() {
        let whole = ContentSearchOptions {
            whole_word: true,
            ..options()
        };
        let matches = scan("set\nsettings", "set", &whole);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].line, 1);
    }

    #[test]
    fn reports_one_based_line_numbers() {
        let matches = scan("first\nsecond\nneedle", "needle", &options());
        assert_eq!(matches[0].line, 3);
    }

    #[test]
    fn caps_the_matches_one_file_can_contribute() {
        let text = "needle\n".repeat(MAX_MATCHES_PER_FILE + 25);
        let pattern = build_pattern("needle", &options()).unwrap();
        let file = scan_text("busy.txt", &text, &pattern).unwrap();
        assert_eq!(file.matches.len(), MAX_MATCHES_PER_FILE);
        assert!(file.truncated);
    }

    #[test]
    fn clips_a_very_long_line() {
        let text = format!("{}needle", "x".repeat(MAX_LINE_CHARS));
        let matches = scan(&text, "needle", &options());
        assert_eq!(matches[0].text.chars().count(), MAX_LINE_CHARS);
    }

    #[test]
    fn surfaces_a_malformed_regex_rather_than_matching_nothing() {
        let regex = ContentSearchOptions {
            regex: true,
            ..options()
        };
        assert!(build_pattern("a(", &regex).is_err());
    }

    #[test]
    fn include_without_a_separator_matches_any_directory() {
        let glob = compile_include("*.rs").unwrap().unwrap();
        assert!(glob.is_match("main.rs"));
        assert!(glob.is_match("crates/core/src/main.rs"));
        assert!(!glob.is_match("main.ts"));
    }

    #[test]
    fn include_spans_segments_only_through_a_double_star() {
        let deep = compile_include("src/**/*.ts").unwrap().unwrap();
        assert!(deep.is_match("src/a/b/c.ts"));
        assert!(deep.is_match("src/c.ts"));

        let shallow = compile_include("src/*.ts").unwrap().unwrap();
        assert!(shallow.is_match("src/c.ts"));
        assert!(!shallow.is_match("src/a/c.ts"));
    }

    #[test]
    fn an_empty_include_filters_nothing() {
        assert!(compile_include("   ").unwrap().is_none());
    }

    /// A repository on disk with `files` written and staged. Staged rather than
    /// committed because `ls-files` reads the index, which is what both searches
    /// walk — and it keeps the fixture free of a commit identity.
    async fn repository(files: &[(&str, &str)]) -> String {
        let root = std::env::temp_dir().join(format!("nomoreide-git-search-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let cwd = root.to_string_lossy().into_owned();
        exec::checked(&cwd, &["init", "--quiet"]).await.unwrap();

        for (path, contents) in files {
            let full = root.join(path);
            if let Some(parent) = full.parent() {
                tokio::fs::create_dir_all(parent).await.unwrap();
            }
            tokio::fs::write(&full, contents).await.unwrap();
        }
        exec::checked(&cwd, &["add", "-A"]).await.unwrap();
        cwd
    }

    #[tokio::test]
    async fn searches_only_what_git_tracks() {
        let cwd = repository(&[
            ("src/widget.ts", "export const widget = 1;\n"),
            (".gitignore", "ignored/\n"),
            ("ignored/widget.ts", "export const widget = 2;\n"),
        ])
        .await;

        let by_name = GitManager::search_files(&cwd, "widget", 20).await.unwrap();
        assert_eq!(
            by_name.iter().map(|m| m.path.as_str()).collect::<Vec<_>>(),
            vec!["src/widget.ts"],
        );

        let by_content = GitManager::search_content(&cwd, "widget", &options())
            .await
            .unwrap();
        assert_eq!(
            by_content
                .files
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            vec!["src/widget.ts"],
        );

        tokio::fs::remove_dir_all(&cwd).await.ok();
    }

    #[tokio::test]
    async fn an_empty_file_query_lists_the_repository() {
        let cwd = repository(&[("b.txt", "b"), ("a.txt", "a")]).await;
        let listed = GitManager::search_files(&cwd, "  ", 20).await.unwrap();
        assert_eq!(
            listed.iter().map(|m| m.path.as_str()).collect::<Vec<_>>(),
            vec!["a.txt", "b.txt"],
        );
        tokio::fs::remove_dir_all(&cwd).await.ok();
    }

    #[tokio::test]
    async fn content_results_are_grouped_and_ordered_by_path() {
        let cwd = repository(&[
            ("z.txt", "needle\nnothing\nneedle\n"),
            ("a.txt", "needle\n"),
            ("none.txt", "nothing here\n"),
        ])
        .await;

        let found = GitManager::search_content(&cwd, "needle", &options())
            .await
            .unwrap();
        assert_eq!(
            found
                .files
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            vec!["a.txt", "z.txt"],
        );
        assert_eq!(found.files[1].matches.len(), 2);
        assert_eq!(found.total_matches, 3);
        assert!(!found.truncated);

        tokio::fs::remove_dir_all(&cwd).await.ok();
    }

    #[tokio::test]
    async fn the_limit_truncates_and_says_so() {
        let cwd = repository(&[("a.txt", "hit\nhit\nhit\n"), ("b.txt", "hit\n")]).await;
        let capped = ContentSearchOptions {
            limit: 2,
            ..options()
        };
        let found = GitManager::search_content(&cwd, "hit", &capped)
            .await
            .unwrap();
        assert_eq!(found.total_matches, 2);
        assert!(found.truncated);
        tokio::fs::remove_dir_all(&cwd).await.ok();
    }

    #[tokio::test]
    async fn an_include_glob_narrows_the_files_scanned() {
        let cwd = repository(&[("src/a.ts", "target"), ("docs/a.md", "target")]).await;
        let only_ts = ContentSearchOptions {
            include: "**/*.ts".into(),
            ..options()
        };
        let found = GitManager::search_content(&cwd, "target", &only_ts)
            .await
            .unwrap();
        assert_eq!(
            found
                .files
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            vec!["src/a.ts"],
        );
        tokio::fs::remove_dir_all(&cwd).await.ok();
    }

    #[tokio::test]
    async fn skips_a_binary_file() {
        let cwd = repository(&[("logo.bin", "before\u{0}needle after")]).await;
        let found = GitManager::search_content(&cwd, "needle", &options())
            .await
            .unwrap();
        assert!(found.files.is_empty());
        tokio::fs::remove_dir_all(&cwd).await.ok();
    }
}
