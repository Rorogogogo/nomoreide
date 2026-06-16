use std::collections::HashMap;
use std::path::PathBuf;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
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
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseDef {
    pub name: String,
    pub engine: String, // "postgres" | "mysql" | "sqlite"
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write_unlocked: Option<bool>,
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
pub struct GithubTokenDef {
    pub host: String,
    pub token: String,
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
    #[serde(default)]
    pub github_tokens: Vec<GithubTokenDef>,
    #[serde(default)]
    pub workflows: Vec<serde_json::Value>,
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
            github_tokens: vec![],
            workflows: vec![],
            chat_provider: None,
        }
    }
}

// ---------------------------------------------------------------------------
// ConfigStore
// ---------------------------------------------------------------------------

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
                let config: Config = serde_json::from_str(&raw)
                    .context("Failed to parse config.json")?;
                Ok(config)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
            Err(e) => Err(e).context("Failed to read config.json"),
        }
    }

    pub async fn save(&self, config: &Config) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).await.context("Failed to create config dir")?;
        }
        let json = serde_json::to_string_pretty(config).context("Failed to serialize config")?;
        fs::write(&self.path, format!("{json}\n")).await.context("Failed to write config.json")
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
        config.bundles.iter_mut().for_each(|b| b.services.retain(|s| s != name));
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

    pub async fn register_git_repository(&self, repo: GitRepoDef) -> Result<Config> {
        let mut config = self.load().await?;
        config.git_repositories.retain(|r| r.name != repo.name);
        config.git_repositories.push(repo);
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
        config.github_tokens.retain(|t| t.host != host);
        config.github_tokens.push(GithubTokenDef { host, token });
        self.save(&config).await?;
        Ok(config)
    }

    pub async fn remove_github_token(&self, host: &str) -> Result<Config> {
        let mut config = self.load().await?;
        config.github_tokens.retain(|t| t.host != host);
        self.save(&config).await?;
        Ok(config)
    }

    pub fn get_github_token<'a>(&self, config: &'a Config, host: &str) -> Option<&'a str> {
        config.github_tokens.iter()
            .find(|t| t.host == host)
            .map(|t| t.token.as_str())
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
        let id = workflow.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        config.workflows.retain(|w| w.get("id").and_then(|v| v.as_str()).unwrap_or("") != id);
        config.workflows.push(workflow);
        self.save(&config).await?;
        Ok(config)
    }

    pub async fn remove_workflow(&self, id: &str) -> Result<Config> {
        let mut config = self.load().await?;
        config.workflows.retain(|w| w.get("id").and_then(|v| v.as_str()).unwrap_or("") != id);
        self.save(&config).await?;
        Ok(config)
    }
}
