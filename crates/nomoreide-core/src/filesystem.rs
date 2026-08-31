use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Default)]
pub struct AtomicWriteOptions {
    pub unix_mode: Option<u32>,
}

impl AtomicWriteOptions {
    pub const fn private() -> Self {
        Self {
            unix_mode: Some(0o600),
        }
    }
}

pub fn atomic_write(
    path: &Path,
    content: impl AsRef<[u8]>,
    options: AtomicWriteOptions,
) -> io::Result<()> {
    create_parent(path)?;
    let temporary_path = temporary_path(path);
    let result = (|| {
        let mut open_options = OpenOptions::new();
        open_options.write(true).create_new(true);
        #[cfg(unix)]
        if let Some(mode) = options.unix_mode {
            use std::os::unix::fs::OpenOptionsExt;
            open_options.mode(mode);
        }
        let mut file = open_options.open(&temporary_path)?;
        file.write_all(content.as_ref())?;
        file.sync_all()?;
        drop(file);
        replace_file(&temporary_path, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

pub async fn atomic_write_async(
    path: &Path,
    content: impl AsRef<[u8]>,
    options: AtomicWriteOptions,
) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let temporary_path = temporary_path(path);
    let mut open_options = tokio::fs::OpenOptions::new();
    open_options.write(true).create_new(true);
    #[cfg(unix)]
    if let Some(mode) = options.unix_mode {
        open_options.mode(mode);
    }
    let result = async {
        let mut file = open_options.open(&temporary_path).await?;
        file.write_all(content.as_ref()).await?;
        file.sync_all().await?;
        drop(file);
        replace_file(&temporary_path, path)
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary_path).await;
    }
    result
}

pub fn resolve_relative_path(root: &Path, relative: impl AsRef<Path>) -> io::Result<PathBuf> {
    let relative = relative.as_ref();
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path must remain inside its root",
        ));
    }
    Ok(root.join(relative))
}

pub fn canonicalize_contained(root: &Path, path: &Path) -> io::Result<PathBuf> {
    let canonical_root = fs::canonicalize(root)?;
    let canonical_path = fs::canonicalize(path)?;
    if canonical_path == canonical_root || canonical_path.starts_with(&canonical_root) {
        Ok(canonical_path)
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "path escapes its root through a symbolic link",
        ))
    }
}

fn create_parent(path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

fn temporary_path(path: &Path) -> PathBuf {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    path.with_file_name(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        Uuid::new_v4()
    ))
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let replaced = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("nomoreide-filesystem-{label}-{}", Uuid::new_v4()))
    }

    #[test]
    fn atomically_creates_and_replaces_files_without_temp_leaks() {
        let dir = test_dir("replace");
        let path = dir.join("nested/state.json");

        atomic_write(&path, b"first", AtomicWriteOptions::default()).unwrap();
        atomic_write(&path, b"second", AtomicWriteOptions::default()).unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"second");
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn async_private_writes_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = test_dir("private");
        let path = dir.join("credential");
        atomic_write_async(&path, b"secret", AtomicWriteOptions::private())
            .await
            .unwrap();

        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn relative_paths_reject_root_and_parent_traversal() {
        let root = Path::new("/vault");

        assert_eq!(
            resolve_relative_path(root, "Notes/note.md").unwrap(),
            root.join("Notes/note.md")
        );
        assert!(resolve_relative_path(root, "../secret").is_err());
        assert!(resolve_relative_path(root, "/tmp/secret").is_err());
        assert!(resolve_relative_path(root, "").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn canonical_containment_rejects_symlink_escapes() {
        use std::os::unix::fs::symlink;

        let root = test_dir("root");
        let outside = test_dir("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret"), "secret").unwrap();
        symlink(&outside, root.join("escape")).unwrap();

        assert!(canonicalize_contained(&root, &root.join("escape/secret")).is_err());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }
}
