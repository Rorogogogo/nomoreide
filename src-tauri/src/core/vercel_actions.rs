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
//! projects, and rotating env values — which would need their own guarded surface.

use serde_json::Value;

use super::vercel_manager::{request, RequestAuth, VercelApiError};

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
    pub async fn redeploy(
        &self,
        uid: &str,
        name: &str,
        target: Option<&str>,
    ) -> Result<Value, VercelApiError> {
        let mut body = serde_json::json!({ "deploymentId": uid, "name": name });
        if let Some(target) = target {
            body["target"] = Value::String(target.to_string());
        }
        let created = post_json(&self.auth, "/v13/deployments?forceNew=1", body).await?;
        Ok(serde_json::json!({
            "uid": created
                .get("uid")
                .or_else(|| created.get("id"))
                .cloned()
                .unwrap_or(Value::String(String::new())),
            "url": created.get("url").cloned().unwrap_or(Value::Null),
        }))
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
            path.push_str(&format!("?description={}", urlencoding::encode(description)));
        }
        request(&self.auth, "POST", &path, None).await?;
        Ok(())
    }
}

/// `request` has no JSON body support (nothing on the read side needs one), so
/// the single action that posts a body does it here rather than widening the
/// shared helper for one caller.
async fn post_json(auth: &RequestAuth, path: &str, body: Value) -> Result<Value, VercelApiError> {
    let mut url = format!("https://api.vercel.com{path}");
    if let Some(team_id) = auth.team_id.as_ref() {
        let separator = if url.contains('?') { '&' } else { '?' };
        url.push(separator);
        url.push_str(&format!("teamId={}", urlencoding::encode(team_id)));
    }

    let response = reqwest::Client::new()
        .post(&url)
        .header("Authorization", format!("Bearer {}", auth.token))
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|error| VercelApiError {
            message: format!("Vercel request failed: {error}"),
            status: 0,
        })?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| format!("Vercel returned {} for {path}", status.as_u16()));
        return Err(VercelApiError {
            message,
            status: status.as_u16(),
        });
    }
    serde_json::from_str(&text).or(Ok(Value::Null))
}
