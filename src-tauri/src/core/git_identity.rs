//! Commit identity derived from the GitHub account selected for a repository.
//!
//! Rust counterpart of `src/core/git-identity.ts`. The account switcher governs
//! the GitHub API (pull requests, issues, CI) while plain `git commit` would
//! otherwise use the machine's `user.email` — letting a commit be authored by
//! one account and its pull request opened by another with nothing saying so.
//!
//! Scoped to the repository on purpose: `gh auth switch` would change identity
//! for every terminal and every other repo on the machine.

use crate::core::config::{
    Config, ConfigStore, GitRepoDef, GithubCredentialSelection, GithubIdentityDef,
};
use crate::core::github_auth;
use serde::Serialize;
use std::collections::HashMap;
use tokio::process::Command;

/// What `git config user.*` resolves to in a working tree.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineIdentity {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentityState {
    /// Identity commits will carry, or None when the machine's config governs.
    pub selected: Option<GithubIdentityDef>,
    pub machine: MachineIdentity,
    /// True when a commit here would carry an author the machine does not use.
    pub diverged: bool,
    /// Why `selected` is None — the UI explains the fallback rather than hiding it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Environment that pins a commit's author and committer. Passed per command
/// rather than written to `git config`, so nothing about the machine changes.
pub fn identity_env(identity: &GithubIdentityDef) -> HashMap<String, String> {
    HashMap::from([
        ("GIT_AUTHOR_NAME".into(), identity.name.clone()),
        ("GIT_AUTHOR_EMAIL".into(), identity.email.clone()),
        ("GIT_COMMITTER_NAME".into(), identity.name.clone()),
        ("GIT_COMMITTER_EMAIL".into(), identity.email.clone()),
    ])
}

pub async fn resolve_identity_state(
    store: &ConfigStore,
    config: &Config,
    repository: Option<&GitRepoDef>,
    cwd: &str,
) -> GitIdentityState {
    let machine = machine_identity(cwd).await;

    let Some(repository) = repository else {
        return GitIdentityState {
            selected: None,
            machine,
            diverged: false,
            reason: Some("No GitHub account is selected for this repository.".into()),
        };
    };
    if repository.github_credential.is_none() {
        return GitIdentityState {
            selected: None,
            machine,
            diverged: false,
            reason: Some("No GitHub account is selected for this repository.".into()),
        };
    }

    match resolve_selected_identity(store, config, repository).await {
        Ok(selected) => {
            let diverged = is_diverged(&selected, &machine);
            GitIdentityState {
                selected: Some(selected),
                machine,
                diverged,
                reason: None,
            }
        }
        Err(reason) => GitIdentityState {
            selected: None,
            machine,
            diverged: false,
            reason: Some(reason),
        },
    }
}

/// Identity for the repository's selected account, from the config cache when
/// possible and the GitHub API otherwise.
pub async fn resolve_selected_identity(
    store: &ConfigStore,
    config: &Config,
    repository: &GitRepoDef,
) -> Result<GithubIdentityDef, String> {
    let selection = repository
        .github_credential
        .as_ref()
        .ok_or("No GitHub account is selected for this repository.")?;

    let (host, known_login) = match selection {
        GithubCredentialSelection::Gh { host, login } => (host.clone(), Some(login.clone())),
        GithubCredentialSelection::Stored { host } => (
            host.clone(),
            config
                .github_tokens
                .iter()
                .find(|entry| &entry.host == host)
                .and_then(|entry| entry.login.clone()),
        ),
    };

    if let Some(login) = &known_login {
        if let Some(cached) = store.get_github_identity(config, &host, login) {
            return Ok(cached.clone());
        }
    }

    let (token, _, _) = github_auth::resolve(config, Some(&repository.name), &host).await?;
    let viewer = fetch_viewer(&token, &host).await?;
    let login = viewer
        .login
        .or(known_login)
        .ok_or("GitHub did not report an account login for the selected credential.")?;

    let identity = GithubIdentityDef {
        host,
        name: viewer
            .name
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| login.clone()),
        email: commit_email(viewer.email.as_deref(), viewer.id, &login),
        login,
    };
    store
        .set_github_identity(identity.clone())
        .await
        .map_err(|error| error.to_string())?;
    Ok(identity)
}

/// Token to push the selected account with, or None to leave the machine's
/// credential helper in charge.
///
/// None for SSH remotes on purpose: authentication there comes from a key, and
/// no token can change which key `ssh` offers.
pub async fn resolve_push_credential(
    config: &Config,
    repository: Option<&GitRepoDef>,
    remote_url: Option<&str>,
) -> Option<(String, Option<String>)> {
    let repository = repository?;
    let selection = repository.github_credential.as_ref()?;
    let selected_host = match selection {
        GithubCredentialSelection::Gh { host, .. } => host,
        GithubCredentialSelection::Stored { host } => host,
    };
    let host = https_remote_host(remote_url?)?;
    if &host != selected_host {
        return None;
    }

    let (token, _, resolved) = github_auth::resolve(config, Some(&repository.name), &host)
        .await
        .ok()?;
    let login = match resolved {
        GithubCredentialSelection::Gh { login, .. } => Some(login),
        GithubCredentialSelection::Stored { .. } => None,
    };
    Some((token, login))
}

/// Host of an HTTPS git remote, or None when the remote is SSH or unparseable.
pub fn https_remote_host(remote_url: &str) -> Option<String> {
    let trimmed = remote_url.trim();
    let rest = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))?;
    let authority = rest.split('/').next()?;
    // Strip any userinfo and port so the comparison is host-only.
    let host = authority.rsplit('@').next()?.split(':').next()?;
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

/// The address a commit should carry. GitHub's own address is preferred over a
/// guess; the id-qualified `noreply` form still attributes the commit when the
/// account keeps its email private.
pub fn commit_email(public_email: Option<&str>, id: Option<u64>, login: &str) -> String {
    if let Some(email) = public_email.map(str::trim).filter(|v| !v.is_empty()) {
        return email.to_string();
    }
    match id {
        Some(id) => format!("{id}+{login}@users.noreply.github.com"),
        None => format!("{login}@users.noreply.github.com"),
    }
}

pub async fn machine_identity(cwd: &str) -> MachineIdentity {
    MachineIdentity {
        name: git_config_value(cwd, "user.name").await,
        email: git_config_value(cwd, "user.email").await,
    }
}

fn is_diverged(selected: &GithubIdentityDef, machine: &MachineIdentity) -> bool {
    match machine.email.as_deref().map(str::trim) {
        Some(configured) if !configured.is_empty() => {
            !configured.eq_ignore_ascii_case(selected.email.trim())
        }
        _ => true,
    }
}

struct Viewer {
    login: Option<String>,
    name: Option<String>,
    email: Option<String>,
    id: Option<u64>,
}

async fn fetch_viewer(token: &str, host: &str) -> Result<Viewer, String> {
    let url = if host == "github.com" || host.is_empty() {
        "https://api.github.com/user".to_string()
    } else {
        format!("https://{host}/api/v3/user")
    };
    let response = reqwest::Client::new()
        .get(&url)
        .header("Authorization", format!("token {token}"))
        .header("User-Agent", "nomoreide")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "GitHub rejected the credential while resolving the commit identity ({}).",
            response.status()
        ));
    }
    let body: serde_json::Value = response.json().await.map_err(|error| error.to_string())?;
    Ok(Viewer {
        login: body
            .get("login")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        name: body
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        email: body
            .get("email")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        id: body.get("id").and_then(|v| v.as_u64()),
    })
}

async fn git_config_value(cwd: &str, key: &str) -> Option<String> {
    // `git config --get` exits non-zero when the key is unset — an unconfigured
    // machine identity is a normal state here, not a failure.
    let out = Command::new("git")
        .args(["config", "--get", key])
        .current_dir(cwd)
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::config::{GitRepoDef, GithubTokenDef};

    #[test]
    fn prefers_the_accounts_public_address() {
        assert_eq!(
            commit_email(Some("dev@example.com"), Some(42), "octocat"),
            "dev@example.com"
        );
    }

    #[test]
    fn falls_back_to_the_id_qualified_noreply_address() {
        assert_eq!(
            commit_email(None, Some(42), "octocat"),
            "42+octocat@users.noreply.github.com"
        );
        assert_eq!(
            commit_email(Some("  "), None, "octocat"),
            "octocat@users.noreply.github.com"
        );
    }

    #[test]
    fn parses_only_https_remote_hosts() {
        assert_eq!(
            https_remote_host("https://github.com/acme/app.git").as_deref(),
            Some("github.com")
        );
        assert_eq!(
            https_remote_host("https://user@github.com:443/acme/app.git").as_deref(),
            Some("github.com")
        );
        // SSH remotes authenticate with a key, so no token can re-attribute them.
        assert!(https_remote_host("git@github.com:acme/app.git").is_none());
        assert!(https_remote_host("ssh://git@github.com/acme/app.git").is_none());
        assert!(https_remote_host("/local/path/repo.git").is_none());
    }

    #[test]
    fn identity_env_pins_author_and_committer() {
        let env = identity_env(&identity("octocat", "octo@example.com"));
        assert_eq!(env["GIT_AUTHOR_EMAIL"], "octo@example.com");
        assert_eq!(env["GIT_COMMITTER_EMAIL"], "octo@example.com");
        assert_eq!(env["GIT_AUTHOR_NAME"], "Octo Cat");
    }

    #[test]
    fn divergence_compares_email_case_insensitively() {
        let selected = identity("work", "Work@example.test");
        assert!(!is_diverged(
            &selected,
            &MachineIdentity {
                name: None,
                email: Some("work@example.test".into()),
            }
        ));
        assert!(is_diverged(
            &selected,
            &MachineIdentity {
                name: None,
                email: Some("other@example.test".into()),
            }
        ));
        // An unconfigured machine identity counts as divergence — the commit
        // would otherwise be authored by whatever git falls back to.
        assert!(is_diverged(&selected, &MachineIdentity::default()));
    }

    #[tokio::test]
    async fn push_credential_declines_ssh_and_mismatched_hosts() {
        let mut config = Config::default();
        config.github_tokens.push(GithubTokenDef {
            host: "github.com".into(),
            token: "token".into(),
            login: Some("work".into()),
            avatar_url: None,
        });
        let repo = GitRepoDef {
            name: "app".into(),
            path: "/tmp/app".into(),
            active_worktree_path: None,
            github_credential: Some(GithubCredentialSelection::Stored {
                host: "github.com".into(),
            }),
            provider_projects: None,
            legacy_vercel_project_id: None,
        };

        assert!(
            resolve_push_credential(&config, Some(&repo), Some("git@github.com:acme/app.git"))
                .await
                .is_none()
        );
        assert!(
            resolve_push_credential(&config, Some(&repo), Some("https://gitlab.com/a/b.git"))
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn push_credential_declines_when_no_account_is_selected() {
        let config = Config::default();
        let repo = GitRepoDef {
            name: "app".into(),
            path: "/tmp/app".into(),
            active_worktree_path: None,
            github_credential: None,
            provider_projects: None,
            legacy_vercel_project_id: None,
        };

        assert!(
            resolve_push_credential(&config, Some(&repo), Some("https://github.com/a/b.git"))
                .await
                .is_none()
        );
    }

    fn identity(login: &str, email: &str) -> GithubIdentityDef {
        GithubIdentityDef {
            host: "github.com".into(),
            login: login.into(),
            name: "Octo Cat".into(),
            email: email.into(),
        }
    }
}
