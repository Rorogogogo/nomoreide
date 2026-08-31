//! What the machine already has for connecting somewhere, and the two terminals
//! that fill the gaps.
//!
//! The Rust half of `src/core/ssh-setup.ts`. Neither action is performed here:
//! generating a key and installing one are *interactive* — `ssh-keygen` asks
//! about a passphrase and `ssh-copy-id` asks for a password — so this resolves
//! what to spawn and hands it to the terminal manager. A background process
//! could not answer either prompt.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::locale;
use regex::Regex;

/// A destination `ssh-copy-id` may be pointed at. The leading character class
/// is what stops a value starting with `-` from being read as an option.
fn safe_destination() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._:@-]*$").expect("valid pattern"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSetupStatus {
    pub public_keys: Vec<String>,
    pub ssh_copy_id_available: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SshSetupAction {
    GenerateKey,
    InstallKey,
}

impl SshSetupAction {
    /// Only these two spellings. An unknown action is refused by the caller
    /// rather than defaulted, because both of these spawn a program.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "generate-key" => Some(Self::GenerateKey),
            "install-key" => Some(Self::InstallKey),
            _ => None,
        }
    }
}

/// What to spawn, and what to call the tab.
#[derive(Debug)]
pub struct SshSetupTerminal {
    pub shell: String,
    pub args: Vec<String>,
    pub label: String,
}

/// A missing `~/.ssh` is no keys, not a failure — that is the state a machine
/// that has never connected anywhere is in, and it is exactly when this page is
/// most useful.
pub async fn inspect_ssh_setup(ssh_directory: &Path, path_value: &str) -> SshSetupStatus {
    let mut public_keys: Vec<String> = Vec::new();
    if let Ok(mut entries) = tokio::fs::read_dir(ssh_directory).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            // A *directory* named `something.pub` is not a public key.
            if !entry
                .file_type()
                .await
                .map(|kind| kind.is_file())
                .unwrap_or(false)
            {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".pub") {
                public_keys.push(name);
            }
        }
    }
    public_keys.sort_by(|left, right| locale::compare(left, right));

    SshSetupStatus {
        public_keys,
        ssh_copy_id_available: executable_exists("ssh-copy-id", path_value).await,
    }
}

/// PATH order decides, and the first hit wins — the same walk the shell does.
async fn executable_exists(name: &str, path_value: &str) -> bool {
    for directory in path_value.split(':').filter(|entry| !entry.is_empty()) {
        let candidate = PathBuf::from(directory).join(name);
        if is_executable(&candidate).await {
            return true;
        }
    }
    false
}

#[cfg(unix)]
async fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match tokio::fs::metadata(path).await {
        // `access(X_OK)` asks whether *this* process may execute it, which for
        // any bit set is near enough — the alternative is reimplementing the
        // uid/gid walk for an answer that only decides whether a button shows.
        Ok(metadata) => metadata.permissions().mode() & 0o111 != 0,
        Err(_) => false,
    }
}

#[cfg(not(unix))]
async fn is_executable(path: &Path) -> bool {
    tokio::fs::metadata(path).await.is_ok()
}

/// Which terminal an action opens.
///
/// `generate-key` ignores the destination entirely — there is nowhere to send a
/// key that does not exist yet — so an unusable host is not an error there. Only
/// `install-key` has a target to check, and it trims before checking, so a
/// destination pasted with surrounding whitespace works and is labelled by its
/// trimmed spelling.
pub fn resolve_ssh_setup_terminal(
    action: SshSetupAction,
    destination: Option<&str>,
) -> Result<SshSetupTerminal, String> {
    if action == SshSetupAction::GenerateKey {
        return Ok(SshSetupTerminal {
            shell: "ssh-keygen".to_string(),
            args: vec!["-t".to_string(), "ed25519".to_string()],
            label: "Generate SSH key".to_string(),
        });
    }

    let target = destination.unwrap_or_default().trim();
    if !safe_destination().is_match(target) {
        return Err(
            "SSH destination must be a host name, IP, user@host, or SSH config alias.".to_string(),
        );
    }
    Ok(SshSetupTerminal {
        shell: "ssh-copy-id".to_string(),
        args: vec![target.to_string()],
        label: format!("Set up SSH · {target}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generating_a_key_ignores_the_destination() {
        let terminal = resolve_ssh_setup_terminal(SshSetupAction::GenerateKey, Some("!! nope !!"))
            .expect("a key is generated locally, so the destination is not consulted");
        assert_eq!(terminal.shell, "ssh-keygen");
        assert_eq!(terminal.args, ["-t", "ed25519"]);
        assert_eq!(terminal.label, "Generate SSH key");
    }

    #[test]
    fn installing_a_key_trims_before_it_checks() {
        let terminal =
            resolve_ssh_setup_terminal(SshSetupAction::InstallKey, Some("  deploy@10.0.0.1  "))
                .unwrap();
        assert_eq!(terminal.args, ["deploy@10.0.0.1"]);
        assert_eq!(terminal.label, "Set up SSH · deploy@10.0.0.1");
    }

    #[test]
    fn a_destination_that_could_be_an_option_is_refused() {
        for destination in [
            None,
            Some("   "),
            Some("-oProxyCommand=danger"),
            Some("a; rm"),
        ] {
            assert_eq!(
                resolve_ssh_setup_terminal(SshSetupAction::InstallKey, destination).unwrap_err(),
                "SSH destination must be a host name, IP, user@host, or SSH config alias."
            );
        }
    }

    #[test]
    fn only_two_actions_parse() {
        assert_eq!(
            SshSetupAction::parse("generate-key"),
            Some(SshSetupAction::GenerateKey)
        );
        assert_eq!(
            SshSetupAction::parse("install-key"),
            Some(SshSetupAction::InstallKey)
        );
        assert_eq!(SshSetupAction::parse("rm-rf"), None);
        assert_eq!(SshSetupAction::parse(""), None);
    }

    /// The crate's convention for a throwaway fixture: no `tempfile`
    /// dependency, a uuid so parallel tests cannot collide.
    fn scratch(label: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "nomoreide-ssh-setup-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[tokio::test]
    async fn only_files_ending_in_pub_are_keys_and_they_collate() {
        let root = scratch("keys");
        let ssh = root.join(".ssh");
        std::fs::create_dir_all(&ssh).unwrap();
        for name in [
            "id_rsa.pub",
            "Backup.pub",
            "_work.pub",
            "id_rsa",
            "config.pub.bak",
        ] {
            std::fs::write(ssh.join(name), "x\n").unwrap();
        }
        std::fs::create_dir_all(ssh.join("archive.pub")).unwrap();

        let status = inspect_ssh_setup(&ssh, "").await;
        assert_eq!(
            status.public_keys,
            ["_work.pub", "Backup.pub", "id_rsa.pub"]
        );
        assert!(!status.ssh_copy_id_available);
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn a_missing_ssh_directory_is_no_keys_rather_than_a_failure() {
        let root = scratch("missing");
        let status = inspect_ssh_setup(&root.join("nowhere"), "").await;
        assert!(status.public_keys.is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn an_executable_is_found_by_walking_path() {
        let root = scratch("path");
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let tool = bin.join("ssh-copy-id");
        std::fs::write(&tool, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path_value = format!("{}:{}", root.join("empty").display(), bin.display());
        let status = inspect_ssh_setup(&root, &path_value).await;
        assert!(status.ssh_copy_id_available);
        std::fs::remove_dir_all(&root).ok();
    }
}
