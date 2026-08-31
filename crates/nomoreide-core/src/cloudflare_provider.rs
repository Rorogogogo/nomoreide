//! Cloudflare Pages seen through the vendor-neutral deploy contract.
//!
//! The Rust half of `src/core/cloudflare-provider.ts`. Where Vercel needed a
//! second normalization because the desktop app already had one, Cloudflare
//! needs one because Pages describes a deployment in nothing like Vercel's
//! terms: a *stage* and its *status* rather than a ready state, an
//! *environment* rather than a target, and an owner/repo pair rather than a
//! repository URL.

use serde_json::Value;

use crate::cloudflare_manager::{
    repo_url, CloudflareApiError, CloudflareEnvVar, CloudflareManager, PLAIN_TEXT,
};
use crate::providers::api_base::provider_api_host;
use crate::providers::deploy::{
    present, Deployment, DeploymentDetail, DeploymentMeta, DomainVerification, ProjectLink,
    ProjectSetting, ProviderDomain, ProviderEnvVar, ProviderLogLine, ProviderProject,
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

/// `project` is the project the caller *resolved*, not the one the record
/// names. They agree whenever Pages labelled the deployment — but the dashboard
/// link has to open even when it did not, and the record's own label is the one
/// field here that can be missing.
pub fn deployment_from_raw(
    raw: &Value,
    account: &str,
    project: &str,
    canonical: Option<&str>,
) -> Deployment {
    let (state, raw_state) = states_of(raw);

    let id = raw
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    Deployment {
        // Current production is whichever deployment the project points at, not
        // whichever one is newest and production-targeted: Pages can serve an
        // older build after a rollback, and can serve a preview URL as the
        // canonical one.
        is_current_production: canonical.is_some_and(|canonical| canonical == id),
        // The record's own label, always a string and empty when Pages did not
        // set one — a record old enough to predate the field still has to
        // render in a list whose name column the client reads unconditionally.
        name: Some(Value::from(
            raw.get("project_name")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )),
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
        inspector_url: Some(Value::from(inspector_url(account, project, &id))),
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

pub fn detail_from_raw(
    raw: &Value,
    account: &str,
    project: &str,
    canonical: Option<&str>,
) -> DeploymentDetail {
    let deployment = deployment_from_raw(raw, account, project, canonical);
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

/// One variable, in the neutral shape.
///
/// Cloudflare has no variable ids, so the key is both — which is what makes
/// the reveal and update routes addressable at all.
pub fn env_from_merged(variable: &CloudflareEnvVar) -> ProviderEnvVar {
    ProviderEnvVar {
        id: Some(Value::String(variable.key.clone())),
        key: Some(Value::String(variable.key.clone())),
        environments: variable
            .environments
            .iter()
            .map(|environment| Value::String(environment.clone()))
            .collect(),
        kind: Value::String(
            if variable.kind == PLAIN_TEXT {
                "plain"
            } else {
                "encrypted"
            }
            .into(),
        ),
        // Cloudflare has neither concept, and reporting them as null would
        // claim it had asked and found nothing.
        git_branch: None,
        comment: None,
        created_at: None,
        updated_at: None,
    }
}

/// One custom domain, in the neutral shape.
///
/// A domain that is not yet active *and* has a TXT record to add reports that
/// record as the one thing the user can do about it. A domain that is merely
/// pending with nothing to copy reports no record, because an empty row to
/// paste is worse than none.
fn domain_from_raw(raw: &Value) -> ProviderDomain {
    let status = raw
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("pending");
    let validation = raw.get("validation_data").filter(|value| !value.is_null());
    let txt_name = validation
        .and_then(|data| data.get("txt_name"))
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty());

    let verification = match txt_name.filter(|_| status != "active") {
        Some(txt_name) => vec![DomainVerification {
            kind: Value::String("TXT".into()),
            domain: Value::String(txt_name.to_string()),
            value: Value::String(
                validation
                    .and_then(|data| data.get("txt_value"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            ),
            // Cloudflare puts the reason in either of two places; when it gives
            // none, the status is the only thing there is to say.
            reason: Some(
                validation
                    .and_then(|data| present(data.get("error_message")))
                    .or_else(|| {
                        present(
                            raw.get("verification_data")
                                .and_then(|data| data.get("error_message")),
                        )
                    })
                    .unwrap_or_else(|| Value::String(status.to_string())),
            ),
        }],
        None => Vec::new(),
    };

    ProviderDomain {
        name: raw.get("name").cloned(),
        // Pages has no apex grouping, no redirects, no per-branch domains and
        // no modification time, so each is absent rather than null.
        apex_name: None,
        verified: status == "active",
        redirect: None,
        git_branch: None,
        created_at: raw
            .get("created_on")
            .and_then(Value::as_str)
            .and_then(epoch_ms)
            .map(Value::from),
        updated_at: None,
        verification,
    }
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

    /// Who the credential belongs to — `/user`, or the token's own identity
    /// when `/user` is out of its scope. See [`CloudflareManager::viewer`].
    pub async fn viewer(&self) -> Result<Value, CloudflareApiError> {
        self.manager.viewer().await
    }

    /// The accounts this credential can act as.
    ///
    /// Cloudflare accounts have no slug, so the id addresses one and is
    /// reported as both; a nameless account is offered under its id rather
    /// than as a blank row.
    pub async fn list_scopes(&self) -> Result<Vec<Value>, CloudflareApiError> {
        Ok(self
            .manager
            .list_accounts()
            .await?
            .iter()
            .map(|raw| {
                let id = raw.get("id").filter(|value| !value.is_null()).cloned();
                let name = raw
                    .get("name")
                    .filter(|value| !value.is_null())
                    .cloned()
                    .or_else(|| id.clone());
                let mut scope = serde_json::Map::new();
                for (key, value) in [("id", id.clone()), ("slug", id), ("name", name)] {
                    if let Some(value) = value {
                        scope.insert(key.into(), value);
                    }
                }
                Value::Object(scope)
            })
            .collect())
    }

    pub async fn list_env(&self, project: &str) -> Result<Vec<ProviderEnvVar>, CloudflareApiError> {
        Ok(self
            .manager
            .list_env(project)
            .await?
            .iter()
            .map(env_from_merged)
            .collect())
    }

    pub async fn get_env_value(
        &self,
        project: &str,
        key: &str,
    ) -> Result<String, CloudflareApiError> {
        self.manager.env_value(project, key).await
    }

    /// The project's domains, including the `*.pages.dev` host Cloudflare
    /// assigns.
    ///
    /// `/domains` lists **custom** domains only, so a project serving perfectly
    /// well reads as having none — while Vercel's equivalent endpoint includes
    /// the vendor-assigned `*.vercel.app`. Both render through the same generic
    /// view, so the asymmetry showed up on a live account as "no domains"
    /// beside a site anyone could load. The assigned host goes last, the way
    /// Vercel orders its own, so a custom domain still leads.
    ///
    /// A failed *project* read degrades to the custom domains alone: the panel
    /// is still correct, just missing the assigned host.
    pub async fn list_domains(
        &self,
        project: &str,
    ) -> Result<Vec<ProviderDomain>, CloudflareApiError> {
        let (custom, project_raw) = tokio::join!(
            self.manager.list_domains_raw(project),
            self.manager.get_project_raw(project)
        );
        let mut domains: Vec<ProviderDomain> = custom?.iter().map(domain_from_raw).collect();
        let Ok(project_raw) = project_raw else {
            return Ok(domains);
        };
        let Some(subdomain) = project_raw
            .get("subdomain")
            .and_then(Value::as_str)
            .filter(|subdomain| !subdomain.is_empty())
        else {
            return Ok(domains);
        };
        if domains
            .iter()
            .any(|domain| domain.name.as_ref().and_then(Value::as_str) == Some(subdomain))
        {
            return Ok(domains);
        }
        domains.push(ProviderDomain {
            name: Some(Value::String(subdomain.to_string())),
            apex_name: None,
            // The assigned host is always serving; there is nothing to verify.
            verified: true,
            redirect: None,
            git_branch: None,
            created_at: project_raw
                .get("created_on")
                .and_then(Value::as_str)
                .and_then(epoch_ms)
                .map(Value::from),
            updated_at: None,
            verification: Vec::new(),
        });
        Ok(domains)
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
            .map(|raw| deployment_from_raw(raw, &account, project, canonical.as_deref()))
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
            project,
            canonical.as_deref(),
        ))
    }

    pub async fn build_logs(
        &self,
        project: &str,
        deployment: &str,
    ) -> Result<Vec<ProviderLogLine>, CloudflareApiError> {
        Ok(self
            .manager
            .build_logs_raw(project, deployment)
            .await?
            .iter()
            // Numbered before the empty lines are dropped, because the index is
            // part of the fallback id: filtering first would renumber every
            // line after a blank one.
            .enumerate()
            .filter_map(|(index, entry)| {
                // Trailing whitespace goes and leading whitespace stays, the
                // same way Vercel's build log is read — indentation is what
                // makes a build log legible, and a line that is only whitespace
                // is a hole in it.
                let text = entry.get("line").and_then(Value::as_str)?.trim_end();
                if text.is_empty() {
                    return None;
                }
                let stamp = entry.get("ts").and_then(Value::as_str);
                Some(ProviderLogLine::build(
                    // Pages numbers nothing, so the id is the timestamp it did
                    // send — a string, not a number — paired with the position.
                    match stamp {
                        Some(ts) => format!("{ts}-{index}"),
                        None => format!("{index}-{index}"),
                    },
                    stamp.and_then(epoch_ms).unwrap_or(0),
                    // Pages does not separate its streams, so every line is
                    // stdout rather than a level the vendor chose.
                    "stdout".to_string(),
                    text.to_string(),
                ))
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

/// The manifest the dashboard renders a tab from.
///
/// `requiresScope` is the field Vercel has no use for: a Cloudflare token is
/// account-scoped, so a connection that has not chosen an account cannot ask
/// for anything yet.
pub fn manifest() -> Value {
    serde_json::json!({
        "id": "cloudflare",
        "name": "Cloudflare",
        "kind": "deploy",
        "strings": {
            "en": {
                "scope.label": "Cloudflare account",
                "action.redeploy": "Retry build",
                "action.redeploy.done": "Build retried.",
                "action.rollback": "Roll back",
                "action.rollback.done": "Rolled back production.",
                "action.rollback.confirmTitle": "Roll production back?",
                "action.rollback.confirm": "Production traffic switches back to this older deployment immediately."
            },
            "zh": {
                "scope.label": "Cloudflare 账户",
                "action.redeploy": "重试构建",
                "action.redeploy.done": "已重试构建。",
                "action.rollback": "回滚",
                "action.rollback.done": "已回滚生产环境。",
                "action.rollback.confirmTitle": "回滚生产环境？",
                "action.rollback.confirm": "生产流量将立即切回这个较旧的部署。"
            }
        },
        "authSources": [
            "cli",
            "stored"
        ],
        "capabilities": [
            "projects",
            "deployments",
            "buildLogs",
            "env",
            "domains"
        ],
        "requiresScope": true,
        "actions": [
            "redeploy",
            "rollback"
        ],
        "productionAffecting": [
            "rollback"
        ],
        // `dash.cloudflare.com` is deliberately absent: the manager builds
        // dashboard and deployment URLs as strings for the UI to link to, and
        // never fetches them. An allowlist covers what is requested, not what
        // is displayed.
        //
        // Derived from the base URL rather than written out, so the allowlist
        // and the place requests actually go cannot drift apart — including
        // when `NOMOREIDE_CLOUDFLARE_API_BASE` points them at a loopback stub.
        "api": {
            "hosts": [
                provider_api_host(&crate::cloudflare_manager::api_base())
            ]
        }
    })
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
            "app",
            None,
        );
        assert_eq!(deployment.state, "canceled");
        assert_eq!(deployment.raw_state, "skipped");
    }

    /// A stage that is running is *building*; no stage at all is *queued*.
    #[test]
    fn a_missing_stage_reads_as_queued_and_idle() {
        let deployment = deployment_from_raw(&json!({"id": "d"}), "acc", "app", None);
        assert_eq!(deployment.state, "queued");
        assert_eq!(deployment.raw_state, "queued:idle");
    }

    /// Pages can serve an older build after a rollback, so "current
    /// production" is what the project points at and not what is newest.
    #[test]
    fn current_production_is_the_canonical_deployment() {
        let raw = json!({"id": "d1", "environment": "preview"});
        assert!(deployment_from_raw(&raw, "acc", "app", Some("d1")).is_current_production);
        assert!(!deployment_from_raw(&raw, "acc", "app", Some("d2")).is_current_production);
        assert!(!deployment_from_raw(&raw, "acc", "app", None).is_current_production);
    }

    #[test]
    fn only_a_finished_build_has_a_ready_moment() {
        let ready = json!({
            "id": "d", "latest_stage": {"name": "deploy", "status": "success"},
            "modified_on": "2026-02-01T10:05:00Z"
        });
        assert!(deployment_from_raw(&ready, "acc", "app", None)
            .ready_at
            .is_some());
        let failed = json!({
            "id": "d", "latest_stage": {"name": "deploy", "status": "failure"},
            "modified_on": "2026-02-01T10:05:00Z"
        });
        assert!(deployment_from_raw(&failed, "acc", "app", None)
            .ready_at
            .is_none());
    }

    #[test]
    fn urls_and_aliases_are_reported_as_bare_hostnames() {
        let detail = detail_from_raw(
            &json!({"id": "d", "url": "https://d.pages.dev", "aliases": ["https://a.pages.dev", "b.pages.dev"]}),
            "acc",
            "app",
            None,
        );
        assert_eq!(detail.deployment.url, Some(json!("d.pages.dev")));
        assert_eq!(detail.aliases, json!(["a.pages.dev", "b.pages.dev"]));
    }
}
