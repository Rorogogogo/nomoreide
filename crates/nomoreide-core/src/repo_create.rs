//! Create a brand-new Git project from nothing: make the directory, `git init`
//! it, and seed a README so the folder is not empty.
//!
//! Rust counterpart of `src/core/repo-create.ts`. Like cloning, this is an
//! additive write that deliberately lives outside the read-safe `GitManager`.
//! It only ever creates a *new* directory — it refuses to touch one that
//! already has contents — so it can never clobber existing work.

use crate::repo_onboard::default_repos_dir;
use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use tokio::process::Command;

pub struct CreateRepoResult {
    pub name: String,
    pub path: String,
}

/// Reduce a user-typed project name to one safe directory segment.
///
/// Anything outside `[A-Za-z0-9._-]` collapses to a single `-`, then leading
/// dashes *and dots* are stripped along with trailing dashes. The asymmetry is
/// the reference's: a leading dot would hide the folder, while a trailing one
/// is merely untidy, so only the leading case is worth refusing.
pub fn sanitize_project_name(raw: &str) -> Result<String> {
    let mut collapsed = String::with_capacity(raw.len());
    let mut in_run = false;
    for character in raw.trim().chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
            collapsed.push(character);
            in_run = false;
        } else if !in_run {
            collapsed.push('-');
            in_run = true;
        }
    }
    let trimmed = collapsed
        .trim_start_matches(['-', '.'])
        .trim_end_matches('-');
    if trimmed.is_empty() {
        bail!("Project name is required.");
    }
    Ok(trimmed.to_string())
}

/// Create `<parent>/<name>` as an initialised Git repository. `parent` defaults
/// to the managed repos dir, the same place clones land.
pub async fn create_repository(
    raw_name: &str,
    parent_dir: Option<&str>,
) -> Result<CreateRepoResult> {
    let name = sanitize_project_name(raw_name)?;
    let parent = match parent_dir {
        Some(directory) => absolute(Path::new(directory)),
        None => default_repos_dir(),
    };
    if !parent.is_absolute() {
        bail!("Parent directory must be an absolute path.");
    }
    let path = parent.join(&name);
    if is_non_empty_dir(&path).await? {
        bail!(
            "Destination already exists and is not empty: {}.",
            path.display()
        );
    }
    tokio::fs::create_dir_all(&path)
        .await
        .context("Failed to create the project directory")?;

    // `-b main` rather than whatever `init.defaultBranch` happens to be, so a
    // project created here is named the same on every machine.
    let output = Command::new("git")
        .args(["init", "-b", "main"])
        .current_dir(&path)
        .output()
        .await
        .context("Failed to run git init")?;
    if !output.status.success() {
        bail!("{}", String::from_utf8_lossy(&output.stderr).trim());
    }

    tokio::fs::write(path.join("README.md"), format!("# {name}\n"))
        .await
        .context("Failed to seed README.md")?;

    Ok(CreateRepoResult {
        name,
        path: path.to_string_lossy().into_owned(),
    })
}

async fn is_non_empty_dir(path: &Path) -> Result<bool> {
    match tokio::fs::read_dir(path).await {
        Ok(mut entries) => Ok(entries.next_entry().await?.is_some()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).context("Failed to inspect the destination"),
    }
}

/// Node's `path.resolve`: absolute-ize against the process cwd, then collapse
/// `.` and `..` lexically.
fn absolute(path: &Path) -> PathBuf {
    let base = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut out = PathBuf::new();
    for component in base.components() {
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
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn a_plain_name_survives() {
        assert_eq!(sanitize_project_name("my-app").unwrap(), "my-app");
        assert_eq!(sanitize_project_name("app_2.0").unwrap(), "app_2.0");
    }

    #[test]
    fn unsafe_runs_collapse_to_one_dash() {
        assert_eq!(sanitize_project_name("my  app").unwrap(), "my-app");
        assert_eq!(sanitize_project_name("a/b\\c").unwrap(), "a-b-c");
        assert_eq!(sanitize_project_name("a???b").unwrap(), "a-b");
    }

    #[test]
    fn a_path_cannot_be_smuggled_through_the_name() {
        assert_eq!(
            sanitize_project_name("../../etc/passwd").unwrap(),
            "etc-passwd"
        );
        assert_eq!(
            sanitize_project_name("/absolute/path").unwrap(),
            "absolute-path"
        );
    }

    /// Leading dots go, trailing dots stay — the reference strips `^[-.]+` but
    /// only `-+$`.
    #[test]
    fn leading_dots_and_dashes_go_but_trailing_dots_stay() {
        assert_eq!(sanitize_project_name(".hidden").unwrap(), "hidden");
        assert_eq!(sanitize_project_name("--name--").unwrap(), "name");
        assert_eq!(sanitize_project_name("name.").unwrap(), "name.");
    }

    #[test]
    fn a_name_with_nothing_left_is_refused() {
        assert!(sanitize_project_name("").is_err());
        assert!(sanitize_project_name("   ").is_err());
        assert!(sanitize_project_name("///").is_err());
        assert!(sanitize_project_name("...").is_err());
    }

    /// Every row here was printed by the *reference's own*
    /// `sanitizeProjectName` (`handoffs/probe/sanitize-name-probe.ts`), not
    /// derived from reading its regex. The surprising ones are the point:
    /// `Ü` is not alphanumeric ASCII so it becomes a dash and is then stripped
    /// as a leading one, and a run of dashes the user typed is preserved
    /// because `-` is itself a safe character.
    #[test]
    fn matches_the_reference_answer_for_every_probed_input() {
        let expected: &[(&str, Option<&str>)] = &[
            ("my-app", Some("my-app")),
            ("app_2.0", Some("app_2.0")),
            ("my  app", Some("my-app")),
            ("a/b\\c", Some("a-b-c")),
            ("a???b", Some("a-b")),
            ("../../etc/passwd", Some("etc-passwd")),
            ("/absolute/path", Some("absolute-path")),
            (".hidden", Some("hidden")),
            ("--name--", Some("name")),
            ("name.", Some("name.")),
            ("", None),
            ("   ", None),
            ("///", None),
            ("...", None),
            ("Demo App", Some("Demo-App")),
            ("-.-x", Some("x")),
            ("x-", Some("x")),
            ("x.", Some("x.")),
            (".-.", None),
            ("a..b", Some("a..b")),
            ("  spaced  ", Some("spaced")),
            ("ÜNICODE", Some("NICODE")),
            ("a-b--c", Some("a-b--c")),
            ("-", None),
            (".", None),
            ("..hidden", Some("hidden")),
            ("name..", Some("name..")),
            ("-lead", Some("lead")),
        ];
        for (input, want) in expected {
            let got = sanitize_project_name(input);
            match want {
                Some(name) => assert_eq!(got.as_deref().ok(), Some(*name), "sanitizing {input:?}"),
                None => assert!(got.is_err(), "sanitizing {input:?} should be refused"),
            }
        }
    }

    #[tokio::test]
    async fn creates_an_initialised_repository_with_a_readme() {
        let parent = std::env::temp_dir().join(format!("nomoreide-create-{}", Uuid::new_v4()));
        let created = create_repository("Demo App", Some(&parent.to_string_lossy()))
            .await
            .unwrap();
        assert_eq!(created.name, "Demo-App");
        let path = Path::new(&created.path);
        assert!(path.join(".git").is_dir());
        let readme = tokio::fs::read_to_string(path.join("README.md"))
            .await
            .unwrap();
        assert_eq!(readme, "# Demo-App\n");
        tokio::fs::remove_dir_all(&parent).await.ok();
    }

    #[tokio::test]
    async fn refuses_a_destination_that_already_has_contents() {
        let parent = std::env::temp_dir().join(format!("nomoreide-create-{}", Uuid::new_v4()));
        let occupied = parent.join("taken");
        tokio::fs::create_dir_all(&occupied).await.unwrap();
        tokio::fs::write(occupied.join("keep.txt"), b"existing work")
            .await
            .unwrap();
        assert!(create_repository("taken", Some(&parent.to_string_lossy()))
            .await
            .is_err());
        // The existing file must still be there: refusing is only worth
        // anything if nothing was touched first.
        assert!(occupied.join("keep.txt").exists());
        tokio::fs::remove_dir_all(&parent).await.ok();
    }

    /// An *empty* directory is not "contents", so creating into one works.
    #[tokio::test]
    async fn an_empty_destination_directory_is_fine() {
        let parent = std::env::temp_dir().join(format!("nomoreide-create-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(parent.join("empty"))
            .await
            .unwrap();
        let created = create_repository("empty", Some(&parent.to_string_lossy()))
            .await
            .unwrap();
        assert!(Path::new(&created.path).join(".git").is_dir());
        tokio::fs::remove_dir_all(&parent).await.ok();
    }
}
