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

/// `String.prototype.localeCompare`, to the depth a file listing needs.
///
/// **This is an approximation of ICU's collation, not an implementation of
/// it.** Three levels, compared in order:
///
/// 1. *Primary* — punctuation before digits before letters, and within letters
///    the accent-folded lowercase form. This is what puts `alpha` before
///    `Beta` where a byte comparison puts `Beta` first, and what keeps
///    `Éclair` next to `eclair` instead of after `zeta`.
/// 2. *Secondary* — the accent itself, so `eclair` precedes `Éclair`.
/// 3. *Tertiary* — case, lowercase first.
///
/// Names outside Latin-1 fall back to code-point order at the primary level,
/// which is where this parts company with ICU. A directory listing is the only
/// caller, and the alternative is an ICU dependency for a picker's sort.
pub fn locale_compare(left: &str, right: &str) -> Ordering {
    for level in 0..3 {
        let ordering = sort_key(left, level).cmp(&sort_key(right, level));
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    left.cmp(right)
}

fn sort_key(value: &str, level: usize) -> Vec<u32> {
    value
        .chars()
        .map(|character| match level {
            0 => {
                let base = fold(character);
                // Two classes, not three: punctuation is ranked by its
                // collation group, and everything else by its folded lowercase
                // code point. A separate class for digits would be redundant —
                // every digit's code point already sorts below every letter's.
                let (class, weight) = if base.is_alphanumeric() {
                    (1, base.to_lowercase().next().unwrap_or(base) as u32)
                } else {
                    (0, punctuation_rank(base))
                };
                (class << 24) | weight
            }
            1 => character as u32 - fold(character) as u32,
            _ => u32::from(character.is_uppercase()),
        })
        .collect()
}

/// Where a punctuation mark sorts *relative to other punctuation*.
///
/// Not its code point: the collation orders these by their group in the default
/// table, so an underscore comes before a full stop even though `.` is the
/// lower code point. That one pair is the whole reason this table exists —
/// `_under` sorts before `.hidden`, and a code-point comparison gets it
/// backwards. Anything not listed keeps its code point, offset past the table
/// so it sorts after everything named here.
fn punctuation_rank(character: char) -> u32 {
    const ORDER: [char; 26] = [
        ' ', '_', '-', ',', ';', ':', '!', '?', '.', '\'', '"', '(', ')', '[', ']', '{', '}', '@',
        '*', '/', '\\', '&', '#', '%', '+', '=',
    ];
    match ORDER.iter().position(|entry| *entry == character) {
        Some(index) => index as u32,
        None => ORDER.len() as u32 + character as u32,
    }
}

/// Strip a Latin-1 accent down to its base letter. Anything else is itself.
fn fold(character: char) -> char {
    match character {
        'à'..='å' | 'À'..='Å' => 'a',
        'è'..='ë' | 'È'..='Ë' => 'e',
        'ì'..='ï' | 'Ì'..='Ï' => 'i',
        'ò'..='ö' | 'Ò'..='Ö' => 'o',
        'ù'..='ü' | 'Ù'..='Ü' => 'u',
        'ç' | 'Ç' => 'c',
        'ñ' | 'Ñ' => 'n',
        'ý' | 'ÿ' | 'Ý' => 'y',
        other => other,
    }
}
