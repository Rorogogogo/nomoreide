//! Read-safe Cloudflare Pages REST client — the Rust counterpart of
//! `src/core/cloudflare-manager.ts`.
//!
//! Like `vercel_manager`, this module deliberately contains no operation that
//! changes what is deployed: retry and rollback live on the write side.
//!
//! Two things shape everything here. Cloudflare wraps every answer in a
//! `{ success, errors, result }` envelope, so a failure carries a message even
//! when the status does not; and Pages paginates everything, ten at a time,
//! with no way to ask for more — so a listing is a walk rather than a request.

use serde_json::Value;

use crate::providers::api_base::{provider_api_base, provider_api_host};
use crate::providers::egress::ProviderEgress;

const API_BASE: &str = "https://api.cloudflare.com/client/v4";
/// Pages' own page size. Not configurable at the vendor.
const PAGE_SIZE: usize = 10;
/// How far a listing walks before giving up. Ten pages is a hundred projects,
/// which is more than a dashboard can show and far more than a person has.
const MAX_PAGES: usize = 10;
/// Accounts are asked for in one request; a token with more than fifty is not
/// a case the account picker could help with anyway.
const ACCOUNT_PAGE_SIZE: usize = 50;

/// Cloudflare's API, or the loopback stand-in an environment override names.
pub fn api_base() -> String {
    provider_api_base("NOMOREIDE_CLOUDFLARE_API_BASE", API_BASE)
}

fn egress() -> ProviderEgress {
    ProviderEgress::new("cloudflare", vec![provider_api_host(&api_base())])
}

#[derive(Debug, Clone)]
pub struct CloudflareApiError {
    pub message: String,
    pub status: u16,
}

impl std::fmt::Display for CloudflareApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

/// The refusal every account-scoped read starts with.
///
/// Pages addresses everything as `/accounts/<id>/…`, and `/accounts` answers
/// with an empty list rather than an error for a token that lacks
/// `Account Settings: Read` — so a working Pages token can arrive here with
/// nothing to pick from, and the message has to cover both.
pub const NO_ACCOUNT: &str = "Choose a Cloudflare account before reading its Pages projects. If the account list is empty, this API token has no account access — recreate it with Account Resources including your account.";

/// The one place a Cloudflare API call is made.
pub async fn request(token: &str, path: &str) -> Result<Value, CloudflareApiError> {
    let url = if path.starts_with("http") {
        path.to_string()
    } else {
        format!("{}{path}", api_base())
    };

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| CloudflareApiError {
            message: format!("Cloudflare request failed: {error}"),
            status: 0,
        })?;
    let bearer = token.to_string();
    let response = egress()
        .send(
            &client,
            &url,
            |client, verb, target| {
                client
                    .request(verb, target)
                    .header("Authorization", format!("Bearer {bearer}"))
                    .header("Accept", "application/json")
            },
            reqwest::Method::GET,
        )
        .await
        .map_err(|error| CloudflareApiError {
            message: format!("Cloudflare request failed: {error}"),
            status: 0,
        })?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(body);
    }
    Err(CloudflareApiError {
        message: api_error_message(&body, status.as_u16(), path),
        status: status.as_u16(),
    })
}

/// Cloudflare puts the useful sentence in `errors[0].message`. When it sends
/// none, the bare status says nothing about what was being asked, so the
/// request is named instead.
fn api_error_message(body: &Value, status: u16, path: &str) -> String {
    body.get("errors")
        .and_then(Value::as_array)
        .and_then(|errors| errors.first())
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("Cloudflare returned {status} for {path}"))
}

/// A field the vendor actually sent, in the sense `??` means it: an absent key
/// and an explicit `null` are both "no value", and everything else survives as
/// the JSON it was rather than being narrowed to a string.
fn present(field: Option<&Value>) -> Option<Value> {
    field.filter(|value| !value.is_null()).cloned()
}

/// The identity record, with the keys the vendor had nothing for left out —
/// `JSON.stringify` drops an `undefined` field, and the shape is compared.
fn user_value(id: Option<Value>, email: Option<Value>, username: Option<Value>) -> Value {
    let mut user = serde_json::Map::new();
    for (key, value) in [("id", id), ("email", email), ("username", username)] {
        if let Some(value) = value {
            user.insert(key.into(), value);
        }
    }
    Value::Object(user)
}

/// The `result` of an envelope, as a list.
fn results(body: &Value) -> Vec<Value> {
    body.get("result")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

pub struct CloudflareManager {
    token: String,
    account_id: Option<String>,
}

impl CloudflareManager {
    pub fn new(token: String, account_id: Option<String>) -> Self {
        Self { token, account_id }
    }

    pub fn account_id(&self) -> Option<&str> {
        self.account_id.as_deref()
    }

    fn require_account(&self) -> Result<&str, CloudflareApiError> {
        self.account_id.as_deref().ok_or(CloudflareApiError {
            message: NO_ACCOUNT.to_string(),
            status: 0,
        })
    }

    /// Who this credential belongs to.
    ///
    /// `/user` answers for a Wrangler OAuth login but is forbidden to a scoped
    /// API token, which is the common case — so a 4xx here is not a failure,
    /// it is the signal to identify the token instead. A 5xx (or a transport
    /// failure, which arrives as status 0) is a real outage and propagates.
    ///
    /// Cloudflare's `username` is an opaque 32-char hex id rather than a
    /// display name, so the email is the only human-readable identity `/user`
    /// carries. Preferring `username` here put a hex blob in the account menu.
    pub async fn viewer(&self) -> Result<Value, CloudflareApiError> {
        let failure = match request(&self.token, "/user").await {
            Ok(body) => {
                let user = body.get("result").cloned().unwrap_or(Value::Null);
                let email = present(user.get("email"));
                let username = email.clone().or_else(|| present(user.get("username")));
                // `email` is reported even when there is none — the reference
                // writes `email ?? null`, so the key is always on the record.
                return Ok(user_value(
                    present(user.get("id")),
                    Some(email.unwrap_or(Value::Null)),
                    username,
                ));
            }
            Err(failure) => failure,
        };
        if failure.status == 0 || failure.status >= 500 {
            return Err(failure);
        }
        self.token_viewer().await
    }

    /// Identity for a token that cannot read `/user`. `/user/tokens/verify` is
    /// answerable by every API token, so a failure *there* is a genuine auth
    /// error and is left to propagate.
    async fn token_viewer(&self) -> Result<Value, CloudflareApiError> {
        let verified = request(&self.token, "/user/tokens/verify")
            .await?
            .get("result")
            .cloned()
            .unwrap_or(Value::Null);
        // Only a token Cloudflare calls something other than `active` is
        // rejected; a response that names no status at all is accepted, the
        // way a missing field always is here.
        if let Some(status) = verified.get("status").and_then(Value::as_str) {
            if status != "active" {
                return Err(CloudflareApiError {
                    message: format!("This Cloudflare API token is {status}."),
                    status: 401,
                });
            }
        }
        let accounts = self.list_accounts().await.unwrap_or_default();
        let account = accounts
            .iter()
            .find(|entry| entry.get("id").and_then(Value::as_str) == self.account_id.as_deref())
            .or_else(|| accounts.first());
        // `listAccounts` reports `name ?? id`, so the fallback to the id is the
        // account's own and not this function's.
        let name = account
            .and_then(|entry| present(entry.get("name")).or_else(|| present(entry.get("id"))));
        Ok(user_value(
            present(verified.get("id"))
                .or_else(|| self.account_id.clone().map(Value::String))
                .or(Some(Value::String(String::new()))),
            Some(Value::Null),
            name.or_else(|| Some(Value::String("Cloudflare API token".into()))),
        ))
    }

    /// Every account this token can see, which is what the scope picker offers.
    pub async fn list_accounts(&self) -> Result<Vec<Value>, CloudflareApiError> {
        let path = format!("/accounts?per_page={ACCOUNT_PAGE_SIZE}");
        Ok(results(&request(&self.token, &path).await?))
    }

    /// Every Pages project in the account, walked a page at a time.
    pub async fn list_projects_raw(&self) -> Result<Vec<Value>, CloudflareApiError> {
        let account = self.require_account()?.to_string();
        let mut projects = Vec::new();
        for page in 1..=MAX_PAGES {
            let path =
                format!("/accounts/{account}/pages/projects?per_page={PAGE_SIZE}&page={page}");
            let batch = results(&request(&self.token, &path).await?);
            let short = batch.len() < PAGE_SIZE;
            projects.extend(batch);
            if short {
                break;
            }
        }
        projects.truncate(MAX_PAGES * PAGE_SIZE);
        Ok(projects)
    }

    pub async fn get_project_raw(&self, name: &str) -> Result<Value, CloudflareApiError> {
        let account = self.require_account()?.to_string();
        let path = format!("/accounts/{account}/pages/projects/{}", segment(name));
        Ok(request(&self.token, &path)
            .await?
            .get("result")
            .cloned()
            .unwrap_or(Value::Null))
    }

    /// A project's deployments, newest first, walked until `limit` are in hand.
    ///
    /// The environment filter is the vendor's own (`env=`), unlike Vercel's
    /// preview case — Pages labels every deployment with one.
    pub async fn list_deployments_raw(
        &self,
        project: &str,
        target: Option<&str>,
        limit: usize,
    ) -> Result<Vec<Value>, CloudflareApiError> {
        let account = self.require_account()?.to_string();
        let filter = target
            .map(|target| format!("?env={}", segment(target)))
            .unwrap_or_default();
        let separator = if filter.is_empty() { '?' } else { '&' };
        let mut deployments: Vec<Value> = Vec::new();
        for page in 1..=MAX_PAGES {
            let path = format!(
                "/accounts/{account}/pages/projects/{}/deployments{filter}{separator}per_page={PAGE_SIZE}&page={page}",
                segment(project)
            );
            let batch = results(&request(&self.token, &path).await?);
            let short = batch.len() < PAGE_SIZE;
            deployments.extend(batch);
            if short || deployments.len() >= limit {
                break;
            }
        }
        deployments.truncate(limit);
        Ok(deployments)
    }

    pub async fn get_deployment_raw(
        &self,
        project: &str,
        deployment: &str,
    ) -> Result<Value, CloudflareApiError> {
        let account = self.require_account()?.to_string();
        let path = format!(
            "/accounts/{account}/pages/projects/{}/deployments/{}",
            segment(project),
            segment(deployment)
        );
        Ok(request(&self.token, &path)
            .await?
            .get("result")
            .cloned()
            .unwrap_or(Value::Null))
    }

    /// Build history for a deployment. Pages serves it as one document; the
    /// live tail is a websocket, which is why there is no `follow` here.
    pub async fn build_logs_raw(
        &self,
        project: &str,
        deployment: &str,
    ) -> Result<Vec<Value>, CloudflareApiError> {
        let account = self.require_account()?.to_string();
        let path = format!(
            "/accounts/{account}/pages/projects/{}/deployments/{}/history/logs",
            segment(project),
            segment(deployment)
        );
        Ok(request(&self.token, &path)
            .await?
            .get("result")
            .and_then(|result| result.get("data"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }
}

/// One path segment, encoded the way `encodeURIComponent` encodes it.
///
/// The account id deliberately does not go through this: the reference
/// interpolates it raw, and an id it encoded differently would address a
/// different account.
fn segment(value: &str) -> String {
    urlencoding::encode(value).into_owned()
}

/// The URL Cloudflare keys an imported project by: `owner/repo`, lowercased.
///
/// Pages stores the two halves separately rather than as a URL, so this is what
/// a git remote has to be reduced to before the two can be compared.
pub fn repo_url(remote_url: &str) -> Option<String> {
    let trimmed = remote_url.trim().trim_end_matches('/');
    let trimmed = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    let parts: Vec<&str> = trimmed
        .split(['/', ':'])
        .filter(|part| !part.is_empty())
        .collect();
    if parts.len() < 2 {
        return None;
    }
    Some(parts[parts.len() - 2..].join("/").to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_error_body_without_a_message_names_the_request() {
        assert_eq!(
            api_error_message(&json!({"errors": []}), 404, "/accounts"),
            "Cloudflare returned 404 for /accounts"
        );
        assert_eq!(
            api_error_message(
                &json!({"errors": [{"code": 10000, "message": "Authentication error"}]}),
                403,
                "/accounts"
            ),
            "Authentication error"
        );
    }

    /// Pages keys a project by owner and repo, so a remote in any of git's
    /// spellings has to reduce to the same pair.
    #[test]
    fn a_remote_reduces_to_owner_and_repo() {
        for remote in [
            "https://github.com/Acme/App.git",
            "git@github.com:Acme/App.git",
            "https://github.com/Acme/App/",
            "ssh://git@github.com/Acme/App",
        ] {
            assert_eq!(repo_url(remote).as_deref(), Some("acme/app"), "{remote}");
        }
        assert_eq!(repo_url("app"), None);
    }
}
