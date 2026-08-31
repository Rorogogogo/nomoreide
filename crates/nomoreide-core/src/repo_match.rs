//! Which registered repository a working directory belongs to.
//!
//! Rust counterpart of `src/core/repo-match.ts`. Deliberately strict: an
//! ambiguous or nested match is refused rather than resolved to one of the
//! candidates, because the answer decides which GitHub account a push or a
//! commit is attributed to. Guessing there would be worse than refusing.
//!
//! Its own module so the GitHub API context and the commit/push identity path
//! share one definition without importing each other.

use crate::config::{Config, GitRepoDef};
use anyhow::Result;
use std::path::{Path, PathBuf};
use tokio::process::Command;

pub async fn match_registered_repository<'a>(
    config: &'a Config,
    top_level: &str,
) -> Result<Option<&'a GitRepoDef>> {
    let target = canonical(top_level).await;

    // A repository is reachable by its own path and by whichever worktree is
    // selected for it, and either one identifies it.
    let mut candidates: Vec<(&GitRepoDef, PathBuf)> = Vec::new();
    for repository in &config.git_repositories {
        for root in [
            Some(repository.path.as_str()),
            repository.active_worktree_path.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            candidates.push((repository, canonical(root).await));
        }
    }

    let exact: Vec<&GitRepoDef> = candidates
        .iter()
        .filter(|(_, root)| root == &target)
        .map(|(repository, _)| *repository)
        .collect();
    let mut names: Vec<&str> = exact.iter().map(|r| r.name.as_str()).collect();
    names.sort_unstable();
    names.dedup();
    match names.len() {
        1 => return Ok(exact.first().copied()),
        0 => {}
        _ => anyhow::bail!("The Git repository matches multiple registered projects."),
    }

    if candidates
        .iter()
        .any(|(_, root)| path_contains(root, &target))
    {
        anyhow::bail!("This nested Git repository is not registered with its own GitHub account.");
    }
    Ok(None)
}

/// The root of the working tree containing `path`, or None when there is none.
pub async fn git_toplevel(path: &str) -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(path)
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let top = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!top.is_empty()).then_some(top)
}

async fn canonical(path: &str) -> PathBuf {
    tokio::fs::canonicalize(path)
        .await
        .unwrap_or_else(|_| PathBuf::from(path))
}

/// Whether `candidate` is `root` or sits inside it.
fn path_contains(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn config(repos: Vec<GitRepoDef>) -> Config {
        Config {
            git_repositories: repos,
            ..Config::default()
        }
    }

    #[tokio::test]
    async fn matches_a_repository_by_its_path_or_its_selected_worktree() {
        let config = config(vec![repo(
            "app",
            "/repos/app",
            Some("/worktrees/app/feature"),
        )]);
        assert_eq!(
            match_registered_repository(&config, "/repos/app")
                .await
                .unwrap()
                .map(|r| r.name.as_str()),
            Some("app")
        );
        assert_eq!(
            match_registered_repository(&config, "/worktrees/app/feature")
                .await
                .unwrap()
                .map(|r| r.name.as_str()),
            Some("app")
        );
    }

    #[tokio::test]
    async fn an_unregistered_directory_matches_nothing() {
        let config = config(vec![repo("app", "/repos/app", None)]);
        assert!(match_registered_repository(&config, "/repos/other")
            .await
            .unwrap()
            .is_none());
    }

    /// Two registrations of one directory cannot be told apart, and picking
    /// either would attribute a commit to an account the user did not choose.
    #[tokio::test]
    async fn two_projects_on_one_directory_are_refused_rather_than_guessed() {
        let config = config(vec![
            repo("app", "/repos/app", None),
            repo("app-mirror", "/repos/app", None),
        ]);
        assert_eq!(
            match_registered_repository(&config, "/repos/app")
                .await
                .unwrap_err()
                .to_string(),
            "The Git repository matches multiple registered projects."
        );
    }

    /// One project registered twice — by path and by worktree — is still one
    /// project, so it resolves rather than being called ambiguous.
    #[tokio::test]
    async fn one_project_reachable_two_ways_is_not_ambiguous() {
        let config = config(vec![repo("app", "/repos/app", Some("/repos/app"))]);
        assert_eq!(
            match_registered_repository(&config, "/repos/app")
                .await
                .unwrap()
                .map(|r| r.name.as_str()),
            Some("app")
        );
    }

    #[tokio::test]
    async fn a_nested_repository_is_refused_rather_than_borrowing_its_parents_account() {
        let config = config(vec![repo("app", "/repos/app", None)]);
        assert_eq!(
            match_registered_repository(&config, "/repos/app/vendor/lib")
                .await
                .unwrap_err()
                .to_string(),
            "This nested Git repository is not registered with its own GitHub account."
        );
        // A sibling whose name merely starts the same is not inside it.
        assert!(match_registered_repository(&config, "/repos/app-tools")
            .await
            .unwrap()
            .is_none());
    }
}
