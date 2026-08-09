use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::fs;

// ---------------------------------------------------------------------------
// Data types (mirror the TypeScript Zod schemas)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDef {
    pub name: String,
    /// "local" | "docker-compose" | "ssh" — absent means "local"
    #[serde(default = "default_local_kind")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub test: Option<String>,
    /// Services that must start before this one (bundle start order). Preserved
    /// on round-trip; ordering itself is enforced by the Node backend today.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depends_on: Option<Vec<String>>,
    // docker-compose fields
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compose_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compose_service: Option<String>,
    // ssh fields
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
}

fn default_local_kind() -> String {
    "local".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BundleDef {
    pub name: String,
    pub services: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoDef {
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_worktree_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub github_credential: Option<GithubCredentialSelection>,
    /// Vercel project this repository deploys, when the user pinned one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vercel_project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "source", rename_all = "lowercase")]
pub enum GithubCredentialSelection {
    Gh { host: String, login: String },
    Stored { host: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseDef {
    pub name: String,
    pub engine: String, // "postgres" | "mysql" | "sqlite"
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write_unlocked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogSourceDef {
    pub name: String,
    pub kind: String, // "file" | "ssh" | "command"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub driver: Option<String>, // "journald" | "docker"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SshServerDef {
    pub host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GithubTokenDef {
    pub host: String,
    pub token: String,
    /// Account the token belongs to, captured by the Node side at connect time.
    /// Carried through here so a desktop-side config write does not drop it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

/// Commit author/committer for a GitHub account, resolved once and cached so
/// committing does not spend an API call per commit. Shares the
/// `githubIdentities` key with the Node side.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GithubIdentityDef {
    pub host: String,
    pub login: String,
    pub name: String,
    pub email: String,
}

/// How the Vercel integration authenticates. Mirrors the TypeScript
/// `VercelConnection`: `cli` holds no secret (the token is re-read from the
/// Vercel CLI's own auth file), `stored` carries a pasted token, and `oauth` is
/// the browser sign-in whose access token expires hourly and is renewed from
/// `refresh_token`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VercelConnectionDef {
    /// "cli" | "stored" | "oauth"
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    /// `oauth` only: renews `token`, and is itself rotated on every use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// `oauth` only: epoch ms at which `token` expires.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    /// `oauth` only: the registered client the tokens belong to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_slug: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub version: u32,
    #[serde(default)]
    pub services: Vec<ServiceDef>,
    #[serde(default)]
    pub bundles: Vec<BundleDef>,
    #[serde(default)]
    pub git_repositories: Vec<GitRepoDef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_git_repository: Option<String>,
    /// Ordered repo names pinned to the board; None = show all; Some([]) = board cleared.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_board_repositories: Option<Vec<String>>,
    #[serde(default)]
    pub databases: Vec<DatabaseDef>,
    #[serde(default)]
    pub log_sources: Vec<LogSourceDef>,
    /// Saved SSH server metadata. Keys remain in ~/.ssh/config / ssh-agent.
    #[serde(default)]
    pub ssh_servers: Vec<SshServerDef>,
    #[serde(default)]
    pub github_tokens: Vec<GithubTokenDef>,
    #[serde(default)]
    pub github_identities: Vec<GithubIdentityDef>,
    /// How the Vercel integration authenticates; absent = not connected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vercel: Option<VercelConnectionDef>,
    #[serde(default)]
    pub workflows: Vec<serde_json::Value>,
    /// Node-owned keys the desktop never reads but must not destroy. `save()`
    /// serializes this whole struct, so a field missing here is a field deleted
    /// from the shared config the next time the desktop writes it.
    #[serde(default)]
    pub workflow_triggers: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferences: Option<serde_json::Value>,
    /// Which CLI the in-dock agent chat drives ("claude" | "codex"). None = never
    /// chosen → fall back to detection. Shares the `chatProvider` key with Node.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_provider: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            version: 1,
            services: vec![],
            bundles: vec![],
            git_repositories: vec![],
            selected_git_repository: None,
            git_board_repositories: None,
            databases: vec![],
            log_sources: vec![],
            ssh_servers: vec![],
            github_tokens: vec![],
            github_identities: vec![],
            vercel: None,
            workflows: vec![],
            workflow_triggers: vec![],
            preferences: None,
            chat_provider: None,
        }
    }
}

// ---------------------------------------------------------------------------
// ConfigStore
// ---------------------------------------------------------------------------

/// Clone is cheap and meaningful: the store is a path plus the file behind it,
/// so a clone is the same store, not a second copy of the config.
#[derive(Clone)]
pub struct ConfigStore {
    path: PathBuf,
}

impl ConfigStore {
    pub fn new(path: PathBuf) -> Self {
        ConfigStore { path }
    }

    pub fn default_path() -> PathBuf {
        let base = std::env::var("XDG_CONFIG_HOME")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(".config")
            });
        base.join("nomoreide").join("config.json")
    }

    pub async fn load(&self) -> Result<Config> {
        match fs::read_to_string(&self.path).await {
            Ok(raw) => {
                let config: Config =
                    serde_json::from_str(&raw).context("Failed to parse config.json")?;
                Ok(config)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
            Err(e) => Err(e).context("Failed to read config.json"),
        }
    }

    pub async fn save(&self, config: &Config) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .await
                .context("Failed to create config dir")?;
        }
        let json = serde_json::to_string_pretty(config).context("Failed to serialize config")?;
        fs::write(&self.path, format!("{json}\n"))
            .await
            .context("Failed to write config.json")
    }

    pub async fn register_service(&self, service: ServiceDef) -> Result<Config> {
        let mut config = self.load().await?;
        config.services.retain(|s| s.name != service.name);
        config.services.push(service);
        self.save(&config).await?;
        Ok(config)
    }

    pub async fn remove_service(&self, name: &str) -> Result<Config> {
        let mut config = self.load().await?;
        config.services.retain(|s| s.name != name);
        config
            .bundles
            .iter_mut()
            .for_each(|b| b.services.retain(|s| s != name));
        self.save(&config).await?;
        Ok(config)
    }

    pub async fn register_bundle(&self, bundle: BundleDef) -> Result<Config> {
        let mut config = self.load().await?;
        config.bundles.retain(|b| b.name != bundle.name);
        config.bundles.push(bundle);
        self.save(&config).await?;
        Ok(config)
    }

    pub async fn register_git_repository(&self, mut repo: GitRepoDef) -> Result<Config> {
        let mut config = self.load().await?;
        let existing = config.git_repositories.iter().find(|r| r.name == repo.name);
        if repo.github_credential.is_none() {
            repo.github_credential = existing.and_then(|r| r.github_credential.clone());
        }
        if repo.vercel_project_id.is_none() {
            repo.vercel_project_id = existing.and_then(|r| r.vercel_project_id.clone());
        }
        config.git_repositories.retain(|r| r.name != repo.name);
        config.git_repositories.push(repo);
        self.save(&config).await?;
        Ok(config)
    }

    pub async fn set_github_credential(
        &self,
        repository: &str,
        credential: GithubCredentialSelection,
    ) -> Result<Config> {
        let mut config = self.load().await?;
        let repo = config
            .git_repositories
            .iter_mut()
            .find(|r| r.name == repository)
            .ok_or_else(|| anyhow::anyhow!("Git repository \"{repository}\" is not registered."))?;
        repo.github_credential = Some(credential);
        self.save(&config).await?;
        Ok(config)
    }

    pub async fn remove_git_repository(&self, name: &str) -> Result<Config> {
        let mut config = self.load().await?;
        config.git_repositories.retain(|r| r.name != name);
        if config.selected_git_repository.as_deref() == Some(name) {
            config.selected_git_repository = None;
        }
        self.save(&config).await?;
        Ok(config)
    }

    pub async fn select_git_repository(&self, name: Option<String>) -> Result<Config> {
        let mut config = self.load().await?;
        config.selected_git_repository = name;
        self.save(&config).await?;
        Ok(config)
    }

    pub async fn select_git_worktree(&self, name: &str, path: String) -> Result<Config> {
        let mut config = self.load().await?;
        let repo = config
            .git_repositories
            .iter_mut()
            .find(|repo| repo.name == name)
            .context("Git repository is not registered")?;
        repo.active_worktree_path = Some(path);
        self.save(&config).await?;
        Ok(config)
    }

    pub async fn set_chat_provider(&self, provider: String) -> Result<Config> {
        let mut config = self.load().await?;
        config.chat_provider = Some(provider);
        self.save(&config).await?;
        Ok(config)
    }

    pub async fn set_git_board_repositories(&self, names: Vec<String>) -> Result<Config> {
        let mut config = self.load().await?;
        // Cap at 5, mirroring the UI's 5-column limit.
        let capped: Vec<String> = names.into_iter().take(5).collect();
        config.git_board_repositories = Some(capped);
        self.save(&config).await?;
        Ok(config)
    }

    pub async fn register_database(&self, db: DatabaseDef) -> Result<Config> {
        let mut config = self.load().await?;
        config.databases.retain(|d| d.name != db.name);
        config.databases.push(db);
        self.save(&config).await?;
        Ok(config)
    }

    pub async fn remove_database(&self, name: &str) -> Result<Config> {
        let mut config = self.load().await?;
        config.databases.retain(|d| d.name != name);
        self.save(&config).await?;
        Ok(config)
    }

    pub async fn set_database_write_access(&self, name: &str, unlocked: bool) -> Result<Config> {
        let mut config = self.load().await?;
        if let Some(db) = config.databases.iter_mut().find(|d| d.name == name) {
            db.write_unlocked = Some(unlocked);
        }
        self.save(&config).await?;
        Ok(config)
    }

    pub async fn set_github_token(&self, host: String, token: String) -> Result<Config> {
        let mut config = self.load().await?;
        // Preserve any identity captured for this host; only the secret changes.
        let previous = config
            .github_tokens
            .iter()
            .find(|t| t.host == host)
            .map(|t| (t.login.clone(), t.avatar_url.clone()));
        config.github_tokens.retain(|t| t.host != host);
        let (login, avatar_url) = previous.unwrap_or((None, None));
        config.github_tokens.push(GithubTokenDef {
            host,
            token,
            login,
            avatar_url,
        });
        self.save(&config).await?;
        Ok(config)
    }

    pub async fn remove_github_token(&self, host: &str) -> Result<Config> {
        let mut config = self.load().await?;
        config.github_tokens.retain(|t| t.host != host);
        self.save(&config).await?;
        Ok(config)
    }

    /// Cached account identity for a stored token, when one was captured.
    pub fn get_github_profile(
        &self,
        config: &Config,
        host: &str,
    ) -> Option<(String, Option<String>)> {
        config
            .github_tokens
            .iter()
            .find(|t| t.host == host)
            .and_then(|t| t.login.clone().map(|login| (login, t.avatar_url.clone())))
    }

    /// Attach identity to an already-stored token without touching the secret.
    pub async fn set_github_profile(
        &self,
        host: &str,
        login: String,
        avatar_url: Option<String>,
    ) -> Result<Config> {
        let mut config = self.load().await?;
        if let Some(entry) = config.github_tokens.iter_mut().find(|t| t.host == host) {
            entry.login = Some(login);
            entry.avatar_url = avatar_url;
        }
        self.save(&config).await?;
        Ok(config)
    }

    /// Cached commit identity for a GitHub account, when one has been resolved.
    pub fn get_github_identity<'a>(
        &self,
        config: &'a Config,
        host: &str,
        login: &str,
    ) -> Option<&'a GithubIdentityDef> {
        config
            .github_identities
            .iter()
            .find(|entry| entry.host == host && entry.login.eq_ignore_ascii_case(login))
    }

    pub async fn set_github_identity(&self, identity: GithubIdentityDef) -> Result<Config> {
        let mut config = self.load().await?;
        config.github_identities.retain(|entry| {
            entry.host != identity.host || !entry.login.eq_ignore_ascii_case(&identity.login)
        });
        config.github_identities.push(identity);
        self.save(&config).await?;
        Ok(config)
    }

    pub fn get_github_token<'a>(&self, config: &'a Config, host: &str) -> Option<&'a str> {
        config
            .github_tokens
            .iter()
            .find(|t| t.host == host)
            .map(|t| t.token.as_str())
    }

    /// Save how Vercel is connected. A `cli` connection deliberately drops any
    /// token, so `vercel logout` revokes us too instead of leaving a stale copy.
    pub async fn set_vercel_connection(
        &self,
        mut connection: VercelConnectionDef,
    ) -> Result<Config> {
        if connection.source == "cli" {
            connection.token = None;
            connection.refresh_token = None;
            connection.expires_at = None;
            connection.client_id = None;
        }
        let mut config = self.load().await?;
        config.vercel = Some(connection);
        self.save(&config).await?;
        Ok(config)
    }

    /// Replace the tokens of an existing `oauth` connection after a refresh.
    /// Separate from `set_vercel_connection` because it runs mid-request on an
    /// already-connected config and must not disturb the chosen scope.
    pub async fn update_vercel_tokens(
        &self,
        token: String,
        refresh_token: Option<String>,
        expires_at: i64,
    ) -> Result<Config> {
        let mut config = self.load().await?;
        if let Some(vercel) = config.vercel.as_mut() {
            if vercel.source == "oauth" {
                vercel.token = Some(token);
                // Vercel rotates refresh tokens; keep the previous one only if
                // this response did not carry a replacement.
                if refresh_token.is_some() {
                    vercel.refresh_token = refresh_token;
                }
                vercel.expires_at = Some(expires_at);
            }
        }
        self.save(&config).await?;
        Ok(config)
    }

    pub async fn set_vercel_scope(
        &self,
        team_id: Option<String>,
        team_slug: Option<String>,
    ) -> Result<Config> {
        let mut config = self.load().await?;
        let vercel = config
            .vercel
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("Vercel is not connected."))?;
        vercel.team_id = team_id;
        vercel.team_slug = team_slug;
        self.save(&config).await?;
        Ok(config)
    }

    pub async fn remove_vercel_connection(&self) -> Result<Config> {
        let mut config = self.load().await?;
        config.vercel = None;
        self.save(&config).await?;
        Ok(config)
    }

    /// Pin which Vercel project a registered repository deploys.
    pub async fn set_vercel_project(
        &self,
        repository: &str,
        project_id: Option<String>,
    ) -> Result<Config> {
        let mut config = self.load().await?;
        let repo = config
            .git_repositories
            .iter_mut()
            .find(|repo| repo.name == repository)
            .ok_or_else(|| anyhow::anyhow!("Git repository \"{repository}\" is not registered."))?;
        repo.vercel_project_id = project_id.filter(|id| !id.trim().is_empty());
        self.save(&config).await?;
        Ok(config)
    }

    pub async fn register_log_source(&self, source: LogSourceDef) -> Result<Config> {
        let mut config = self.load().await?;
        config.log_sources.retain(|s| s.name != source.name);
        config.log_sources.push(source);
        self.save(&config).await?;
        Ok(config)
    }

    pub async fn remove_log_source(&self, name: &str) -> Result<Config> {
        let mut config = self.load().await?;
        config.log_sources.retain(|s| s.name != name);
        self.save(&config).await?;
        Ok(config)
    }

    pub async fn save_workflow(&self, workflow: serde_json::Value) -> Result<Config> {
        let mut config = self.load().await?;
        let id = workflow
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        config
            .workflows
            .retain(|w| w.get("id").and_then(|v| v.as_str()).unwrap_or("") != id);
        config.workflows.push(workflow);
        self.save(&config).await?;
        Ok(config)
    }

    pub async fn remove_workflow(&self, id: &str) -> Result<Config> {
        let mut config = self.load().await?;
        config
            .workflows
            .retain(|w| w.get("id").and_then(|v| v.as_str()).unwrap_or("") != id);
        self.save(&config).await?;
        Ok(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `save()` serializes the whole struct, so any Node-owned key missing from
    /// `Config` is a key the desktop silently deletes from the shared config.
    #[test]
    fn round_trip_preserves_node_owned_keys() {
        let raw = r#"{
            "version": 1,
            "services": [],
            "bundles": [],
            "gitRepositories": [],
            "databases": [],
            "logSources": [],
            "githubTokens": [],
            "githubIdentities": [
                { "host": "github.com", "login": "work", "name": "Work", "email": "work@example.test" }
            ],
            "workflows": [],
            "workflowTriggers": [{ "id": "t1", "event": "service.crashed" }],
            "preferences": { "logs": { "showTimestamps": true, "wrapLines": false } },
            "vercel": { "source": "oauth", "token": "at", "refreshToken": "rt", "clientId": "cl_1", "teamId": "team_1" }
        }"#;

        let config: Config = serde_json::from_str(raw).expect("config should parse");
        assert_eq!(config.github_identities.len(), 1);
        assert_eq!(config.github_identities[0].email, "work@example.test");

        let written: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();
        assert_eq!(written["workflowTriggers"][0]["id"], "t1");
        assert_eq!(written["preferences"]["logs"]["showTimestamps"], true);
        assert_eq!(written["githubIdentities"][0]["login"], "work");
        // A dropped Vercel connection would silently sign the user out of the
        // web app the next time the desktop wrote the shared config.
        assert_eq!(written["vercel"]["refreshToken"], "rt");
        assert_eq!(written["vercel"]["teamId"], "team_1");
    }

    /// The repo-level Vercel pin lives on `GitRepoDef`, which is rewritten
    /// wholesale on re-register — the pin has to survive that.
    #[tokio::test]
    async fn re_registering_a_repository_keeps_its_vercel_pin() {
        let dir = std::env::temp_dir().join(format!("nomoreide-vercel-cfg-{}", std::process::id()));
        let store = ConfigStore::new(dir.join("config.json"));
        store
            .register_git_repository(GitRepoDef {
                name: "app".into(),
                path: "/tmp/app".into(),
                active_worktree_path: None,
                github_credential: None,
                vercel_project_id: Some("prj_1".into()),
            })
            .await
            .unwrap();

        let config = store
            .register_git_repository(GitRepoDef {
                name: "app".into(),
                path: "/tmp/app".into(),
                active_worktree_path: None,
                github_credential: None,
                vercel_project_id: None,
            })
            .await
            .unwrap();

        assert_eq!(
            config.git_repositories[0].vercel_project_id.as_deref(),
            Some("prj_1")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn identity_lookup_ignores_login_case() {
        let store = ConfigStore::new(std::path::PathBuf::from("/tmp/unused-config.json"));
        let mut config = Config::default();
        config.github_identities.push(GithubIdentityDef {
            host: "github.com".into(),
            login: "Work".into(),
            name: "Work".into(),
            email: "work@example.test".into(),
        });

        assert!(store
            .get_github_identity(&config, "github.com", "work")
            .is_some());
        assert!(store
            .get_github_identity(&config, "github.com", "other")
            .is_none());
    }
}
