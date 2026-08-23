//! Cloudflare Pages seen through the vendor-neutral deploy contract.
//!
//! The Rust half of `src/core/cloudflare-provider.ts`. Where Vercel needed a
//! second normalization because the desktop app already had one, Cloudflare
//! needs one because Pages describes a deployment in nothing like Vercel's
//! terms: a *stage* and its *status* rather than a ready state, an
//! *environment* rather than a target, and an owner/repo pair rather than a
//! repository URL.

use serde_json::Value;

use crate::cloudflare_manager::{repo_url, CloudflareApiError, CloudflareManager};
use crate::providers::deploy::{
    BuildLogLine, Deployment, DeploymentDetail, DeploymentMeta, ProjectLink, ProjectSetting,
    ProviderProject,
};
use crate::providers::project_resolution::LinkFile;

pub const CLOUDFLARE_PROVIDER_ID: &str = "cloudflare";

/// Wrangler records the project it is bound to in `wrangler.toml`, not in a
/// JSON link file, so Pages has no equivalent of `.vercel/project.json`.
pub const CLOUDFLARE_LINK_FILE: Option<&LinkFile> = None;

/// Pages' build settings, in the order the dashboard shows them.
///
/// Four rather than Vercel's six, and unlike Vercel's these are always
/// reported: Pages nests them under `build_config` and omits the whole object
/// for a project it has never built, so "absent" here would mean "never built"
/// rather than "this setting does not exist".
const SETTINGS: [(&str, &str); 4] = [
    ("buildCommand", "Build command"),
    ("outputDirectory", "Output directory"),
    ("rootDirectory", "Root directory"),
    ("productionBranch", "Production branch"),
];

/// The dashboard a deployment links to. Built as a string and never fetched,
/// which is why `dash.cloudflare.com` is not on the egress allowlist — an
/// allowlist covers what is requested, not what is displayed.
///
/// The project and deployment are escaped even though this is only ever
/// displayed: a link is still a URL, and a name with a space in it would make
/// one that does not open.
fn inspector_url(account: &str, project: &str, deployment: &str) -> String {
    format!(
        "https://dash.cloudflare.com/{account}/pages/view/{}/{}",
        urlencoding::encode(project),
        urlencoding::encode(deployment)
    )
}

/// Pages reports a stage and its status; only three of the statuses mean
/// anything a person acts on, and everything else is work in progress.
///
/// A deployment with **no stage at all** is queued rather than building — it is
/// a record Pages has created and not started. That is why this takes an
/// `Option` rather than the defaulted status: `idle` on a real stage means the
/// stage is running, and reading the two the same way would say a queued
/// deployment is already building.
fn state_of(status: Option<&str>) -> &'static str {
    match status {
        Some("success") => "ready",
        Some("failure") => "error",
        Some("canceled") => "canceled",
        Some(_) => "building",
        None => "queued",
    }
}

/// A project's id **is its name**: Pages addresses projects by name, and the
/// opaque `id` it also carries addresses nothing.
pub fn project_from_raw(raw: &Value) -> ProviderProject {
    let build = raw.get("build_config");
    let field = |owner: Option<&Value>, key: &str| -> Value {
        owner
            .and_then(|value| value.get(key))
            .cloned()
            .unwrap_or(Value::Null)
    };
    let values = [
        field(build, "build_command"),
        field(build, "destination_dir"),
        field(build, "root_dir"),
        field(Some(raw), "production_branch"),
    ];

    ProviderProject {
        id: raw.get("name").cloned(),
        name: raw.get("name").cloned(),
        // Pages does not detect a framework, and saying `null` is the honest
        // answer rather than an omission.
        framework: Value::Null,
        updated_at: raw
            .get("created_on")
            .and_then(Value::as_str)
            .and_then(epoch_ms)
            .map(Value::from),
        link: link_from_raw(raw.get("source")),
        settings: SETTINGS
            .iter()
            .zip(values)
            .map(|((key, label), value)| ProjectSetting { key, label, value })
            .collect(),
    }
}

fn link_from_raw(raw: Option<&Value>) -> Option<ProjectLink> {
    let source = raw?;
    let kind = source
        .get("type")
        .and_then(Value::as_str)
        .filter(|kind| !kind.is_empty())?;
    let config = source.get("config");
    Some(ProjectLink {
        kind: kind.to_string(),
        org: config.and_then(|config| config.get("owner")).cloned(),
        repo: config.and_then(|config| config.get("repo_name")).cloned(),
        production_branch: config
            .and_then(|config| config.get("production_branch"))
            .cloned(),
    })
}

/// The `owner/repo` pair Pages stores, for comparing against a git remote.
fn project_repo_url(raw: &Value) -> Option<String> {
    let config = raw.get("source")?.get("config")?;
    let owner = config.get("owner")?.as_str()?;
    let repo = config.get("repo_name")?.as_str()?;
    Some(format!("{owner}/{repo}").to_lowercase())
}

/// The two states a Pages deployment reports: the vendor-neutral one, and the
/// `stage:status` pair the vendor's own UI shows.
fn states_of(raw: &Value) -> (&'static str, String) {
    // A skipped deployment never ran, so its stage says nothing useful — it is
    // reported as its own state rather than as whatever stage it stopped at.
    if raw.get("is_skipped").and_then(Value::as_bool) == Some(true) {
        return ("canceled", "skipped".to_string());
    }
    let stage = raw.get("latest_stage");
    let stage_name = stage
        .and_then(|stage| stage.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("queued");
    let status = stage
        .and_then(|stage| stage.get("status"))
        .and_then(Value::as_str);
    (
        state_of(status),
        format!("{stage_name}:{}", status.unwrap_or("idle")),
    )
}

pub fn deployment_from_raw(raw: &Value, account: &str, canonical: Option<&str>) -> Deployment {
    let (state, raw_state) = states_of(raw);

    let id = raw
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let project = raw
        .get("project_name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    Deployment {
        // Current production is whichever deployment the project points at, not
        // whichever one is newest and production-targeted: Pages can serve an
        // older build after a rollback, and can serve a preview URL as the
        // canonical one.
        is_current_production: canonical.is_some_and(|canonical| canonical == id),
        name: raw.get("project_name").cloned(),
        // Always reported, `null` included: Pages assigns a URL the moment a
        // build starts, so its absence is news rather than an omission.
        url: Some(
            raw.get("url")
                .and_then(Value::as_str)
                .map(hostname)
                .map_or(Value::Null, Value::from),
        ),
        state: state.to_string(),
        raw_state,
        // Pages' default environment, and it labels every deployment with one —
        // so an absent label is a record that predates the field rather than a
        // deployment with no environment, and `null` would read as "unknown".
        target: Value::from(
            raw.get("environment")
                .and_then(Value::as_str)
                .unwrap_or("preview"),
        ),
        created_at: raw
            .get("created_on")
            .and_then(Value::as_str)
            .and_then(epoch_ms)
            .map(Value::from),
        // Only a finished build has a moment it became ready; for anything else
        // `modified_on` is just the last time the record changed.
        ready_at: (state == "ready")
            .then(|| {
                raw.get("modified_on")
                    .and_then(Value::as_str)
                    .and_then(epoch_ms)
            })
            .flatten()
            .map(Value::from),
        creator: None,
        meta: meta_from_raw(raw.get("deployment_trigger")),
        inspector_url: Some(Value::from(inspector_url(account, &project, &id))),
        id: Value::from(id),
    }
}

/// The commit, out of the trigger that caused the build. Pages records no
/// author, so `commitAuthor` is simply absent rather than empty.
fn meta_from_raw(raw: Option<&Value>) -> DeploymentMeta {
    let metadata = raw.and_then(|trigger| trigger.get("metadata"));
    let pick = |key: &str| metadata.and_then(|metadata| metadata.get(key)).cloned();
    DeploymentMeta {
        branch: pick("branch"),
        sha: pick("commit_hash"),
        commit_message: pick("commit_message"),
        commit_author: None,
    }
}

pub fn detail_from_raw(raw: &Value, account: &str, canonical: Option<&str>) -> DeploymentDetail {
    let deployment = deployment_from_raw(raw, account, canonical);
    // Pages records no failure message on the deployment — the reason is in the
    // build log. Naming the stage that failed is the most a caller gets without
    // a second request, and it is what tells "the build broke" apart from "the
    // deploy broke".
    let error_message = (deployment.state == "error").then(|| {
        let stage = raw
            .get("latest_stage")
            .and_then(|stage| stage.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("build");
        Value::from(format!("The {stage} stage failed."))
    });
    DeploymentDetail {
        deployment,
        aliases: Value::Array(
            raw.get("aliases")
                .and_then(Value::as_array)
                .map(|aliases| {
                    aliases
                        .iter()
                        .filter_map(Value::as_str)
                        .map(|alias| Value::from(hostname(alias)))
                        .collect()
                })
                .unwrap_or_default(),
        ),
        // Pages has no separate build-start moment: a stage's `started_on` is
        // when *that* stage began, not when the build did.
        building_at: None,
        error_message,
    }
}

/// The host part of a URL Pages reports with a scheme, since every other
/// provider reports a bare hostname.
fn hostname(url: &str) -> String {
    url.trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_string()
}

/// An ISO instant as epoch milliseconds, which is how every other provider
/// reports a time.
fn epoch_ms(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.timestamp_millis())
}

/// A connected Cloudflare client answering in the vendor-neutral shapes.
pub struct CloudflareDeployProvider {
    manager: CloudflareManager,
}

impl CloudflareDeployProvider {
    pub fn new(manager: CloudflareManager) -> Self {
        Self { manager }
    }

    fn account(&self) -> String {
        self.manager.account_id().unwrap_or_default().to_string()
    }

    /// Pages has no server-side project search, so the filter is applied here —
    /// on the name, which is also the id a caller would act on.
    pub async fn list_projects(
        &self,
        search: Option<&str>,
    ) -> Result<Vec<ProviderProject>, CloudflareApiError> {
        let projects = self.manager.list_projects_raw().await?;
        let needle = search.map(str::to_lowercase);
        Ok(projects
            .iter()
            .filter(|raw| match &needle {
                None => true,
                Some(needle) => raw
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| name.to_lowercase().contains(needle)),
            })
            .map(project_from_raw)
            .collect())
    }

    pub async fn get_project(&self, name: &str) -> Result<ProviderProject, CloudflareApiError> {
        Ok(project_from_raw(&self.manager.get_project_raw(name).await?))
    }

    /// The project imported from this git remote, found by walking the listing:
    /// Pages offers no lookup by repository.
    pub async fn find_by_repo_url(
        &self,
        repo: &str,
    ) -> Result<Option<ProviderProject>, CloudflareApiError> {
        Ok(self
            .manager
            .list_projects_raw()
            .await?
            .iter()
            .find(|raw| project_repo_url(raw).as_deref() == Some(repo))
            .map(project_from_raw))
    }

    pub async fn list_deployments(
        &self,
        project: &str,
        target: Option<&str>,
        limit: u32,
    ) -> Result<Vec<Deployment>, CloudflareApiError> {
        // Issued alongside the listing rather than after it. The listing is a
        // multi-page walk, and waiting for it before asking which deployment is
        // canonical would add a round trip to every read.
        let (deployments, canonical) = tokio::join!(
            self.manager
                .list_deployments_raw(project, target, limit as usize),
            self.canonical_deployment(project)
        );
        let deployments = deployments?;
        let account = self.account();
        Ok(deployments
            .iter()
            .map(|raw| deployment_from_raw(raw, &account, canonical.as_deref()))
            .collect())
    }

    pub async fn get_deployment(
        &self,
        project: &str,
        deployment: &str,
    ) -> Result<DeploymentDetail, CloudflareApiError> {
        let (raw, canonical) = tokio::join!(
            self.manager.get_deployment_raw(project, deployment),
            self.canonical_deployment(project)
        );
        Ok(detail_from_raw(
            &raw?,
            &self.account(),
            canonical.as_deref(),
        ))
    }

    pub async fn build_logs(
        &self,
        project: &str,
        deployment: &str,
    ) -> Result<Vec<BuildLogLine>, CloudflareApiError> {
        Ok(self
            .manager
            .build_logs_raw(project, deployment)
            .await?
            .iter()
            .filter_map(|entry| {
                // Trailing whitespace goes and leading whitespace stays, the
                // same way Vercel's build log is read — indentation is what
                // makes a build log legible, and a line that is only whitespace
                // is a hole in it.
                let text = entry.get("line").and_then(Value::as_str)?.trim_end();
                if text.is_empty() {
                    return None;
                }
                Some(BuildLogLine {
                    text: text.to_string(),
                    created: entry
                        .get("ts")
                        .and_then(Value::as_str)
                        .and_then(epoch_ms)
                        .map(Value::from),
                    level: None,
                })
            })
            .collect())
    }

    /// Which deployment the project currently serves. A failure to read it is
    /// not a failure to list deployments — it only means none is marked.
    async fn canonical_deployment(&self, project: &str) -> Option<String> {
        self.manager
            .get_project_raw(project)
            .await
            .ok()?
            .get("canonical_deployment")?
            .get("id")?
            .as_str()
            .map(str::to_string)
    }
}

/// The `owner/repo` a git remote reduces to, for matching Pages' own pair.
pub fn cloudflare_repo_url(remote: &str) -> Option<String> {
    repo_url(remote)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_projects_id_is_its_name() {
        let project = project_from_raw(&json!({"id": "prj_opaque", "name": "app"}));
        assert_eq!(project.id, Some(json!("app")));
        assert_eq!(project.name, Some(json!("app")));
    }

    /// Unlike Vercel's, these are always reported: Pages omits the whole
    /// `build_config` for a project it has never built.
    #[test]
    fn every_setting_is_reported_even_when_the_project_has_none() {
        let project = project_from_raw(&json!({"name": "app"}));
        assert_eq!(project.settings.len(), 4);
        assert!(project
            .settings
            .iter()
            .all(|setting| setting.value.is_null()));
    }

    #[test]
    fn a_skipped_deployment_is_canceled_and_says_so_plainly() {
        let deployment = deployment_from_raw(
            &json!({"id": "d", "is_skipped": true, "latest_stage": {"name": "deploy", "status": "success"}}),
            "acc",
            None,
        );
        assert_eq!(deployment.state, "canceled");
        assert_eq!(deployment.raw_state, "skipped");
    }

    /// A stage that is running is *building*; no stage at all is *queued*.
    #[test]
    fn a_missing_stage_reads_as_queued_and_idle() {
        let deployment = deployment_from_raw(&json!({"id": "d"}), "acc", None);
        assert_eq!(deployment.state, "queued");
        assert_eq!(deployment.raw_state, "queued:idle");
    }

    /// Pages can serve an older build after a rollback, so "current
    /// production" is what the project points at and not what is newest.
    #[test]
    fn current_production_is_the_canonical_deployment() {
        let raw = json!({"id": "d1", "environment": "preview"});
        assert!(deployment_from_raw(&raw, "acc", Some("d1")).is_current_production);
        assert!(!deployment_from_raw(&raw, "acc", Some("d2")).is_current_production);
        assert!(!deployment_from_raw(&raw, "acc", None).is_current_production);
    }

    #[test]
    fn only_a_finished_build_has_a_ready_moment() {
        let ready = json!({
            "id": "d", "latest_stage": {"name": "deploy", "status": "success"},
            "modified_on": "2026-02-01T10:05:00Z"
        });
        assert!(deployment_from_raw(&ready, "acc", None).ready_at.is_some());
        let failed = json!({
            "id": "d", "latest_stage": {"name": "deploy", "status": "failure"},
            "modified_on": "2026-02-01T10:05:00Z"
        });
        assert!(deployment_from_raw(&failed, "acc", None).ready_at.is_none());
    }

    #[test]
    fn urls_and_aliases_are_reported_as_bare_hostnames() {
        let detail = detail_from_raw(
            &json!({"id": "d", "url": "https://d.pages.dev", "aliases": ["https://a.pages.dev", "b.pages.dev"]}),
            "acc",
            None,
        );
        assert_eq!(detail.deployment.url, Some(json!("d.pages.dev")));
        assert_eq!(detail.aliases, json!(["a.pages.dev", "b.pages.dev"]));
    }
}
