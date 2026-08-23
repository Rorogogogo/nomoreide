//! Copies taken before anything an agent's config is edited.
//!
//! Every write here is to a file the *user* owns and did not ask this program
//! to reformat, so each edit keeps the previous version beside it. The name
//! carries the second it was taken in, which means several backups of one file
//! in the same second collide; a counter is appended rather than the earlier
//! copy being overwritten, since overwriting the backup would defeat it.

use chrono::Local;
use std::path::{Path, PathBuf};

/// `YYYYMMDD-HHMMSS`, in local time — the clock the user reads.
fn stamp() -> String {
    Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// The first free spelling of `<prefix><stamp>`, `<prefix><stamp>-1`, and so on.
fn free_path(directory: &Path, prefix: &str) -> PathBuf {
    let stamp = stamp();
    let candidate = directory.join(format!("{prefix}{stamp}"));
    if !candidate.exists() {
        return candidate;
    }
    // Bounded so a directory that somehow cannot be written to ends the search
    // rather than spinning; the caller reports the failure either way.
    for counter in 1..10_000 {
        let candidate = directory.join(format!("{prefix}{stamp}-{counter}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!("{prefix}{stamp}-overflow"))
}

/// Copy `path` beside itself as `<path>.bak.<stamp>`.
///
/// A file that is not there needs no backup and is not an error: adding the
/// first MCP server to an agent that has never been configured is an ordinary
/// thing to do.
pub(super) fn file(path: &Path) -> Result<Option<PathBuf>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let directory = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let target = free_path(directory, &format!("{name}.bak."));
    std::fs::copy(path, &target)
        .map_err(|error| format!("Failed to back up {}: {error}", path.display()))?;
    Ok(Some(target))
}

/// Move a skill's directory into the backup store and return where it went.
///
/// A skill is a directory rather than a file, and a move takes it out of the
/// scope it was in — so this is the only copy of it left until it is written
/// into its new scope, and it goes somewhere neither scope will overwrite.
pub(super) fn directory(source: &Path, name: &str) -> Result<PathBuf, String> {
    let store = store_directory();
    std::fs::create_dir_all(&store)
        .map_err(|error| format!("Failed to create {}: {error}", store.display()))?;
    let target = free_path(&store, &format!("{name}."));
    copy_tree(source, &target)?;
    Ok(target)
}

/// `~/.config/nomoreide/agent-env-backups`, honouring `XDG_CONFIG_HOME` the
/// way the rest of this program's configuration does.
fn store_directory() -> PathBuf {
    let base = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".config")
        });
    base.join("nomoreide").join("agent-env-backups")
}

pub(super) fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    std::fs::create_dir_all(target)
        .map_err(|error| format!("Failed to create {}: {error}", target.display()))?;
    let listing = std::fs::read_dir(source)
        .map_err(|error| format!("Failed to read {}: {error}", source.display()))?;
    for entry in listing.filter_map(Result::ok) {
        let from = entry.path();
        let to = target.join(entry.file_name());
        if from.is_dir() {
            copy_tree(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)
                .map_err(|error| format!("Failed to copy {}: {error}", from.display()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "nomoreide-backup-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::remove_dir_all(&path).ok();
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn backups_taken_in_one_second_count_up_instead_of_replacing_each_other() {
        let base = scratch("collide");
        let config = base.join("config.json");
        let mut taken = Vec::new();
        for round in 0..6 {
            std::fs::write(&config, format!("body {round}")).unwrap();
            taken.push((round, file(&config).unwrap().unwrap()));
        }

        // Grouped by the second each landed in, because a run that straddles a
        // second boundary starts counting again — and this has to hold either
        // way, not only when all six happen to land together.
        let mut by_stamp: std::collections::BTreeMap<String, Vec<String>> = Default::default();
        for (round, path) in &taken {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            let stamp = name.rsplit_once(".bak.").unwrap().1.to_string();
            by_stamp
                .entry(stamp[..15].to_string())
                .or_default()
                .push(stamp[15..].to_string());
            // Each backup still holds what was there when it was taken, so
            // none of them was overwritten by a later one.
            assert_eq!(
                std::fs::read_to_string(path).unwrap(),
                format!("body {round}")
            );
        }
        // The first of a second carries no counter and the rest count up from
        // one. Spelled out exactly: a counter starting anywhere else still
        // produces distinct names, and so would pass a looser check.
        for (stamp, suffixes) in &by_stamp {
            let expected: Vec<String> = (0..suffixes.len())
                .map(|index| {
                    if index == 0 {
                        String::new()
                    } else {
                        format!("-{index}")
                    }
                })
                .collect();
            assert_eq!(suffixes, &expected, "for {stamp}");
        }
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn the_stamp_is_a_date_and_a_time_to_the_second() {
        let base = scratch("stamp");
        let config = base.join("config.json");
        std::fs::write(&config, "x").unwrap();
        let backup = file(&config).unwrap().unwrap();
        let name = backup.file_name().unwrap().to_string_lossy().into_owned();
        let stamp = name.strip_prefix("config.json.bak.").unwrap();
        assert_eq!(stamp.len(), 15, "{stamp}");
        assert!(stamp[..8].chars().all(|c| c.is_ascii_digit()));
        assert_eq!(&stamp[8..9], "-");
        assert!(stamp[9..].chars().all(|c| c.is_ascii_digit()));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn a_file_that_is_not_there_is_not_backed_up_and_not_an_error() {
        let base = scratch("absent");
        assert_eq!(file(&base.join("nothing.json")).unwrap(), None);
        std::fs::remove_dir_all(&base).ok();
    }
}
