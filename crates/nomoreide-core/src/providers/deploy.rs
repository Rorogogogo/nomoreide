//! The vendor-neutral shapes every deploy provider reports in, and the client
//! that produces them.
//!
//! The Rust half of `src/core/providers/deploy-provider.ts`. Vercel and
//! Cloudflare describe a project and a deployment differently enough that the
//! dashboard — and the four MCP tools — would otherwise need a branch per
//! vendor; these types are where each vendor's answer is turned into the one
//! the caller reads.
//!
//! **Numbers are passed through as `Value` rather than parsed into `i64`.**
//! Every one of them is a vendor timestamp reported verbatim, and a parse would
//! be the one place this could disagree with the reference about a value
//! neither of them interprets.

use serde::Serialize;
use serde_json::Value;

/// A field the vendor actually sent, in the sense `??` means it: an absent key
/// and an explicit `null` are both "no value", and everything else survives as
/// the JSON it was rather than being narrowed to a string.
///
/// Shared because the difference between a key the vendor omitted and one it
/// sent as null is *observable* in every shape below — `JSON.stringify` drops
/// an `undefined` field and keeps a null one — and each provider would
/// otherwise re-derive that rule slightly differently.
pub fn present(field: Option<&Value>) -> Option<Value> {
    field.filter(|value| !value.is_null()).cloned()
}

/// JavaScript truthiness, for the fields the reference gates on `if (value)`
/// rather than on presence.
///
/// Worth spelling out because the difference bites twice in this file: an
/// empty string is *not* a value there, so an empty `target` is no target and
/// an empty request method is no method — while an explicit `null` is still a
/// value wherever presence is what is being tested.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        _ => true,
    }
}

/// One project environment variable, with its value deliberately absent.
///
/// Listing answers "is this key set, and where" — the question a failed deploy
/// actually raises. The value is a separate, explicitly-requested read, so
/// merely opening the tab never puts a secret on the wire.
///
/// Almost every field is optional because the two vendors fill different
/// subsets: Vercel reports `gitBranch` and `comment` even when it has neither,
/// while Cloudflare has no concept of either and omits them entirely.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEnvVar {
    /// Cloudflare has no variable ids — there, the key is how one is addressed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<Value>,
    /// `production` / `preview` / `development`. Vercel's `target`.
    pub environments: Vec<Value>,
    /// `encrypted` / `plain` / `system` / `secret`.
    #[serde(rename = "type")]
    pub kind: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<Value>,
}

/// An outstanding DNS record the user must add before a domain will serve.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DomainVerification {
    #[serde(rename = "type")]
    pub kind: Value,
    pub domain: Value,
    pub value: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<Value>,
}

/// A domain a project serves on.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDomain {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apex_name: Option<Value>,
    pub verified: bool,
    /// Set when the domain is a redirect rather than a served alias.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redirect: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<Value>,
    /// Empty when the domain is already serving.
    pub verification: Vec<DomainVerification>,
}

/// One of a project's build settings, in a fixed order with a fixed label.
///
/// An entry appears only when the vendor's project carries that key at all —
/// an explicit `null` is a setting the user cleared and is reported as one,
/// while a missing key is a setting this vendor does not have.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProjectSetting {
    pub key: &'static str,
    pub label: &'static str,
    pub value: Value,
}

/// Where a project's code comes from. `org`/`repo` are GitHub's spelling of it
/// and are simply absent for the other hosts, which is what the dashboard shows.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLink {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub production_branch: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProject {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<Value>,
    /// Always reported, `null` included: "no framework detected" is an answer,
    /// and an absent key would read as "not asked".
    pub framework: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<ProjectLink>,
    pub settings: Vec<ProjectSetting>,
}

impl ProviderProject {
    /// The id a caller can act on — the one field a project is useless without.
    pub fn identifier(&self) -> Option<&str> {
        self.id.as_ref().and_then(Value::as_str)
    }
}

/// The commit a deployment was built from, in the one spelling the dashboard
/// reads. Every field is absent rather than null when the vendor has none.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_message: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_author: Option<Value>,
}

/// The states a deployment can be in, collapsed to the five a person acts on.
///
/// `rawState` carries the vendor's own word alongside, so a state this does not
/// know about is still visible rather than silently becoming "queued".
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Deployment {
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<Value>,
    pub state: String,
    pub raw_state: String,
    /// Always reported, `null` included — an unknown target is not a preview.
    pub target: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ready_at: Option<Value>,
    pub is_current_production: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creator: Option<Value>,
    pub meta: DeploymentMeta,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inspector_url: Option<Value>,
}

/// One deployment read on its own, which is where the fields worth a round trip
/// live: the aliases it serves, when its build started, and why it failed.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentDetail {
    #[serde(flatten)]
    pub deployment: Deployment,
    pub aliases: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub building_at: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<Value>,
}

/// One line of a deployment's output, build or runtime.
///
/// **Both kinds are one type on purpose.** They answer different questions —
/// the build log says why a deployment never shipped, the runtime log says why
/// a shipped one is failing requests — but the dashboard renders them in the
/// same pane, and a reader scrolling a failure wants them to line up. `kind`
/// is what tells them apart.
///
/// The two runtime-only fields are *absent* on a build line rather than null,
/// which is a contract and not a detail: the client renders a request badge on
/// any line that has one.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderLogLine {
    pub id: String,
    pub created_at: i64,
    /// `build` or `runtime`.
    pub kind: &'static str,
    /// `stdout` / `stderr` / `command` for build lines; `error` / `warning` /
    /// `info` for runtime ones. The vendor's word, not ours.
    pub level: String,
    pub text: String,
    /// Runtime lines only, and only when the vendor named a source.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
    /// Runtime lines only — which request produced this line.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<LogRequest>,
}

impl ProviderLogLine {
    pub fn build(id: String, created_at: i64, level: String, text: String) -> Self {
        Self {
            id,
            created_at,
            kind: "build",
            level,
            text,
            source: None,
            request: None,
        }
    }
}

/// The request a runtime log line was emitted while serving.
///
/// Present as a whole or not at all: the reference builds it only when the
/// vendor sent at least one of the three, so a line with none carries no
/// `request` key rather than one with three nulls.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_code: Option<Value>,
}

/// Everything an action needs beyond its own name.
///
/// One struct rather than four signatures because the route does not know
/// which action it is dispatching — the name arrives in the path and the legal
/// names come from the manifest, so the caller fills what it can and each
/// provider takes what it needs. Which fields are *required* is therefore the
/// provider's answer, not this type's: Vercel's redeploy needs the original's
/// `name`, Cloudflare's needs only the project.
#[derive(Debug, Clone, Default)]
pub struct DeployActionInput {
    pub deployment_id: String,
    /// Required by actions that address the project rather than the deployment.
    pub project_id: Option<String>,
    /// The original's name and environment, read before the call and passed
    /// through by actions that recreate it. Without the target a production
    /// retry silently comes back as a preview.
    pub name: Option<Value>,
    pub target: Option<Value>,
    /// Recorded by providers that accept a reason (Vercel's rollback).
    pub description: Option<String>,
}

/// The deployment an action created, when it created one.
///
/// `url` is always present and sometimes null — a deployment that exists but
/// has not been assigned a hostname yet is a real state, and the client shows
/// it differently from one it simply was not told about.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CreatedDeployment {
    pub id: String,
    pub url: Value,
}
