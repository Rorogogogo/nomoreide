//! Machine-global loopback daemon ownership and state boundary.

// A route helper that fails hands back the response it wants sent — that is
// axum's own idiom, and `axum::response::Response` is 128 bytes, exactly the
// threshold `result_large_err` fires at. Boxing it would put a `Box<Response>`
// and a `.map_err` in the signature of every helper on a path that is already
// allocating an HTTP response, to save moving 128 bytes. The lint is right in
// general and wrong here.
#![allow(clippy::result_large_err)]

mod runtime;
mod server;
mod service_discovery;

pub use server::{
    run, run_embedded, run_embedded_with_shutdown_requests, run_with_listener, serve_until,
    serve_with_shutdown_requests, DaemonOptions,
};

use nomoreide_core::filesystem::{atomic_write, AtomicWriteOptions};
use nomoreide_daemon_client::{DaemonState, RuntimePaths};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Seek, SeekFrom, Write};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LockRecord {
    pid: u32,
    owner_id: String,
}

/// Exclusive ownership of the machine-global runtime. The OS lock is released
/// automatically on crash; state and credentials are removed on orderly drop.
pub struct DaemonOwnership {
    paths: RuntimePaths,
    lock_file: File,
    owner_id: String,
    credential: String,
}

impl DaemonOwnership {
    pub fn acquire(paths: RuntimePaths) -> io::Result<Self> {
        fs::create_dir_all(&paths.state_dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&paths.state_dir, fs::Permissions::from_mode(0o700))?;
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
            options
                .share_mode(0)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        }
        let mut lock_file = options.open(&paths.lock).map_err(map_lock_open_error)?;
        if !lock_file.metadata()?.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "daemon lock path is not a regular file",
            ));
        }
        lock_exclusive(&lock_file)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            lock_file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }

        let owner_id = Uuid::new_v4().to_string();
        let record = LockRecord {
            pid: std::process::id(),
            owner_id: owner_id.clone(),
        };
        lock_file.set_len(0)?;
        lock_file.seek(SeekFrom::Start(0))?;
        lock_file.write_all(&serde_json::to_vec(&record).map_err(invalid_data)?)?;
        lock_file.sync_all()?;

        // Any files visible before this lock was acquired belong to a crashed
        // owner. Clear them before publishing this owner's identity.
        remove_if_present(&paths.state)?;
        remove_if_present(&paths.credential)?;

        Ok(Self {
            paths,
            lock_file,
            owner_id,
            credential: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
        })
    }

    pub fn publish(&self, state: &DaemonState) -> io::Result<()> {
        state.validate()?;
        if state.pid != std::process::id() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "daemon state pid does not match the lock owner",
            ));
        }
        if state.owner_id != self.owner_id {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "daemon state identity does not match the lock owner",
            ));
        }
        let mut serialized = serde_json::to_vec_pretty(state).map_err(invalid_data)?;
        serialized.push(b'\n');
        atomic_write(
            &self.paths.credential,
            format!("{}\n", self.credential),
            AtomicWriteOptions::private(),
        )?;
        atomic_write(&self.paths.state, serialized, AtomicWriteOptions::private())
    }

    pub fn credential(&self) -> &str {
        &self.credential
    }

    pub fn owner_id(&self) -> &str {
        &self.owner_id
    }
}

impl Drop for DaemonOwnership {
    fn drop(&mut self) {
        let _ = remove_if_present(&self.paths.state);
        let _ = remove_if_present(&self.paths.credential);
        unlock(&self.lock_file);
    }
}

#[cfg(unix)]
fn lock_exclusive(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        Ok(())
    } else {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
            Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "another NoMoreIDE daemon owns the runtime lock",
            ))
        } else {
            Err(error)
        }
    }
}

#[cfg(unix)]
fn unlock(file: &File) {
    use std::os::fd::AsRawFd;
    let _ = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
}

#[cfg(windows)]
fn lock_exclusive(_file: &File) -> io::Result<()> {
    // share_mode(0) on the open file is the exclusive, crash-safe lock.
    Ok(())
}

#[cfg(windows)]
fn unlock(_file: &File) {}

fn remove_if_present(path: &std::path::Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(not(windows))]
fn map_lock_open_error(error: io::Error) -> io::Error {
    error
}

#[cfg(windows)]
fn map_lock_open_error(error: io::Error) -> io::Error {
    const ERROR_SHARING_VIOLATION: i32 = 32;
    if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION) {
        io::Error::new(
            io::ErrorKind::WouldBlock,
            "another NoMoreIDE daemon owns the runtime lock",
        )
    } else {
        error
    }
}

fn invalid_data(error: impl std::fmt::Display) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nomoreide_daemon_client::DaemonEndpoint;

    fn paths(label: &str) -> RuntimePaths {
        RuntimePaths::new(
            std::env::temp_dir().join(format!("nomoreide-daemon-{label}-{}", Uuid::new_v4())),
        )
    }

    fn state(owner_id: &str) -> DaemonState {
        let endpoint = DaemonEndpoint::localhost(4317);
        DaemonState {
            pid: std::process::id(),
            owner_id: owner_id.into(),
            url: endpoint.as_str().trim_end_matches('/').to_string(),
            port: 4317,
            version: Some("0.1.103".into()),
            started_at: "2026-08-20T00:00:00Z".into(),
        }
    }

    #[test]
    fn only_one_owner_can_hold_the_runtime_lock() {
        let paths = paths("exclusive");
        let owner = DaemonOwnership::acquire(paths.clone()).unwrap();
        let error = DaemonOwnership::acquire(paths.clone()).err().unwrap();
        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        drop(owner);
        assert!(DaemonOwnership::acquire(paths.clone()).is_ok());
        let _ = fs::remove_dir_all(paths.state_dir);
    }

    #[test]
    fn acquisition_clears_stale_state_and_publishes_private_runtime_files() {
        let paths = paths("stale");
        fs::create_dir_all(&paths.state_dir).unwrap();
        fs::write(&paths.state, "stale").unwrap();
        fs::write(&paths.credential, "stale-secret").unwrap();

        let owner = DaemonOwnership::acquire(paths.clone()).unwrap();
        assert!(!paths.state.exists());
        assert!(!paths.credential.exists());
        owner.publish(&state(owner.owner_id())).unwrap();
        assert_eq!(
            fs::read_to_string(&paths.credential).unwrap().trim().len(),
            64
        );
        assert!(!fs::read_to_string(&paths.state)
            .unwrap()
            .contains(owner.credential()));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for path in [&paths.lock, &paths.state, &paths.credential] {
                assert_eq!(
                    fs::metadata(path).unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
        }

        drop(owner);
        assert!(!paths.state.exists());
        assert!(!paths.credential.exists());
        let _ = fs::remove_dir_all(paths.state_dir);
    }

    #[test]
    fn publication_rejects_state_for_a_different_owner() {
        let paths = paths("identity-mismatch");
        let owner = DaemonOwnership::acquire(paths.clone()).unwrap();

        let error = owner.publish(&state("different-owner")).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(!paths.state.exists());
        assert!(!paths.credential.exists());
        drop(owner);
        let _ = fs::remove_dir_all(paths.state_dir);
    }

    #[cfg(unix)]
    #[test]
    fn ownership_refuses_a_symlinked_lock_file() {
        use std::os::unix::fs::symlink;

        let paths = paths("symlink");
        fs::create_dir_all(&paths.state_dir).unwrap();
        let target = paths.state_dir.join("target");
        fs::write(&target, "must remain unchanged").unwrap();
        symlink(&target, &paths.lock).unwrap();

        assert!(DaemonOwnership::acquire(paths.clone()).is_err());
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "must remain unchanged"
        );
        let _ = fs::remove_dir_all(paths.state_dir);
    }
}
