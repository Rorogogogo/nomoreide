use reqwest;
use tauri::State;
use serde_json::Value;
use crate::AppState;

fn github_api_url(host: &str, path: &str) -> String {
    if host == "github.com" || host.is_empty() {
        format!("https://api.github.com{path}")
    } else {
        format!("https://{host}/api/v3{path}")
    }
}

async fn gh_get(token: &str, host: &str, path: &str) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let url = github_api_url(host, path);
    let resp = client.get(&url)
        .header("Authorization", format!("token {token}"))
        .header("User-Agent", "nomoreide")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    resp.json::<Value>().await.map_err(|e| e.to_string())
}

async fn gh_post(token: &str, host: &str, path: &str, body: Value) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let url = github_api_url(host, path);
    let resp = client.post(&url)
        .header("Authorization", format!("token {token}"))
        .header("User-Agent", "nomoreide")
        .header("Accept", "application/vnd.github+json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    resp.json::<Value>().await.map_err(|e| e.to_string())
}

fn get_token_and_host(config: &crate::core::config::Config) -> Result<(String, String), String> {
    let token_def = config.github_tokens.first()
        .ok_or("No GitHub token configured")?;
    Ok((token_def.token.clone(), token_def.host.clone()))
}

#[tauri::command]
pub async fn get_github_token_status(
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    if let Some(t) = config.github_tokens.first() {
        Ok(serde_json::json!({ "configured": true, "host": t.host }))
    } else {
        Ok(serde_json::json!({ "configured": false }))
    }
}

#[tauri::command]
pub async fn list_pull_requests(
    state: State<'_, AppState>,
    owner: String,
    repo: String,
    state_filter: Option<String>,
) -> Result<Value, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let (token, host) = get_token_and_host(&config)?;
    let st = state_filter.as_deref().unwrap_or("open");
    gh_get(&token, &host, &format!("/repos/{owner}/{repo}/pulls?state={st}&per_page=50")).await
}

#[tauri::command]
pub async fn get_pull_request(
    state: State<'_, AppState>,
    owner: String,
    repo: String,
    number: u64,
) -> Result<Value, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let (token, host) = get_token_and_host(&config)?;
    gh_get(&token, &host, &format!("/repos/{owner}/{repo}/pulls/{number}")).await
}

#[tauri::command]
pub async fn create_pull_request(
    state: State<'_, AppState>,
    owner: String,
    repo: String,
    title: String,
    body: String,
    head: String,
    base: String,
    draft: Option<bool>,
) -> Result<Value, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let (token, host) = get_token_and_host(&config)?;
    gh_post(&token, &host, &format!("/repos/{owner}/{repo}/pulls"), serde_json::json!({
        "title": title, "body": body, "head": head, "base": base,
        "draft": draft.unwrap_or(false),
    })).await
}

#[tauri::command]
pub async fn list_issues(
    state: State<'_, AppState>,
    owner: String,
    repo: String,
    state_filter: Option<String>,
) -> Result<Value, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let (token, host) = get_token_and_host(&config)?;
    let st = state_filter.as_deref().unwrap_or("open");
    gh_get(&token, &host, &format!("/repos/{owner}/{repo}/issues?state={st}&per_page=50")).await
}

#[tauri::command]
pub async fn github_oauth_start(
    _state: State<'_, AppState>,
    client_id: String,
) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let resp = client.post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .json(&serde_json::json!({ "client_id": client_id, "scope": "repo" }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    resp.json::<Value>().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn github_oauth_poll(
    _state: State<'_, AppState>,
    client_id: String,
    device_code: String,
) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let resp = client.post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "client_id": client_id,
            "device_code": device_code,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code"
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    resp.json::<Value>().await.map_err(|e| e.to_string())
}
