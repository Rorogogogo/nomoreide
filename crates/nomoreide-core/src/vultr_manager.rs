//! The one place a Vultr API call is made.
//!
//! The Rust half of `src/core/vultr-manager.ts`. Shared with the actions crate
//! so auth and error shaping stay identical across the read and write halves —
//! the read/write boundary is which module exposes an operation, not which one
//! can reach the network.

use crate::providers::api_base::{provider_api_base, provider_api_host};
use crate::providers::egress::ProviderEgress;
use serde_json::Value;

const API_BASE: &str = "https://api.vultr.com/v2";

/// Vultr's own maximum, so an account of any size is one request per page.
const PAGE_SIZE: u32 = 500;

/// A hard stop on cursor following, so a pathological account cannot hang a
/// request.
const MAX_PAGES: usize = 10;

pub fn api_base() -> String {
    provider_api_base("NOMOREIDE_VULTR_API_BASE", API_BASE)
}

fn egress() -> ProviderEgress {
    ProviderEgress::new("vultr", vec![provider_api_host(&api_base())])
}

#[derive(Debug, Clone)]
pub struct VultrApiError {
    pub message: String,
    pub status: u16,
}

impl std::fmt::Display for VultrApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for VultrApiError {}

/// One request, through the provider's egress boundary.
pub async fn request(
    token: &str,
    path: &str,
    method: reqwest::Method,
) -> Result<Value, VultrApiError> {
    let url = format!("{}{path}", api_base());
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| VultrApiError {
            message: format!("Vultr request failed: {error}"),
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
            method,
        )
        .await
        .map_err(|error| VultrApiError {
            message: format!("Vultr request failed: {error}"),
            status: 0,
        })?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(body);
    }
    Err(VultrApiError {
        message: api_error_message(&body, status.as_u16(), path),
        status: status.as_u16(),
    })
}

/// Vultr puts the useful sentence in a top-level `error`. When the body is not
/// JSON at all — a proxy's HTML error page, say — the bare status says nothing
/// about what was being asked, so the request is named instead.
fn api_error_message(body: &Value, status: u16, path: &str) -> String {
    body.get("error")
        .and_then(Value::as_str)
        .filter(|message| !message.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("Vultr returned {status} for {path}"))
}

/// One path segment, encoded the way `encodeURIComponent` encodes it.
fn segment(value: &str) -> String {
    urlencoding::encode(value).into_owned()
}

pub struct VultrManager {
    token: String,
}

impl VultrManager {
    pub fn new(token: impl Into<String>) -> Self {
        Self {
            token: token.into(),
        }
    }

    /// The signed-in account.
    pub async fn account(&self) -> Result<Value, VultrApiError> {
        let body = request(&self.token, "/account", reqwest::Method::GET).await?;
        Ok(body.get("account").cloned().unwrap_or(Value::Null))
    }

    /// Every instance, following the cursor Vultr hands back.
    ///
    /// The walk stops on an empty `next` — the vendor's own end-of-list signal —
    /// or at `MAX_PAGES`, whichever comes first.
    pub async fn list_instances(&self) -> Result<Vec<Value>, VultrApiError> {
        let mut instances = Vec::new();
        let mut cursor: Option<String> = None;

        for _ in 0..MAX_PAGES {
            let path = match &cursor {
                None => format!("/instances?per_page={PAGE_SIZE}"),
                Some(next) => format!("/instances?per_page={PAGE_SIZE}&cursor={}", segment(next)),
            };
            let body = request(&self.token, &path, reqwest::Method::GET).await?;
            if let Some(page) = body.get("instances").and_then(Value::as_array) {
                instances.extend(page.iter().cloned());
            }
            let next = body
                .get("meta")
                .and_then(|meta| meta.get("links"))
                .and_then(|links| links.get("next"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if next.is_empty() {
                break;
            }
            cursor = Some(next);
        }
        Ok(instances)
    }

    /// One instance.
    pub async fn instance(&self, id: &str) -> Result<Value, VultrApiError> {
        let path = format!("/instances/{}", segment(id));
        let body = request(&self.token, &path, reqwest::Method::GET).await?;
        Ok(body.get("instance").cloned().unwrap_or(Value::Null))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_vendors_sentence_wins_over_the_status() {
        let body = json!({ "error": "Instance not found", "status": 404 });
        assert_eq!(
            api_error_message(&body, 404, "/instances/x"),
            "Instance not found"
        );
    }

    #[test]
    fn a_body_that_is_not_json_names_the_request() {
        assert_eq!(
            api_error_message(&Value::Null, 500, "/instances/x"),
            "Vultr returned 500 for /instances/x"
        );
    }

    #[test]
    fn an_id_with_a_space_is_encoded() {
        assert_eq!(segment("inst space"), "inst%20space");
    }
}
