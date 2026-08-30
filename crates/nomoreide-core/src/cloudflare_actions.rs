//! Write-capable Cloudflare Pages operations, deliberately separate from the
//! read-safe `cloudflare_manager` — the same split as `git_manager` / git write
//! commands, and the Rust counterpart of `src/core/cloudflare-actions.ts`.
//!
//! Everything here changes what the internet is serving, so none of it is
//! exposed to an agent: these are reached only from the dashboard's own routes,
//! where a human clicked the button.
//!
//! Still intentionally excludes the irreversible ones — Cloudflare's
//! `DELETE .../deployments/{id}` and project deletion — which would need their
//! own guarded surface.
//!
//! **A variable is not a record here, it is a patch.** Pages has no env-var
//! endpoint at all: variables live inside the project's `deployment_configs`,
//! one map per environment, so every write below is a `PATCH` of the project.
//! Cloudflare *merges* the map it is sent — a key set to `null` is deleted and
//! keys the patch does not mention are untouched — which is what lets these
//! avoid a read-modify-write that could clobber a variable added in between.

use serde_json::{Map, Value};

use crate::cloudflare_manager::{
    merge_env_vars, request_json, CloudflareApiError, CloudflareEnvVar, PLAIN_TEXT, SECRET_TEXT,
};
use crate::providers::deploy::CreatedDeployment;

/// The only two environments Pages has. A third would be silently created by a
/// `PATCH` and then read by nothing.
pub const CLOUDFLARE_ENVIRONMENTS: [&str; 2] = ["production", "preview"];

pub struct CloudflareActions {
    token: String,
    account_id: String,
}

impl CloudflareActions {
    pub fn new(token: String, account_id: String) -> Self {
        Self { token, account_id }
    }

    /// Rebuild an existing deployment.
    ///
    /// Cloudflare calls this "retry" and mints a new deployment id, inheriting
    /// the original's branch, commit and environment — so, unlike Vercel's
    /// redeploy, nothing has to be carried through by the caller to keep a
    /// production retry in production.
    pub async fn retry(
        &self,
        project: &str,
        deployment_id: &str,
    ) -> Result<CreatedDeployment, CloudflareApiError> {
        let created = self
            .post_deployment(project, deployment_id, "retry")
            .await?;
        Ok(CreatedDeployment {
            id: result_string(&created, "id").unwrap_or_default(),
            url: result_field(&created, "url"),
        })
    }

    /// Point the project's production alias at an earlier deployment without
    /// rebuilding it. Cloudflare records this as a rollback, and it takes
    /// effect immediately.
    ///
    /// Falls back to the id it was *given* when Cloudflare does not name one:
    /// a rollback does not create a deployment, so the answer describes the one
    /// production now serves.
    pub async fn rollback(
        &self,
        project: &str,
        deployment_id: &str,
    ) -> Result<CreatedDeployment, CloudflareApiError> {
        let rolled = self
            .post_deployment(project, deployment_id, "rollback")
            .await?;
        Ok(CreatedDeployment {
            id: result_string(&rolled, "id").unwrap_or_else(|| deployment_id.to_string()),
            url: result_field(&rolled, "url"),
        })
    }

    async fn post_deployment(
        &self,
        project: &str,
        deployment_id: &str,
        action: &str,
    ) -> Result<Value, CloudflareApiError> {
        let path = format!(
            "{}/deployments/{}/{action}",
            self.project_path(project),
            urlencoding::encode(deployment_id)
        );
        request_json(&self.token, "POST", &path, None).await
    }

    /// Add a variable. `encrypted` is the default, and its value never reads
    /// back over the API afterwards.
    pub async fn create_env(
        &self,
        project: &str,
        key: &str,
        value: &str,
        environments: &[String],
        secret: bool,
    ) -> Result<CloudflareEnvVar, CloudflareApiError> {
        let kind = if secret { SECRET_TEXT } else { PLAIN_TEXT };
        let mut patch = Map::new();
        for environment in require_environments(environments)? {
            patch.insert(
                environment,
                serde_json::json!({ key: { "type": kind, "value": value } }),
            );
        }
        self.patch_env(project, key, patch).await
    }

    /// Change a variable's value and/or the environments it applies to.
    ///
    /// Adding an environment needs a value: Cloudflare stores the variable
    /// separately per environment and never hands back a secret's value, so
    /// there is nothing to copy across. Saying that is better than writing an
    /// empty string into the new environment.
    pub async fn update_env(
        &self,
        project: &str,
        key: &str,
        value: Option<&str>,
        environments: Option<&[String]>,
    ) -> Result<CloudflareEnvVar, CloudflareApiError> {
        let current = self.current_env(project, key).await?;
        let wanted = match environments {
            Some(environments) => require_environments(environments)?,
            None => current.environments.clone(),
        };

        let mut patch = Map::new();
        for environment in &wanted {
            match value {
                Some(value) => {
                    patch.insert(
                        environment.clone(),
                        serde_json::json!({ key: { "type": current.kind, "value": value } }),
                    );
                }
                None if !current.environments.contains(environment) => {
                    return Err(local(format!(
                        "Adding \"{key}\" to {environment} needs a value — Cloudflare stores it separately per environment."
                    )));
                }
                None => {}
            }
        }
        // Every environment the variable is leaving, cleared by name.
        for environment in &current.environments {
            if !wanted.contains(environment) {
                patch.insert(environment.clone(), serde_json::json!({ key: Value::Null }));
            }
        }
        self.patch_env(project, key, patch).await
    }

    /// Remove a variable from every environment it is set in.
    pub async fn delete_env(&self, project: &str, key: &str) -> Result<(), CloudflareApiError> {
        let current = self.current_env(project, key).await?;
        let mut patch = Map::new();
        for environment in current.environments {
            patch.insert(environment, serde_json::json!({ key: Value::Null }));
        }
        self.patch_project(project, patch).await?;
        Ok(())
    }

    /// The one write to a project's variables, plus the check that Cloudflare
    /// actually reported the key afterwards — a `PATCH` it accepted but did not
    /// apply would otherwise read as a successful save.
    async fn patch_env(
        &self,
        project: &str,
        key: &str,
        patch: Map<String, Value>,
    ) -> Result<CloudflareEnvVar, CloudflareApiError> {
        self.patch_project(project, patch)
            .await?
            .into_iter()
            .find(|variable| variable.key == key)
            .ok_or_else(|| {
                local(format!(
                    "Cloudflare did not report \"{key}\" after the update."
                ))
            })
    }

    async fn patch_project(
        &self,
        project: &str,
        patch: Map<String, Value>,
    ) -> Result<Vec<CloudflareEnvVar>, CloudflareApiError> {
        let mut configs = Map::new();
        for (environment, variables) in patch {
            configs.insert(environment, serde_json::json!({ "env_vars": variables }));
        }
        let body = serde_json::json!({ "deployment_configs": configs });
        let updated = request_json(
            &self.token,
            "PATCH",
            &self.project_path(project),
            Some(&body),
        )
        .await?;
        Ok(merge_env_vars(
            updated
                .get("result")
                .and_then(|result| result.get("deployment_configs")),
        ))
    }

    /// What the project holds for this key right now, which both `update` and
    /// `delete` need in order to know which environments to touch.
    async fn current_env(
        &self,
        project: &str,
        key: &str,
    ) -> Result<CloudflareEnvVar, CloudflareApiError> {
        let project = request_json(&self.token, "GET", &self.project_path(project), None).await?;
        merge_env_vars(
            project
                .get("result")
                .and_then(|result| result.get("deployment_configs")),
        )
        .into_iter()
        .find(|variable| variable.key == key)
        .ok_or_else(|| local(format!("No variable named \"{key}\" on this project.")))
    }

    fn project_path(&self, project: &str) -> String {
        format!(
            "/accounts/{}/pages/projects/{}",
            self.account_id,
            urlencoding::encode(project)
        )
    }
}

/// Rejects anything that is not one of Pages' two environments.
///
/// Vercel's env dialog offers `development` as well, and the two providers
/// share that dialog — so a `PATCH` naming it would quietly create a third
/// deployment config that nothing ever reads.
fn require_environments(environments: &[String]) -> Result<Vec<String>, CloudflareApiError> {
    let invalid: Vec<&str> = environments
        .iter()
        .filter(|environment| !CLOUDFLARE_ENVIRONMENTS.contains(&environment.as_str()))
        .map(String::as_str)
        .collect();
    if !invalid.is_empty() {
        return Err(local(format!(
            "Cloudflare Pages only has {} and {} environments, not {}.",
            CLOUDFLARE_ENVIRONMENTS[0],
            CLOUDFLARE_ENVIRONMENTS[1],
            invalid.join(", ")
        )));
    }
    Ok(environments.to_vec())
}

/// A string inside Cloudflare's `result` envelope, if it sent one.
fn result_string(payload: &Value, key: &str) -> Option<String> {
    payload
        .get("result")
        .and_then(|result| result.get(key))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// A field inside `result`, narrowed to null when absent — the shape the
/// dashboard reads, where a deployment with no hostname yet is a real state.
fn result_field(payload: &Value, key: &str) -> Value {
    payload
        .get("result")
        .and_then(|result| result.get(key))
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or(Value::Null)
}

/// A refusal this module reached on its own, with no request behind it.
fn local(message: String) -> CloudflareApiError {
    CloudflareApiError { message, status: 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_pages_two_environments_are_accepted() {
        let ok = require_environments(&["production".into(), "preview".into()]).unwrap();
        assert_eq!(ok, vec!["production".to_string(), "preview".to_string()]);

        let refused = require_environments(&["production".into(), "development".into()])
            .unwrap_err()
            .message;
        // The message names what was wrong, not just that something was.
        assert!(refused.contains("development"), "{refused}");
        assert!(refused.contains("production and preview"), "{refused}");
    }

    #[test]
    fn an_empty_environment_list_is_not_this_functions_refusal() {
        // The route requires at least one before it gets here; this only
        // decides whether the *names* are ones Pages has.
        assert_eq!(require_environments(&[]).unwrap(), Vec::<String>::new());
    }
}
