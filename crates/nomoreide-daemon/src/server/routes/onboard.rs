//! The "Add from GitHub" wizard: paste a URL, get a proposal, confirm it.
//!
//! The three endpoints the wizard uses. The middle one — the streamed install
//! — is Server-Sent Events, and is the only route here that answers 200 before
//! it knows whether the work succeeded: a failed install is a `done` frame
//! carrying a non-zero exit code, not an HTTP error.
//!
//! **Everything that goes wrong is a 422.** Both routes have exactly one guard
//! answering 400 (a missing `url`; a `name`/`cwd` pair that is not an onboarded
//! path) and wrap the rest in one `try`. So a URL that does not parse, a clone
//! that fails, a scan that cannot read the clone, a schema refusal, and a port
//! conflict raised while starting the new service all come back the same way:
//! `422` with whatever the error said. The status does not tell the wizard
//! which step failed — the message does.
//!
//! **`cwd` is checked before `name` is used, and both before anything is
//! written.** The containment guard is the reason this route can register a
//! service at a path a browser chose: the path has to be inside the onboarding
//! directory, which only this wizard writes to.
//!
//! **Two of the three writes are best-effort.** Registering the service is the
//! operation; also listing the clone in the Git tab and registering a database
//! that rode along with the proposal are conveniences, and a failure in either
//! is swallowed rather than failing an onboarding that otherwise worked.

use crate::server::app::AppState;
use crate::server::body::read_json_object;
use crate::server::errors::{error, mutation_message};
use crate::server::sse;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use nomoreide_core::config::{DatabaseDef, GitRepoDef};
use nomoreide_core::repo_onboard::{
    clone_repository, default_repos_dir, is_inside_repos_dir, propose_databases, propose_services,
    run_install, scan_repo,
};
use nomoreide_core::service_definition::service_definition;
use serde_json::{json, Map, Value};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/onboard/scan", post(scan))
        .route("/api/onboard/install/stream", post(install_stream))
        .route("/api/onboard/register", post(register))
}

/// Run the install command a proposal named, streaming its output.
///
/// **The containment guard is the whole of the safety here**: the body names a
/// directory and a shell command, and the command runs in that directory. So
/// the path has to resolve inside the onboarding root, which only this wizard
/// writes to. The command itself is deliberately unconstrained — it is the
/// `npm install` the user just confirmed — and a path outside the root is
/// refused before anything is spawned.
///
/// The order of the two checks is load-bearing: a request that is wrong in
/// both ways reports the path, because that is the one that decided.
async fn install_stream(State(state): State<AppState>, body: Bytes) -> Response {
    let _ = &state;
    let payload = read_json_object(&body);
    let clone_path = payload
        .get("clonePath")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let command = payload
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();

    if clone_path.is_empty() || !is_inside_repos_dir(&clone_path, &default_repos_dir()) {
        return error(
            StatusCode::BAD_REQUEST,
            "clonePath must be an onboarded repo",
        );
    }
    if command.is_empty() {
        return error(StatusCode::BAD_REQUEST, "command is required");
    }

    sse::driven(sse::RETRY_AND_PING, move |sink| async move {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let install = tokio::spawn(async move { run_install(&clone_path, &command, tx).await });
        while let Some(line) = rx.recv().await {
            if !sink.send(sse::named("output", line)).await {
                // The browser left. The child keeps going — an install half
                // done is worse than one finished — but nothing more is
                // written.
                break;
            }
        }
        let exit_code = install.await.ok().flatten();
        sink.send(sse::named("done", json!({ "exitCode": exit_code })))
            .await;
    })
}

/// Clone a repository and read it into a profile plus a proposal.
///
/// No GitHub token is passed, unlike the clone behind the Git tab's own
/// registration: this route hands `clone_repository` two arguments, so a
/// private repository fails here with git's own authentication error.
async fn scan(State(state): State<AppState>, body: Bytes) -> Response {
    let _ = &state;
    let payload = read_json_object(&body);
    let url = payload
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    if url.is_empty() {
        return error(StatusCode::BAD_REQUEST, "url is required");
    }
    let cloned = match clone_repository(&url, Some(&default_repos_dir()), None).await {
        Ok(cloned) => cloned,
        Err(reason) => return error(StatusCode::UNPROCESSABLE_ENTITY, &reason.to_string()),
    };
    let profile = match scan_repo(&cloned.clone_path).await {
        Ok(profile) => profile,
        Err(reason) => return error(StatusCode::UNPROCESSABLE_ENTITY, &reason.to_string()),
    };
    let proposals = propose_services(&profile);
    let databases = propose_databases(&profile);
    Json(json!({
        "ok": true,
        "profile": profile,
        "proposals": proposals,
        "databases": databases,
    }))
    .into_response()
}

/// Register a confirmed proposal, and optionally start it.
async fn register(State(state): State<AppState>, body: Bytes) -> Response {
    let payload = read_json_object(&body);
    // Both fields have to be *strings* — a number `name` is refused here rather
    // than stringified — and the path has to be one this wizard cloned.
    let (Some(_), Some(cwd)) = (
        payload.get("name").and_then(Value::as_str),
        payload.get("cwd").and_then(Value::as_str),
    ) else {
        return error(
            StatusCode::BAD_REQUEST,
            "name and an onboarded cwd are required",
        );
    };
    if !is_inside_repos_dir(cwd, &default_repos_dir()) {
        return error(
            StatusCode::BAD_REQUEST,
            "name and an onboarded cwd are required",
        );
    }

    let arguments = match proposal_arguments(&payload) {
        Ok(arguments) => arguments,
        Err(reason) => return error(StatusCode::UNPROCESSABLE_ENTITY, &reason),
    };
    let definition = match service_definition(&arguments) {
        Ok(definition) => definition,
        // The schema refusal lands in the same catch as everything else, so
        // zod's report is a 422 here rather than the 500 the form route gives
        // it.
        Err(report) => return error(StatusCode::UNPROCESSABLE_ENTITY, &report),
    };
    let name = definition.name.clone();
    let config = match state.config_store.register_service(definition).await {
        Ok(config) => config,
        Err(reason) => return error(StatusCode::UNPROCESSABLE_ENTITY, &reason.to_string()),
    };

    // Best-effort: surface the clone in the Git tab too.
    let _ = state
        .config_store
        .register_git_repository(GitRepoDef {
            name: name.clone(),
            path: cwd.to_string(),
            active_worktree_path: None,
            github_credential: None,
            provider_projects: None,
            legacy_vercel_project_id: None,
        })
        .await;
    // Best-effort: register the database the proposal carried, so a compose
    // Postgres behind the app shows up in the Database tab.
    //
    // **The answer is the config as of the service write**, not as of this one.
    // The reference keeps the value `registerService` returned and never
    // re-reads, so neither the git repository above nor this database appears
    // in the `config` the wizard is handed back — they are on disk a moment
    // later, and the next read sees them. Mirrored rather than corrected: a
    // fresher config here would be a different answer to the same request.
    if let Some(database) = parse_database_input(payload.get("database")) {
        let _ = state.config_store.register_database(database).await;
    }

    // `start` is compared to `true` itself: a truthy `"yes"` does not start it.
    let started = if payload.get("start") == Some(&Value::Bool(true)) {
        match state.runtime.start_service(&name).await {
            Ok(status) => match serde_json::to_value(status) {
                Ok(value) => value,
                Err(_) => Value::Null,
            },
            // Including a port conflict: this route does not catch that
            // separately, so it is a 422 with the message and no `conflict`.
            Err(failure) => {
                return error(StatusCode::UNPROCESSABLE_ENTITY, &mutation_message(failure))
            }
        }
    } else {
        Value::Null
    };

    let view = serde_json::to_value(config.public_view()).unwrap_or_else(|_| json!({}));
    Json(json!({ "ok": true, "config": view, "started": started })).into_response()
}

/// Map a confirmed proposal onto the arguments the service schema validates.
///
/// **Which fields are carried depends on the kind**, and only `docker-compose`
/// is a kind here: anything else — `ssh` included — is built as a local
/// service, so an `ssh` proposal loses its `host` and is refused for having no
/// `command` rather than being registered as a remote service.
fn proposal_arguments(payload: &Value) -> Result<Map<String, Value>, String> {
    let mut arguments = Map::new();
    let text = |key: &str| payload.get(key).and_then(Value::as_str);
    // Not trimmed, unlike the form route: whatever the wizard sent is the name.
    arguments.insert("name".to_string(), json!(text("name").unwrap_or_default()));
    arguments.insert("cwd".to_string(), json!(text("cwd").unwrap_or_default()));
    // A `port` that is not a *number* is dropped rather than refused — the
    // wizard fills this in itself, so a string here is a client bug, not
    // something to report to whoever is onboarding.
    if let Some(port) = payload.get("port").filter(|value| value.is_number()) {
        arguments.insert("port".to_string(), port.clone());
    }
    if let Some(description) = text("description")
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        arguments.insert("description".to_string(), json!(description));
    }

    if text("kind") == Some("docker-compose") {
        arguments.insert("kind".to_string(), json!("docker-compose"));
        let Some(service) = text("composeService")
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return Err("composeService is required for a docker-compose service.".to_string());
        };
        arguments.insert("composeService".to_string(), json!(service));
        if let Some(file) = text("composeFile")
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            arguments.insert("composeFile".to_string(), json!(file));
        }
        return Ok(arguments);
    }

    let Some(command) = text("command")
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Err("command is required for a local service.".to_string());
    };
    arguments.insert("command".to_string(), json!(command));
    // Passed through as it stands: the values are not checked to be strings
    // here, so a non-string one reaches the schema and is reported by it.
    if let Some(env) = payload.get("env").filter(|value| value.is_object()) {
        arguments.insert("env".to_string(), env.clone());
    }
    Ok(arguments)
}

/// The optional database that rides along with a registration.
///
/// Anything wrong with it means **no database**, not a refusal: this is a
/// convenience beside the service that was actually asked for, and a proposal
/// the wizard filled in badly should not cost someone their onboarding.
fn parse_database_input(value: Option<&Value>) -> Option<DatabaseDef> {
    let value = value?;
    if !value.is_object() {
        return None;
    }
    let text = |key: &str| value.get(key).and_then(Value::as_str);
    let name = text("name")?;
    let url = text("url")?;
    let engine = text("engine")?;
    if name.trim().is_empty() || url.trim().is_empty() {
        return None;
    }
    if !matches!(engine, "postgres" | "mysql" | "sqlite") {
        return None;
    }
    Some(DatabaseDef {
        name: name.trim().to_string(),
        engine: engine.to_string(),
        url: url.trim().to_string(),
        write_unlocked: None,
        project_path: None,
    })
}
