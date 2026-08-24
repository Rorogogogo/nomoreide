//! Tracked-file listing, reading, writing, and size ranking.

use super::exec;
use super::types::{FileSizeRank, TrackedFileContent};
use super::GitManager;
use anyhow::{anyhow, Context, Result};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

impl GitManager {
    pub async fn list_tracked_files(cwd: &str) -> Result<Vec<String>> {
        exec::lines(cwd, &["ls-files"]).await
    }

    pub async fn read_file(cwd: &str, path: &str) -> Result<String> {
        tokio::fs::read_to_string(Path::new(cwd).join(path))
            .await
            .context("Failed to read tracked file")
    }

    pub async fn write_file(cwd: &str, path: &str, content: &str) -> Result<()> {
        let full = Path::new(cwd).join(path);
        tokio::fs::write(full, content)
            .await
            .context("Failed to write file")
    }

    /// Read a tracked file for the `/api/git/file` route: refuses a path git
    /// does not track (the primary guard — an escape attempt is simply not in
    /// that set), refuses one [`resolve_inside`] would still let climb out
    /// through a symlink or an untracked parent, caps what it reads, and
    /// reports a binary file's size rather than mangling it as text.
    pub async fn read_tracked_file(cwd: &str, path: &str) -> Result<TrackedFileContent> {
        const MAX_BYTES: usize = 1_000_000;
        let tracked: HashSet<String> = Self::list_tracked_files(cwd).await?.into_iter().collect();
        if !tracked.contains(path) {
            return Err(anyhow!("file is not tracked by git"));
        }
        let full = resolve_inside(cwd, path)?;
        let bytes = tokio::fs::read(&full).await.context("Failed to read tracked file")?;
        let size = bytes.len() as u64;
        if bytes.contains(&0) {
            return Ok(TrackedFileContent { content: String::new(), truncated: false, binary: true, size });
        }
        let truncated = bytes.len() > MAX_BYTES;
        let slice = if truncated { &bytes[..MAX_BYTES] } else { &bytes[..] };
        Ok(TrackedFileContent {
            content: String::from_utf8_lossy(slice).into_owned(),
            truncated,
            binary: false,
            size,
        })
    }

    /// Rank tracked files by line count (then bytes), skipping binaries. Mirrors
    /// the Node `rankFilesBySize`: files past `MAX_BYTES` are measured from a
    /// capped read and flagged `truncated`.
    pub async fn rank_files_by_size(cwd: &str) -> Result<Vec<FileSizeRank>> {
        const MAX_BYTES: u64 = 2_000_000;
        let files = Self::list_tracked_files(cwd).await?;
        let mut ranks: Vec<FileSizeRank> = Vec::new();

        for path in files {
            let full = Path::new(cwd).join(&path);
            let Ok(meta) = tokio::fs::metadata(&full).await else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }

            let bytes = meta.len();
            let truncated = bytes > MAX_BYTES;
            let read_len = if truncated {
                MAX_BYTES as usize
            } else {
                bytes as usize
            };

            let Ok(buf) = read_capped(&full, read_len).await else {
                continue;
            };
            if buf.contains(&0) {
                continue;
            } // binary

            let mut lines = buf.iter().filter(|&&b| b == b'\n').count();
            // Count a final line that has no trailing newline.
            if !buf.is_empty() && *buf.last().unwrap() != b'\n' {
                lines += 1;
            }

            ranks.push(FileSizeRank {
                path,
                lines,
                bytes,
                truncated,
            });
        }

        ranks.sort_by(|a, b| b.lines.cmp(&a.lines).then(b.bytes.cmp(&a.bytes)));
        Ok(ranks)
    }
}

/// Read at most `len` bytes from the start of a file (reads fully up to the cap;
/// a single `read` can return short).
async fn read_capped(path: &Path, len: usize) -> Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let file = tokio::fs::File::open(path).await?;
    let mut buf = Vec::new();
    file.take(len as u64).read_to_end(&mut buf).await?;
    Ok(buf)
}

/// Refuse a path that resolves outside `root`, the way the reference's own
/// `resolveInside` does: a joined path must equal the root or start with
/// `root/`, not merely start with the root's characters (`/root-evil` must
/// not pass a check against `/root`).
fn resolve_inside(root: &str, path: &str) -> Result<PathBuf> {
    let root_path = absolutize(root);
    let target = absolutize_join(&root_path, path);
    if target != root_path && !target.starts_with(&root_path) {
        return Err(anyhow!("file path must stay inside the repository"));
    }
    Ok(target)
}

/// A lightweight stand-in for Node's `path.resolve`: absolute-ize without
/// requiring the path to exist (a target file may not yet, though its parent
/// directory does for every route that reaches this).
fn absolutize(path: &str) -> PathBuf {
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(candidate)
    }
}

fn absolutize_join(root: &Path, path: &str) -> PathBuf {
    let joined = if Path::new(path).is_absolute() {
        Path::new(path).to_path_buf()
    } else {
        root.join(path)
    };
    normalize(&joined)
}

/// Collapse `.` and `..` components lexically, without touching the
/// filesystem — `resolve_inside` must reject a climbing path before ever
/// reading it, so it cannot rely on `canonicalize()`, which requires the
/// target to exist.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod resolve_inside_tests {
    use super::*;

    #[test]
    fn a_plain_relative_path_stays_inside() {
        let resolved = resolve_inside("/repo", "src/main.rs").unwrap();
        assert_eq!(resolved, Path::new("/repo/src/main.rs"));
    }

    #[test]
    fn a_climbing_path_is_refused() {
        assert!(resolve_inside("/repo", "../escape.txt").is_err());
        assert!(resolve_inside("/repo", "sub/../../escape.txt").is_err());
    }

    /// A sibling directory sharing the root's characters as a prefix
    /// (`/repo-evil` starts with `/repo`) must not pass.
    #[test]
    fn a_prefix_sharing_sibling_is_refused() {
        assert!(resolve_inside("/repo", "../repo-evil/x").is_err());
    }

    #[test]
    fn the_root_itself_is_allowed() {
        assert_eq!(resolve_inside("/repo", ".").unwrap(), Path::new("/repo"));
    }

    #[test]
    fn a_deeply_nested_climb_that_still_lands_inside_is_allowed() {
        assert_eq!(
            resolve_inside("/repo", "a/b/../../c.txt").unwrap(),
            Path::new("/repo/c.txt")
        );
    }
}

#[cfg(test)]
mod read_tracked_file_tests {
    use super::*;
    use uuid::Uuid;

    async fn repository(files: &[(&str, &[u8])]) -> String {
        let root = std::env::temp_dir().join(format!("nomoreide-git-files-{}", Uuid::new_v4()));
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
    async fn reads_a_tracked_text_file() {
        let cwd = repository(&[("src/main.rs", b"fn main() {}\n")]).await;
        let file = GitManager::read_tracked_file(&cwd, "src/main.rs").await.unwrap();
        assert_eq!(file.content, "fn main() {}\n");
        assert!(!file.truncated);
        assert!(!file.binary);
        assert_eq!(file.size, 13);
        tokio::fs::remove_dir_all(&cwd).await.ok();
    }

    #[tokio::test]
    async fn refuses_a_path_git_does_not_track() {
        let cwd = repository(&[("tracked.txt", b"hi")]).await;
        tokio::fs::write(Path::new(&cwd).join("untracked.txt"), b"secret").await.unwrap();
        assert!(GitManager::read_tracked_file(&cwd, "untracked.txt").await.is_err());
        tokio::fs::remove_dir_all(&cwd).await.ok();
    }

    /// The primary guard is the tracked-file set, not path resolution — but a
    /// caller that names a path outside the repository entirely must still be
    /// refused rather than reading whatever it happens to resolve to.
    #[tokio::test]
    async fn refuses_a_climbing_path_even_if_it_were_somehow_tracked() {
        let cwd = repository(&[("a.txt", b"hi")]).await;
        assert!(GitManager::read_tracked_file(&cwd, "../a.txt").await.is_err());
        tokio::fs::remove_dir_all(&cwd).await.ok();
    }

    #[tokio::test]
    async fn a_binary_file_is_reported_not_decoded() {
        let cwd = repository(&[("image.bin", &[0x00, 0xff, 0x01, 0x00])]).await;
        let file = GitManager::read_tracked_file(&cwd, "image.bin").await.unwrap();
        assert!(file.binary);
        assert!(!file.truncated);
        assert_eq!(file.content, "");
        assert_eq!(file.size, 4);
        tokio::fs::remove_dir_all(&cwd).await.ok();
    }

    #[tokio::test]
    async fn a_file_past_the_cap_is_truncated_but_still_reports_its_full_size() {
        let big = vec![b'x'; 1_000_010];
        let cwd = repository(&[("big.txt", &big)]).await;
        let file = GitManager::read_tracked_file(&cwd, "big.txt").await.unwrap();
        assert!(file.truncated);
        assert!(!file.binary);
        assert_eq!(file.content.len(), 1_000_000);
        assert_eq!(file.size, 1_000_010);
        tokio::fs::remove_dir_all(&cwd).await.ok();
    }
}
