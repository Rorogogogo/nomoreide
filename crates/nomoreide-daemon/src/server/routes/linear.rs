use crate::server::{app::AppState, errors::error};
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use nomoreide_core::{
    config::ProviderConnectionDef, linear, remote::protocol::linear::LinearRequest,
};
use serde::Deserialize;
use serde_json::json;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/linear/connection",
            get(connection).post(connect).delete(disconnect),
        )
        .route("/api/linear/request", post(execute))
}
async fn connection(State(state): State<AppState>) -> Response {
    match state.config_store.load().await {
        Ok(config) => Json(json!({"ok": true, "connected": config.connections.get("linear").is_some_and(|c| c.token.is_some()), "username": config.connections.get("linear").and_then(|c| c.username.as_ref())})).into_response(),
        Err(_) => refused("Could not read Linear connection"),
    }
}
#[derive(Deserialize)]
struct Connect {
    token: String,
}
async fn connect(State(state): State<AppState>, Json(input): Json<Connect>) -> Response {
    let token = input.token.trim();
    if token.is_empty() || token.len() > 4096 {
        return refused("A Linear API key is required");
    }
    let viewer = match linear::query(token, "query { viewer { id name } }", json!({})).await {
        Ok(data) => data,
        Err(reason) => return refused(&reason),
    };
    let connection = ProviderConnectionDef {
        source: "stored".into(),
        token: Some(token.into()),
        username: viewer["viewer"]["name"].as_str().map(str::to_owned),
        ..Default::default()
    };
    match state
        .config_store
        .set_connection("linear", connection)
        .await
    {
        Ok(_) => Json(json!({"ok": true})).into_response(),
        Err(_) => refused("Could not save Linear connection"),
    }
}
async fn disconnect(State(state): State<AppState>) -> Response {
    match state.config_store.remove_connection("linear").await {
        Ok(_) => Json(json!({"ok": true})).into_response(),
        Err(_) => refused("Could not remove Linear connection"),
    }
}
async fn execute(State(state): State<AppState>, Json(request): Json<LinearRequest>) -> Response {
    if let Err(reason) = request.validate() {
        return refused(reason);
    }
    let mut config = match state.config_store.load().await {
        Ok(config) => config,
        Err(_) => return refused("Could not read Linear connection"),
    };
    let Some(token) = config
        .connections
        .get("linear")
        .and_then(|c| c.token.as_deref())
    else {
        return refused("Connect Linear on the host to use tasks");
    };
    let repository = config.selected_git_repository.clone().unwrap_or_default();
    if let LinearRequest::Binding { team, project } = &request {
        if repository.is_empty() {
            return refused("Select a repository before linking Linear");
        }
        let metadata = match linear::execute(token, &LinearRequest::Metadata {}).await {
            Ok(data) => data,
            Err(reason) => return refused(&reason),
        };
        let selected = metadata["teams"]["nodes"]
            .as_array()
            .and_then(|teams| teams.iter().find(|t| t["id"].as_str() == Some(team)));
        let Some(selected) = selected else {
            return refused("Choose an accessible Linear team");
        };
        if project.as_ref().is_some_and(|p| {
            !selected["projects"]["nodes"]
                .as_array()
                .is_some_and(|ps| ps.iter().any(|v| v["id"].as_str() == Some(p)))
        }) {
            return refused("Project does not belong to this team");
        }
        let preferences = config.preferences.get_or_insert_with(|| json!({}));
        if !preferences.is_object() {
            return refused("Invalid repository preferences");
        }
        if !preferences["linearBindings"].is_object() {
            preferences["linearBindings"] = json!({});
        }
        preferences["linearBindings"][&repository] = json!({"team": team, "project": project});
        return match state.config_store.save(&config).await {
            Ok(_) => {
                Json(json!({"ok": true, "data": {"binding": {"team": team, "project": project}}}))
                    .into_response()
            }
            Err(_) => refused("Could not save Linear project link"),
        };
    }
    match linear::execute(token, &request).await {
        Ok(mut data) => {
            if matches!(request, LinearRequest::Metadata {}) {
                data["binding"] = config
                    .preferences
                    .as_ref()
                    .map(|p| p["linearBindings"][&repository].clone())
                    .unwrap_or(serde_json::Value::Null);
            }
            Json(json!({"ok": true, "data": data})).into_response()
        }
        Err(reason) => refused(&reason),
    }
}
fn refused(reason: &str) -> Response {
    error(StatusCode::BAD_REQUEST, reason)
}
