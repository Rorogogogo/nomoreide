//! Write-capable Vercel operations, deliberately separate from the read-safe
//! `vercel_manager` — the same split as `git_manager` / git write commands, and
//! the Rust counterpart of `src/core/vercel-actions.ts`.
//!
//! Everything here changes what the internet is serving, so none of it is
//! exposed to an agent: these are reached only from the dashboard's own
//! commands, where a human clicked the button. Callers are expected to confirm
//! production-affecting actions (`promote`, `rollback`) before invoking them.
//!
//! Still intentionally excludes the irreversible ones — deleting deployments or
//! projects — which would need their own guarded surface.

use serde_json::Value;

use super::vercel_manager::{request, request_json, RequestAuth, VercelApiError};
use crate::providers::deploy::{truthy, CreatedDeployment};

pub struct VercelActions {
    auth: RequestAuth,
}

impl VercelActions {
    pub fn new(auth: RequestAuth) -> Self {
        VercelActions { auth }
    }

    /// Rebuild an existing deployment. Vercel inherits the original's settings,
    /// env, and git ref, minting a new deployment id — it never mutates the one
    /// being retried, so this is safe to offer on a failed build.
    ///
    /// `target` carries the original's environment through: without it a
    /// redeploy of a production deployment would come back as a preview.
    /// `name` and `target` travel as the JSON the vendor sent, not as strings:
    /// they are read straight off the original deployment and handed back
    /// unchanged, and narrowing them here would be this layer inventing a type
    /// the vendor never promised.
    pub async fn redeploy(
        &self,
        uid: &str,
        name: &Value,
        target: &Value,
    ) -> Result<CreatedDeployment, VercelApiError> {
        let mut body = serde_json::json!({ "deploymentId": uid, "name": name });
        // Omitted rather than sent as null when the original had none: Vercel
        // reads the key's presence, and a null target is a preview.
        if truthy(target) {
            body["target"] = target.clone();
        }
        let created = request_json(
            &self.auth,
            "POST",
            "/v13/deployments?forceNew=1",
            Some(&body),
        )
        .await?;
        Ok(CreatedDeployment {
            id: created
                .get("uid")
                .or_else(|| created.get("id"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            url: created.get("url").cloned().unwrap_or(Value::Null),
        })
    }

    /// Stop an in-flight build. A finished deployment cannot be canceled
    /// (Vercel answers 400).
    pub async fn cancel(&self, deployment_id: &str) -> Result<(), VercelApiError> {
        let path = format!(
            "/v12/deployments/{}/cancel",
            urlencoding::encode(deployment_id)
        );
        request(&self.auth, "PATCH", &path, None).await?;
        Ok(())
    }

    /// Point the project's production alias at an existing deployment without
    /// rebuilding it. This is what "Promote to Production" does in the Vercel
    /// dashboard, and it takes effect immediately.
    pub async fn promote(
        &self,
        project_id: &str,
        deployment_id: &str,
    ) -> Result<(), VercelApiError> {
        let path = format!(
            "/v10/projects/{}/promote/{}",
            urlencoding::encode(project_id),
            urlencoding::encode(deployment_id)
        );
        request(&self.auth, "POST", &path, None).await?;
        Ok(())
    }

    /// Roll production back *to* an earlier deployment. Distinct from
    /// `promote` on the API side: it records a rollback (with its reason)
    /// rather than a forward promotion, which is what the project's rollback
    /// history reads back.
    pub async fn rollback(
        &self,
        project_id: &str,
        deployment_id: &str,
        description: Option<&str>,
    ) -> Result<(), VercelApiError> {
        let mut path = format!(
            "/v1/projects/{}/rollback/{}",
            urlencoding::encode(project_id),
            urlencoding::encode(deployment_id)
        );
        if let Some(description) = description {
            path.push_str(&format!(
                "?description={}",
                urlencoding::encode(description)
            ));
        }
        request(&self.auth, "POST", &path, None).await?;
        Ok(())
    }

    /// Add a variable.
    ///
    /// `encrypted` (Vercel's "Sensitive") is the default, and its value never
    /// reads back over the API afterwards — `plain` is for values a build
    /// script needs to see, not for secrets.
    pub async fn create_env(
        &self,
        project_id: &str,
        key: &str,
        value: &str,
        environments: &[String],
        kind: &str,
    ) -> Result<Value, VercelApiError> {
        let path = format!("/v10/projects/{}/env", urlencoding::encode(project_id));
        let body = serde_json::json!({
            "key": key,
            "value": value,
            "target": environments,
            "type": kind,
        });
        let created = request_json(&self.auth, "POST", &path, Some(&body)).await?;
        // This endpoint answers either the record itself or a `{ created: [] }`
        // batch, depending on how Vercel felt about the request.
        // The record is returned as Vercel sent it; the provider layer is
        // where a vendor record becomes a neutral one, and doing it here would
        // be a second place that mapping lives.
        Ok(created
            .get("created")
            .and_then(Value::as_array)
            .and_then(|batch| batch.first())
            .cloned()
            .unwrap_or(created))
    }

    /// Change a variable's value and/or the environments it applies to.
    ///
    /// The key itself is not editable: Vercel does not support renaming in
    /// place, so a rename is a delete-and-recreate the UI does not offer as one
    /// step.
    pub async fn update_env(
        &self,
        project_id: &str,
        env_id: &str,
        value: Option<&str>,
        environments: Option<&[String]>,
    ) -> Result<Value, VercelApiError> {
        let path = format!(
            "/v9/projects/{}/env/{}",
            urlencoding::encode(project_id),
            urlencoding::encode(env_id)
        );
        // Only the fields the caller named: an absent `value` means "leave it",
        // which is not the same as setting it to the empty string.
        let mut body = serde_json::Map::new();
        if let Some(value) = value {
            body.insert("value".into(), Value::String(value.to_string()));
        }
        if let Some(environments) = environments {
            body.insert("target".into(), serde_json::json!(environments));
        }
        request_json(&self.auth, "PATCH", &path, Some(&Value::Object(body))).await
    }

    pub async fn delete_env(&self, project_id: &str, env_id: &str) -> Result<(), VercelApiError> {
        let path = format!(
            "/v9/projects/{}/env/{}",
            urlencoding::encode(project_id),
            urlencoding::encode(env_id)
        );
        request(&self.auth, "DELETE", &path, None).await?;
        Ok(())
    }
}
