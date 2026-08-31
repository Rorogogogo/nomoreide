//! Listing a directory for the in-app pickers.
//!
//! Folders only by default — the service `cwd` and repository pickers want
//! nothing else — with files included on request for the agent dock, which
//! attaches individual files.
//!
//! Two names are skipped and no others: `.git` and `node_modules`. Every other
//! dotfile directory is listed like any other, and *inside* a skipped name
//! everything is listed again — the rule is about the name, not the subtree.
//!
//! A failure is not handled: a path that is not there, or that names a file,
//! comes back as an error the route lets escape. There is no "not a directory"
//! answer, because the reference has none.

use std::cmp::Ordering;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

const IGNORED: [&str; 2] = [".git", "node_modules"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DirectoryListing {
    pub ok: bool,
    pub path: String,
    pub parent: String,
    pub entries: Vec<DirectoryEntry>,
}

/// List a directory, or say why not.
pub async fn list_directories(
    path: &str,
    cwd: &str,
    include_files: bool,
) -> Result<DirectoryListing, String> {
    let resolved = resolve(path, cwd);
    // Node rejects a path containing a null byte in its argument check, before
    // `readdir` is called at all, and reports the received value with the byte
    // escaped rather than embedded. The message is the caller's, so it is
    // reproduced rather than replaced.
    let text = resolved.to_string_lossy();
    if text.contains('\0') {
        return Err(format!(
            "The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received '{}'",
            text.replace('\0', "\\x00")
        ));
    }
    let mut reader = tokio::fs::read_dir(&resolved)
        .await
        .map_err(|error| readdir_error(&resolved, &error))?;

    let mut entries: Vec<DirectoryEntry> = Vec::new();
    loop {
        let next = reader
            .next_entry()
            .await
            .map_err(|error| readdir_error(&resolved, &error))?;
        let Some(entry) = next else { break };
        let name = entry.file_name().to_string_lossy().to_string();
        // `withFileTypes` reports the *link*, so a symlink is neither a
        // directory nor a file and is dropped unless files are included — and
        // then it is dropped anyway, because it is not a regular file either.
        let Ok(kind) = entry.file_type().await else {
            continue;
        };
        let is_dir = kind.is_dir();
        if is_dir {
            if IGNORED.contains(&name.as_str()) {
                continue;
            }
        } else if !(include_files && kind.is_file()) {
            continue;
        }
        entries.push(DirectoryEntry {
            path: resolved.join(&name).to_string_lossy().to_string(),
            name,
            is_dir,
        });
    }

    // Folders first, then files, each group by the platform's collation.
    entries.sort_by(|left, right| match (left.is_dir, right.is_dir) {
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        _ => locale_compare(&left.name, &right.name),
    });

    Ok(DirectoryListing {
        ok: true,
        parent: parent_of(&resolved),
        path: resolved.to_string_lossy().to_string(),
        entries,
    })
}

/// Node reports a failed `readdir` as `<syscall> <errno> <path>` wrapped in its
/// own prose; the route hands whatever comes back straight to the caller.
fn readdir_error(path: &Path, error: &std::io::Error) -> String {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        std::io::ErrorKind::NotADirectory => "ENOTDIR",
        _ => "EIO",
    };
    let reason = match code {
        "ENOENT" => "no such file or directory",
        "EACCES" => "permission denied",
        "ENOTDIR" => "not a directory",
        _ => "i/o error",
    };
    format!("{code}: {reason}, scandir '{}'", path.to_string_lossy())
}

/// `path.resolve(cwd, requested)`: an absolute request stands, a relative one
/// hangs off the daemon's own working directory, and `.`/`..` are folded away
/// without touching the filesystem.
fn resolve(requested: &str, cwd: &str) -> PathBuf {
    let candidate = Path::new(requested);
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        Path::new(cwd).join(candidate)
    };
    normalize(&joined)
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        PathBuf::from("/")
    } else {
        out
    }
}

/// `dirname`, which treats the filesystem root as its own parent.
fn parent_of(path: &Path) -> String {
    path.parent()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

/// `String.prototype.localeCompare`, for a directory listing.
///
/// The implementation moved to [`crate::locale`] when a second listing needed
/// it. Kept as a name here because a picker's sort reads better as
/// `locale_compare` than as `locale::compare` at every call site.
pub fn locale_compare(left: &str, right: &str) -> Ordering {
    crate::locale::compare(left, right)
}
