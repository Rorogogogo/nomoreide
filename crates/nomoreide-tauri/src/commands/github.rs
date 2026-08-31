use crate::AppState;
use nomoreide_core::config::{Config, GithubCredentialSelection};
use nomoreide_core::github_auth;
use reqwest;
use serde_json::Value;
use tauri::State;
use tokio::process::Command;

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
    let resp = client
        .get(&url)
        .header("Authorization", format!("token {token}"))
        .header("User-Agent", "nomoreide")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    response_json(resp).await
}

async fn gh_get_text(token: &str, host: &str, path: &str, accept: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let url = github_api_url(host, path);
    let resp = client
        .get(&url)
        .header("Authorization", format!("token {token}"))
        .header("User-Agent", "nomoreide")
        .header("Accept", accept)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    response_text(resp).await
}

async fn gh_post(token: &str, host: &str, path: &str, body: Value) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let url = github_api_url(host, path);
    let resp = client
        .post(&url)
        .header("Authorization", format!("token {token}"))
        .header("User-Agent", "nomoreide")
        .header("Accept", "application/vnd.github+json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    response_json(resp).await
}

async fn response_json(resp: reqwest::Response) -> Result<Value, String> {
    let text = response_text(resp).await?;
    serde_json::from_str(&text).map_err(|error| error.to_string())
}

async fn response_text(resp: reqwest::Response) -> Result<String, String> {
    let status = resp.status();
    let text = resp.text().await.map_err(|error| error.to_string())?;
    if status.is_success() {
        return Ok(text);
    }
    let kind = if status.as_u16() == 401 || status.as_u16() == 403 {
        "GitHub authentication failed"
    } else {
        "GitHub API request failed"
    };
    Err(format!(
        "{kind} ({status}): {}",
        github_error_message(&text)
    ))
}

fn github_error_message(text: &str) -> String {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "Unexpected response from GitHub".into())
}

async fn get_token_and_host(
    config: &nomoreide_core::config::Config,
    repository: &str,
    owner: &str,
    repo: &str,
) -> Result<(String, String), String> {
    let definition = config
        .git_repositories
        .iter()
        .find(|entry| entry.name == repository)
        .ok_or("The GitHub repository is not registered in NoMoreIDE.")?;
    if registered_remote(definition).await?.as_ref() != Some(&(owner.to_string(), repo.to_string()))
    {
        return Err(
            "The requested GitHub repository does not match the registered project.".into(),
        );
    }
    let (token, host, _) = github_auth::resolve(config, Some(repository), "github.com").await?;
    Ok((token, host))
}

async fn registered_remote(
    repository: &nomoreide_core::config::GitRepoDef,
) -> Result<Option<(String, String)>, String> {
    let cwd = repository
        .active_worktree_path
        .as_ref()
        .unwrap_or(&repository.path);
    let output = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(cwd)
        .output()
        .await
        .map_err(|error| error.to_string())?;
    Ok(parse_github_remote(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

fn parse_github_remote(remote: &str) -> Option<(String, String)> {
    let trimmed = remote.trim().trim_end_matches(".git");
    let path = trimmed
        .strip_prefix("git@github.com:")
        .or_else(|| trimmed.strip_prefix("https://github.com/"))
        .or_else(|| trimmed.strip_prefix("http://github.com/"))?;
    let mut parts = path.splitn(2, '/');
    Some((parts.next()?.to_string(), parts.next()?.to_string()))
}

// ---------------------------------------------------------------------------
// Token / OAuth
// ---------------------------------------------------------------------------

/// Public avatar for a login we already know, no API call needed.
fn avatar_for_login(login: &str) -> String {
    format!("https://github.com/{login}.png?size=64")
}

/// The connected account (`{ login, avatarUrl }`) for the header indicator.
///
/// Resolved without spending an API call whenever possible: a `gh` credential
/// names its login, and a stored token remembers its own identity after the
/// first lookup. `viewer` is the already-fetched `/user` payload when the
/// status check happened to request it. Mirrors the Node route in
/// `src/web/routes/github-routes.ts`.
async fn resolve_account(
    state: &State<'_, AppState>,
    config: &Config,
    credential: &GithubCredentialSelection,
    token: &str,
    host: &str,
    viewer: Option<&Value>,
) -> Option<Value> {
    if let GithubCredentialSelection::Gh { login, .. } = credential {
        return Some(serde_json::json!({
            "login": login,
            "avatarUrl": avatar_for_login(login),
        }));
    }

    if let Some(profile) = state.config_store.get_github_profile(config, host) {
        let avatar = profile
            .avatar_url
            .unwrap_or_else(|| avatar_for_login(&profile.login));
        return Some(serde_json::json!({ "login": profile.login, "avatarUrl": avatar }));
    }

    // Nothing cached yet: use the viewer payload if this check already fetched
    // one, otherwise ask once — then persist so later checks stay free.
    let fetched;
    let payload = match viewer {
        Some(value) => Some(value),
        None => {
            fetched = gh_get(token, host, "/user").await.ok();
            fetched.as_ref()
        }
    };
    let login = payload?.get("login")?.as_str()?.to_string();
    let avatar_url = payload
        .and_then(|value| value.get("avatar_url"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    let _ = state
        .config_store
        .set_github_profile(host, login.clone(), avatar_url.clone())
        .await;
    let avatar = avatar_url.unwrap_or_else(|| avatar_for_login(&login));
    Some(serde_json::json!({ "login": login, "avatarUrl": avatar }))
}

#[tauri::command]
pub async fn get_github_token_status(state: State<'_, AppState>) -> Result<Value, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let accounts = github_auth::list_accounts().await;
    let repository = config.selected_git_repository.as_ref().and_then(|name| {
        config
            .git_repositories
            .iter()
            .find(|repo| &repo.name == name)
    });
    let selected = repository.and_then(|repo| repo.github_credential.clone());
    let stored_configured = state
        .config_store
        .get_github_token(&config, "github.com")
        .is_some();
    match github_auth::resolve(
        &config,
        config.selected_git_repository.as_deref(),
        "github.com",
    )
    .await
    {
        Ok((token, host, credential)) => {
            // Resolved up front so the repository can still be named when the
            // API refuses to describe it (see the 404 case below).
            let remote = match repository {
                Some(definition) => registered_remote(definition).await?,
                None => None,
            };
            let repository_slug = remote
                .as_ref()
                .map(|(owner, repo)| format!("{owner}/{repo}"));
            let validation = match repository {
                Some(_) => match &remote {
                    Some((owner, repo)) => {
                        gh_get(&token, &host, &format!("/repos/{owner}/{repo}")).await
                    }
                    None => Err("Could not parse the selected repository's GitHub remote.".into()),
                },
                None => gh_get(&token, &host, "/user").await,
            };
            match validation {
                Ok(resource) => {
                    let user = resolve_account(
                        &state,
                        &config,
                        &credential,
                        &token,
                        &host,
                        repository.is_none().then_some(&resource),
                    )
                    .await;
                    Ok(serde_json::json!({
                        "configured": true,
                        "storedConfigured": stored_configured,
                        "deviceFlowAvailable": true,
                        "status": "connected",
                        "accounts": accounts.accounts,
                        "cliAvailable": accounts.available,
                        "cliError": accounts.error,
                        "selected": selected,
                        "credential": credential,
                        "repositoryName": repository.map(|repo| repo.name.clone()),
                        "repositorySlug": repository_slug,
                        "repository": if repository.is_some() { Some(resource.clone()) } else { None },
                        "user": user,
                    }))
                }
                Err(error) => {
                    // A 404 on the repository means the credential authenticated and
                    // GitHub answered "not for you" — an access problem, not a
                    // broken connection, and the UI says so instead of asking for a
                    // reconnect. Mirrors the daemon's `/api/github/token`.
                    let no_repo_access = repository_slug.is_some()
                        && error.starts_with("GitHub API request failed (404");
                    let user =
                        resolve_account(&state, &config, &credential, &token, &host, None).await;
                    Ok(serde_json::json!({
                        "configured": true,
                        "storedConfigured": stored_configured,
                        "deviceFlowAvailable": true,
                        "status": if error.starts_with("GitHub authentication failed") {
                            "auth_error"
                        } else if no_repo_access {
                            "repo_access"
                        } else {
                            "connection_error"
                        },
                        "accounts": accounts.accounts,
                        "cliAvailable": accounts.available,
                        "cliError": accounts.error,
                        "selected": selected,
                        "credential": credential,
                        "repositoryName": repository.map(|repo| repo.name.clone()),
                        "repositorySlug": repository_slug,
                        "user": user,
                        "error": error,
                    }))
                }
            }
        }
        Err(error) => Ok(serde_json::json!({
            "configured": false,
            "storedConfigured": stored_configured,
            "deviceFlowAvailable": true,
            "status": "not_configured",
            "accounts": accounts.accounts,
            "cliAvailable": accounts.available,
            "cliError": accounts.error,
            "selected": selected,
            "repositoryName": repository.map(|repo| repo.name.clone()),
            "error": error,
        })),
    }
}

#[tauri::command]
pub async fn list_github_accounts() -> Result<Value, String> {
    serde_json::to_value(github_auth::list_accounts().await).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn set_github_account(
    state: State<'_, AppState>,
    repository: String,
    credential: GithubCredentialSelection,
) -> Result<(), String> {
    let credential_host = match &credential {
        GithubCredentialSelection::Gh { host, .. } => host,
        GithubCredentialSelection::Stored { host } => host,
    };
    if credential_host != "github.com" {
        return Err("The selected repository uses github.com; choose a github.com account.".into());
    }
    match &credential {
        GithubCredentialSelection::Gh { host, login } => {
            github_auth::token(host, login).await?;
        }
        GithubCredentialSelection::Stored { host } => {
            let config = state
                .config_store
                .load()
                .await
                .map_err(|error| error.to_string())?;
            if state.config_store.get_github_token(&config, host).is_none() {
                return Err(format!("No stored GitHub token configured for {host}."));
            }
        }
    }
    state
        .config_store
        .set_github_credential(&repository, credential)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn github_oauth_start(
    _state: State<'_, AppState>,
    client_id: String,
) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post("https://github.com/login/device/code")
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
    let resp = client
        .post("https://github.com/login/oauth/access_token")
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

// ---------------------------------------------------------------------------
// Pull Requests
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_pull_requests(
    state: State<'_, AppState>,
    repository: String,
    owner: String,
    repo: String,
    state_filter: Option<String>,
) -> Result<Value, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let (token, host) = get_token_and_host(&config, &repository, &owner, &repo).await?;
    let st = state_filter.as_deref().unwrap_or("open");
    gh_get(
        &token,
        &host,
        &format!("/repos/{owner}/{repo}/pulls?state={st}&per_page=50"),
    )
    .await
}

#[tauri::command]
pub async fn get_pull_request(
    state: State<'_, AppState>,
    repository: String,
    owner: String,
    repo: String,
    number: u64,
) -> Result<Value, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let (token, host) = get_token_and_host(&config, &repository, &owner, &repo).await?;
    gh_get(
        &token,
        &host,
        &format!("/repos/{owner}/{repo}/pulls/{number}"),
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_pull_request(
    state: State<'_, AppState>,
    repository: String,
    owner: String,
    repo: String,
    title: String,
    body: String,
    head: String,
    base: String,
    draft: Option<bool>,
) -> Result<Value, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let (token, host) = get_token_and_host(&config, &repository, &owner, &repo).await?;
    gh_post(
        &token,
        &host,
        &format!("/repos/{owner}/{repo}/pulls"),
        serde_json::json!({
            "title": title, "body": body, "head": head, "base": base,
            "draft": draft.unwrap_or(false),
        }),
    )
    .await
}

#[tauri::command]
pub async fn get_pr_diff(
    state: State<'_, AppState>,
    repository: String,
    owner: String,
    repo: String,
    number: u64,
) -> Result<String, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let (token, host) = get_token_and_host(&config, &repository, &owner, &repo).await?;
    gh_get_text(
        &token,
        &host,
        &format!("/repos/{owner}/{repo}/pulls/{number}"),
        "application/vnd.github.diff",
    )
    .await
}

#[tauri::command]
pub async fn list_pr_files(
    state: State<'_, AppState>,
    repository: String,
    owner: String,
    repo: String,
    number: u64,
) -> Result<Value, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let (token, host) = get_token_and_host(&config, &repository, &owner, &repo).await?;
    gh_get(
        &token,
        &host,
        &format!("/repos/{owner}/{repo}/pulls/{number}/files?per_page=100"),
    )
    .await
}

#[tauri::command]
pub async fn list_pr_reviews(
    state: State<'_, AppState>,
    repository: String,
    owner: String,
    repo: String,
    number: u64,
) -> Result<Value, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let (token, host) = get_token_and_host(&config, &repository, &owner, &repo).await?;
    gh_get(
        &token,
        &host,
        &format!("/repos/{owner}/{repo}/pulls/{number}/reviews"),
    )
    .await
}

#[tauri::command]
pub async fn list_pr_comments(
    state: State<'_, AppState>,
    repository: String,
    owner: String,
    repo: String,
    number: u64,
) -> Result<Value, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let (token, host) = get_token_and_host(&config, &repository, &owner, &repo).await?;
    gh_get(
        &token,
        &host,
        &format!("/repos/{owner}/{repo}/pulls/{number}/comments?per_page=100"),
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn merge_pull_request(
    state: State<'_, AppState>,
    repository: String,
    owner: String,
    repo: String,
    number: u64,
    method: Option<String>,
    commit_title: Option<String>,
    commit_message: Option<String>,
) -> Result<Value, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let (token, host) = get_token_and_host(&config, &repository, &owner, &repo).await?;
    let mut body = serde_json::json!({
        "merge_method": method.as_deref().unwrap_or("squash"),
    });
    if let Some(t) = commit_title {
        body["commit_title"] = serde_json::json!(t);
    }
    if let Some(m) = commit_message {
        body["commit_message"] = serde_json::json!(m);
    }
    gh_post(
        &token,
        &host,
        &format!("/repos/{owner}/{repo}/pulls/{number}/merge"),
        body,
    )
    .await
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_issues(
    state: State<'_, AppState>,
    repository: String,
    owner: String,
    repo: String,
    state_filter: Option<String>,
) -> Result<Value, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let (token, host) = get_token_and_host(&config, &repository, &owner, &repo).await?;
    let st = state_filter.as_deref().unwrap_or("open");
    gh_get(
        &token,
        &host,
        &format!("/repos/{owner}/{repo}/issues?state={st}&per_page=50"),
    )
    .await
}

#[tauri::command]
pub async fn get_github_issue(
    state: State<'_, AppState>,
    repository: String,
    owner: String,
    repo: String,
    number: u64,
) -> Result<Value, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let (token, host) = get_token_and_host(&config, &repository, &owner, &repo).await?;
    gh_get(
        &token,
        &host,
        &format!("/repos/{owner}/{repo}/issues/{number}"),
    )
    .await
}

#[tauri::command]
pub async fn list_issue_comments(
    state: State<'_, AppState>,
    repository: String,
    owner: String,
    repo: String,
    number: u64,
) -> Result<Value, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let (token, host) = get_token_and_host(&config, &repository, &owner, &repo).await?;
    gh_get(
        &token,
        &host,
        &format!("/repos/{owner}/{repo}/issues/{number}/comments?per_page=100"),
    )
    .await
}

#[tauri::command]
pub async fn add_issue_comment(
    state: State<'_, AppState>,
    repository: String,
    owner: String,
    repo: String,
    number: u64,
    body: String,
) -> Result<Value, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let (token, host) = get_token_and_host(&config, &repository, &owner, &repo).await?;
    gh_post(
        &token,
        &host,
        &format!("/repos/{owner}/{repo}/issues/{number}/comments"),
        serde_json::json!({ "body": body }),
    )
    .await
}

#[tauri::command]
pub async fn create_github_issue(
    state: State<'_, AppState>,
    repository: String,
    owner: String,
    repo: String,
    title: String,
    body: Option<String>,
) -> Result<Value, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let (token, host) = get_token_and_host(&config, &repository, &owner, &repo).await?;
    gh_post(
        &token,
        &host,
        &format!("/repos/{owner}/{repo}/issues"),
        serde_json::json!({ "title": title, "body": body.unwrap_or_default() }),
    )
    .await
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_github_branches(
    state: State<'_, AppState>,
    repository: String,
    owner: String,
    repo: String,
) -> Result<Value, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let (token, host) = get_token_and_host(&config, &repository, &owner, &repo).await?;
    gh_get(
        &token,
        &host,
        &format!("/repos/{owner}/{repo}/branches?per_page=100"),
    )
    .await
}

#[tauri::command]
pub async fn get_github_repo_info(
    state: State<'_, AppState>,
    repository: String,
    owner: String,
    repo: String,
) -> Result<Value, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let (token, host) = get_token_and_host(&config, &repository, &owner, &repo).await?;
    gh_get(&token, &host, &format!("/repos/{owner}/{repo}")).await
}

// ---------------------------------------------------------------------------
// CI / Actions
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_commit_check_runs(
    state: State<'_, AppState>,
    repository: String,
    owner: String,
    repo: String,
    sha: String,
) -> Result<Value, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let (token, host) = get_token_and_host(&config, &repository, &owner, &repo).await?;
    gh_get(
        &token,
        &host,
        &format!("/repos/{owner}/{repo}/commits/{sha}/check-runs?per_page=50"),
    )
    .await
}

#[tauri::command]
pub async fn list_workflow_runs(
    state: State<'_, AppState>,
    repository: String,
    owner: String,
    repo: String,
    branch: Option<String>,
    page: Option<u32>,
) -> Result<Value, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let (token, host) = get_token_and_host(&config, &repository, &owner, &repo).await?;
    let p = page.unwrap_or(1);
    let mut path = format!("/repos/{owner}/{repo}/actions/runs?per_page=25&page={p}");
    if let Some(b) = branch {
        path.push_str(&format!("&branch={b}"));
    }
    gh_get(&token, &host, &path).await
}

#[tauri::command]
pub async fn list_workflow_run_jobs(
    state: State<'_, AppState>,
    repository: String,
    owner: String,
    repo: String,
    run_id: u64,
) -> Result<Value, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let (token, host) = get_token_and_host(&config, &repository, &owner, &repo).await?;
    gh_get(
        &token,
        &host,
        &format!("/repos/{owner}/{repo}/actions/runs/{run_id}/jobs"),
    )
    .await
}
