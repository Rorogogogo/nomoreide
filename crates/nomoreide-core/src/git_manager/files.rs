//! Tracked-file listing, reading, writing, and size ranking.

use super::exec;
use super::types::FileSizeRank;
use super::GitManager;
use anyhow::{Context, Result};
use std::path::Path;

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
