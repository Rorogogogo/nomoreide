//! Where this machine keeps the credential that identifies it to the relay.
//!
//! `~/.nomoreide/remote.json`, mode `0600`. Three things about that location are
//! deliberate:
//!
//! **It is beside the daemon's state, not inside the checkout.** A credential in
//! a repository is a credential in a backup, a container image and eventually a
//! commit. It also has to outlive `npm install -g nomoreide`, `install.sh` and
//! `cargo install`, none of which touch `~/.nomoreide/`.
//!
//! **It is its own file, not a key in `config.json`.** The daemon deletes
//! `daemon.json` and `daemon.credential` by name when it shuts down cleanly —
//! see `DaemonOwnership::drop` — and a pairing that evaporated every time the
//! daemon stopped would be worse than no pairing at all. A separate name is what
//! makes surviving that automatic rather than a rule someone has to remember.
//!
//! **It holds the platform it was issued by.** A credential is only meaningful
//! against the deployment that minted it, and a developer who points
//! `NOMOREIDE_API_BASE_URL` at a local stack must not have their production
//! pairing silently reused against it.

use crate::filesystem::{atomic_write, AtomicWriteOptions};
use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};

/// The file name inside the state directory.
///
/// Not `daemon.*`: those are the two names the daemon removes on an orderly
/// shutdown.
pub const CREDENTIAL_FILE: &str = "remote.json";

/// What pairing left behind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCredential {
    pub device_id: String,
    /// The name the machine was paired under. Shown by `nomoreide remote
    /// status` so a user can tell which of their machines this is without a
    /// round trip to the platform.
    pub device_name: String,
    /// 64 hex characters. The only copy — the platform stores a hash.
    pub credential: String,
    /// The deployment that issued it.
    pub platform_base_url: String,
    /// RFC 3339, UTC.
    pub paired_at: String,
}

/// Reads and writes the credential file.
///
/// Takes its directory rather than finding it, so tests get a real file in a
/// temporary home instead of a mock — the permission behaviour below is most of
/// what there is to get wrong, and a mock would not have any.
#[derive(Debug, Clone)]
pub struct RemoteCredentials {
    path: PathBuf,
}

impl RemoteCredentials {
    pub fn new(state_dir: impl AsRef<Path>) -> Self {
        Self {
            path: state_dir.as_ref().join(CREDENTIAL_FILE),
        }
    }

    /// The real location: `~/.nomoreide/remote.json`.
    pub fn discover() -> Self {
        Self::new(crate::home::home_directory().join(".nomoreide"))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The stored credential, or `None` when this machine is not paired.
    ///
    /// A file that cannot be parsed reads as "not paired" rather than as an
    /// error. The recovery for a corrupt credential is to pair again, and that
    /// is exactly what `None` prompts; an error here would instead make every
    /// command that merely *asks* whether we are paired fail.
    pub fn load(&self) -> Option<StoredCredential> {
        let text = std::fs::read_to_string(&self.path).ok()?;
        let credential: StoredCredential = serde_json::from_str(&text).ok()?;
        if credential.credential.trim().is_empty() || credential.device_id.trim().is_empty() {
            return None;
        }
        Some(credential)
    }

    pub fn store(&self, credential: &StoredCredential) -> io::Result<()> {
        let body = serde_json::to_string_pretty(credential)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        atomic_write(
            &self.path,
            format!("{body}\n"),
            AtomicWriteOptions::private(),
        )
    }

    /// Forget the pairing. `true` when there was one.
    ///
    /// Local only. It does **not** revoke anything: a machine that deletes its
    /// own credential is a machine that has stopped using it, not one the
    /// platform has stopped trusting. Only the owner revoking from their
    /// account does that, which is the whole point of revocation not depending
    /// on the daemon cooperating.
    pub fn clear(&self) -> io::Result<bool> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// Whether the file is readable by anyone but its owner.
    ///
    /// Reported rather than enforced: refusing to use a credential because the
    /// user's umask is loose would break remote control for a reason they
    /// cannot see, while saying so plainly in `nomoreide remote status` is
    /// something they can act on. Always `false` off Unix, where the mode does
    /// not mean this.
    pub fn is_world_readable(&self) -> bool {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::metadata(&self.path)
                .map(|metadata| metadata.permissions().mode() & 0o077 != 0)
                .unwrap_or(false)
        }
        #[cfg(not(unix))]
        {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credential() -> StoredCredential {
        StoredCredential {
            device_id: "11111111-2222-3333-4444-555555555555".into(),
            device_name: "Studio".into(),
            credential: "c".repeat(64),
            platform_base_url: "https://api.nomoreide.com".into(),
            paired_at: "2026-09-02T00:00:00Z".into(),
        }
    }

    /// A store over a throwaway state directory, cleaned up by [`Scratch`].
    fn store(label: &str) -> (Scratch, RemoteCredentials) {
        let directory = std::env::temp_dir().join(format!(
            "nomoreide-remote-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).expect("create scratch");
        let store = RemoteCredentials::new(&directory);
        (Scratch(directory), store)
    }

    struct Scratch(PathBuf);

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn an_unpaired_machine_has_nothing_stored() {
        let (_directory, store) = store("unpaired");

        assert_eq!(store.load(), None);
        assert!(!store.clear().expect("clear"));
    }

    #[test]
    fn a_credential_round_trips() {
        let (_directory, store) = store("round-trip");
        store.store(&credential()).expect("store");

        assert_eq!(store.load(), Some(credential()));
    }

    /// The property the whole file exists for.
    #[cfg(unix)]
    #[test]
    fn a_stored_credential_is_readable_only_by_its_owner() {
        use std::os::unix::fs::PermissionsExt;
        let (_directory, store) = store("mode");
        store.store(&credential()).expect("store");

        let mode = std::fs::metadata(store.path())
            .expect("metadata")
            .permissions()
            .mode();

        assert_eq!(mode & 0o777, 0o600, "{mode:o}");
        assert!(!store.is_world_readable());
    }

    /// Loose permissions are reported, not enforced — a user can act on being
    /// told, and cannot act on remote control silently not working.
    #[cfg(unix)]
    #[test]
    fn a_loosened_credential_is_reported_but_still_usable() {
        use std::os::unix::fs::PermissionsExt;
        let (_directory, store) = store("loosened");
        store.store(&credential()).expect("store");
        std::fs::set_permissions(store.path(), std::fs::Permissions::from_mode(0o644))
            .expect("loosen");

        assert!(store.is_world_readable());
        assert!(store.load().is_some());
    }

    #[test]
    fn clearing_forgets_the_pairing() {
        let (_directory, store) = store("clear");
        store.store(&credential()).expect("store");

        assert!(store.clear().expect("clear"));
        assert_eq!(store.load(), None);
    }

    /// A half-written or hand-edited file means "pair again", not "every
    /// command fails".
    #[test]
    fn an_unreadable_credential_reads_as_unpaired() {
        let (_directory, store) = store("unreadable");
        for body in ["", "{", "null", "{}", r#"{"deviceId":"x","credential":""}"#] {
            std::fs::write(store.path(), body).expect("write");
            assert_eq!(store.load(), None, "{body:?}");
        }
    }

    /// The daemon removes `daemon.json` and `daemon.credential` by name when it
    /// stops cleanly. If this file were one of those, a pairing would evaporate
    /// every time the daemon shut down.
    #[test]
    fn the_credential_is_not_one_of_the_files_the_daemon_deletes() {
        assert_ne!(CREDENTIAL_FILE, "daemon.json");
        assert_ne!(CREDENTIAL_FILE, "daemon.credential");
        assert!(!CREDENTIAL_FILE.starts_with("daemon."));
    }

    /// It lives beside the daemon's state, which no installer touches.
    #[test]
    fn the_credential_lives_in_the_state_directory() {
        let path = RemoteCredentials::discover().path().to_path_buf();

        assert!(
            path.ends_with(".nomoreide/remote.json"),
            "{}",
            path.display()
        );
    }
}
