use crate::filesystem::{atomic_write_async, AtomicWriteOptions};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use tokio::fs;
#[cfg(test)]
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Data types (mirror the TypeScript Zod schemas)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDef {
    pub name: String,
    /// "local" | "docker-compose" | "ssh" — absent means "local"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// Undefined preserves the legacy shell command; present executes
    /// `command` directly with these arguments.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
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

impl ServiceDef {
    pub fn effective_kind(&self) -> &str {
        self.kind.as_deref().unwrap_or("local")
    }
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
    /// Deploy-provider project this repository ships, keyed by provider id.
    /// A missing entry means "infer it" — from the provider's link file, else
    /// the git remote.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_projects: Option<BTreeMap<String, String>>,
    /// Pre-registry shape, read so an older config still resolves and dropped
    /// on the next write. See `Config::normalize_legacy_providers`.
    #[serde(default, rename = "vercelProjectId", skip_serializing)]
    pub legacy_vercel_project_id: Option<String>,
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

/// Who a stored token belongs to, as captured once at connect time so a status
/// check can name the account without spending an API call on it.
#[derive(Debug, Clone, PartialEq)]
pub struct GithubProfile {
    pub login: String,
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

/// How a provider integration authenticates. Mirrors the TypeScript
/// `ProviderConnection`: `cli` holds no secret (the token is re-read from the
/// vendor CLI's own auth file), `stored` carries a pasted token, and `oauth` is
/// the browser sign-in whose access token expires and is renewed from
/// `refresh_token`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConnectionDef {
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
    /// Account scope within the provider — a Vercel team, a Cloudflare account.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_slug: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    /// Pre-registry scope fields, read once and then dropped on write.
    #[serde(default, rename = "teamId", skip_serializing)]
    pub legacy_team_id: Option<String>,
    #[serde(default, rename = "teamSlug", skip_serializing)]
    pub legacy_team_slug: Option<String>,
}

/// Field order is the reference's, not this struct's convenience: the same
/// document is rendered by both runtimes and compared between them, so the keys
/// have to come out in the same sequence.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicServiceDef<'a> {
    name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<&'a String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<&'a String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    test: Option<&'a String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    depends_on: Option<&'a Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_path: Option<&'a String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    command: Option<&'a String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    args: Option<&'a Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<&'a String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    compose_file: Option<&'a String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    compose_service: Option<&'a String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    host: Option<&'a String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicDatabaseDef<'a> {
    name: &'a str,
    engine: &'a str,
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    write_unlocked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_path: Option<&'a String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicGithubTokenDef<'a> {
    host: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    login: Option<&'a String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    avatar_url: Option<&'a String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicProviderConnectionDef<'a> {
    source: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_id: Option<&'a String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scope_id: Option<&'a String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scope_slug: Option<&'a String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<&'a String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicConfig<'a> {
    version: u32,
    services: Vec<PublicServiceDef<'a>>,
    bundles: &'a [BundleDef],
    git_repositories: &'a [GitRepoDef],
    #[serde(skip_serializing_if = "Option::is_none")]
    selected_git_repository: Option<&'a String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    git_board_repositories: Option<&'a Vec<String>>,
    databases: Vec<PublicDatabaseDef<'a>>,
    log_sources: &'a [LogSourceDef],
    ssh_servers: &'a [SshServerDef],
    github_tokens: Vec<PublicGithubTokenDef<'a>>,
    github_identities: &'a [GithubIdentityDef],
    connections: BTreeMap<String, PublicProviderConnectionDef<'a>>,
    workflows: &'a [serde_json::Value],
    workflow_triggers: &'a [serde_json::Value],
    #[serde(skip_serializing_if = "Option::is_none")]
    chat_provider: Option<&'a String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    chat_models: Option<&'a ChatModelsDef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    preferences: Option<&'a serde_json::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatModelsDef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex: Option<String>,
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
    /// How each provider authenticates, keyed by provider id (`vercel`, …).
    /// A missing entry means that provider is not connected.
    #[serde(default)]
    pub connections: BTreeMap<String, ProviderConnectionDef>,
    /// Pre-registry Vercel connection, lifted into `connections` on load.
    #[serde(default, rename = "vercel", skip_serializing)]
    pub legacy_vercel: Option<ProviderConnectionDef>,
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
    /// Model pins are owned by the shared agent-chat config. The desktop does
    /// not apply them yet, but must preserve them when it writes config.json.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_models: Option<ChatModelsDef>,
}

/// Provider id the pre-registry fields belonged to.
pub const LEGACY_PROVIDER_ID: &str = "vercel";

impl Config {
    /// Configuration metadata safe to serialize to the dashboard, as a value.
    ///
    /// Convenient, and lossy in one way that matters to nobody who reads it by
    /// key: `serde_json::Value` sorts object keys, so the field order below
    /// does not survive. Anything rendering this document for comparison
    /// against the reference must serialize [`Config::public_view`] instead.
    pub fn public_value(&self) -> serde_json::Value {
        serde_json::to_value(self.public_view()).expect("Public config must serialize")
    }

    /// Configuration metadata safe to serialize to the dashboard.
    /// Runtime code must continue to use `Config` so credentials never have to
    /// make a round trip through a webview merely to start a service.
    pub fn public_view(&self) -> impl Serialize + '_ {
        PublicConfig {
            version: self.version,
            services: self
                .services
                .iter()
                .map(|service| PublicServiceDef {
                    name: &service.name,
                    kind: service.kind.as_ref(),
                    command: service.command.as_ref(),
                    args: service.args.as_ref(),
                    cwd: service.cwd.as_ref(),
                    port: service.port,
                    description: service.description.as_ref(),
                    project_path: service.project_path.as_ref(),
                    test: service.test.as_ref(),
                    depends_on: service.depends_on.as_ref(),
                    compose_file: service.compose_file.as_ref(),
                    compose_service: service.compose_service.as_ref(),
                    host: service.host.as_ref(),
                })
                .collect(),
            bundles: &self.bundles,
            git_repositories: &self.git_repositories,
            selected_git_repository: self.selected_git_repository.as_ref(),
            git_board_repositories: self.git_board_repositories.as_ref(),
            databases: self
                .databases
                .iter()
                .map(|database| PublicDatabaseDef {
                    name: &database.name,
                    engine: &database.engine,
                    url: if database.engine == "sqlite" {
                        database.url.clone()
                    } else {
                        mask_database_url(&database.url)
                    },
                    write_unlocked: database.write_unlocked,
                    project_path: database.project_path.as_ref(),
                })
                .collect(),
            log_sources: &self.log_sources,
            ssh_servers: &self.ssh_servers,
            github_tokens: self
                .github_tokens
                .iter()
                .map(|token| PublicGithubTokenDef {
                    host: &token.host,
                    login: token.login.as_ref(),
                    avatar_url: token.avatar_url.as_ref(),
                })
                .collect(),
            github_identities: &self.github_identities,
            connections: self
                .connections
                .iter()
                .map(|(id, connection)| {
                    (
                        id.clone(),
                        PublicProviderConnectionDef {
                            source: &connection.source,
                            expires_at: connection.expires_at,
                            client_id: connection.client_id.as_ref(),
                            scope_id: connection.scope_id.as_ref(),
                            scope_slug: connection.scope_slug.as_ref(),
                            username: connection.username.as_ref(),
                        },
                    )
                })
                .collect(),
            workflows: &self.workflows,
            workflow_triggers: &self.workflow_triggers,
            preferences: self.preferences.as_ref(),
            chat_provider: self.chat_provider.as_ref(),
            chat_models: self.chat_models.as_ref(),
        }
    }

    /// Lift the pre-registry Vercel fields into their provider-keyed homes:
    ///
    ///   config.vercel                  → config.connections["vercel"]
    ///   connection.teamId / .teamSlug  → .scopeId / .scopeSlug
    ///   repository.vercelProjectId     → repository.providerProjects["vercel"]
    ///
    /// Mirrors `migrateLegacyProviderFields` in `src/core/config-store.ts` — the
    /// two runtimes share one config.json, so both must read the old shape. The
    /// legacy fields are `skip_serializing`, so they vanish on the next write.
    ///
    /// Existing provider-keyed values win; the legacy key is then discarded.
    fn normalize_legacy_providers(&mut self) {
        if let Some(mut legacy) = self.legacy_vercel.take() {
            legacy.scope_id = legacy.scope_id.or(legacy.legacy_team_id.take());
            legacy.scope_slug = legacy.scope_slug.or(legacy.legacy_team_slug.take());
            self.connections
                .entry(LEGACY_PROVIDER_ID.to_string())
                .or_insert(legacy);
        }
        for connection in self.connections.values_mut() {
            connection.scope_id = connection
                .scope_id
                .take()
                .or(connection.legacy_team_id.take());
            connection.scope_slug = connection
                .scope_slug
                .take()
                .or(connection.legacy_team_slug.take());
        }
        for repo in &mut self.git_repositories {
            if let Some(project_id) = repo.legacy_vercel_project_id.take() {
                repo.provider_projects
                    .get_or_insert_with(BTreeMap::new)
                    .entry(LEGACY_PROVIDER_ID.to_string())
                    .or_insert(project_id);
            }
        }
    }
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
            connections: BTreeMap::new(),
            legacy_vercel: None,
            workflows: vec![],
            workflow_triggers: vec![],
            preferences: None,
            chat_provider: None,
            chat_models: None,
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
                let mut config: Config =
                    serde_json::from_str(&raw).context("Failed to parse config.json")?;
                config.normalize_legacy_providers();
                Ok(config)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
            Err(e) => Err(e).context("Failed to read config.json"),
        }
    }

    pub async fn save(&self, config: &Config) -> Result<()> {
        let json = serde_json::to_string_pretty(config).context("Failed to serialize config")?;
        atomic_write_async(
            &self.path,
            format!("{json}\n"),
            AtomicWriteOptions::private(),
        )
        .await
        .context("Failed to atomically replace config.json")
    }

    /// The project's preferences, or the defaults when it has none.
    ///
    /// The defaults are returned rather than written: a project that has never
    /// had a preference set should not grow a config file merely by being
    /// looked at.
    pub async fn preferences(&self) -> Result<serde_json::Value> {
        let config = self.load().await?;
        Ok(config
            .preferences
            .clone()
            .unwrap_or_else(default_preferences))
    }

    /// Fold a validated patch into the stored preferences, one level deep, so
    /// a patch naming `logs` leaves `database` alone.
    pub async fn update_preferences(&self, patch: &serde_json::Value) -> Result<serde_json::Value> {
        let mut config = self.load().await?;
        let mut current = config
            .preferences
            .clone()
            .unwrap_or_else(default_preferences);
        if let (Some(current), Some(patch)) = (current.as_object_mut(), patch.as_object()) {
            for (group, fields) in patch {
                let Some(fields) = fields.as_object() else {
                    continue;
                };
                let entry = current
                    .entry(group.clone())
                    .or_insert_with(|| serde_json::json!({}));
                if let Some(entry) = entry.as_object_mut() {
                    for (key, value) in fields {
                        entry.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        config.preferences = Some(current.clone());
        self.save(&config).await?;
        Ok(current)
    }

    /// Clear the stored preferences and report the defaults.
    ///
    /// The key is **removed**, not overwritten with the defaults: "unset" and
    /// "set to exactly the defaults" should not be the same file, so that a
    /// later change to a default reaches a project that never chose otherwise.
    pub async fn reset_preferences(&self) -> Result<serde_json::Value> {
        let mut config = self.load().await?;
        config.preferences = None;
        self.save(&config).await?;
        Ok(default_preferences())
    }

    pub async fn register_service(&self, service: ServiceDef) -> Result<Config> {
        let mut config = self.load().await?;
        config.services.retain(|s| s.name != service.name);
        config.services.push(service);
        self.save(&config).await?;
        Ok(config)
    }

    /// Drop a service, and with it every bundle membership that named it.
    ///
    /// A name that is not registered is an **error**, not a no-op: the caller
    /// asked for a state change and did not get one, and a delete button that
    /// silently succeeds on a stale name hides a config that moved underneath
    /// it.
    pub async fn remove_service(&self, name: &str) -> Result<Config> {
        let name = name.trim();
        if name.is_empty() {
            bail!("service name is required");
        }
        let mut config = self.load().await?;
        let before = config.services.len();
        config.services.retain(|s| s.name != name);
        if config.services.len() == before {
            bail!("Service \"{name}\" is not registered.");
        }
        config
            .bundles
            .iter_mut()
            .for_each(|b| b.services.retain(|s| s != name));
        self.save(&config).await?;
        Ok(config)
    }

    /// Point a service at a project folder, or clear the assignment.
    ///
    /// `None` and a blank string mean the same thing — **clear it** — because
    /// absent and empty both arrive from a form that way, and storing an empty
    /// path would leave a service assigned to nothing in particular rather than
    /// inferring its project from `cwd`.
    pub async fn set_service_project(
        &self,
        name: &str,
        project_path: Option<&str>,
    ) -> Result<Config> {
        let name = name.trim();
        if name.is_empty() {
            bail!("service name is required");
        }
        let assigned = project_path
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let mut config = self.load().await?;
        let Some(service) = config.services.iter_mut().find(|s| s.name == name) else {
            bail!("Service \"{name}\" is not registered.");
        };
        service.project_path = assigned.map(str::to_string);
        self.save(&config).await?;
        Ok(config)
    }

    /// Register a bundle, optionally replacing one that used to have a
    /// different name.
    ///
    /// A rename is one write, not a delete plus an add: `previous_name` is
    /// dropped in the same pass that drops a same-named bundle, so a rename
    /// cannot half-apply and leave both names registered.
    pub async fn register_bundle(
        &self,
        bundle: BundleDef,
        previous_name: Option<&str>,
    ) -> Result<Config> {
        let mut config = self.load().await?;
        config
            .bundles
            .retain(|b| b.name != bundle.name && Some(b.name.as_str()) != previous_name);
        config.bundles.push(bundle);
        self.save(&config).await?;
        Ok(config)
    }

    /// Register a repository folder, keeping the credentials and provider
    /// projects an existing registration of the same name already carried.
    ///
    /// The two checks come first, and live here rather than at each caller, so
    /// the dashboard, the desktop app, and an agent all refuse the same folder.
    pub async fn register_git_repository(&self, mut repo: GitRepoDef) -> Result<Config> {
        require_absolute_path(&repo.path)?;
        require_git_worktree(&repo.path).await?;
        let mut config = self.load().await?;
        let existing = config.git_repositories.iter().find(|r| r.name == repo.name);
        if repo.github_credential.is_none() {
            repo.github_credential = existing.and_then(|r| r.github_credential.clone());
        }
        if repo.provider_projects.is_none() {
            repo.provider_projects = existing.and_then(|r| r.provider_projects.clone());
        }
        config.git_repositories.retain(|r| r.name != repo.name);
        // Registering is how a repository becomes the one on screen. Selecting
        // it here rather than leaving that to the caller is what the reference
        // does, and it means re-registering an existing repository also brings
        // it back to the front.
        config.selected_git_repository = Some(repo.name.clone());
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

    /// Forget a repository.
    ///
    /// Refuses a name that is not registered rather than reporting success for
    /// a no-op: "removed" and "was never there" are different answers, and the
    /// dashboard shows the second one to the user.
    pub async fn remove_git_repository(&self, name: &str) -> Result<Config> {
        let name = name.trim();
        if name.is_empty() {
            return Err(validation("repository name is required"));
        }
        let mut config = self.load().await?;
        let before = config.git_repositories.len();
        config.git_repositories.retain(|r| r.name != name);
        if config.git_repositories.len() == before {
            anyhow::bail!("Git repository \"{name}\" is not registered.");
        }
        if config.selected_git_repository.as_deref() == Some(name) {
            config.selected_git_repository = None;
        }
        self.save(&config).await?;
        Ok(config)
    }

    /// `None` clears the selection; a name must be one that is registered.
    pub async fn select_git_repository(&self, name: Option<String>) -> Result<Config> {
        let mut config = self.load().await?;
        if let Some(name) = &name {
            if !config.git_repositories.iter().any(|r| &r.name == name) {
                anyhow::bail!("Git repository \"{name}\" is not registered.");
            }
        }
        config.selected_git_repository = name;
        self.save(&config).await?;
        Ok(config)
    }

    /// Point a repository at one of its worktrees.
    ///
    /// `path` has to name a worktree of *that* repository, which is a question
    /// only git can answer — a folder that merely sits inside the managed root,
    /// or one that belongs to a different project, is refused. What is stored is
    /// the path git reports rather than the one passed in, so a symlinked or
    /// relative-through-`..` spelling of the same directory is recorded once.
    pub async fn select_git_worktree(&self, name: &str, path: &str) -> Result<Config> {
        require_absolute_path(path)?;
        let mut config = self.load().await?;
        let repository_path = config
            .git_repositories
            .iter()
            .find(|repo| repo.name == name)
            .map(|repo| repo.path.clone())
            .with_context(|| format!("Git repository \"{name}\" is not registered."))?;
        let worktree = crate::git_manager::worktree_at(&repository_path, path)
            .await?
            .context("The selected folder is not a worktree of this project.")?;
        if let Some(repo) = config
            .git_repositories
            .iter_mut()
            .find(|repo| repo.name == name)
        {
            repo.active_worktree_path = Some(worktree.path);
        }
        self.save(&config).await?;
        Ok(config)
    }

    pub async fn set_chat_provider(&self, provider: String) -> Result<Config> {
        let mut config = self.load().await?;
        config.chat_provider = Some(provider);
        self.save(&config).await?;
        Ok(config)
    }

    /// Persist the ordered set of repositories pinned to the board.
    ///
    /// Names are filtered to those still registered, de-duped with the first
    /// occurrence winning, and only then capped — so a stale, repeated, or
    /// overflowing list from the client cannot corrupt the board or strand a
    /// repository off-screen. Filtering before the cap matters: capping first
    /// would let five stale names push every real one out.
    pub async fn set_git_board_repositories(&self, names: Vec<String>) -> Result<Config> {
        let mut config = self.load().await?;
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let kept: Vec<String> = names
            .into_iter()
            .filter(|name| {
                config
                    .git_repositories
                    .iter()
                    .any(|repo| &repo.name == name)
                    && seen.insert(name.clone())
            })
            // Capped at 5, mirroring the UI's 5-column limit.
            .take(5)
            .collect();
        config.git_board_repositories = Some(kept);
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

    /// Open or close write access for one registered connection.
    ///
    /// A name that is not registered is an **error**, not a no-op. Reporting
    /// success for a connection that was never touched tells the caller the
    /// database is unlocked when nothing was stored, and the next write would
    /// be refused by a flag the caller believes it already set.
    pub async fn set_database_write_access(&self, name: &str, unlocked: bool) -> Result<Config> {
        let mut config = self.load().await?;
        let Some(database) = config.databases.iter_mut().find(|d| d.name == name) else {
            return Err(anyhow::anyhow!(
                "Database connection \"{name}\" is not registered."
            ));
        };
        database.write_unlocked = Some(unlocked);
        self.save(&config).await?;
        Ok(config)
    }

    /// Store the secret for `host`, together with whoever it belongs to.
    ///
    /// The entry is **replaced, not merged**: storing a token without a profile
    /// clears any identity the previous one carried. A new token can belong to
    /// a different account, and a login left over from the old one would name
    /// the wrong person on every screen that reads it. A caller that means to
    /// keep an identity passes it, or uses [`Self::set_github_profile`] to
    /// attach one without touching the secret.
    pub async fn set_github_token(
        &self,
        host: String,
        token: String,
        profile: Option<GithubProfile>,
    ) -> Result<Config> {
        let host = host.trim().to_string();
        let token = token.trim().to_string();
        if host.is_empty() {
            return Err(validation("GitHub host is required"));
        }
        if token.is_empty() {
            return Err(validation("GitHub token is required"));
        }
        let (login, avatar_url) = match profile {
            Some(profile) => (
                non_empty(&profile.login),
                profile.avatar_url.as_deref().and_then(non_empty),
            ),
            None => (None, None),
        };
        let mut config = self.load().await?;
        config.github_tokens.retain(|t| t.host != host);
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
    pub fn get_github_profile(&self, config: &Config, host: &str) -> Option<GithubProfile> {
        config
            .github_tokens
            .iter()
            .find(|t| t.host == host)
            .and_then(|t| {
                t.login.clone().map(|login| GithubProfile {
                    login,
                    avatar_url: t.avatar_url.clone(),
                })
            })
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

    /// Save how a provider is connected. A `cli` connection deliberately drops
    /// any token, so `vercel logout` revokes us too instead of leaving a stale
    /// copy behind.
    pub async fn set_connection(
        &self,
        provider_id: &str,
        mut connection: ProviderConnectionDef,
    ) -> Result<Config> {
        if connection.source == "cli" {
            connection.token = None;
            connection.refresh_token = None;
            connection.expires_at = None;
            connection.client_id = None;
        }
        let mut config = self.load().await?;
        config
            .connections
            .insert(provider_id.to_string(), connection);
        self.save(&config).await?;
        Ok(config)
    }

    /// Replace the tokens of an existing `oauth` connection after a refresh.
    /// Separate from `set_connection` because it runs mid-request on an
    /// already-connected config and must not disturb the chosen scope.
    pub async fn update_connection_tokens(
        &self,
        provider_id: &str,
        token: String,
        refresh_token: Option<String>,
        expires_at: i64,
    ) -> Result<Config> {
        let mut config = self.load().await?;
        if let Some(connection) = config.connections.get_mut(provider_id) {
            if connection.source == "oauth" {
                connection.token = Some(token);
                // Providers rotate refresh tokens; keep the previous one only if
                // this response did not carry a replacement.
                if refresh_token.is_some() {
                    connection.refresh_token = refresh_token;
                }
                connection.expires_at = Some(expires_at);
            }
        }
        self.save(&config).await?;
        Ok(config)
    }

    pub async fn set_connection_scope(
        &self,
        provider_id: &str,
        scope_id: Option<String>,
        scope_slug: Option<String>,
    ) -> Result<Config> {
        let mut config = self.load().await?;
        let connection = config
            .connections
            .get_mut(provider_id)
            .ok_or_else(|| anyhow::anyhow!("{provider_id} is not connected."))?;
        connection.scope_id = scope_id;
        connection.scope_slug = scope_slug;
        self.save(&config).await?;
        Ok(config)
    }

    pub async fn remove_connection(&self, provider_id: &str) -> Result<Config> {
        let mut config = self.load().await?;
        config.connections.remove(provider_id);
        self.save(&config).await?;
        Ok(config)
    }

    /// Pin which provider project a registered repository deploys.
    pub async fn set_provider_project(
        &self,
        provider_id: &str,
        repository: &str,
        project_id: Option<String>,
    ) -> Result<Config> {
        let mut config = self.load().await?;
        let repo = config
            .git_repositories
            .iter_mut()
            .find(|repo| repo.name == repository)
            .ok_or_else(|| anyhow::anyhow!("Git repository \"{repository}\" is not registered."))?;
        match project_id.filter(|id| !id.trim().is_empty()) {
            Some(id) => {
                repo.provider_projects
                    .get_or_insert_with(BTreeMap::new)
                    .insert(provider_id.to_string(), id);
            }
            None => {
                if let Some(projects) = repo.provider_projects.as_mut() {
                    projects.remove(provider_id);
                    // Drop the key entirely when nothing is pinned, so an
                    // untouched repo serializes as it did before providers.
                    if projects.is_empty() {
                        repo.provider_projects = None;
                    }
                }
            }
        }
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

    /// Store a trigger, replacing one that already had its id.
    ///
    /// The record is appended rather than written in place, so re-saving a
    /// trigger moves it to the end of the list — which is the order the
    /// dashboard shows them in.
    pub async fn save_workflow_trigger(&self, trigger: serde_json::Value) -> Result<Config> {
        let mut config = self.load().await?;
        let id = trigger
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        config
            .workflow_triggers
            .retain(|t| t.get("id").and_then(|v| v.as_str()).unwrap_or("") != id);
        config.workflow_triggers.push(trigger);
        self.save(&config).await?;
        Ok(config)
    }

    /// Drop a trigger. An id that is not there is **not** an error: the caller
    /// asked for it to be gone and it is gone.
    pub async fn remove_workflow_trigger(&self, id: &str) -> Result<Config> {
        let id = id.trim();
        let mut config = self.load().await?;
        config
            .workflow_triggers
            .retain(|t| t.get("id").and_then(|v| v.as_str()).unwrap_or("") != id);
        self.save(&config).await?;
        Ok(config)
    }
}

fn mask_database_url(url: &str) -> String {
    let Some(scheme_end) = url.find("://") else {
        return "[redacted]".to_string();
    };
    let authority_start = scheme_end + 3;
    let Some(at_offset) = url[authority_start..].find('@') else {
        return mask_database_query(url);
    };
    let at = authority_start + at_offset;
    let authority = &url[authority_start..at];
    let Some(colon_offset) = authority.find(':') else {
        return mask_database_query(url);
    };
    let password_start = authority_start + colon_offset + 1;
    mask_database_query(&format!("{}****{}", &url[..password_start], &url[at..]))
}

fn mask_database_query(url: &str) -> String {
    let Some((base, query)) = url.split_once('?') else {
        return url.to_string();
    };
    let masked = query
        .split('&')
        .map(|part| {
            let Some((key, _value)) = part.split_once('=') else {
                return part.to_string();
            };
            let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
            if normalized.contains("password")
                || normalized.contains("passwd")
                || normalized.contains("secret")
                || normalized.contains("token")
                || normalized.contains("apikey")
            {
                format!("{key}=****")
            } else {
                part.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("&");
    format!("{base}?{masked}")
}

/// `~` is not expanded anywhere in this project, so a path that starts with it
/// would be stored literally and resolve to nothing. Say so rather than storing
/// it.
/// A refusal the caller can fix: a relative path, a missing name, a folder that
/// is not a worktree.
///
/// The distinction has to survive the trip up to the web layer, because the
/// reference's dispatcher answers `ConfigValidationError` with 400 and every
/// other failure with 500. Carried through `anyhow` and recovered by
/// downcasting, so existing `?` call sites keep working unchanged.
#[derive(Debug)]
pub struct ConfigValidationError(pub String);

impl std::fmt::Display for ConfigValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ConfigValidationError {}

/// Whether a failure is one the caller can correct — the 400/500 split above.
pub fn is_config_validation_error(error: &anyhow::Error) -> bool {
    error.downcast_ref::<ConfigValidationError>().is_some()
}

fn validation(message: impl Into<String>) -> anyhow::Error {
    anyhow::Error::new(ConfigValidationError(message.into()))
}

/// A trimmed value, or nothing when it trims away to nothing. The reference
/// stores `undefined` rather than an empty string for both halves of a
/// profile, and an empty login rendered as an account name would be a blank
/// avatar next to a blank name.
fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn require_absolute_path(path: &str) -> Result<()> {
    if PathBuf::from(path).is_absolute() {
        return Ok(());
    }
    Err(validation(
        "Please add an absolute path. Paths beginning with ~ are not expanded here.",
    ))
}

async fn require_git_worktree(path: &str) -> Result<()> {
    if is_git_worktree(path).await {
        return Ok(());
    }
    Err(validation(
        "Not a Git repository. Choose a folder inside a Git worktree.",
    ))
}

/// The repository a request that named none is about: the selected one, or the
/// first registered one when nothing is selected.
pub fn selected_git_repository(config: &Config) -> Option<&GitRepoDef> {
    config
        .git_repositories
        .iter()
        .find(|repository| Some(&repository.name) == config.selected_git_repository.as_ref())
        .or_else(|| config.git_repositories.first())
}

/// The working directory a request that named no repository runs in.
///
/// The active worktree is **verified before it is used**. A worktree that has
/// been removed from disk leaves its path behind in the config, and running
/// there would fail every git command for a repository that is perfectly fine —
/// so a path that is no longer a worktree falls back to the repository's own
/// folder, not to `fallback`. Only a config with no repositories at all reaches
/// `fallback`.
pub async fn selected_git_cwd(config: &Config, fallback: &str) -> String {
    let Some(repository) = selected_git_repository(config) else {
        return fallback.to_string();
    };
    if let Some(worktree) = repository.active_worktree_path.as_deref() {
        if is_git_worktree(worktree).await {
            return worktree.to_string();
        }
    }
    repository.path.clone()
}

/// A missing directory, a missing `git`, and a directory outside any repository
/// are all the same answer here: not a worktree.
pub async fn is_git_worktree(path: &str) -> bool {
    tokio::process::Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(path)
        .output()
        .await
        .ok()
        .filter(|output| output.status.success())
        .is_some_and(|output| String::from_utf8_lossy(&output.stdout).trim() == "true")
}

/// What a project's preferences are before anyone sets one.
pub fn default_preferences() -> serde_json::Value {
    serde_json::json!({
        "logs": { "showTimestamps": true, "wrapLines": true },
        "database": { "confirmWrites": true, "resultLimit": 100 }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_kind_preserves_legacy_omission() {
        let implicit: ServiceDef = serde_json::from_value(serde_json::json!({
            "name": "api",
            "command": "npm run dev",
            "cwd": "/repo"
        }))
        .unwrap();
        assert_eq!(implicit.kind, None);
        assert_eq!(implicit.effective_kind(), "local");
        assert!(serde_json::to_value(&implicit)
            .unwrap()
            .get("kind")
            .is_none());

        let explicit: ServiceDef = serde_json::from_value(serde_json::json!({
            "name": "worker",
            "kind": "local",
            "command": "npm run worker",
            "cwd": "/repo"
        }))
        .unwrap();
        assert_eq!(explicit.kind.as_deref(), Some("local"));
        assert_eq!(explicit.effective_kind(), "local");
        assert_eq!(serde_json::to_value(&explicit).unwrap()["kind"], "local");
    }

    /// A store over a throwaway config file.
    fn scratch_store(label: &str) -> ConfigStore {
        let dir = std::env::temp_dir().join(format!(
            "nomoreide-{label}-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        ConfigStore::new(dir.join("config.json"))
    }

    /// A real, throwaway git worktree. Registration refuses anything else, so
    /// a test that registers a repository has to have one.
    async fn scratch_repo(label: &str) -> String {
        let dir = std::env::temp_dir().join(format!(
            "nomoreide-repo-{label}-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).await.unwrap();
        tokio::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&dir)
            .output()
            .await
            .unwrap();
        dir.to_string_lossy().into_owned()
    }

    fn repo(name: &str, path: &str) -> GitRepoDef {
        GitRepoDef {
            name: name.to_string(),
            path: path.to_string(),
            active_worktree_path: None,
            github_credential: None,
            provider_projects: None,
            legacy_vercel_project_id: None,
        }
    }

    #[tokio::test]
    async fn registering_a_repository_also_selects_it() {
        let store = scratch_store("register-selects");
        let demo = scratch_repo("selects-demo").await;
        let other = scratch_repo("selects-other").await;

        let config = store
            .register_git_repository(repo("demo", &demo))
            .await
            .unwrap();
        assert_eq!(config.selected_git_repository.as_deref(), Some("demo"));

        // A second registration takes the selection, and re-registering the
        // first brings it back — registering is how a repository comes forward.
        let config = store
            .register_git_repository(repo("other", &other))
            .await
            .unwrap();
        assert_eq!(config.selected_git_repository.as_deref(), Some("other"));
        let config = store
            .register_git_repository(repo("demo", &demo))
            .await
            .unwrap();
        assert_eq!(config.selected_git_repository.as_deref(), Some("demo"));
        assert_eq!(config.git_repositories.len(), 2);
    }

    #[tokio::test]
    async fn selecting_an_unregistered_repository_is_refused() {
        let store = scratch_store("select-unknown");
        store
            .register_git_repository(repo("demo", &scratch_repo("select-unknown").await))
            .await
            .unwrap();

        let error = store
            .select_git_repository(Some("ghost".to_string()))
            .await
            .expect_err("an unregistered name should be refused");
        assert_eq!(
            error.to_string(),
            "Git repository \"ghost\" is not registered."
        );

        // The refusal leaves the previous selection alone rather than clearing it.
        let config = store.load().await.unwrap();
        assert_eq!(config.selected_git_repository.as_deref(), Some("demo"));
    }

    #[tokio::test]
    async fn a_folder_that_is_not_a_repository_cannot_be_registered() {
        let store = scratch_store("register-refusals");
        let plain = std::env::temp_dir().join(format!(
            "nomoreide-plain-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        fs::create_dir_all(&plain).await.unwrap();

        // Both checks live here rather than at each caller, so the dashboard,
        // the desktop app, and an agent all refuse the same folder.
        let relative = store
            .register_git_repository(repo("demo", "relative/path"))
            .await
            .expect_err("a relative path should be refused");
        assert_eq!(
            relative.to_string(),
            "Please add an absolute path. Paths beginning with ~ are not expanded here."
        );

        for path in [plain.to_string_lossy().as_ref(), "/definitely/not/here"] {
            let error = store
                .register_git_repository(repo("demo", path))
                .await
                .expect_err("a folder outside any worktree should be refused");
            assert_eq!(
                error.to_string(),
                "Not a Git repository. Choose a folder inside a Git worktree."
            );
        }

        // Nothing was registered or selected on the way through.
        let config = store.load().await.unwrap();
        assert!(config.git_repositories.is_empty());
        assert_eq!(config.selected_git_repository, None);
    }

    #[tokio::test]
    async fn selecting_a_worktree_takes_the_path_git_reports() {
        let store = scratch_store("select-worktree");
        let path = scratch_repo("select-worktree").await;
        store
            .register_git_repository(repo("demo", &path))
            .await
            .unwrap();

        // The primary worktree, named through a "." detour: what is stored is
        // the directory git reports, not the spelling that was passed in.
        let spelled = format!("{path}/.");
        let config = store.select_git_worktree("demo", &spelled).await.unwrap();
        let stored = config.git_repositories[0]
            .active_worktree_path
            .clone()
            .expect("a worktree should have been selected");
        assert_ne!(stored, spelled);
        assert!(
            std::fs::canonicalize(&stored).unwrap() == std::fs::canonicalize(&path).unwrap(),
            "{stored} should be the same directory as {path}"
        );

        assert_eq!(
            store
                .select_git_worktree("demo", "relative/path")
                .await
                .expect_err("a relative path should be refused")
                .to_string(),
            "Please add an absolute path. Paths beginning with ~ are not expanded here."
        );
        assert_eq!(
            store
                .select_git_worktree("ghost", &path)
                .await
                .expect_err("an unregistered repository should be refused")
                .to_string(),
            "Git repository \"ghost\" is not registered."
        );
        assert_eq!(
            store
                .select_git_worktree("demo", "/")
                .await
                .expect_err("a folder outside the project should be refused")
                .to_string(),
            "The selected folder is not a worktree of this project."
        );
    }

    #[tokio::test]
    async fn selecting_nothing_clears_the_selection() {
        let store = scratch_store("select-none");
        store
            .register_git_repository(repo("demo", &scratch_repo("select-none").await))
            .await
            .unwrap();

        let config = store.select_git_repository(None).await.unwrap();
        assert_eq!(config.selected_git_repository, None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn save_uses_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!(
            "nomoreide-private-config-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        let path = dir.join("config.json");
        let store = ConfigStore::new(path.clone());

        store.save(&Config::default()).await.unwrap();

        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn public_config_removes_credentials() {
        let mut config = Config::default();
        config.services.push(ServiceDef {
            name: "api".into(),
            kind: Some("local".into()),
            command: Some("npm run dev".into()),
            args: None,
            cwd: Some("/repo".into()),
            port: None,
            description: None,
            project_path: None,
            env: Some(HashMap::from([(
                "API_TOKEN".into(),
                "service-secret".into(),
            )])),
            test: None,
            depends_on: None,
            compose_file: None,
            compose_service: None,
            host: None,
        });
        config.databases.push(DatabaseDef {
            name: "main".into(),
            engine: "postgres".into(),
            url: "postgres://app:database-secret@localhost/app?sslpassword=query-secret".into(),
            write_unlocked: None,
            project_path: None,
        });
        config.github_tokens.push(GithubTokenDef {
            host: "github.com".into(),
            token: "github-secret".into(),
            login: Some("octocat".into()),
            avatar_url: None,
        });
        config.connections.insert(
            "vercel".into(),
            ProviderConnectionDef {
                source: "oauth".into(),
                token: Some("access-secret".into()),
                refresh_token: Some("refresh-secret".into()),
                username: Some("octocat".into()),
                ..ProviderConnectionDef::default()
            },
        );

        let public = config.public_value();
        let serialized = public.to_string();

        assert!(public["services"][0].get("env").is_none());
        assert_eq!(
            public["databases"][0]["url"],
            "postgres://app:****@localhost/app?sslpassword=****"
        );
        assert!(public["githubTokens"][0].get("token").is_none());
        assert!(public["connections"]["vercel"].get("token").is_none());
        assert!(public["connections"]["vercel"]
            .get("refreshToken")
            .is_none());
        for secret in [
            "service-secret",
            "database-secret",
            "query-secret",
            "github-secret",
            "access-secret",
            "refresh-secret",
        ] {
            assert!(!serialized.contains(secret));
        }
    }

    /// `save()` serializes the whole struct, so any Node-owned key missing from
    /// `Config` is a key the desktop silently deletes from the shared config.
    #[tokio::test]
    async fn round_trip_preserves_node_owned_keys() {
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
            "chatModels": { "claude": "claude-opus-4-1", "codex": "gpt-5.3-codex" },
            "vercel": { "source": "oauth", "token": "at", "refreshToken": "rt", "clientId": "cl_1", "teamId": "team_1" }
        }"#;

        // Goes through ConfigStore::load rather than deserializing directly,
        // because that is the only path production takes — and it is where the
        // legacy provider fields are lifted into `connections`.
        let dir = std::env::temp_dir().join(format!("nomoreide-round-trip-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        std::fs::write(&path, raw).unwrap();
        let store = ConfigStore::new(path.clone());

        let config = store.load().await.expect("config should parse");
        assert_eq!(config.github_identities.len(), 1);
        assert_eq!(config.github_identities[0].email, "work@example.test");
        assert_eq!(
            config
                .chat_models
                .as_ref()
                .and_then(|models| models.claude.as_deref()),
            Some("claude-opus-4-1")
        );

        store.save(&config).await.unwrap();
        let written: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written["workflowTriggers"][0]["id"], "t1");
        assert_eq!(written["preferences"]["logs"]["showTimestamps"], true);
        assert_eq!(written["githubIdentities"][0]["login"], "work");
        assert_eq!(written["chatModels"]["codex"], "gpt-5.3-codex");
        assert_eq!(
            config.public_value()["chatModels"]["claude"],
            "claude-opus-4-1"
        );
        // A dropped connection would silently sign the user out of the web app
        // the next time the desktop wrote the shared config.
        assert_eq!(written["connections"]["vercel"]["refreshToken"], "rt");
        assert_eq!(written["connections"]["vercel"]["scopeId"], "team_1");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The repo-level Vercel pin lives on `GitRepoDef`, which is rewritten
    /// wholesale on re-register — the pin has to survive that.
    #[tokio::test]
    async fn re_registering_a_repository_keeps_its_vercel_pin() {
        let dir = std::env::temp_dir().join(format!("nomoreide-vercel-cfg-{}", std::process::id()));
        let store = ConfigStore::new(dir.join("config.json"));
        let app = scratch_repo("vercel-pin").await;
        store
            .register_git_repository(GitRepoDef {
                name: "app".into(),
                path: app.clone(),
                active_worktree_path: None,
                github_credential: None,
                provider_projects: Some(BTreeMap::from([(
                    LEGACY_PROVIDER_ID.to_string(),
                    "prj_1".to_string(),
                )])),
                legacy_vercel_project_id: None,
            })
            .await
            .unwrap();

        let config = store
            .register_git_repository(GitRepoDef {
                name: "app".into(),
                path: app.clone(),
                active_worktree_path: None,
                github_credential: None,
                provider_projects: None,
                legacy_vercel_project_id: None,
            })
            .await
            .unwrap();

        assert_eq!(
            config.git_repositories[0]
                .provider_projects
                .as_ref()
                .and_then(|projects| projects.get(LEGACY_PROVIDER_ID))
                .map(String::as_str),
            Some("prj_1")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A config.json written by a pre-registry build must keep working: both
    /// runtimes share the file, so the desktop has to read the old shape too.
    #[tokio::test]
    async fn lifts_legacy_vercel_fields_into_their_provider_keyed_homes() {
        let dir = std::env::temp_dir().join(format!("nomoreide-legacy-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        std::fs::write(
            &path,
            r#"{
              "version": 1,
              "gitRepositories": [
                { "name": "web", "path": "/tmp/web", "vercelProjectId": "prj_legacy" },
                { "name": "api", "path": "/tmp/api" }
              ],
              "vercel": {
                "source": "stored",
                "token": "pat_legacy",
                "teamId": "team_abc",
                "teamSlug": "acme"
              }
            }"#,
        )
        .unwrap();

        let config = ConfigStore::new(path.clone()).load().await.unwrap();

        let connection = config.connections.get(LEGACY_PROVIDER_ID).unwrap();
        assert_eq!(connection.token.as_deref(), Some("pat_legacy"));
        assert_eq!(connection.scope_id.as_deref(), Some("team_abc"));
        assert_eq!(connection.scope_slug.as_deref(), Some("acme"));
        assert!(config.legacy_vercel.is_none());
        assert_eq!(
            config.git_repositories[0]
                .provider_projects
                .as_ref()
                .and_then(|projects| projects.get(LEGACY_PROVIDER_ID))
                .map(String::as_str),
            Some("prj_legacy")
        );
        // A repo that never pinned one stays absent rather than gaining a map.
        assert!(config.git_repositories[1].provider_projects.is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `save()` serializes the whole struct, so the legacy keys must be gone —
    /// and, critically, `connections` must survive a desktop-side write.
    #[tokio::test]
    async fn drops_legacy_keys_and_preserves_connections_on_write() {
        let dir = std::env::temp_dir().join(format!("nomoreide-legacy-w-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        std::fs::write(
            &path,
            r#"{"version":1,"vercel":{"source":"stored","token":"pat","teamId":"team_abc"}}"#,
        )
        .unwrap();
        let store = ConfigStore::new(path.clone());

        let config = store.load().await.unwrap();
        store.save(&config).await.unwrap();

        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(raw.get("vercel").is_none());
        assert_eq!(raw["connections"]["vercel"]["scopeId"], "team_abc");
        assert_eq!(raw["connections"]["vercel"]["token"], "pat");
        assert!(raw["connections"]["vercel"].get("teamId").is_none());

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
