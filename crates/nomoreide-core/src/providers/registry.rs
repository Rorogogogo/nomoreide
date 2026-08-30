//! The in-tree provider registry.
//!
//! The Rust half of `src/core/providers/registry.ts`, and — apart from a
//! provider's own module — the only file adding one touches. That is the point
//! of the layer: adding Cloudflare should not mean editing the daemon's routes,
//! the MCP tools, and the dashboard the way adding Vercel did.
//!
//! A closed `enum` rather than a boxed trait object. The set is deliberately
//! static (third-party providers are out of scope until three implementations
//! have shaped the contract), and dispatching over an enum keeps every
//! provider's answer to a question visible side by side, which is what makes a
//! divergence between them a thing you notice rather than a thing you go
//! looking for.

use crate::cloudflare_actions::CloudflareActions;
use crate::cloudflare_context::{
    require_actions as require_cloudflare_actions, require_client as require_cloudflare_client,
};
use crate::cloudflare_manager::CloudflareApiError;
use crate::cloudflare_provider::{
    cloudflare_repo_url, env_from_merged, CloudflareDeployProvider, CLOUDFLARE_LINK_FILE,
    CLOUDFLARE_PROVIDER_ID,
};
use crate::config::{Config, ConfigStore, PublicProviderConnectionDef};
use crate::providers::deploy::{
    present, BuildLogLine, Deployment, DeploymentDetail, ProviderDomain, ProviderEnvVar,
    ProviderProject,
};
use crate::providers::project_resolution::{project_hints, LinkFile, ProjectHint};
use crate::vercel_actions::VercelActions;
use crate::vercel_context::{require_actions as require_vercel_actions, require_client};
use crate::vercel_manager::VercelApiError;
use crate::vercel_provider::{
    env_from_raw, vercel_repo_url, VercelDeployProvider, VERCEL_LINK_FILE, VERCEL_PROVIDER_ID,
};
use serde_json::Value;

/// Every provider a `provider` argument may name, in the order the tool
/// descriptions list them.
pub const DEPLOY_PROVIDER_IDS: &[&str] = &[VERCEL_PROVIDER_ID, CLOUDFLARE_PROVIDER_ID];

/// A connected provider client, whichever provider it is.
pub enum DeployClient {
    Vercel(VercelDeployProvider),
    Cloudflare(CloudflareDeployProvider),
}

impl DeployClient {
    /// Who the credential belongs to, in the two fields the connection panel
    /// puts on screen.
    ///
    /// Narrower than the vendors' own identity records on purpose: everything
    /// else they carry — ids, emails, plan names — would be a field nothing
    /// reads and every provider would have to invent an answer for.
    pub async fn account(&self) -> Result<ProviderAccount, ProviderError> {
        match self {
            Self::Vercel(provider) => {
                let user = provider.viewer().await?;
                Ok(ProviderAccount {
                    // Reported even when it is null: the vendor saying the
                    // account has no username is an answer, and the reference
                    // passes it through rather than dropping the key.
                    username: user.get("username").cloned(),
                    avatar: present(user.get("avatar")),
                })
            }
            Self::Cloudflare(provider) => Ok(ProviderAccount {
                username: Some(cloudflare_username(&provider.viewer().await?)),
                // Neither of Cloudflare's identity endpoints carries one.
                avatar: None,
            }),
        }
    }

    /// The accounts this credential can act as — a Vercel team, a Cloudflare
    /// account — which is what the scope switcher offers.
    pub async fn list_scopes(&self) -> Result<Vec<Value>, ProviderError> {
        match self {
            Self::Vercel(provider) => Ok(provider.list_scopes().await?),
            Self::Cloudflare(provider) => Ok(provider.list_scopes().await?),
        }
    }

    /// One project read in full.
    ///
    /// Distinct from the project on a [`ProviderContext`], which may have come
    /// from a *listing* — and Vercel's listing omits the build settings the
    /// settings panel exists to show.
    pub async fn get_project(&self, id: &str) -> Result<ProviderProject, ProviderError> {
        match self {
            Self::Vercel(provider) => Ok(provider.get_project(id).await?),
            Self::Cloudflare(provider) => Ok(provider.get_project(id).await?),
        }
    }

    /// The project's variables, keys and environments only.
    ///
    /// Never the values: listing answers "is this key set, and where", which is
    /// the question a failed deploy raises. Reading one value is a separate,
    /// explicitly-requested act — see [`Self::get_env_value`].
    pub async fn list_env(&self, project: &str) -> Result<Vec<ProviderEnvVar>, ProviderError> {
        match self {
            Self::Vercel(provider) => Ok(provider.list_env(project).await?),
            Self::Cloudflare(provider) => Ok(provider.list_env(project).await?),
        }
    }

    /// One variable's value — the single door for putting a secret on the wire.
    pub async fn get_env_value(
        &self,
        project: &str,
        env_id: &str,
    ) -> Result<String, ProviderError> {
        match self {
            Self::Vercel(provider) => Ok(provider.get_env_value(project, env_id).await?),
            Self::Cloudflare(provider) => Ok(provider.get_env_value(project, env_id).await?),
        }
    }

    pub async fn list_domains(&self, project: &str) -> Result<Vec<ProviderDomain>, ProviderError> {
        match self {
            Self::Vercel(provider) => Ok(provider.list_domains(project).await?),
            Self::Cloudflare(provider) => Ok(provider.list_domains(project).await?),
        }
    }

    pub async fn list_projects(
        &self,
        search: Option<&str>,
    ) -> Result<Vec<ProviderProject>, ProviderError> {
        match self {
            Self::Vercel(provider) => Ok(provider.list_projects(search).await?),
            Self::Cloudflare(provider) => Ok(provider.list_projects(search).await?),
        }
    }

    pub async fn list_deployments(
        &self,
        project_id: &str,
        target: Option<&str>,
        limit: u32,
    ) -> Result<Vec<Deployment>, ProviderError> {
        match self {
            Self::Vercel(provider) => {
                Ok(provider.list_deployments(project_id, target, limit).await?)
            }
            Self::Cloudflare(provider) => {
                Ok(provider.list_deployments(project_id, target, limit).await?)
            }
        }
    }

    /// Cloudflare addresses a deployment *within a project*, so it needs one
    /// resolved before it can answer at all — Vercel's ids are global.
    pub async fn get_deployment(
        &self,
        project: Option<&str>,
        id: &str,
    ) -> Result<DeploymentDetail, ProviderError> {
        match self {
            Self::Vercel(provider) => Ok(provider.get_deployment(id).await?),
            Self::Cloudflare(provider) => Ok(provider
                .get_deployment(project.ok_or_else(|| local(WITHIN_A_PROJECT))?, id)
                .await?),
        }
    }

    pub async fn build_logs(
        &self,
        project: Option<&str>,
        id: &str,
        limit: u32,
    ) -> Result<Vec<BuildLogLine>, ProviderError> {
        match self {
            Self::Vercel(provider) => Ok(provider.build_logs(id, limit).await?),
            // Pages serves the whole build history in one document, so there is
            // no line cap to pass on — it is applied to what came back, and it
            // keeps the *end*. A capped build log is read to find out why the
            // build failed, and that is the last thing it says. (Vercel gets
            // the same answer from the vendor, which reads its events
            // backwards.)
            Self::Cloudflare(provider) => Ok(provider
                .build_logs(project.ok_or_else(|| local(WITHIN_A_PROJECT))?, id)
                .await
                .map(|lines| {
                    let skip = lines.len().saturating_sub(limit as usize);
                    lines.into_iter().skip(skip).collect()
                })?),
        }
    }

    /// One project by id. A rejection means "not this one", not a failure — the
    /// project ladder tries the next rung.
    async fn project_by_id(&self, id: &str) -> Option<ProviderProject> {
        match self {
            Self::Vercel(provider) => provider.get_project(id).await.ok(),
            Self::Cloudflare(provider) => provider.get_project(id).await.ok(),
        }
    }

    async fn project_by_repo_url(&self, repo_url: &str) -> Option<ProviderProject> {
        match self {
            Self::Vercel(provider) => provider.find_by_repo_url(repo_url).await.ok().flatten(),
            Self::Cloudflare(provider) => provider.find_by_repo_url(repo_url).await.ok().flatten(),
        }
    }

    fn link_file(&self) -> Option<&'static LinkFile> {
        match self {
            Self::Vercel(_) => Some(&VERCEL_LINK_FILE),
            // Wrangler records its binding in `wrangler.toml`, not in a JSON
            // link file, so Pages has no equivalent rung on the ladder.
            Self::Cloudflare(_) => CLOUDFLARE_LINK_FILE,
        }
    }

    fn repo_url_of(&self) -> fn(&str) -> Option<String> {
        match self {
            Self::Vercel(_) => vercel_repo_url,
            Self::Cloudflare(_) => cloudflare_repo_url,
        }
    }
}

/// What a deployment read answers when the provider needs a project and the
/// repository resolved to none.
const WITHIN_A_PROJECT: &str =
    "Cloudflare addresses deployments within a project. Link this repository to a Pages project first.";

/// A provider refusal that still knows the status it arrived with.
///
/// The message alone was enough while every route answered failure the same
/// way. `status` cannot tell an expired credential from an outage from a
/// message — both vendors word theirs differently and neither promises to keep
/// wording them that way — so the one caller that has to make that distinction
/// reads the number the vendor sent instead of guessing from prose.
#[derive(Debug, Clone)]
pub struct ProviderError {
    pub message: String,
    /// The vendor's HTTP status, or 0 when the request never reached it.
    pub status: u16,
}

impl ProviderError {
    /// Whether the vendor refused the *credential* rather than the request,
    /// which is the difference between offering "reconnect" and "retry".
    pub fn is_auth(&self) -> bool {
        matches!(self.status, 401 | 403)
    }
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

/// So a caller that only ever reported the message keeps compiling — and keeps
/// reporting exactly what it did before.
impl From<ProviderError> for String {
    fn from(error: ProviderError) -> String {
        error.message
    }
}

impl From<VercelApiError> for ProviderError {
    fn from(error: VercelApiError) -> Self {
        Self {
            message: error.message,
            status: error.status,
        }
    }
}

impl From<CloudflareApiError> for ProviderError {
    fn from(error: CloudflareApiError) -> Self {
        Self {
            message: error.message,
            status: error.status,
        }
    }
}

/// The signed-in account, in the two fields the connection panel shows.
///
/// Both are `Value` rather than `String` because both are reported verbatim:
/// a vendor that sends a null username is saying something, and narrowing it
/// to a string would make that indistinguishable from sending nothing.
pub struct ProviderAccount {
    /// Absent when the vendor's record carried no such key at all.
    pub username: Option<Value>,
    /// Absent when the vendor has no avatar *or* sent an explicit null — the
    /// panel has one fallback for both.
    pub avatar: Option<Value>,
}

/// What to call a Cloudflare credential on screen.
///
/// The email first, because Cloudflare's `username` is an opaque 32-char hex
/// id rather than a display name and putting one in the account menu reads as
/// a bug. The `username` field is the fallback for a record that carries no
/// email — a scoped API token, whose identity endpoint names it after its
/// account — and the literal is the fallback for a record that carries
/// neither, which is a vendor answer nobody should have to decipher.
fn cloudflare_username(user: &Value) -> Value {
    present(user.get("email"))
        .or_else(|| present(user.get("username")))
        .unwrap_or_else(|| Value::String("cloudflare".into()))
}

/// A refusal this layer raised itself, with no vendor behind it.
fn local(message: &str) -> ProviderError {
    ProviderError {
        message: message.to_string(),
        status: 0,
    }
}

/// Where a connected client's token came from, and which account it acts as.
///
/// The token itself is deliberately not here. Nothing above this layer needs
/// it, and a field nobody reads is a field that ends up in a log.
pub struct ProviderCredential {
    /// `cli` | `stored` | `oauth`.
    pub source: String,
    /// The scope actually in force, which is not always the stored one — an
    /// unscoped connection adopts the sole team or account it can see.
    pub scope_id: Option<String>,
}

/// The write-capable half, whichever provider it is.
///
/// A separate type resolved by a separate call, never reachable from a
/// [`ProviderContext`] — the same read/write split as `git_manager` /
/// `git_actions` and `db::peek` / `nomoreide_actions::db`. Nothing here is
/// exposed as an MCP tool: these are reached only from the dashboard's own
/// routes, where a human clicked the button.
pub enum DeployActions {
    Vercel(VercelActions),
    Cloudflare(CloudflareActions),
}

impl DeployActions {
    /// Add a variable.
    ///
    /// `kind` is the shared dialog's word — `plain` or `encrypted` — and each
    /// provider spells it its own way: Vercel takes it verbatim, Cloudflare
    /// stores `plain_text` or `secret_text`.
    pub async fn create_env(
        &self,
        project: &str,
        key: &str,
        value: &str,
        environments: &[String],
        kind: &str,
    ) -> Result<ProviderEnvVar, ProviderError> {
        match self {
            Self::Vercel(actions) => Ok(env_from_raw(
                &actions
                    .create_env(project, key, value, environments, kind)
                    .await?,
            )),
            Self::Cloudflare(actions) => Ok(env_from_merged(
                &actions
                    .create_env(project, key, value, environments, kind != "plain")
                    .await?,
            )),
        }
    }

    pub async fn update_env(
        &self,
        project: &str,
        env_id: &str,
        value: Option<&str>,
        environments: Option<&[String]>,
    ) -> Result<ProviderEnvVar, ProviderError> {
        match self {
            Self::Vercel(actions) => Ok(env_from_raw(
                &actions
                    .update_env(project, env_id, value, environments)
                    .await?,
            )),
            Self::Cloudflare(actions) => Ok(env_from_merged(
                &actions
                    .update_env(project, env_id, value, environments)
                    .await?,
            )),
        }
    }

    pub async fn delete_env(&self, project: &str, env_id: &str) -> Result<(), ProviderError> {
        match self {
            Self::Vercel(actions) => Ok(actions.delete_env(project, env_id).await?),
            Self::Cloudflare(actions) => Ok(actions.delete_env(project, env_id).await?),
        }
    }
}

/// The write-capable client for `provider_id`.
///
/// Resolved separately from [`require_provider_context`] rather than hanging
/// off it, so a caller that only reads cannot reach a write by accident — and
/// so the two can disagree about what is required. Cloudflare's writes need an
/// account where its reads do not.
pub async fn require_provider_actions(
    provider_id: &str,
    store: &ConfigStore,
    config: &Config,
) -> Result<DeployActions, String> {
    match provider_id {
        VERCEL_PROVIDER_ID => Ok(DeployActions::Vercel(
            require_vercel_actions(store, config).await?,
        )),
        CLOUDFLARE_PROVIDER_ID => Ok(DeployActions::Cloudflare(
            require_cloudflare_actions(store, config).await?,
        )),
        other => Err(unknown_provider(other)),
    }
}

/// A connected client plus whatever project resolves for the repository.
pub struct ProviderContext {
    pub client: DeployClient,
    pub credential: ProviderCredential,
    /// Absent when connected but no project is linked to this repo yet.
    pub project: Option<ProviderProject>,
}

impl ProviderContext {
    /// The project a repository resolved to, if any. Unlike
    /// {@link Self::require_project} this is not an error when absent — the
    /// provider decides whether it needed one.
    pub fn linked_project(&self) -> Option<String> {
        self.project
            .as_ref()
            .and_then(ProviderProject::identifier)
            .map(str::to_string)
    }

    /// The project id deployment reads need, or the message saying which knob
    /// fixes it when there is none.
    pub fn require_project(&self) -> Result<&str, String> {
        self.project
            .as_ref()
            .and_then(ProviderProject::identifier)
            .ok_or_else(|| {
                "No project is linked to this repository. Link it with the provider's CLI, or pick one in the NoMoreIDE deploy tab."
                    .to_string()
            })
    }
}

/// A connected client for `provider_id`, or a message naming what is not
/// connected.
///
/// A missing *project* is not an error: the dashboard's job in that state is to
/// help the user pick one, and three of the four tools work without it.
pub async fn require_provider_context(
    provider_id: &str,
    store: &ConfigStore,
    config: &Config,
    git_cwd: &str,
) -> Result<ProviderContext, String> {
    let (client, credential) = match provider_id {
        VERCEL_PROVIDER_ID => {
            let (manager, credential) = require_client(store, config).await?;
            (
                DeployClient::Vercel(VercelDeployProvider::new(manager)),
                ProviderCredential {
                    source: credential.source,
                    scope_id: credential.team_id,
                },
            )
        }
        CLOUDFLARE_PROVIDER_ID => {
            let (manager, credential) = require_cloudflare_client(store, config).await?;
            (
                DeployClient::Cloudflare(CloudflareDeployProvider::new(manager)),
                ProviderCredential {
                    source: credential.source,
                    scope_id: credential.account_id,
                },
            )
        }
        other => return Err(unknown_provider(other)),
    };
    let project = resolve_project(&client, config, provider_id, git_cwd).await;
    Ok(ProviderContext {
        client,
        credential,
        project,
    })
}

/// The project this repository deploys, walking the ladder until one resolves.
///
/// Nothing is guessed when none of the rungs answer: the wrong project would
/// show deployments for unrelated code.
async fn resolve_project(
    client: &DeployClient,
    config: &Config,
    provider_id: &str,
    git_cwd: &str,
) -> Option<ProviderProject> {
    let hints = project_hints(
        config,
        provider_id,
        git_cwd,
        client.link_file(),
        client.repo_url_of(),
    )
    .await;
    for hint in hints {
        let resolved = match hint {
            ProjectHint::Pinned(id) | ProjectHint::Linked(id) => client.project_by_id(&id).await,
            ProjectHint::RepoUrl(url) => client.project_by_repo_url(&url).await,
        };
        if resolved.is_some() {
            return resolved;
        }
    }
    None
}

/// The message a route reports for an id no provider claims. Spelled once
/// because two routes report it and the dashboard matches on neither — it is
/// the sentence the user reads.
fn unknown_provider(id: &str) -> String {
    format!("Unknown provider \"{id}\".")
}

/// One provider's manifest, looked up by the id a request named.
pub fn find_deploy_provider(id: &str) -> Option<Value> {
    deploy_provider_manifests()
        .into_iter()
        .find(|manifest| manifest.get("id").and_then(Value::as_str) == Some(id))
}

/// The same, refusing with the id the caller asked for — which is what the
/// route reports.
pub fn require_deploy_provider(id: &str) -> Result<Value, String> {
    find_deploy_provider(id).ok_or_else(|| unknown_provider(id))
}

/// The vendor CLI's own login, when there is one.
///
/// **Deliberately without the token.** A CLI token is never copied into
/// NoMoreIDE's config — it is re-read from the vendor's auth file at use time,
/// which is what makes `vercel logout` and `wrangler logout` revoke our access
/// too. Handing one to a caller that persists connections is the one way that
/// policy could be broken by accident, so it is not on the type.
pub struct ProviderCliSession {
    /// The scope the vendor CLI is currently pointed at, adopted as the
    /// default so the dashboard opens where the CLI already is.
    pub current_scope: Option<String>,
}

/// Whether the vendor CLI is logged in, and what to tell the user when it is
/// not.
pub struct ProviderCliStatus {
    pub available: bool,
    pub error: Option<String>,
}

pub async fn provider_cli_session(provider_id: &str) -> Option<ProviderCliSession> {
    match provider_id {
        VERCEL_PROVIDER_ID => {
            crate::vercel_auth::read_cli_session()
                .await
                .map(|session| ProviderCliSession {
                    current_scope: session.current_team,
                })
        }
        CLOUDFLARE_PROVIDER_ID => {
            crate::cloudflare_auth::read_wrangler_session()
                .await
                .map(|session| ProviderCliSession {
                    current_scope: session.current_account,
                })
        }
        _ => None,
    }
}

pub async fn provider_cli_status(provider_id: &str) -> ProviderCliStatus {
    if provider_cli_session(provider_id).await.is_some() {
        return ProviderCliStatus {
            available: true,
            error: None,
        };
    }
    ProviderCliStatus {
        available: false,
        error: cli_missing(provider_id).map(str::to_string),
    }
}

/// What to tell the user when there is no vendor CLI login to inherit.
///
/// `None` only for an id no provider claims, which every caller has already
/// refused before reaching here.
pub fn cli_missing(provider_id: &str) -> Option<&'static str> {
    match provider_id {
        VERCEL_PROVIDER_ID => Some(crate::vercel_auth::CLI_MISSING),
        CLOUDFLARE_PROVIDER_ID => Some(crate::cloudflare_auth::CLI_MISSING),
        _ => None,
    }
}

/// The saved connection with its secrets removed, which is the only shape of
/// one that may leave the process.
pub fn public_provider_connection(config: &Config, provider_id: &str) -> Option<Value> {
    let connection = config.connections.get(provider_id)?;
    serde_json::to_value(PublicProviderConnectionDef::new(connection)).ok()
}

/// Every deploy provider's manifest, in registry order.
pub fn deploy_provider_manifests() -> Vec<Value> {
    vec![
        crate::vercel_provider::manifest(),
        crate::cloudflare_provider::manifest(),
    ]
}

/// One neutral row per installed plugin, both registries flattened together.
///
/// Kind is a *field* on the answer rather than a shape difference in it: the
/// two contracts stay disjoint everywhere they disagree, but an inventory is
/// one of the few places they genuinely agree, because what an inventory
/// reports is the manifest — and both manifests carry an id, a name, an action
/// list and an egress allowlist.
///
/// Everything is `built-in`, so there is nothing to install or remove. The page
/// says so rather than rendering disabled buttons.
pub fn installed_extensions() -> Vec<Value> {
    let mut rows: Vec<Value> = deploy_provider_manifests()
        .iter()
        // A deploy plugin's projects and deployments render on its own page, so
        // there is nowhere else to send the reader.
        .map(|manifest| extension_row(manifest, "deploy", Value::Null))
        .collect();
    // A host plugin has its own page like everything else, *and* its instances
    // keep appearing in the SSH server list beside machines no plugin owns.
    rows.push(extension_row(
        &crate::vultr_provider::manifest(),
        "host",
        Value::String("servers".into()),
    ));
    rows
}

fn extension_row(manifest: &Value, kind: &str, merges_into: Value) -> Value {
    let list = |key: &str| match manifest.get(key) {
        Some(Value::Array(items)) => Value::Array(items.clone()),
        _ => Value::Array(Vec::new()),
    };
    let mut row = serde_json::Map::new();
    row.insert(
        "id".into(),
        manifest.get("id").cloned().unwrap_or(Value::Null),
    );
    row.insert(
        "name".into(),
        manifest.get("name").cloned().unwrap_or(Value::Null),
    );
    row.insert("kind".into(), Value::String(kind.to_string()));
    row.insert("source".into(), Value::String("built-in".into()));
    // A host plugin has no capability list, because it has no optional reads.
    row.insert("capabilities".into(), list("capabilities"));
    row.insert("actions".into(), list("actions"));
    row.insert("productionAffecting".into(), list("productionAffecting"));
    row.insert(
        "hosts".into(),
        match manifest.get("api").and_then(|api| api.get("hosts")) {
            Some(Value::Array(hosts)) => Value::Array(hosts.clone()),
            _ => Value::Array(Vec::new()),
        },
    );
    row.insert("mergesInto".into(), merges_into);
    Value::Object(row)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The one `??` chain in this file that the parity gate reaches only two
    /// branches of: its walks cover a record with an email and a token record
    /// named after its account, but never one that carries neither.
    #[test]
    fn a_cloudflare_credential_is_named_by_email_then_username_then_nothing() {
        for (user, expected) in [
            (
                json!({ "email": "dev@acme.test", "username": "9f2c" }),
                "dev@acme.test",
            ),
            (
                json!({ "email": Value::Null, "username": "Acme Account" }),
                "Acme Account",
            ),
            (
                json!({ "username": "Cloudflare API token" }),
                "Cloudflare API token",
            ),
            (
                json!({ "email": Value::Null, "username": Value::Null }),
                "cloudflare",
            ),
            (json!({}), "cloudflare"),
        ] {
            assert_eq!(cloudflare_username(&user), json!(expected), "{user}");
        }
    }

    /// Only these two statuses mean "reconnect"; everything else, a transport
    /// failure included, means "try again".
    #[test]
    fn only_401_and_403_are_credential_refusals() {
        for (status, auth) in [
            (401, true),
            (403, true),
            (400, false),
            (429, false),
            (500, false),
            (0, false),
        ] {
            let error = ProviderError {
                message: "no".into(),
                status,
            };
            assert_eq!(error.is_auth(), auth, "{status}");
        }
    }
}
