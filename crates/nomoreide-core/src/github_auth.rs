use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

use super::config::{Config, GithubCredentialSelection};
use super::process_manager::service_path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubCliAccount {
    pub host: String,
    pub login: String,
    pub active: bool,
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubCliAccounts {
    pub available: bool,
    pub accounts: Vec<GithubCliAccount>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub async fn list_accounts() -> GithubCliAccounts {
    match run_gh(&["auth", "status", "--json", "hosts"]).await {
        Ok(stdout) => match parse_accounts(&stdout) {
            Ok(accounts) => GithubCliAccounts {
                available: true,
                accounts,
                error: None,
            },
            Err(error) => GithubCliAccounts {
                available: false,
                accounts: vec![],
                error: Some(error),
            },
        },
        Err(error) => GithubCliAccounts {
            available: false,
            accounts: vec![],
            error: Some(error),
        },
    }
}

pub async fn token(host: &str, login: &str) -> Result<String, String> {
    validate_identity(host, login)?;
    let value = run_gh(&["auth", "token", "--hostname", host, "--user", login])
        .await
        .map_err(|_| format!(
            "GitHub CLI could not provide credentials for @{login} on {host}. Re-authenticate with gh auth login or choose another account."
        ))?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("GitHub CLI returned an empty token.".into());
    }
    Ok(trimmed.to_string())
}

pub async fn resolve(
    config: &Config,
    repository: Option<&str>,
    remote_host: &str,
) -> Result<(String, String, GithubCredentialSelection), String> {
    let selection = repository
        .and_then(|name| {
            config
                .git_repositories
                .iter()
                .find(|repo| repo.name == name)
        })
        .and_then(|repo| repo.github_credential.clone());

    match selection {
        Some(GithubCredentialSelection::Gh { host, login }) => {
            if host != remote_host {
                return Err(format!("The selected GitHub credential is for {host}, but this repository uses {remote_host}."));
            }
            let value = token(&host, &login).await?;
            Ok((
                value,
                host.clone(),
                GithubCredentialSelection::Gh { host, login },
            ))
        }
        Some(GithubCredentialSelection::Stored { host }) => {
            if host != remote_host {
                return Err(format!("The selected GitHub credential is for {host}, but this repository uses {remote_host}."));
            }
            // Named in the refusal, because a repository that picked this host
            // is telling the user which one to connect.
            let value = stored_token(config, &host, true)?;
            Ok((
                value,
                host.clone(),
                GithubCredentialSelection::Stored { host },
            ))
        }
        None => {
            let value = stored_token(config, remote_host, false)?;
            Ok((
                value,
                remote_host.to_string(),
                GithubCredentialSelection::Stored {
                    host: remote_host.to_string(),
                },
            ))
        }
    }
}

/// The stored token for `host`.
///
/// `name_the_host` decides how a missing one reads: a repository that chose a
/// stored credential is told which host it chose, and a repository that chose
/// nothing is only told that nothing is connected — naming a host it never
/// picked would look like a setting it had got wrong.
fn stored_token(config: &Config, host: &str, name_the_host: bool) -> Result<String, String> {
    config
        .github_tokens
        .iter()
        .find(|entry| entry.host == host)
        .map(|entry| entry.token.clone())
        .ok_or_else(|| {
            let suffix = if name_the_host {
                format!(" for {host}")
            } else {
                String::new()
            };
            format!(
                "No stored GitHub token configured{suffix}. Choose a GitHub CLI account or connect GitHub."
            )
        })
}

fn parse_accounts(raw: &str) -> Result<Vec<GithubCliAccount>, String> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|_| "GitHub CLI returned an unsupported account response.".to_string())?;
    let hosts = value
        .get("hosts")
        .and_then(Value::as_object)
        .ok_or("GitHub CLI returned an unsupported account response.")?;
    let mut result = Vec::new();
    for (host, entries) in hosts {
        let Some(entries) = entries.as_array() else {
            continue;
        };
        for entry in entries {
            let Some(login) = entry.get("login").and_then(Value::as_str) else {
                continue;
            };
            let entry_host = entry.get("host").and_then(Value::as_str).unwrap_or(host);
            if login.trim().is_empty() || entry_host.trim().is_empty() {
                continue;
            }
            result.push(GithubCliAccount {
                host: entry_host.to_string(),
                login: login.to_string(),
                active: entry
                    .get("active")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                state: entry
                    .get("state")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
            });
        }
    }
    Ok(result)
}

async fn run_gh(args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("gh");
    command
        .args(args)
        .env("PATH", service_path())
        .env("GH_PROMPT_DISABLED", "1")
        .env_remove("GH_TOKEN")
        .env_remove("GITHUB_TOKEN")
        .env_remove("GH_ENTERPRISE_TOKEN")
        .env_remove("GITHUB_ENTERPRISE_TOKEN");
    let output = timeout(Duration::from_secs(5), command.output())
        .await
        .map_err(|_| "GitHub CLI account discovery timed out.".to_string())?
        .map_err(|_| "GitHub CLI is not installed or is not available on PATH.".to_string())?;
    if !output.status.success() && output.stdout.is_empty() {
        return Err(
            "GitHub CLI account discovery is unavailable. Update gh and run gh auth login.".into(),
        );
    }
    String::from_utf8(output.stdout).map_err(|_| "GitHub CLI returned invalid output.".into())
}

fn validate_identity(host: &str, login: &str) -> Result<(), String> {
    if host.trim().is_empty()
        || login.trim().is_empty()
        || host.chars().chain(login.chars()).any(|c| c.is_control())
    {
        return Err("Invalid GitHub host or account login.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{GitRepoDef, GithubTokenDef};

    #[test]
    fn parses_multiple_accounts() {
        let accounts = parse_accounts(r#"{"hosts":{"github.com":[{"login":"work","host":"github.com","active":true,"state":"success"},{"login":"personal","active":false,"state":"error"}]}}"#).unwrap();
        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0].login, "work");
        assert_eq!(accounts[1].host, "github.com");
    }

    #[tokio::test]
    async fn legacy_fallback_uses_the_remote_host_not_token_order() {
        let config = Config {
            github_tokens: vec![
                GithubTokenDef {
                    host: "enterprise.example".into(),
                    token: "enterprise".into(),
                    login: None,
                    avatar_url: None,
                },
                GithubTokenDef {
                    host: "github.com".into(),
                    token: "public".into(),
                    login: None,
                    avatar_url: None,
                },
            ],
            ..Config::default()
        };
        let resolved = resolve(&config, None, "github.com").await.unwrap();
        assert_eq!(resolved.0, "public");
        assert_eq!(resolved.1, "github.com");
    }

    #[tokio::test]
    async fn explicit_selection_rejects_a_different_remote_host() {
        let mut config = Config::default();
        config.git_repositories.push(GitRepoDef {
            name: "app".into(),
            path: "/tmp/app".into(),
            active_worktree_path: None,
            github_credential: Some(GithubCredentialSelection::Stored {
                host: "enterprise.example".into(),
            }),
            provider_projects: None,
            legacy_vercel_project_id: None,
        });
        let error = resolve(&config, Some("app"), "github.com")
            .await
            .unwrap_err();
        assert!(error.contains("enterprise.example"));
        assert!(error.contains("github.com"));
    }
}
