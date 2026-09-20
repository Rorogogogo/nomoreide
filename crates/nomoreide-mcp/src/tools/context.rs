//! `nomoreide_context_search` and `nomoreide_context_get`.
//!
//! The context library, from the agent's side. Until these existed the library
//! was push-only: a human browsed it in the dashboard and attached rows to an
//! agent's prompt, and the agent itself had no way to ask. These are the pull.
//!
//! **Both go through the daemon**, like the error inbox and for the same
//! reason: a context listing folds in incidents, which only the daemon holds.
//! Reading the vault in this process would answer with a listing that silently
//! omits them.
//!
//! Read-safe, like the rest of the agent surface. `get` takes a ref, never a
//! path, so it reaches exactly the files the library already indexed.

use crate::tools::render;
use nomoreide_daemon_client::DaemonClient;
use serde_json::Value;

/// What a caller gets when they ask for no particular number of rows.
pub(crate) const DEFAULT_CONTEXT_LIMIT: usize = 40;

pub(crate) async fn search(
    client: &DaemonClient,
    query: Option<&str>,
    kinds: Option<&[String]>,
    project_path: Option<&str>,
    limit: usize,
) -> Result<String, String> {
    let answer = client
        .context_search(query, kinds, project_path)
        .await
        .map_err(|error| error.to_string())?;
    let items = answer
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| "The daemon returned no context items.".to_string())?;
    // Capped here rather than in the query because the listing has its own
    // ordering and its own cap; taking a prefix keeps whichever rows it
    // considered most relevant instead of asking it to re-rank.
    let capped: Vec<&Value> = items.iter().take(limit).collect();
    render(&serde_json::json!({
        "items": capped,
        "returned": capped.len(),
        "total": items.len(),
    }))
}

/// The body, as text rather than as JSON: an agent reads a file, and quoting
/// one into a JSON string would only make it something to unwrap first. The
/// header above it is what places the body — which file, and whether it was
/// cut — because a bare body does not say where it came from.
pub(crate) async fn get(client: &DaemonClient, kind: &str, id: &str) -> Result<String, String> {
    let content = client
        .context_content(kind, id)
        .await
        .map_err(|error| error.to_string())?;
    let title = content.get("title").and_then(Value::as_str).unwrap_or(id);
    let mut header = format!("{kind}: {title}");
    if let Some(path) = content.get("path").and_then(Value::as_str) {
        header.push_str(&format!("\nPath: {path}"));
    }
    match content.get("body").and_then(Value::as_str) {
        Some(body) => {
            if content.get("truncated").and_then(Value::as_bool) == Some(true) {
                header.push_str("\n(truncated)");
            }
            Ok(format!("{header}\n\n{body}"))
        }
        // Not an error. A service never had a body, and saying so is a real
        // answer — an agent that got a failure here would retry it.
        None => {
            let reason = content
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("This item has no stored content.");
            Ok(format!("{header}\n\n{reason}"))
        }
    }
}
