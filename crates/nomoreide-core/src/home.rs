//! Where the user's dotfiles live.
//!
//! One answer, because several surfaces read agent state out of `$HOME` and
//! two of them disagreeing would mean the servers page and the settings page
//! describing different machines. `dirs::home_dir` reads `$HOME` on Unix, which
//! is also what makes a fixture home work.

use std::path::PathBuf;

/// The home directory, or the working directory when there is none.
///
/// The fallback never happens in practice — a process with no `$HOME` and no
/// passwd entry — and `.` is the least surprising thing to do about it: a read
/// finds nothing, and a write lands somewhere visible rather than at the
/// filesystem root.
pub fn home_directory() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}
