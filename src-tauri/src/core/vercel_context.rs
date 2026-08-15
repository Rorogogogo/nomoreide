//! Resolves "which Vercel account and project does this repository mean" —
//! the Rust counterpart of `src/core/vercel-context.ts`.

use serde_json::Value;
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::process::Command;

use super::config::{Config, ConfigStore, LEGACY_PROVIDER_ID};
use super::vercel_actions::VercelActions;
use super::vercel_auth::{resolve, ResolvedCredential};
use super::vercel_manager::{repo_url, Identity, VercelManager};

pub struct VercelContext {
    pub manager: VercelManager,
    pub credential: ResolvedCredential,
    /// Absent when connected but no project is linked to this repo yet.
    pub project: Option<Value>,
}

/// A connected Vercel client for the given working directory.
///
/// Fails when Vercel isn't connected — a missing *project* is not an error,
/// because the dashboard's job in that state is to help the user pick one.
pub async fn require_context(
    store: &ConfigStore,
    config: &Config,
    git_cwd: &str,
) -> Result<VercelContext, String> {
    let credential = resolve(store, config).await?;
    let identity = if credential.is_oauth() {
        Identity::Oidc
    } else {
        Identity::User
    };

    let team_id = match credential.team_id.clone() {
        Some(team_id) => Some(team_id),
        None => adopt_default_team(store, &credential, identity).await,
    };
    let manager = VercelManager::new(credential.token.clone(), team_id.clone(), identity);
    let project = resolve_project(config, &manager, git_cwd).await;

    Ok(VercelContext {
        manager,
        credential: ResolvedCredential {
            team_id,
            ..credential
        },
        project,
    })
}

/// Write-capable counterpart, resolved the same way but returned separately so
/// the read/write split is visible at the call site.
pub async fn require_actions(
    store: &ConfigStore,
    config: &Config,
) -> Result<VercelActions, String> {
    let credential = resolve(store, config).await?;
    Ok(VercelActions::new(super::vercel_manager::RequestAuth {
        token: credential.token,
        team_id: credential.team_id,
    }))
}

/// The team scope to use when the user has never chosen one.
///
/// Vercel puts a personal account's projects under an implicit "<name>'s
/// projects" team, not under the account itself, so an unscoped client lists
/// nothing at all — which reads as "no projects" rather than "wrong scope". A
/// `cli` connection avoids this by inheriting the CLI's own scope; a browser
/// sign-in or a pasted token has nothing to inherit, so the sole team is
/// adopted here and persisted, making this a one-time lookup.
///
/// With several teams there is no unambiguous answer, so none is chosen and the
/// dashboard's team switcher is left to ask.
async fn adopt_default_team(
    store: &ConfigStore,
    credential: &ResolvedCredential,
    identity: Identity,
) -> Option<String> {
    // A `cli` connection follows the CLI's own scope, so persisting one here
    // would override `vercel switch` from then on.
    if credential.source == "cli" {
        return None;
    }
    let teams = VercelManager::new(credential.token.clone(), None, identity)
        .list_teams()
        .await
        .ok()?;
    if teams.len() != 1 {
        return None;
    }
    let team = teams.first()?;
    let id = team.get("id").and_then(Value::as_str)?.to_string();
    let slug = team.get("slug").and_then(Value::as_str).map(str::to_string);
    store
        .set_connection_scope(LEGACY_PROVIDER_ID, Some(id.clone()), slug)
        .await
        .ok()?;
    Some(id)
}

/// Which Vercel project this repository deploys, in order of confidence:
///
/// 1. an explicit pin the user chose in the dashboard;
/// 2. `.vercel/project.json`, written by `vercel link` — the same file the CLI
///    trusts, so a linked repo needs no configuration here at all;
/// 3. a lookup by the repo's git remote, which is how Vercel itself keys an
///    imported project.
///
/// Returns None rather than guessing when none of those answer, since the wrong
/// project would show deployments for unrelated code.
async fn resolve_project(config: &Config, manager: &VercelManager, git_cwd: &str) -> Option<Value> {
    let top_level = git_top_level(git_cwd)
        .await
        .unwrap_or_else(|| git_cwd.to_string());

    let pinned = config
        .git_repositories
        .iter()
        .find(|repo| {
            let path = repo.active_worktree_path.as_ref().unwrap_or(&repo.path);
            path == &top_level || repo.path == top_level
        })
        .and_then(|repo| {
            repo.provider_projects
                .as_ref()
                .and_then(|projects| projects.get(LEGACY_PROVIDER_ID).cloned())
        });
    if let Some(pinned) = pinned {
        if let Ok(project) = manager.get_project(&pinned).await {
            return Some(project);
        }
    }

    if let Some(linked) = read_linked_project_id(Path::new(&top_level)).await {
        if let Ok(project) = manager.get_project(&linked).await {
            return Some(project);
        }
    }

    let remote = git_remote_url(&top_level).await?;
    let url = repo_url(&remote)?;
    manager
        .list_projects(None, Some(&url), Some(2))
        .await
        .ok()?
        .into_iter()
        .next()
}

/// `projectId` from `.vercel/project.json`, when the repo has been `vercel link`ed.
pub async fn read_linked_project_id(repo_root: &Path) -> Option<String> {
    let path: PathBuf = repo_root.join(".vercel").join("project.json");
    let raw = fs::read_to_string(path).await.ok()?;
    serde_json::from_str::<Value>(&raw)
        .ok()?
        .get("projectId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

async fn git_top_level(cwd: &str) -> Option<String> {
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(cwd)
        .output()
        .await
        .ok()?;
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

async fn git_remote_url(cwd: &str) -> Option<String> {
    let output = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(cwd)
        .output()
        .await
        .ok()?;
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

/// The working directory Vercel operations run against — mirrors the GitHub seam.
pub fn selected_cwd(config: &Config, fallback: &str) -> String {
    let repository = config
        .selected_git_repository
        .as_ref()
        .and_then(|name| {
            config
                .git_repositories
                .iter()
                .find(|repo| &repo.name == name)
        })
        .or_else(|| config.git_repositories.first());
    repository
        .map(|repo| {
            repo.active_worktree_path
                .clone()
                .unwrap_or_else(|| repo.path.clone())
        })
        .unwrap_or_else(|| fallback.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::config::GitRepoDef;

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
        assert_eq!(selected_cwd(&config, "/fallback"), "/repos/app-wt");
    }

    #[test]
    fn an_unregistered_selection_falls_back_to_the_first_repository() {
        let mut config = Config::default();
        config
            .git_repositories
            .push(repo("app", "/repos/app", None));
        config.selected_git_repository = Some("missing".into());
        assert_eq!(selected_cwd(&config, "/fallback"), "/repos/app");
    }

    #[test]
    fn with_no_repositories_at_all_the_fallback_is_used() {
        assert_eq!(selected_cwd(&Config::default(), "/fallback"), "/fallback");
    }
}
