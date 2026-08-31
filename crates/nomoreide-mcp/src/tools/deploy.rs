//! Read-only deploy-provider tools.
//!
//! Four tools with a `provider` argument, deliberately **not** four tools per
//! provider: the tool list is already ninety, and per-provider tools would be
//! the fastest way to make it unusable.
//!
//! Also deliberately no redeploy, cancel, promote, or rollback. Those live
//! behind the actions half of the provider layer and are reachable only from
//! the dashboard, where a human clicked the button. An agent can diagnose a
//! failed deploy here — read its state, its commit, and its build logs — but
//! cannot ship one.

use nomoreide_core::config::ConfigStore;
use nomoreide_core::providers::project_resolution::selected_provider_cwd;
use nomoreide_core::providers::registry::{require_provider_context, ProviderContext};
use serde::Serialize;
use serde_json::Value;

/// The provider a request means when it does not say. Vercel, because it is the
/// one the product shipped with and the one most repositories here deploy to.
pub(crate) const DEFAULT_PROVIDER: &str = "vercel";
/// The reference's `z.number().int().positive().max(100).default(20)`.
pub(crate) const DEFAULT_DEPLOYMENT_LIMIT: u32 = 20;
/// The reference's `z.number().int().positive().max(2000).default(500)`.
pub(crate) const DEFAULT_LOG_LIMIT: u32 = 500;

/// What a project listing answers: every project the account can see, and
/// which one *this* repository deploys — the second is the question an agent
/// actually has, and it would otherwise need a second call to answer.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectListing<'a> {
    linked_project_id: Value,
    projects: &'a [nomoreide_core::providers::deploy::ProviderProject],
}

async fn context(
    config: &ConfigStore,
    provider: Option<&str>,
    cwd: Option<&str>,
) -> Result<ProviderContext, String> {
    let loaded = config.load().await.map_err(|error| error.to_string())?;
    let directory = match cwd {
        Some(cwd) => cwd.to_string(),
        None => selected_provider_cwd(
            &loaded,
            &std::env::current_dir()
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_default(),
        ),
    };
    require_provider_context(
        provider.unwrap_or(DEFAULT_PROVIDER),
        config,
        &loaded,
        &directory,
    )
    .await
}

pub(crate) async fn list_projects(
    config: &ConfigStore,
    provider: Option<&str>,
    cwd: Option<&str>,
    search: Option<&str>,
) -> Result<String, String> {
    let context = context(config, provider, cwd).await?;
    let projects = context.client.list_projects(search).await?;
    let linked = context
        .project
        .as_ref()
        .and_then(|project| project.id.clone())
        .unwrap_or(Value::Null);
    super::render(&ProjectListing {
        linked_project_id: linked,
        projects: &projects,
    })
}

pub(crate) async fn list_deployments(
    config: &ConfigStore,
    provider: Option<&str>,
    cwd: Option<&str>,
    target: Option<&str>,
    limit: u32,
) -> Result<String, String> {
    let context = context(config, provider, cwd).await?;
    let project = context.require_project()?.to_string();
    let deployments = context
        .client
        .list_deployments(&project, target, limit)
        .await?;
    super::render(&deployments)
}

pub(crate) async fn get_deployment(
    config: &ConfigStore,
    provider: Option<&str>,
    cwd: Option<&str>,
    deployment: &str,
) -> Result<String, String> {
    let context = context(config, provider, cwd).await?;
    // The linked project is passed rather than required: Vercel's deployment
    // ids are global and need none, and Cloudflare says so in its own words.
    let project = context.linked_project();
    super::render(
        &context
            .client
            .get_deployment(project.as_deref(), deployment)
            .await?,
    )
}

pub(crate) async fn logs(
    config: &ConfigStore,
    provider: Option<&str>,
    cwd: Option<&str>,
    deployment: &str,
    limit: u32,
) -> Result<String, String> {
    let context = context(config, provider, cwd).await?;
    let project = context.linked_project();
    let lines = context
        .client
        .build_logs(project.as_deref(), deployment, limit)
        .await?;
    if lines.is_empty() {
        return Ok("No build logs available for this deployment.".to_string());
    }
    Ok(lines
        .iter()
        .map(|line| line.text.as_str())
        .collect::<Vec<_>>()
        .join("\n"))
}
