//! Whether an agent's command is installed, answered by looking at PATH.
//!
//! Deliberately not `$SHELL -lc 'command -v …'`: a login shell would answer
//! from *its* PATH rather than this process's, so the answer would depend on
//! the user's shell profile instead of on the environment the agents will
//! actually be started in.

use std::path::{Path, PathBuf};

/// The first entry on PATH that names an executable file, or `None`.
pub(super) fn on_path(command: &str) -> Option<PathBuf> {
    // A command that already spells a path is not looked up at all — PATH is
    // only consulted for a bare name.
    if command.contains(std::path::MAIN_SEPARATOR) {
        let candidate = PathBuf::from(command);
        return is_executable(&candidate).then_some(candidate);
    }
    let path = std::env::var_os("PATH")?;
    // In PATH order: the point of the search is that the first hit wins, the
    // way the shell that starts the agent would resolve it.
    std::env::split_paths(&path)
        .filter(|directory| !directory.as_os_str().is_empty())
        .flat_map(|directory| candidates(&directory, command))
        .find(|candidate| is_executable(candidate))
}

#[cfg(unix)]
fn candidates(directory: &Path, command: &str) -> Vec<PathBuf> {
    vec![directory.join(command)]
}

/// Windows resolves a bare name through PATHEXT, so the extensions have to be
/// tried in their own order before the next PATH entry is.
#[cfg(windows)]
fn candidates(directory: &Path, command: &str) -> Vec<PathBuf> {
    let extensions = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let mut all = vec![directory.join(command)];
    for extension in extensions.split(';').filter(|entry| !entry.is_empty()) {
        all.push(directory.join(format!("{command}{extension}")));
    }
    all
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(windows)]
fn is_executable(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_named_this_is_installed_anywhere() {
        assert!(on_path("nomoreide-no-such-command-b7f2").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn the_first_path_entry_holding_it_wins() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("nomoreide-path-{}", std::process::id()));
        let (first, second) = (base.join("first"), base.join("second"));
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        for directory in [&second, &first] {
            let target = directory.join("agentish");
            std::fs::write(&target, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        // A file that is present but not executable is not a hit, so a
        // directory holding one must not stop the search.
        let inert = base.join("inert");
        std::fs::create_dir_all(&inert).unwrap();
        std::fs::write(inert.join("agentish"), "").unwrap();

        let previous = std::env::var_os("PATH");
        std::env::set_var(
            "PATH",
            std::env::join_paths([&inert, &first, &second]).unwrap(),
        );
        let found = on_path("agentish");
        match previous {
            Some(value) => std::env::set_var("PATH", value),
            None => std::env::remove_var("PATH"),
        }
        std::fs::remove_dir_all(&base).ok();

        assert_eq!(found, Some(first.join("agentish")));
    }
}
