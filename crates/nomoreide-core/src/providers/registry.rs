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

use crate::cloudflare_context::require_client as require_cloudflare_client;
use crate::cloudflare_provider::{
    cloudflare_repo_url, CloudflareDeployProvider, CLOUDFLARE_LINK_FILE, CLOUDFLARE_PROVIDER_ID,
};
use crate::config::{Config, ConfigStore};
use crate::providers::deploy::{BuildLogLine, Deployment, DeploymentDetail, ProviderProject};
use crate::providers::project_resolution::{project_hints, LinkFile, ProjectHint};
use crate::vercel_context::require_client;
use crate::vercel_provider::{
    vercel_repo_url, VercelDeployProvider, VERCEL_LINK_FILE, VERCEL_PROVIDER_ID,
};

/// Every provider a `provider` argument may name, in the order the tool
/// descriptions list them.
pub const DEPLOY_PROVIDER_IDS: &[&str] = &[VERCEL_PROVIDER_ID, CLOUDFLARE_PROVIDER_ID];

/// A connected provider client, whichever provider it is.
pub enum DeployClient {
    Vercel(VercelDeployProvider),
    Cloudflare(CloudflareDeployProvider),
}

impl DeployClient {
    pub async fn list_projects(
        &self,
        search: Option<&str>,
    ) -> Result<Vec<ProviderProject>, String> {
        match self {
            Self::Vercel(provider) => provider.list_projects(search).await.map_err(message),
            Self::Cloudflare(provider) => provider.list_projects(search).await.map_err(message),
        }
    }

    pub async fn list_deployments(
        &self,
        project_id: &str,
        target: Option<&str>,
        limit: u32,
    ) -> Result<Vec<Deployment>, String> {
        match self {
            Self::Vercel(provider) => provider
                .list_deployments(project_id, target, limit)
                .await
                .map_err(message),
            Self::Cloudflare(provider) => provider
                .list_deployments(project_id, target, limit)
                .await
                .map_err(message),
        }
    }

    /// Cloudflare addresses a deployment *within a project*, so it needs one
    /// resolved before it can answer at all — Vercel's ids are global.
    pub async fn get_deployment(
        &self,
        project: Option<&str>,
        id: &str,
    ) -> Result<DeploymentDetail, String> {
        match self {
            Self::Vercel(provider) => provider.get_deployment(id).await.map_err(message),
            Self::Cloudflare(provider) => provider
                .get_deployment(project.ok_or(WITHIN_A_PROJECT)?, id)
                .await
                .map_err(message),
        }
    }

    pub async fn build_logs(
        &self,
        project: Option<&str>,
        id: &str,
        limit: u32,
    ) -> Result<Vec<BuildLogLine>, String> {
        match self {
            Self::Vercel(provider) => provider.build_logs(id, limit).await.map_err(message),
            // Pages serves the whole build history in one document, so there is
            // no line cap to pass on — it is applied to what came back, and it
            // keeps the *end*. A capped build log is read to find out why the
            // build failed, and that is the last thing it says. (Vercel gets
            // the same answer from the vendor, which reads its events
            // backwards.)
            Self::Cloudflare(provider) => provider
                .build_logs(project.ok_or(WITHIN_A_PROJECT)?, id)
                .await
                .map(|lines| {
                    let skip = lines.len().saturating_sub(limit as usize);
                    lines.into_iter().skip(skip).collect()
                })
                .map_err(message),
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

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// A connected client plus whatever project resolves for the repository.
pub struct ProviderContext {
    pub client: DeployClient,
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
    let client = match provider_id {
        VERCEL_PROVIDER_ID => {
            let (manager, _) = require_client(store, config).await?;
            DeployClient::Vercel(VercelDeployProvider::new(manager))
        }
        CLOUDFLARE_PROVIDER_ID => {
            let (manager, _) = require_cloudflare_client(store, config).await?;
            DeployClient::Cloudflare(CloudflareDeployProvider::new(manager))
        }
        other => return Err(format!("Unknown provider \"{other}\".")),
    };
    let project = resolve_project(&client, config, provider_id, git_cwd).await;
    Ok(ProviderContext { client, project })
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
