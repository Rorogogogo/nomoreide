//! Serialized shapes returned by [`super::GitManager`]. `camelCase` because
//! they cross to the dashboard and to MCP clients unchanged.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    pub index: String,
    pub working_tree: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: String,
    /// Absent, not null, when the branch tracks nothing — the reference omits
    /// the key, and a reader that tests for it has to see the same thing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    pub ahead: i32,
    pub behind: i32,
    pub files: Vec<GitFileStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub refs: Vec<String>,
    pub parents: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
    pub remote: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
}

/// One line of history: what `nomoreide_git_log` reports per commit.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogEntry {
    pub hash: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSizeRank {
    pub path: String,
    /// Line count; a lower bound (`truncated: true`) for files past the read cap.
    pub lines: usize,
    pub bytes: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree {
    pub path: String,
    pub head: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
    pub locked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked_reason: Option<String>,
    pub prunable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prunable_reason: Option<String>,
    /// Epoch milliseconds, fractional: the reference reports the filesystem's
    /// birth time unrounded, and a filesystem that has none reports nothing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<f64>,
    pub primary: bool,
    pub dirty: bool,
}

/// One tracked path matched by the file palette. `positions` are character
/// offsets into `path`, so the caller can highlight what the query matched.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNameMatch {
    pub path: String,
    pub score: i32,
    pub positions: Vec<usize>,
}

/// One hit inside a file: the line it fell on, that line's text, and where in
/// the text it sits. `start`/`end` are character offsets, matching `text`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentMatch {
    /// One-based, the way an editor's gutter counts.
    pub line: usize,
    pub text: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContentMatches {
    pub path: String,
    pub matches: Vec<ContentMatch>,
    /// The file had more hits than one file is allowed to contribute.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchResult {
    pub files: Vec<FileContentMatches>,
    /// Matches actually returned — not how many exist, which a truncated search
    /// never finishes counting.
    pub total_matches: usize,
    pub truncated: bool,
}
