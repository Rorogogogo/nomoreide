//! Read-safe Git.
//!
//! Every operation here is confined to one working directory and never reaches
//! the network to *write* or rewrites history. `push`, `pull`, `merge`, and
//! `rebase` deliberately live in `nomoreide-actions`, a crate `nomoreide-mcp`
//! does not link — see that crate's docs for why the split is a crate boundary
//! rather than a naming convention.
//!
//! "Read-safe" here means no network write and no history integration; it does
//! include staging, committing, and branch bookkeeping, matching the split the
//! TypeScript `src/core/git-manager.ts` draws.
//!
//! The implementation is spread over sibling modules by responsibility. They
//! all add methods to the same [`GitManager`].

mod branches;
mod exec;
mod files;
mod graph_layout;
mod inspect;
mod search;
mod types;
mod worktrees;

pub use worktrees::worktree_at;

pub use search::ContentSearchOptions;

pub use graph_layout::{GitGraphEdge, GitGraphEdgeKind, GitGraphLayoutRow};

pub use types::{
    ContentMatch, ContentSearchResult, FileContentMatches, FileNameMatch, FileSizeRank, GitBranch,
    GitCommit, GitFileStatus, GitGraphCommit, GitGraphRef, GitGraphRefKind, GitLogEntry, GitStatus,
    GitWorktree, TrackedFileContent,
};

/// Read-safe Git operations. Every method takes the working directory it acts
/// on, so one process can serve any number of repositories.
pub struct GitManager;
