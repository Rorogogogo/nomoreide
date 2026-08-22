//! Read-safe Vercel REST client — the Rust counterpart of
//! `src/core/vercel-manager.ts`.
//!
//! Like `git_manager`, this module deliberately contains no operation that
//! changes what is deployed. Redeploy / cancel / promote / rollback live in
//! `vercel_actions.rs`, so the read/write split the Node side enforces survives
//! into the desktop app rather than being flattened by the port.
//!
//! Responses are passed through as `serde_json::Value` and normalized on the
//! way out, so the frontend sees the same shapes both backends produce.

use serde_json::Value;

use crate::providers::api_base::{provider_api_base, provider_api_host};
use crate::providers::egress::ProviderEgress;

/// Where account identity comes from. `User` is Vercel's `/v2/user`; `Oidc` is
/// the issuer's userinfo endpoint, which is what an OAuth browser sign-in
/// answers on — a browser sign-in has no legacy user record and 404s on
/// `/v2/user`. The caller states which it holds rather than having this infer
/// it from a failed request, so a genuine authorization error still surfaces.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Identity {
    User,
    Oidc,
}

const API_BASE: &str = "https://api.vercel.com";

/// Vercel's API, or the loopback stand-in an environment override names.
///
/// One host covers everything this client asks for: the REST API and the OIDC
/// userinfo endpoint a browser sign-in uses are both on it.
pub fn api_base() -> String {
    provider_api_base("NOMOREIDE_VERCEL_API_BASE", API_BASE)
}

/// The scoped sender every Vercel request goes through, with its allowlist
/// derived from the base URL so the two cannot drift apart.
fn egress() -> ProviderEgress {
    ProviderEgress::new("vercel", vec![provider_api_host(&api_base())])
}

#[derive(Debug, Clone)]
pub struct VercelApiError {
    pub message: String,
    pub status: u16,
}

impl std::fmt::Display for VercelApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

/// Auth + scope for a single Vercel request. Shared with `vercel_actions` so
/// auth, team scoping, and error shaping stay identical across the read and
/// write halves — the boundary is which module exposes an operation, not which
/// one can reach the network.
#[derive(Debug, Clone)]
pub struct RequestAuth {
    pub token: String,
    pub team_id: Option<String>,
}

/// The one place a Vercel API call is made.
pub async fn request(
    auth: &RequestAuth,
    method: &str,
    path: &str,
    accept: Option<&str>,
) -> Result<Value, VercelApiError> {
    let text = request_text(auth, method, path, accept).await?;
    if accept == Some("text/plain") {
        return Ok(Value::String(text));
    }
    serde_json::from_str(&text).or(Ok(Value::Null))
}

pub async fn request_text(
    auth: &RequestAuth,
    method: &str,
    path: &str,
    accept: Option<&str>,
) -> Result<String, VercelApiError> {
    let mut url = if path.starts_with("http") {
        path.to_string()
    } else {
        format!("{}{path}", api_base())
    };
    if let Some(team_id) = auth.team_id.as_ref() {
        url = with_team_scope(&url, team_id);
    }

    // `redirect(Policy::none())` so a 3xx comes back to be inspected rather
    // than being followed past the allowlist; `egress` then checks every hop.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| VercelApiError {
            message: format!("Vercel request failed: {error}"),
            status: 0,
        })?;
    let verb = match method {
        "POST" => reqwest::Method::POST,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        _ => reqwest::Method::GET,
    };
    let token = auth.token.clone();
    let accept_header = accept.unwrap_or("application/json").to_string();
    let response = egress()
        .send(
            &client,
            &url,
            |client, verb, target| {
                client
                    .request(verb, target)
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Accept", accept_header.clone())
            },
            verb,
        )
        .await
        .map_err(|error| VercelApiError {
            message: format!("Vercel request failed: {error}"),
            status: 0,
        })?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if status.is_success() {
        return Ok(text);
    }
    Err(VercelApiError {
        message: api_error_message(
            &text,
            status.as_u16(),
            status.canonical_reason().unwrap_or_default(),
            path,
        ),
        status: status.as_u16(),
    })
}

/// One query-string value, encoded the way `URLSearchParams` encodes it.
///
/// Not `urlencoding::encode`, which is `encodeURIComponent` and writes a space
/// as `%20`. The reference builds these queries with `URLSearchParams`, whose
/// `application/x-www-form-urlencoded` serialization writes a space as `+` —
/// and that string is quoted verbatim in the error a failed request reports,
/// so it is visible to a caller and not only to the vendor.
fn query_value(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

/// Adds the team scope to a request, the way the reference adds it.
///
/// Not a string append: the reference reaches for `URL.searchParams.set`, which
/// **re-serializes the whole query** as `application/x-www-form-urlencoded` —
/// so a space that was written `%20` in the path comes back out as `+`. That is
/// invisible until a caller searches for something with a space in it, and it
/// is the difference between two runtimes asking a vendor the same question and
/// two runtimes asking different ones. `query_pairs_mut` does the same encoding.
///
/// An existing `teamId` is dropped rather than kept beside the new one, which
/// is what `set` means.
fn with_team_scope(url: &str, team_id: &str) -> String {
    let Ok(mut parsed) = url::Url::parse(url) else {
        return url.to_string();
    };
    let existing: Vec<(String, String)> = parsed
        .query_pairs()
        .filter(|(key, _)| key != "teamId")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    parsed
        .query_pairs_mut()
        .clear()
        .extend_pairs(existing)
        .append_pair("teamId", team_id);
    parsed.to_string()
}

/// Vercel wraps its failures in `{ error: { code, message } }`. When it sends
/// no message the bare status says nothing about what was being asked, so the
/// request is named instead — that string is what the dashboard shows, and it
/// is the only clue the user gets.
fn api_error_message(body: &str, status: u16, reason: &str, path: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| format!("Vercel returned {status} {reason} for {path}"))
}

pub struct VercelManager {
    auth: RequestAuth,
    identity: Identity,
}

impl VercelManager {
    pub fn new(token: String, team_id: Option<String>, identity: Identity) -> Self {
        VercelManager {
            auth: RequestAuth { token, team_id },
            identity,
        }
    }

    /// The signed-in account.
    pub async fn viewer(&self) -> Result<Value, VercelApiError> {
        if self.identity == Identity::Oidc {
            let claims = request(&self.auth, "GET", "/login/oauth/userinfo", None).await?;
            return Ok(serde_json::json!({
                "id": claims.get("sub").and_then(Value::as_str).unwrap_or(""),
                "username": claims
                    .get("preferred_username")
                    .and_then(Value::as_str)
                    .or_else(|| claims.get("email").and_then(Value::as_str))
                    .unwrap_or("vercel"),
                "email": claims.get("email").cloned().unwrap_or(Value::Null),
                "avatar": claims.get("picture").cloned().unwrap_or(Value::Null),
            }));
        }
        let data = request(&self.auth, "GET", "/v2/user", None).await?;
        Ok(data.get("user").cloned().unwrap_or(Value::Null))
    }

    pub async fn list_teams(&self) -> Result<Vec<Value>, VercelApiError> {
        let data = request(&self.auth, "GET", "/v2/teams?limit=100", None).await?;
        Ok(data
            .get("teams")
            .and_then(Value::as_array)
            .map(|teams| {
                teams
                    .iter()
                    .map(|team| {
                        serde_json::json!({
                            "id": team.get("id").cloned().unwrap_or(Value::Null),
                            "slug": team.get("slug").cloned().unwrap_or(Value::Null),
                            "name": team.get("name").cloned().unwrap_or(Value::Null),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Vercel's own project records, exactly as it sent them.
    ///
    /// The desktop app reads {@link Self::list_projects}, whose shape it has
    /// always had; the provider layer reads these, because the vendor-neutral
    /// shape needs to tell a setting the user *cleared* from one this vendor
    /// does not have — a distinction the desktop shape flattens to `null`.
    pub async fn list_projects_raw(
        &self,
        search: Option<&str>,
        repo_url: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Vec<Value>, VercelApiError> {
        let mut path = format!("/v10/projects?limit={}", limit.unwrap_or(50));
        if let Some(search) = search.filter(|value| !value.is_empty()) {
            path.push_str(&format!("&search={}", query_value(search)));
        }
        if let Some(repo_url) = repo_url {
            path.push_str(&format!("&repoUrl={}", query_value(repo_url)));
        }
        let data = request(&self.auth, "GET", &path, None).await?;
        Ok(match &data {
            Value::Array(items) => items.clone(),
            _ => data
                .get("projects")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        })
    }

    pub async fn list_projects(
        &self,
        search: Option<&str>,
        repo_url: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Vec<Value>, VercelApiError> {
        let projects = self.list_projects_raw(search, repo_url, limit).await?;
        Ok(projects.iter().map(normalize_project).collect())
    }

    pub async fn get_project_raw(&self, id_or_name: &str) -> Result<Value, VercelApiError> {
        let path = format!("/v9/projects/{}", urlencoding::encode(id_or_name));
        request(&self.auth, "GET", &path, None).await
    }

    pub async fn get_project(&self, id_or_name: &str) -> Result<Value, VercelApiError> {
        Ok(normalize_project(&self.get_project_raw(id_or_name).await?))
    }

    /// Vercel's own deployment records, filtered but not reshaped.
    pub async fn list_deployments_raw(
        &self,
        project_id: &str,
        target: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Vec<Value>, VercelApiError> {
        let mut path = format!(
            "/v7/deployments?projectId={}&limit={}",
            query_value(project_id),
            limit.unwrap_or(20)
        );
        // Vercel has no `preview` target filter — preview deployments are the
        // ones with a null target, so those are filtered below instead.
        if target == Some("production") {
            path.push_str("&target=production");
        }
        let data = request(&self.auth, "GET", &path, None).await?;
        let deployments = data
            .get("deployments")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        if target == Some("preview") {
            return Ok(deployments
                .into_iter()
                .filter(|deployment| {
                    deployment.get("target") != Some(&Value::String("production".into()))
                })
                .collect());
        }
        Ok(deployments)
    }

    pub async fn list_deployments(
        &self,
        project_id: &str,
        target: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Vec<Value>, VercelApiError> {
        let deployments = self.list_deployments_raw(project_id, target, limit).await?;
        Ok(deployments.iter().map(normalize_deployment).collect())
    }

    pub async fn get_deployment_raw(&self, id_or_url: &str) -> Result<Value, VercelApiError> {
        let path = format!(
            "/v13/deployments/{}?withGitRepoInfo=true",
            urlencoding::encode(id_or_url)
        );
        request(&self.auth, "GET", &path, None).await
    }

    pub async fn get_deployment(&self, id_or_url: &str) -> Result<Value, VercelApiError> {
        let raw = self.get_deployment_raw(id_or_url).await?;
        let mut deployment = normalize_deployment(&raw);
        if let Some(object) = deployment.as_object_mut() {
            object.insert(
                "aliases".into(),
                raw.get("alias").cloned().unwrap_or(Value::Array(vec![])),
            );
            if let Some(building_at) = raw.get("buildingAt") {
                object.insert("buildingAt".into(), building_at.clone());
            }
            if let Some(error_message) = raw.get("errorMessage").filter(|v| !v.is_null()) {
                object.insert("errorMessage".into(), error_message.clone());
            }
        }
        Ok(deployment)
    }

    /// Build logs for a deployment. Requested without `follow`, so the endpoint
    /// answers as a one-shot document instead of an open event stream — the
    /// dashboard polls while a build runs rather than holding a socket.
    pub async fn deployment_build_logs(
        &self,
        id_or_url: &str,
        limit: Option<u32>,
    ) -> Result<Vec<Value>, VercelApiError> {
        let path = format!(
            "/v3/deployments/{}/events?builds=1&direction=backward&limit={}",
            urlencoding::encode(id_or_url),
            limit.unwrap_or(500)
        );
        let raw = request_text(&self.auth, "GET", &path, Some("text/plain")).await?;
        Ok(parse_build_log_events(&raw))
    }

    /// The project's environment variables, without their values.
    ///
    /// `decrypt` is left off, so Vercel returns encrypted variables as
    /// ciphertext — but plain and system ones would still come back readable,
    /// so the value is dropped here for every type rather than for some of
    /// them. One door for reading a value keeps that door easy to audit.
    pub async fn list_env(&self, project_id: &str) -> Result<Vec<Value>, VercelApiError> {
        let path = format!(
            "/v9/projects/{}/env?limit=200",
            urlencoding::encode(project_id)
        );
        let data = request(&self.auth, "GET", &path, None).await?;
        let envs = match &data {
            Value::Array(items) => items.clone(),
            _ => data
                .get("envs")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        };
        let mut normalized: Vec<Value> = envs.iter().map(normalize_env_var).collect();
        normalized.sort_by(|a, b| {
            let key = |value: &Value| {
                value
                    .get("key")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            };
            key(a).cmp(&key(b))
        });
        Ok(normalized)
    }

    /// One variable's decrypted value. Deliberately a single-key read: the
    /// dashboard reveals one row at a time on an explicit click, and nothing
    /// else has a reason to hold every secret at once.
    pub async fn env_value(
        &self,
        project_id: &str,
        env_id: &str,
    ) -> Result<String, VercelApiError> {
        let path = format!(
            "/v9/projects/{}/env/{}",
            urlencoding::encode(project_id),
            urlencoding::encode(env_id)
        );
        let data = request(&self.auth, "GET", &path, None).await?;
        Ok(data
            .get("value")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string())
    }

    pub async fn list_domains(&self, project_id: &str) -> Result<Vec<Value>, VercelApiError> {
        let path = format!(
            "/v9/projects/{}/domains?limit=100",
            urlencoding::encode(project_id)
        );
        let data = request(&self.auth, "GET", &path, None).await?;
        Ok(data
            .get("domains")
            .and_then(Value::as_array)
            .map(|domains| domains.iter().map(normalize_domain).collect())
            .unwrap_or_default())
    }

    /// Runtime (function) logs, as opposed to build logs: why a *deployed*
    /// request failed rather than why the build did.
    ///
    /// Not available on every plan, so a plan-gated refusal yields an empty
    /// list — an absent capability is not a broken dashboard. Genuine auth
    /// failures still surface.
    pub async fn deployment_runtime_logs(
        &self,
        id_or_url: &str,
        limit: Option<u32>,
    ) -> Result<Vec<Value>, VercelApiError> {
        let path = format!(
            "/v1/deployments/{}/runtime-logs?limit={}",
            urlencoding::encode(id_or_url),
            limit.unwrap_or(200)
        );
        match request_text(&self.auth, "GET", &path, Some("text/plain")).await {
            Ok(raw) => Ok(parse_runtime_log_events(&raw)),
            Err(error) if RUNTIME_LOGS_UNAVAILABLE.contains(&error.status) => Ok(vec![]),
            Err(error) => Err(error),
        }
    }
}

/// Statuses that mean "this account cannot use runtime logs" rather than "the
/// request was wrong": plan-gated (402), not entitled (403), or the endpoint
/// not being served for this deployment (404).
const RUNTIME_LOGS_UNAVAILABLE: [u16; 3] = [402, 403, 404];

/// Vercel exposes a repo's project via the exact remote URL it was imported with.
pub fn repo_url(remote_url: &str) -> Option<String> {
    let trimmed = remote_url
        .trim()
        .trim_end_matches(".git")
        .trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        return Some(format!("https://{host}/{path}"));
    }
    if trimmed.starts_with("https://") {
        return Some(trimmed.to_string());
    }
    if let Some(rest) = trimmed.strip_prefix("http://") {
        return Some(format!("https://{rest}"));
    }
    None
}

/// The events endpoint answers either a JSON array or newline-delimited JSON
/// depending on how it decides to stream, so both shapes are accepted and
/// anything unparseable is dropped rather than failing the whole log read.
pub fn parse_build_log_events(raw: &str) -> Vec<Value> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return vec![];
    }

    let mut events: Vec<Value> = Vec::new();
    match serde_json::from_str::<Value>(trimmed) {
        Ok(Value::Array(items)) => events.extend(items),
        Ok(other) => events.push(other),
        Err(_) => {
            for line in trimmed.lines().filter(|line| !line.trim().is_empty()) {
                if let Ok(event) = serde_json::from_str::<Value>(line) {
                    events.push(event);
                }
            }
        }
    }

    let mut lines: Vec<Value> = events
        .iter()
        .enumerate()
        .map(|(index, event)| {
            let payload = event.get("payload");
            let created = event.get("created").and_then(Value::as_i64);
            let created_at = payload
                .and_then(|p| p.get("date"))
                .and_then(Value::as_i64)
                .or(created)
                .unwrap_or(0);
            let id = payload
                .and_then(|p| p.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("{}-{index}", created.unwrap_or(index as i64)));
            let text = payload
                .and_then(|p| p.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("");
            serde_json::json!({
                "id": id,
                "createdAt": created_at,
                "type": event.get("type").and_then(Value::as_str).unwrap_or("stdout"),
                "text": strip_ansi(text).trim_end(),
            })
        })
        .filter(|line| {
            line.get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| !text.is_empty())
        })
        .collect();

    lines.sort_by_key(|line| line.get("createdAt").and_then(Value::as_i64).unwrap_or(0));
    lines
}

/// Build output is ANSI-colored; strip the SGR codes so the log renders as
/// plain text rather than as escape soup.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        if character != '\u{1b}' {
            out.push(character);
            continue;
        }
        if chars.peek() != Some(&'[') {
            continue;
        }
        chars.next();
        // Consume the parameter bytes and the final letter of the sequence.
        for inner in chars.by_ref() {
            if !inner.is_ascii_digit() && inner != ';' {
                break;
            }
        }
    }
    out
}

/// Runtime logs arrive as newline-delimited JSON. Unparseable lines are dropped
/// rather than failing the read — a truncated final line is normal for a stream
/// that was cut off at the limit.
pub fn parse_runtime_log_events(raw: &str) -> Vec<Value> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return vec![];
    }

    let mut rows: Vec<Value> = Vec::new();
    for line in trimmed.lines().filter(|line| !line.trim().is_empty()) {
        match serde_json::from_str::<Value>(line) {
            Ok(Value::Array(items)) => rows.extend(items),
            Ok(other) => rows.push(other),
            Err(_) => {}
        }
    }

    let mut lines: Vec<Value> = rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let created_at = row
                .get("timestampInMs")
                .or_else(|| row.get("timestamp"))
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let id = row
                .get("rowId")
                .or_else(|| row.get("requestId"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("{created_at}-{index}"));
            serde_json::json!({
                "id": id,
                "createdAt": created_at,
                "level": row.get("level").and_then(Value::as_str).unwrap_or("info"),
                "message": row.get("message").and_then(Value::as_str).unwrap_or("").trim_end(),
                "source": row.get("source").cloned().unwrap_or(Value::Null),
                "statusCode": row.get("statusCode").cloned().unwrap_or(Value::Null),
                "requestMethod": row.get("requestMethod").cloned().unwrap_or(Value::Null),
                "requestPath": row.get("requestPath").cloned().unwrap_or(Value::Null),
            })
        })
        .filter(|line| {
            line.get("message")
                .and_then(Value::as_str)
                .is_some_and(|message| !message.is_empty())
        })
        .collect();

    lines.sort_by_key(|line| line.get("createdAt").and_then(Value::as_i64).unwrap_or(0));
    lines
}

fn normalize_env_var(env: &Value) -> Value {
    let target = match env.get("target") {
        Some(Value::Array(items)) => Value::Array(items.clone()),
        Some(Value::String(single)) => Value::Array(vec![Value::String(single.clone())]),
        _ => Value::Array(vec![]),
    };
    serde_json::json!({
        "id": env
            .get("id")
            .or_else(|| env.get("key"))
            .cloned()
            .unwrap_or(Value::Null),
        "key": env.get("key").cloned().unwrap_or(Value::Null),
        "target": target,
        "type": env.get("type").and_then(Value::as_str).unwrap_or("encrypted"),
        "gitBranch": env.get("gitBranch").cloned().unwrap_or(Value::Null),
        "comment": env.get("comment").cloned().unwrap_or(Value::Null),
        "createdAt": env.get("createdAt").cloned().unwrap_or(Value::Null),
        "updatedAt": env.get("updatedAt").cloned().unwrap_or(Value::Null),
    })
}

fn normalize_domain(domain: &Value) -> Value {
    let verification: Vec<Value> = domain
        .get("verification")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter(|entry| {
                    entry.get("domain").and_then(Value::as_str).is_some()
                        && entry.get("value").and_then(Value::as_str).is_some()
                })
                .map(|entry| {
                    serde_json::json!({
                        "type": entry.get("type").and_then(Value::as_str).unwrap_or("TXT"),
                        "domain": entry.get("domain").cloned().unwrap_or(Value::Null),
                        "value": entry.get("value").cloned().unwrap_or(Value::Null),
                        "reason": entry.get("reason").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    serde_json::json!({
        "name": domain.get("name").cloned().unwrap_or(Value::Null),
        "apexName": domain.get("apexName").cloned().unwrap_or(Value::Null),
        "verified": domain.get("verified").and_then(Value::as_bool).unwrap_or(false),
        "redirect": domain.get("redirect").cloned().unwrap_or(Value::Null),
        "gitBranch": domain.get("gitBranch").cloned().unwrap_or(Value::Null),
        "createdAt": domain.get("createdAt").cloned().unwrap_or(Value::Null),
        "updatedAt": domain.get("updatedAt").cloned().unwrap_or(Value::Null),
        "verification": verification,
    })
}

fn normalize_project(project: &Value) -> Value {
    let link = project.get("link").filter(|link| {
        link.get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| !kind.is_empty())
    });
    serde_json::json!({
        "id": project.get("id").cloned().unwrap_or(Value::Null),
        "name": project.get("name").cloned().unwrap_or(Value::Null),
        "framework": project.get("framework").cloned().unwrap_or(Value::Null),
        "updatedAt": project.get("updatedAt").cloned().unwrap_or(Value::Null),
        "link": link.map(|link| serde_json::json!({
            "type": link.get("type").cloned().unwrap_or(Value::Null),
            "org": link.get("org").cloned().unwrap_or(Value::Null),
            "repo": link.get("repo").cloned().unwrap_or(Value::Null),
            "productionBranch": link.get("productionBranch").cloned().unwrap_or(Value::Null),
        })).unwrap_or(Value::Null),
        // Only the single-project read fills these in; null therefore reads as
        // "Vercel is using the framework default", which is what it means.
        "buildCommand": project.get("buildCommand").cloned().unwrap_or(Value::Null),
        "devCommand": project.get("devCommand").cloned().unwrap_or(Value::Null),
        "installCommand": project.get("installCommand").cloned().unwrap_or(Value::Null),
        "outputDirectory": project.get("outputDirectory").cloned().unwrap_or(Value::Null),
        "rootDirectory": project.get("rootDirectory").cloned().unwrap_or(Value::Null),
        "nodeVersion": project.get("nodeVersion").cloned().unwrap_or(Value::Null),
        "serverlessFunctionRegion": project
            .get("serverlessFunctionRegion")
            .cloned()
            .unwrap_or(Value::Null),
    })
}

fn normalize_deployment(deployment: &Value) -> Value {
    let meta = deployment.get("meta");
    let pick = |keys: [&str; 3]| -> Value {
        keys.iter()
            .find_map(|key| meta.and_then(|meta| meta.get(*key)).cloned())
            .unwrap_or(Value::Null)
    };
    let target = deployment.get("target").cloned().unwrap_or(Value::Null);
    let ready_substate = deployment.get("readySubstate").and_then(Value::as_str);

    serde_json::json!({
        "uid": deployment
            .get("uid")
            .or_else(|| deployment.get("id"))
            .cloned()
            .unwrap_or(Value::String(String::new())),
        "name": deployment.get("name").cloned().unwrap_or(Value::Null),
        "url": deployment.get("url").cloned().unwrap_or(Value::Null),
        "state": deployment
            .get("readyState")
            .or_else(|| deployment.get("state"))
            .cloned()
            .unwrap_or(Value::String("QUEUED".into())),
        "target": target,
        "createdAt": deployment
            .get("createdAt")
            .or_else(|| deployment.get("created"))
            .cloned()
            .unwrap_or(Value::from(0)),
        "readyAt": deployment
            .get("readyAt")
            .or_else(|| deployment.get("ready"))
            .cloned()
            .unwrap_or(Value::Null),
        // `PROMOTED`/`ROLLING` mark the deployment currently aliased to
        // production; `STAGED` means built for production but not serving it.
        "isCurrentProduction": deployment.get("target").and_then(Value::as_str) == Some("production")
            && ready_substate != Some("STAGED"),
        "creator": deployment.get("creator").cloned().unwrap_or(Value::Null),
        "meta": {
            "branch": pick(["githubCommitRef", "gitlabCommitRef", "bitbucketCommitRef"]),
            "sha": pick(["githubCommitSha", "gitlabCommitSha", "bitbucketCommitSha"]),
            "commitMessage": pick(["githubCommitMessage", "gitlabCommitMessage", "bitbucketCommitMessage"]),
            "commitAuthor": pick(["githubCommitAuthorName", "gitlabCommitAuthorName", "bitbucketCommitAuthorName"]),
        },
        "inspectorUrl": deployment.get("inspectorUrl").cloned().unwrap_or(Value::Null),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_and_https_remotes_map_to_the_url_vercel_indexes() {
        assert_eq!(
            repo_url("git@github.com:acme/web.git").unwrap(),
            "https://github.com/acme/web"
        );
        assert_eq!(
            repo_url("https://github.com/acme/web/").unwrap(),
            "https://github.com/acme/web"
        );
        // Vercel stores the https form, so an http remote must be upgraded.
        assert_eq!(
            repo_url("http://github.com/acme/web").unwrap(),
            "https://github.com/acme/web"
        );
        assert!(repo_url("/local/path").is_none());
    }

    #[test]
    fn a_production_deployment_staged_behind_the_alias_is_not_current() {
        let staged = normalize_deployment(&serde_json::json!({
            "uid": "dpl_1", "name": "web", "url": null,
            "target": "production", "readySubstate": "STAGED",
        }));
        assert_eq!(staged["isCurrentProduction"], false);

        let promoted = normalize_deployment(&serde_json::json!({
            "uid": "dpl_2", "name": "web", "url": null,
            "target": "production", "readySubstate": "PROMOTED",
        }));
        assert_eq!(promoted["isCurrentProduction"], true);
    }

    #[test]
    fn deployment_ids_fall_back_across_the_api_versions_field_names() {
        let by_id = normalize_deployment(&serde_json::json!({ "id": "dpl_x", "name": "web" }));
        assert_eq!(by_id["uid"], "dpl_x");
        assert_eq!(by_id["state"], "QUEUED");
    }

    #[test]
    fn build_logs_accept_both_an_array_and_newline_delimited_json() {
        let array = parse_build_log_events(
            r#"[{"type":"stdout","created":2,"payload":{"id":"b","text":"second"}},
                {"type":"stdout","created":1,"payload":{"id":"a","text":"first"}}]"#,
        );
        assert_eq!(array.len(), 2);
        // Sorted oldest-first regardless of the order the API returned.
        assert_eq!(array[0]["text"], "first");

        let ndjson = parse_build_log_events(
            "{\"type\":\"stdout\",\"created\":1,\"payload\":{\"text\":\"one\"}}\n{ broken\n{\"type\":\"stdout\",\"created\":2,\"payload\":{\"text\":\"two\"}}",
        );
        // The unparseable line is dropped rather than failing the whole read.
        assert_eq!(ndjson.len(), 2);
    }

    #[test]
    fn ansi_colour_codes_are_stripped_from_build_output() {
        // The escape must reach the parser as JSON's ``, not as a raw
        // control byte — serde_json rejects the latter, as does Vercel's own
        // encoder, so building the document is the only faithful fixture.
        let raw = serde_json::json!({
            "created": 1,
            "payload": { "text": "\u{1b}[32mdone\u{1b}[0m" },
        })
        .to_string();

        let logs = parse_build_log_events(&raw);
        assert_eq!(logs[0]["text"], "done");
    }

    #[test]
    fn blank_lines_are_dropped_so_the_log_has_no_holes() {
        let logs = parse_build_log_events("{\"created\":1,\"payload\":{\"text\":\"   \"}}");
        assert!(logs.is_empty());
    }

    /// The status *and* its reason phrase: a bare number says nothing about
    /// what went wrong, and this string is the only clue the caller gets.
    #[test]
    fn an_error_body_without_a_message_names_the_request() {
        assert_eq!(
            api_error_message("not json", 404, "Not Found", "/v2/user"),
            "Vercel returned 404 Not Found for /v2/user"
        );
        assert_eq!(
            api_error_message(
                r#"{"error":{"message":"Forbidden"}}"#,
                403,
                "Forbidden",
                "/v2/user"
            ),
            "Forbidden"
        );
    }
}
