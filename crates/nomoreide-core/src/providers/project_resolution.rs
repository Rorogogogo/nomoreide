//! Which provider project a repository deploys, and which directory a provider
//! operation runs in.
//!
//! The Rust half of `src/core/providers/project-resolution.ts`. Neither
//! algorithm is vendor-specific — what varies is only where the vendor's CLI
//! records a link, and how the vendor keys an imported project by git remote.
//!
//! The ladder is expressed as an ordered list of *hints* rather than as a
//! generic function taking two async lookups. A hint is data, so the ordering
//! lives here once and stays readable, while each provider does its own two
//! lookups with its own client and its own error handling.

use std::path::Path;

use crate::config::Config;
use crate::repo_match::match_registered_repository;

/// One candidate answer to "which project is this repository", in descending
/// order of confidence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectHint {
    /// An explicit pin the user chose in the dashboard.
    Pinned(String),
    /// The id in the vendor CLI's own link file — the same file the CLI
    /// trusts, so a linked repo needs no configuration here at all.
    Linked(String),
    /// The repo's git remote, which is how a provider itself keys an imported
    /// project. Resolved by a lookup rather than by id.
    RepoUrl(String),
}

/// Where a vendor CLI records the project it linked: a path inside the repo and
/// the field to read out of it.
pub struct LinkFile {
    pub path: &'static [&'static str],
    pub field: &'static str,
}

/// The ordered candidates this repository offers, best first.
///
/// Returns them all rather than stopping at the first, because whether a
/// candidate *resolves* is a question only the provider's client can answer —
/// a pin naming a deleted project has to fall through to the next rung.
pub async fn project_hints(
    config: &Config,
    provider_id: &str,
    git_cwd: &str,
    link_file: Option<&LinkFile>,
    repo_url_of: fn(&str) -> Option<String>,
) -> Vec<ProjectHint> {
    let top_level = crate::repo_match::git_toplevel(git_cwd)
        .await
        .unwrap_or_else(|| git_cwd.to_string());
    let mut hints = Vec::new();

    // An ambiguous or nested repository is not an error here, only an absence:
    // the next rung of the ladder may still answer, and the pin is the rung
    // that needed a registered repository.
    if let Ok(Some(repository)) = match_registered_repository(config, &top_level).await {
        if let Some(pinned) = repository
            .provider_projects
            .as_ref()
            .and_then(|projects| projects.get(provider_id))
            .filter(|pinned| !pinned.is_empty())
        {
            hints.push(ProjectHint::Pinned(pinned.clone()));
        }
    }

    if let Some(link_file) = link_file {
        if let Some(linked) = read_linked_project_id(Path::new(&top_level), link_file).await {
            hints.push(ProjectHint::Linked(linked));
        }
    }

    if let Some(remote) = git_remote_url(&top_level).await {
        if let Some(repo_url) = repo_url_of(&remote) {
            hints.push(ProjectHint::RepoUrl(repo_url));
        }
    }

    hints
}

/// The project id recorded by the vendor CLI's link command, when present.
pub async fn read_linked_project_id(repo_root: &Path, link_file: &LinkFile) -> Option<String> {
    let mut path = repo_root.to_path_buf();
    for segment in link_file.path {
        path.push(segment);
    }
    let raw = tokio::fs::read_to_string(path).await.ok()?;
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()?
        .get(link_file.field)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

async fn git_remote_url(cwd: &str) -> Option<String> {
    let output = tokio::process::Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(cwd)
        .output()
        .await
        .ok()?;
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

/// The working directory provider operations run against — mirrors the GitHub
/// seam: the selected repository's active worktree, else its root, else where
/// the caller happens to be.
pub fn selected_provider_cwd(config: &Config, fallback: &str) -> String {
    let repository = config
        .selected_git_repository
        .as_ref()
        .and_then(|name| {
            config
                .git_repositories
                .iter()
                .find(|repository| &repository.name == name)
        })
        .or_else(|| config.git_repositories.first());
    repository
        .map(|repository| {
            repository
                .active_worktree_path
                .clone()
                .unwrap_or_else(|| repository.path.clone())
        })
        .unwrap_or_else(|| fallback.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::GitRepoDef;

    fn repo(name: &str, path: &str, worktree: Option<&str>) -> GitRepoDef {
        GitRepoDef {
            name: name.into(),
            path: path.into(),
            active_worktree_path: worktree.map(str::to_string),
            github_credential: None,
            provider_projects: None,
            legacy_vercel_project_id: None,
        }
    }

    #[test]
    fn the_active_worktree_wins_over_the_repository_root() {
        let mut config = Config::default();
        config
            .git_repositories
            .push(repo("app", "/repos/app", Some("/repos/app-wt")));
        config.selected_git_repository = Some("app".into());
        assert_eq!(selected_provider_cwd(&config, "/fallback"), "/repos/app-wt");
    }

    #[test]
    fn an_unregistered_selection_falls_back_to_the_first_repository() {
        let mut config = Config::default();
        config
            .git_repositories
            .push(repo("app", "/repos/app", None));
        config.selected_git_repository = Some("missing".into());
        assert_eq!(selected_provider_cwd(&config, "/fallback"), "/repos/app");
    }

    #[test]
    fn with_no_repositories_at_all_the_fallback_is_used() {
        assert_eq!(
            selected_provider_cwd(&Config::default(), "/fallback"),
            "/fallback"
        );
    }

    #[tokio::test]
    async fn a_link_file_that_is_not_json_answers_nothing_rather_than_failing() {
        let root = std::env::temp_dir().join(format!("nomoreide-link-{}", std::process::id()));
        let directory = root.join(".vercel");
        tokio::fs::create_dir_all(&directory).await.unwrap();
        tokio::fs::write(directory.join("project.json"), "not json")
            .await
            .unwrap();
        let link = LinkFile {
            path: &[".vercel", "project.json"],
            field: "projectId",
        };
        assert_eq!(read_linked_project_id(&root, &link).await, None);

        tokio::fs::write(
            directory.join("project.json"),
            r#"{"projectId":"  prj_1  "}"#,
        )
        .await
        .unwrap();
        assert_eq!(
            read_linked_project_id(&root, &link).await,
            Some("prj_1".into())
        );

        // Present but blank is not a link; the next rung of the ladder answers.
        tokio::fs::write(directory.join("project.json"), r#"{"projectId":"   "}"#)
            .await
            .unwrap();
        assert_eq!(read_linked_project_id(&root, &link).await, None);

        tokio::fs::remove_dir_all(&root).await.ok();
    }
}
