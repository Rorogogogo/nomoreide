//! Vercel seen through the vendor-neutral deploy contract.
//!
//! The Rust half of `src/core/vercel-provider.ts`. Everything here is a
//! translation of Vercel's own records into the shapes in `providers::deploy` —
//! no request is built and no policy is decided, so a change to what Vercel
//! returns is absorbed here rather than reaching a caller.
//!
//! **This is a second normalization, not a replacement for the first.**
//! `vercel_manager`'s `normalize_project` / `normalize_deployment` serve the
//! desktop app's frontend and have always had that shape. This one serves the
//! dashboard, the daemon, and the MCP tools. They differ where it matters: the
//! desktop shape reports every project setting as `null` when it is missing,
//! which cannot tell a setting the user *cleared* from one Vercel never had.

use serde_json::Value;

use crate::providers::deploy::{
    BuildLogLine, Deployment, DeploymentDetail, DeploymentMeta, ProjectLink, ProjectSetting,
    ProviderProject,
};
use crate::providers::project_resolution::LinkFile;
use crate::vercel_manager::{repo_url, VercelApiError, VercelManager};

pub const VERCEL_PROVIDER_ID: &str = "vercel";

/// `vercel link` writes this, and it is the same file the CLI itself trusts.
pub const VERCEL_LINK_FILE: LinkFile = LinkFile {
    path: &[".vercel", "project.json"],
    field: "projectId",
};

/// The build settings a project reports, in the order the dashboard shows them.
///
/// A fixed list with fixed labels rather than whatever keys the vendor happens
/// to send: these are the settings a person changes, and a list that reordered
/// itself per project would be unreadable.
const SETTINGS: [(&str, &str); 6] = [
    ("buildCommand", "Build command"),
    ("devCommand", "Dev command"),
    ("installCommand", "Install command"),
    ("outputDirectory", "Output directory"),
    ("rootDirectory", "Root directory"),
    ("nodeVersion", "Node version"),
];

/// Vercel's own words for a deployment state, collapsed to the five a person
/// acts on. `INITIALIZING` is "building" because there is nothing else a
/// caller would do about it, and an unrecognized state is "queued" rather than
/// an error — `rawState` carries Vercel's word alongside either way.
fn state_of(raw: &str) -> &'static str {
    match raw {
        "READY" => "ready",
        "ERROR" => "error",
        "CANCELED" => "canceled",
        "DELETED" => "deleted",
        "BUILDING" | "INITIALIZING" => "building",
        _ => "queued",
    }
}

pub fn project_from_raw(raw: &Value) -> ProviderProject {
    ProviderProject {
        id: raw.get("id").cloned(),
        name: raw.get("name").cloned(),
        framework: raw.get("framework").cloned().unwrap_or(Value::Null),
        updated_at: raw.get("updatedAt").cloned(),
        link: link_from_raw(raw.get("link")),
        settings: SETTINGS
            .iter()
            // Present-but-null is a setting the user cleared; absent is one
            // Vercel does not carry for this project, and the two read
            // differently in the dashboard.
            .filter_map(|(key, label)| {
                raw.get(key).map(|value| ProjectSetting {
                    key,
                    label,
                    value: value.clone(),
                })
            })
            .collect(),
    }
}

/// A link is reported only when it names a host. Vercel sends `link: {}` for a
/// project imported without one, and a link with no type tells a caller nothing
/// it can act on.
fn link_from_raw(raw: Option<&Value>) -> Option<ProjectLink> {
    let link = raw?;
    let kind = link
        .get("type")
        .and_then(Value::as_str)
        .filter(|kind| !kind.is_empty())?;
    Some(ProjectLink {
        kind: kind.to_string(),
        org: link.get("org").cloned(),
        repo: link.get("repo").cloned(),
        production_branch: link.get("productionBranch").cloned(),
    })
}

pub fn deployment_from_raw(raw: &Value) -> Deployment {
    let vendor_state = raw
        .get("readyState")
        .or_else(|| raw.get("state"))
        .and_then(Value::as_str)
        .unwrap_or("QUEUED");
    let target = raw.get("target").cloned().unwrap_or(Value::Null);
    // `PROMOTED`/`ROLLING` mark the deployment currently aliased to production;
    // `STAGED` means built for production but not serving it.
    let staged = raw.get("readySubstate").and_then(Value::as_str) == Some("STAGED");

    Deployment {
        id: raw
            .get("uid")
            .or_else(|| raw.get("id"))
            .cloned()
            .unwrap_or(Value::String(String::new())),
        name: raw.get("name").cloned(),
        url: raw.get("url").cloned(),
        state: state_of(vendor_state).to_string(),
        raw_state: vendor_state.to_string(),
        is_current_production: target.as_str() == Some("production") && !staged,
        target,
        created_at: raw.get("createdAt").or_else(|| raw.get("created")).cloned(),
        ready_at: raw.get("readyAt").or_else(|| raw.get("ready")).cloned(),
        creator: raw.get("creator").cloned(),
        meta: meta_from_raw(raw.get("meta")),
        inspector_url: raw.get("inspectorUrl").cloned(),
    }
}

/// The commit, whichever git host it came from. Each field falls back
/// independently: a deployment carrying a GitHub sha and a GitLab ref is not a
/// real Vercel record, but reading it field by field means one odd key cannot
/// hide the three good ones.
fn meta_from_raw(raw: Option<&Value>) -> DeploymentMeta {
    let pick = |keys: [&str; 3]| -> Option<Value> {
        keys.iter()
            .find_map(|key| raw.and_then(|meta| meta.get(*key)).cloned())
    };
    DeploymentMeta {
        branch: pick(["githubCommitRef", "gitlabCommitRef", "bitbucketCommitRef"]),
        sha: pick(["githubCommitSha", "gitlabCommitSha", "bitbucketCommitSha"]),
        commit_message: pick([
            "githubCommitMessage",
            "gitlabCommitMessage",
            "bitbucketCommitMessage",
        ]),
        commit_author: pick([
            "githubCommitAuthorName",
            "gitlabCommitAuthorName",
            "bitbucketCommitAuthorName",
        ]),
    }
}

pub fn detail_from_raw(raw: &Value) -> DeploymentDetail {
    DeploymentDetail {
        deployment: deployment_from_raw(raw),
        aliases: raw.get("alias").cloned().unwrap_or(Value::Array(vec![])),
        building_at: raw.get("buildingAt").cloned(),
        // An explicit null is "this build did not fail", which is not a message.
        error_message: raw
            .get("errorMessage")
            .filter(|value| !value.is_null())
            .cloned(),
    }
}

/// A connected Vercel client answering in the vendor-neutral shapes.
pub struct VercelDeployProvider {
    manager: VercelManager,
}

impl VercelDeployProvider {
    pub fn new(manager: VercelManager) -> Self {
        Self { manager }
    }

    pub async fn list_projects(
        &self,
        search: Option<&str>,
    ) -> Result<Vec<ProviderProject>, VercelApiError> {
        Ok(self
            .manager
            .list_projects_raw(search, None, None)
            .await?
            .iter()
            .map(project_from_raw)
            .collect())
    }

    pub async fn get_project(&self, id: &str) -> Result<ProviderProject, VercelApiError> {
        Ok(project_from_raw(&self.manager.get_project_raw(id).await?))
    }

    /// The project Vercel has imported from this git remote, if any.
    pub async fn find_by_repo_url(
        &self,
        repo_url: &str,
    ) -> Result<Option<ProviderProject>, VercelApiError> {
        Ok(self
            .manager
            .list_projects_raw(None, Some(repo_url), Some(2))
            .await?
            .first()
            .map(project_from_raw))
    }

    pub async fn list_deployments(
        &self,
        project_id: &str,
        target: Option<&str>,
        limit: u32,
    ) -> Result<Vec<Deployment>, VercelApiError> {
        Ok(self
            .manager
            .list_deployments_raw(project_id, target, Some(limit))
            .await?
            .iter()
            .map(deployment_from_raw)
            .collect())
    }

    pub async fn get_deployment(&self, id: &str) -> Result<DeploymentDetail, VercelApiError> {
        Ok(detail_from_raw(&self.manager.get_deployment_raw(id).await?))
    }

    pub async fn build_logs(
        &self,
        id: &str,
        limit: u32,
    ) -> Result<Vec<BuildLogLine>, VercelApiError> {
        Ok(self
            .manager
            .deployment_build_logs(id, Some(limit))
            .await?
            .iter()
            .map(|line| BuildLogLine {
                text: line
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                created: line.get("createdAt").cloned(),
                level: line.get("type").and_then(Value::as_str).map(str::to_string),
            })
            .collect())
    }
}

/// The URL Vercel keys an imported project by, derived from a git remote.
pub fn vercel_repo_url(remote: &str) -> Option<String> {
    repo_url(remote)
}

/// The manifest the dashboard renders a tab from, and the egress allowlist
/// `createProviderFetch` enforces.
///
/// Data rather than a struct: every field of it is sent verbatim to a client
/// that renders it, including the translated action labels, so a struct would
/// only add a second spelling of the same document to keep in step.
pub fn manifest() -> Value {
    serde_json::json!({
        "id": "vercel",
        "name": "Vercel",
        "kind": "deploy",
        "strings": {
            "en": {
                "scope.label": "Vercel scope",
                "action.redeploy": "Redeploy",
                "action.redeploy.done": "Redeploy started.",
                "action.cancel": "Cancel build",
                "action.cancel.done": "Build canceled.",
                "action.promote": "Promote",
                "action.promote.done": "Promoted to production.",
                "action.promote.confirmTitle": "Promote to production?",
                "action.promote.confirm": "Production traffic switches to this deployment immediately.",
                "action.rollback": "Roll back",
                "action.rollback.done": "Rolled back production.",
                "action.rollback.confirmTitle": "Roll production back?",
                "action.rollback.confirm": "Production traffic switches back to this older deployment immediately."
            },
            "zh": {
                "scope.label": "Vercel 范围",
                "action.redeploy": "重新部署",
                "action.redeploy.done": "已开始重新部署。",
                "action.cancel": "取消构建",
                "action.cancel.done": "已取消构建。",
                "action.promote": "提升至生产",
                "action.promote.done": "已提升至生产环境。",
                "action.promote.confirmTitle": "提升至生产环境？",
                "action.promote.confirm": "生产流量将立即切换到该部署。",
                "action.rollback": "回滚",
                "action.rollback.done": "已回滚生产环境。",
                "action.rollback.confirmTitle": "回滚生产环境？",
                "action.rollback.confirm": "生产流量将立即切回这个较旧的部署。"
            }
        },
        "authSources": [
            "cli",
            "stored",
            "oauth"
        ],
        "capabilities": [
            "projects",
            "deployments",
            "buildLogs",
            "runtimeLogs",
            "env",
            "domains"
        ],
        "actions": [
            "redeploy",
            "cancel",
            "promote",
            "rollback"
        ],
        "productionAffecting": [
            "promote",
            "rollback"
        ],
        "api": {
            "hosts": [
                "api.vercel.com"
            ]
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn value(project: &ProviderProject) -> Value {
        serde_json::to_value(project).unwrap()
    }

    #[test]
    fn a_setting_is_reported_only_when_the_project_carries_the_key() {
        let project = project_from_raw(&json!({
            "id": "prj", "name": "app", "buildCommand": "make", "devCommand": Value::Null
        }));
        assert_eq!(
            project.settings,
            vec![
                ProjectSetting {
                    key: "buildCommand",
                    label: "Build command",
                    value: json!("make")
                },
                ProjectSetting {
                    key: "devCommand",
                    label: "Dev command",
                    value: Value::Null
                },
            ]
        );
    }

    #[test]
    fn framework_is_always_reported_and_a_missing_id_is_not() {
        let project = value(&project_from_raw(&json!({ "name": "app" })));
        assert_eq!(project["framework"], Value::Null);
        assert!(project.get("id").is_none());
        assert_eq!(project["settings"], json!([]));
    }

    /// Vercel sends `link: {}` for a project imported without a git host, and
    /// a link that names none tells a caller nothing.
    #[test]
    fn a_link_without_a_type_is_not_a_link() {
        for raw in [
            json!({"link": {}}),
            json!({"link": Value::Null}),
            json!({"link": "github"}),
        ] {
            assert!(project_from_raw(&raw).link.is_none(), "{raw}");
        }
        assert_eq!(
            project_from_raw(&json!({"link": {"type": "github", "org": "acme", "repo": "app"}}))
                .link
                .map(|link| link.kind),
            Some("github".to_string())
        );
    }

    #[test]
    fn ready_state_wins_over_state_and_an_unknown_one_is_queued() {
        for (raw, state, vendor) in [
            (
                json!({"readyState": "READY", "state": "BUILDING"}),
                "ready",
                "READY",
            ),
            (json!({"state": "CANCELED"}), "canceled", "CANCELED"),
            (
                json!({"readyState": "INITIALIZING"}),
                "building",
                "INITIALIZING",
            ),
            (
                json!({"readyState": "SOMETHING_NEW"}),
                "queued",
                "SOMETHING_NEW",
            ),
            (json!({}), "queued", "QUEUED"),
        ] {
            let deployment = deployment_from_raw(&raw);
            assert_eq!(deployment.state, state, "{raw}");
            assert_eq!(deployment.raw_state, vendor, "{raw}");
        }
    }

    /// A production deployment that is built but not serving is not current.
    #[test]
    fn a_staged_production_deployment_is_not_the_current_one() {
        let staged = json!({"target": "production", "readySubstate": "STAGED"});
        assert!(!deployment_from_raw(&staged).is_current_production);
        let promoted = json!({"target": "production", "readySubstate": "PROMOTED"});
        assert!(deployment_from_raw(&promoted).is_current_production);
        assert!(deployment_from_raw(&json!({"target": "production"})).is_current_production);
        assert!(!deployment_from_raw(&json!({"target": "preview"})).is_current_production);
    }

    #[test]
    fn each_commit_field_falls_back_across_git_hosts_on_its_own() {
        let meta = deployment_from_raw(&json!({"meta": {
            "gitlabCommitRef": "gl", "githubCommitSha": "gh", "bitbucketCommitMessage": "bb"
        }}))
        .meta;
        assert_eq!(meta.branch, Some(json!("gl")));
        assert_eq!(meta.sha, Some(json!("gh")));
        assert_eq!(meta.commit_message, Some(json!("bb")));
        assert_eq!(meta.commit_author, None);
    }

    #[test]
    fn a_detail_reports_aliases_even_when_there_are_none() {
        let detail = detail_from_raw(&json!({"uid": "dpl", "errorMessage": Value::Null}));
        assert_eq!(detail.aliases, json!([]));
        assert_eq!(detail.error_message, None);
        assert_eq!(detail.building_at, None);
    }
}
