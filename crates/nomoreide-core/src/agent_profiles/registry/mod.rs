//! Sharing a profile through the hosted registry.
//!
//! Three operations over one small API. Publishing walks a chain — look the
//! slug up, create it if it is new, create a version, upload the package, then
//! release it — and each step names itself when it fails, because "HTTP 422"
//! on its own does not say which of the five went wrong.
//!
//! What leaves the machine is the *exported* archive, so it carries
//! placeholders rather than secrets; the version manifest carries less still,
//! only the name and kind of each server. Neither is a place a token can hide.

pub mod auth;
pub mod config;

use super::{store, transfer, Profile};
use crate::agent_env::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PublishOutcome {
    pub slug: String,
    pub profile_id: String,
    pub version_id: String,
    pub version: String,
}

/// An install is an import that fetched its own archive, and reports the same
/// thing plus the version it took.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    #[serde(flatten)]
    pub imported: transfer::ImportOutcome,
    pub version: String,
}

#[derive(Debug, Deserialize)]
struct Descriptor {
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    download_url: Option<String>,
}

/// One request, with the step's name carried into any failure.
async fn request(step: &str, builder: reqwest::RequestBuilder) -> Result<(u16, String), String> {
    let response = builder
        .send()
        .await
        .map_err(|error| format!("{step} failed: {error}"))?;
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    Ok((status, body))
}

/// The reference's shape for a failed call, so a caller sees the same sentence
/// whichever runtime answered: the step, the status, and the body verbatim.
fn failed(step: &str, status: u16, body: &str) -> String {
    // An empty body contributes no dash: the reference appends the separator
    // only when there is something to separate.
    if body.is_empty() {
        return format!("{step} failed: HTTP {status}");
    }
    format!("{step} failed: HTTP {status} — {body}")
}

fn json_of(body: &str) -> Value {
    serde_json::from_str(body).unwrap_or(Value::Null)
}

fn text_field(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_string)
}

/// What a caller asked to publish. Grouped because the optional half is
/// descriptive metadata, which only the two calls that create something read.
#[derive(Debug, Clone, Copy, Default)]
pub struct PublishRequest<'a> {
    /// Local profile name.
    pub name: &'a str,
    pub slug: &'a str,
    pub title: &'a str,
    pub summary: Option<&'a str>,
    pub version: Option<&'a str>,
    pub changelog: Option<&'a str>,
    pub visibility: Option<&'a str>,
}

/// Publish a local profile under a registry slug.
pub async fn publish(request_of: PublishRequest<'_>, cwd: &Path) -> Result<PublishOutcome, String> {
    let PublishRequest {
        name,
        slug,
        title,
        summary,
        version,
        changelog,
        visibility,
    } = request_of;
    let token = config::api_token()?;
    let Some(profile) = store::load(name)? else {
        return Err(format!("Profile \"{name}\" not found."));
    };

    // The archive is built before anything is sent, so a profile that cannot be
    // exported — one naming a skill it does not carry — fails without having
    // created half a registry entry.
    let staging = std::env::temp_dir().join(format!(
        "nomoreide-profile-publish-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&staging)
        .map_err(|error| format!("Failed to create {}: {error}", staging.display()))?;
    let archive = staging.join("package.tar.gz");
    let built = transfer::export(name, Some(&archive.to_string_lossy()), cwd);
    let package = built.and_then(|_| {
        std::fs::read(&archive)
            .map_err(|error| format!("Failed to read {}: {error}", archive.display()))
    });
    let _ = std::fs::remove_dir_all(&staging);
    let package = package?;

    let base = config::api_base_url();
    let client = reqwest::Client::new();
    let authorized = |builder: reqwest::RequestBuilder| builder.bearer_auth(&token);
    let version = version.unwrap_or("1.0.0");

    let (status, body) = request(
        "Lookup profile",
        authorized(client.get(format!("{base}/profiles/{slug}"))),
    )
    .await?;
    let profile_id = match status {
        200 => text_field(&json_of(&body), "id").unwrap_or_default(),
        404 => {
            let (status, body) = request(
                "Create profile",
                authorized(client.post(format!("{base}/profiles"))).json(&json!({
                    "slug": slug,
                    "title": title,
                    "summary": summary.unwrap_or(""),
                    "visibility": visibility.unwrap_or("public"),
                })),
            )
            .await?;
            if !(200..300).contains(&status) {
                return Err(failed("Create profile", status, &body));
            }
            text_field(&json_of(&body), "id").unwrap_or_default()
        }
        _ => return Err(failed("Lookup profile", status, &body)),
    };

    let (status, body) = request(
        "Create profile version",
        authorized(client.post(format!("{base}/profiles/{profile_id}/versions"))).json(&json!({
            "version": version,
            "changelog": changelog.unwrap_or(""),
            "manifest_json": version_manifest(slug, version, &profile),
        })),
    )
    .await?;
    if !(200..300).contains(&status) {
        return Err(failed("Create profile version", status, &body));
    }
    let version_id = text_field(&json_of(&body), "id").unwrap_or_default();

    let (status, body) = request(
        "Upload package",
        authorized(client.post(format!(
            "{base}/profiles/{profile_id}/versions/{version_id}/package"
        )))
        .header("content-type", "application/gzip")
        .body(package),
    )
    .await?;
    if !(200..300).contains(&status) {
        return Err(failed("Upload package", status, &body));
    }

    let (status, body) = request(
        "Publish profile version",
        authorized(client.post(format!(
            "{base}/profiles/{profile_id}/versions/{version_id}/publish"
        ))),
    )
    .await?;
    if !(200..300).contains(&status) {
        return Err(failed("Publish profile version", status, &body));
    }

    Ok(PublishOutcome {
        slug: slug.to_string(),
        profile_id,
        version_id,
        version: version.to_string(),
    })
}

/// What a version says about itself, which is much less than the profile does:
/// each server's name and kind and nothing else, so a listing can describe a
/// profile without the archive being opened.
fn version_manifest(slug: &str, version: &str, profile: &Profile) -> Value {
    let mcps: Vec<Value> = profile
        .mcps
        .iter()
        .map(|(name, entry)| {
            let kind = entry
                .as_object()
                .and_then(|fields| fields.get("kind"))
                .and_then(|kind| match kind {
                    Json::String(text) => Some(text.clone()),
                    _ => None,
                })
                .unwrap_or_default();
            json!({ "name": name, "kind": kind })
        })
        .collect();
    let named = |entries: &Vec<Json>| -> Vec<Value> {
        entries
            .iter()
            .map(|entry| {
                let name = entry
                    .as_object()
                    .and_then(|fields| fields.get("name"))
                    .and_then(|name| match name {
                        Json::String(text) => Some(text.clone()),
                        _ => None,
                    })
                    .unwrap_or_default();
                json!({ "name": name })
            })
            .collect()
    };
    json!({
        "name": slug,
        "version": version,
        "mcps": mcps,
        "skills": named(&profile.skills),
        "plugins": named(&profile.plugins),
    })
}

/// Install a published profile by slug.
///
/// The public profiles the browse tab lists.
///
/// Anonymous, and every field is renamed on the way through. A null optional
/// becomes an *absent* key rather than a null, because the reference maps it to
/// `undefined` and `JSON.stringify` drops those — but `summary` is passed
/// through as it came, null included, since the reference does not guard it.
pub async fn list_public_profiles(query: Option<&str>, sort: &str) -> Result<Vec<Value>, String> {
    let base = config::api_base_url();
    let mut url = format!("{base}/profiles");
    let mut params: Vec<String> = Vec::new();
    if let Some(query) = query.map(str::trim).filter(|value| !value.is_empty()) {
        params.push(format!("q={}", urlencoding::encode(query)));
    }
    // The default is not sent. A registry that gained a different default would
    // then serve it, which is the reference's intent in leaving it off.
    if sort != "recent" {
        params.push(format!("sort={}", urlencoding::encode(sort)));
    }
    if !params.is_empty() {
        url = format!("{url}?{}", params.join("&"));
    }

    let (status, body) = request("List profiles", reqwest::Client::new().get(url)).await?;
    if !(200..300).contains(&status) {
        return Err(failed("List profiles", status, &body));
    }
    let listed = json_of(&body);
    Ok(listed
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(summarize)
        .collect())
}

/// One registry profile, in the dashboard's spelling.
fn summarize(profile: &Value) -> Value {
    let version = profile
        .get("latest_version")
        .cloned()
        .unwrap_or(Value::Null);
    let manifest = version.get("manifest_json").cloned().unwrap_or(Value::Null);
    let count = |key: &str| {
        manifest
            .get(key)
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0)
    };

    let mut out = serde_json::Map::new();
    out.insert(
        "id".into(),
        profile.get("id").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "slug".into(),
        profile.get("slug").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "title".into(),
        profile.get("title").cloned().unwrap_or(Value::Null),
    );
    // Not guarded against null, unlike everything below it.
    out.insert(
        "summary".into(),
        profile.get("summary").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "version".into(),
        version.get("version").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "sourceKind".into(),
        profile
            .get("source")
            .and_then(|source| source.get("kind"))
            .cloned()
            .unwrap_or(Value::Null),
    );
    if let Some(repo) = present(profile.get("source").and_then(|s| s.get("github_repo_url"))) {
        out.insert("githubRepoUrl".into(), repo);
    }
    out.insert(
        "starsCount".into(),
        profile.get("stars_count").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "downloadsCount".into(),
        profile
            .get("downloads_count")
            .cloned()
            .unwrap_or(Value::Null),
    );
    if let Some(author) = present(profile.get("author")) {
        let mut described = serde_json::Map::new();
        described.insert(
            "id".into(),
            author.get("id").cloned().unwrap_or(Value::Null),
        );
        if let Some(name) = present(author.get("display_name")) {
            described.insert("displayName".into(), name);
        }
        if let Some(avatar) = present(author.get("avatar_url")) {
            described.insert("avatarUrl".into(), avatar);
        }
        out.insert("author".into(), Value::Object(described));
    }
    if let Some(published) = present(version.get("published_at")) {
        out.insert("publishedAt".into(), published);
    }
    out.insert("mcpCount".into(), json!(count("mcps")));
    out.insert("skillCount".into(), json!(count("skills")));
    out.insert("pluginCount".into(), json!(count("plugins")));
    Value::Object(out)
}

/// A value that is neither missing nor null. The reference's `?? undefined`,
/// which becomes a key that is not there.
fn present(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(Value::Null) | None => None,
        Some(value) => Some(value.clone()),
    }
}

/// The token is *optional*, not absent: a public profile installs without one,
/// and a private profile the caller has access to needs it on both calls — the
/// descriptor and the download.
pub async fn install(
    slug: &str,
    force: bool,
    rename_to: Option<&str>,
    supplied: &BTreeMap<String, String>,
    token: Option<&str>,
) -> Result<InstallOutcome, String> {
    let base = config::api_base_url();
    let client = reqwest::Client::new();
    let authorized = |builder: reqwest::RequestBuilder| match token {
        Some(token) => builder.bearer_auth(token),
        None => builder,
    };

    let (status, body) = request(
        "Read install descriptor",
        authorized(client.get(format!("{base}/profiles/{slug}/install"))),
    )
    .await?;
    if !(200..300).contains(&status) {
        return Err(failed("Read install descriptor", status, &body));
    }
    let descriptor: Descriptor = serde_json::from_str(&body).unwrap_or(Descriptor {
        version: None,
        download_url: None,
    });
    let Some(download_url) = descriptor.download_url.filter(|url| !url.is_empty()) else {
        return Err(format!(
            "Registry profile \"{slug}\" has no downloadable package."
        ));
    };

    let (status, bytes) = {
        let response = authorized(client.get(resolve_download_url(&download_url, &base)))
            .send()
            .await
            .map_err(|error| format!("Download failed: {error}"))?;
        let status = response.status().as_u16();
        let bytes = response.bytes().await.unwrap_or_default();
        (status, bytes)
    };
    if !(200..300).contains(&status) {
        return Err(failed("Download", status, &String::from_utf8_lossy(&bytes)));
    }

    // The archive is written where an import can read it, then imported by the
    // same code any local archive goes through — so a registry install and a
    // hand-carried one cannot drift apart.
    let staging = std::env::temp_dir().join(format!(
        "nomoreide-profile-install-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&staging)
        .map_err(|error| format!("Failed to create {}: {error}", staging.display()))?;
    let archive = staging.join("package.tar.gz");
    let written = std::fs::write(&archive, &bytes)
        .map_err(|error| format!("Failed to write {}: {error}", archive.display()));
    let imported = written.and_then(|()| transfer::import(&archive, force, rename_to, supplied));
    let _ = std::fs::remove_dir_all(&staging);

    Ok(InstallOutcome {
        imported: imported?,
        version: descriptor.version.unwrap_or_default(),
    })
}

/// A relative `download_url` is served by the registry itself; an absolute one
/// is wherever the registry put the package.
fn resolve_download_url(download_url: &str, base: &str) -> String {
    if download_url.contains("://") {
        return download_url.to_string();
    }
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        download_url.trim_start_matches('/')
    )
}

/// Register a GitHub repository as a registry profile.
///
/// Nothing is uploaded: the registry serves the repository, which is the free
/// sharing path.
pub async fn register_github(
    repo_url: &str,
    slug: &str,
    title: &str,
    summary: Option<&str>,
    ref_name: Option<&str>,
    profile_path: Option<&str>,
) -> Result<Value, String> {
    let token = config::api_token()?;
    let base = config::api_base_url();
    let (status, body) = request(
        "Register GitHub profile",
        reqwest::Client::new()
            .post(format!("{base}/profiles/github/register"))
            .bearer_auth(&token)
            .json(&json!({
                "repo_url": repo_url,
                "slug": slug,
                "title": title,
                "summary": summary.unwrap_or(""),
                "ref_name": ref_name.unwrap_or("main"),
                "profile_path": profile_path.unwrap_or("profile.yaml"),
                "manifest_json": { "name": slug },
            })),
    )
    .await?;
    if !(200..300).contains(&status) {
        return Err(failed("Register GitHub profile", status, &body));
    }
    Ok(json_of(&body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relative_download_url_is_served_by_the_registry() {
        assert_eq!(
            resolve_download_url("/packages/a.tar.gz", "http://127.0.0.1:9/"),
            "http://127.0.0.1:9/packages/a.tar.gz"
        );
        assert_eq!(
            resolve_download_url("packages/a.tar.gz", "http://127.0.0.1:9"),
            "http://127.0.0.1:9/packages/a.tar.gz"
        );
        assert_eq!(
            resolve_download_url("https://cdn.example.test/a.tar.gz", "http://127.0.0.1:9"),
            "https://cdn.example.test/a.tar.gz"
        );
    }

    #[test]
    fn a_failure_names_the_step_that_failed() {
        assert_eq!(
            failed("Upload package", 413, "{\"message\":\"too big\"}"),
            "Upload package failed: HTTP 413 — {\"message\":\"too big\"}"
        );
    }
}
