//! Reading a registered database: what it holds, what one object looks like,
//! and the rows themselves.
//!
//! Every route here resolves a connection by name and then asks the engine.
//! Nothing writes, and nothing needs the write-access unlock — the connection
//! string is opened read-only, which is what makes this whole file reachable by
//! an agent while `db-write` is not.
//!
//! Three details are the reference's and worth naming, because each looks like
//! a bug until you see the other side of it:
//!
//! * A **missing query parameter is a 400** with its own sentence, while a
//!   failure from the engine is a **500** carrying the driver's words. The
//!   reference's checks sit outside the dispatcher's try/catch and its driver
//!   calls sit inside, so the status says where the refusal came from rather
//!   than how serious it is. `query` is the exception, and says so at its own
//!   handler.
//! * `catalog/rows` bullets out a column whose *name* looks like a secret;
//!   `rows` does not. One is reached by an opaque key from the browser's own
//!   listing, the other by a table name the caller typed. Both are the
//!   reference's.
//! * A row cap arrives through `Number()`, so `0`, `-0`, and a word all mean
//!   "not given" and fall back to 100. What a *negative* cap then means differs
//!   between the two row routes, and each is clamped where the reference clamps
//!   it.

use crate::server::app::AppState;
use crate::server::body::{parse_form, parse_query, percent_decode};
use crate::server::errors::{config_failure, error, method_not_allowed};
use crate::server::js_json;
use crate::server::query::{js_number, js_number_or};
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use nomoreide_core::config::{Config, DatabaseDef};
use nomoreide_core::db;
use nomoreide_core::db::{RowBrowseQuery, RowFilter, RowSort};
use serde_json::{json, Value};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/databases/:name/catalog/capabilities",
            get(capabilities).fallback(method_not_allowed),
        )
        .route(
            "/api/databases/:name/catalog/schemas",
            get(schemas).fallback(method_not_allowed),
        )
        .route(
            "/api/databases/:name/catalog/objects",
            get(objects).fallback(method_not_allowed),
        )
        .route(
            "/api/databases/:name/catalog/details",
            get(details).fallback(method_not_allowed),
        )
        .route(
            "/api/databases/:name/catalog/rows",
            get(catalog_rows).fallback(method_not_allowed),
        )
        .route(
            "/api/databases/:name/tables",
            get(tables).fallback(method_not_allowed),
        )
        .route(
            "/api/databases/:name/rows",
            get(rows).fallback(method_not_allowed),
        )
        .route(
            "/api/databases/:name/query",
            post(query).fallback(method_not_allowed),
        )
}

/// Which object kinds this engine has, and which details it can describe.
///
/// Answered from the engine's name alone, so it succeeds for a connection
/// nothing can reach. That is the reference's behaviour and the useful one: the
/// browser draws its shell from this before it has connected to anything.
async fn capabilities(State(state): State<AppState>, uri: Uri) -> Response {
    with_connection(&state, &uri, |database| async move {
        db::capabilities(&database.engine)
            .map(|capabilities| json!({ "ok": true, "capabilities": capabilities }))
    })
    .await
}

async fn schemas(State(state): State<AppState>, uri: Uri) -> Response {
    with_connection(&state, &uri, |database| async move {
        db::peek_schemas(&database).await.map(|schemas| {
            json!({
                "ok": true,
                "schemas": schemas
                    .into_iter()
                    .map(|name| json!({ "name": name }))
                    .collect::<Vec<_>>(),
            })
        })
    })
    .await
}

/// The objects in one schema. A schema this connection does not have is empty
/// rather than an error — the caller asked what is in a place, and the answer
/// is that nothing is.
async fn objects(State(state): State<AppState>, uri: Uri) -> Response {
    let schema = match require_param(&uri, "schema") {
        Ok(schema) => schema,
        Err(message) => return error(StatusCode::BAD_REQUEST, &message),
    };
    with_connection(&state, &uri, |database| async move {
        db::peek_objects(&database, &schema)
            .await
            .map(|objects| json!({ "ok": true, "objects": objects }))
    })
    .await
}

async fn details(State(state): State<AppState>, uri: Uri) -> Response {
    let key = match require_param(&uri, "key") {
        Ok(key) => key,
        Err(message) => return error(StatusCode::BAD_REQUEST, &message),
    };
    with_connection(&state, &uri, |database| async move {
        db::peek_details(&database, &key)
            .await
            .map(|details| json!({ "ok": true, "details": details }))
    })
    .await
}

/// Rows for the browser: reached by an opaque catalog key, filtered and sorted
/// by controls the browser drew, and with any column whose name looks like a
/// secret bulleted out.
async fn catalog_rows(State(state): State<AppState>, uri: Uri) -> Response {
    let key = match require_param(&uri, "key") {
        Ok(key) => key,
        Err(message) => return error(StatusCode::BAD_REQUEST, &message),
    };
    let params = parse_query(&uri);
    // `Number(x) || fallback`: an unreadable cap and a zero cap are the same
    // instruction. A negative one is not, and survives to be clamped by the
    // core, which is where the reference clamps it too.
    let limit = js_number_or(params.get("limit").map(String::as_str), 100.0) as i64;
    let offset = js_number_or(params.get("offset").map(String::as_str), 0.0) as i64;
    let browse = match row_browse_query(&params) {
        Ok(browse) => browse,
        Err(reason) => return throw(&reason),
    };
    with_connection(&state, &uri, |database| async move {
        db::sample_object(&database, &key, Some(limit), Some(offset), Some(browse))
            .await
            .map(|rows| merge(json!({ "ok": true }), json!(rows)))
    })
    .await
}

async fn tables(State(state): State<AppState>, uri: Uri) -> Response {
    with_connection(&state, &uri, |database| async move {
        db::peek_tables(&database)
            .await
            .map(|tables| json!({ "ok": true, "tables": tables }))
    })
    .await
}

/// Rows for a table the caller named. Unlike the browser's reader this one
/// reports what is stored, secret-looking column names included: a caller who
/// typed the table's name is reading their own data, not browsing someone's.
async fn rows(State(state): State<AppState>, uri: Uri) -> Response {
    let table = match require_param(&uri, "table") {
        Ok(table) => table,
        Err(message) => return error(StatusCode::BAD_REQUEST, &message),
    };
    let params = parse_query(&uri);
    let limit = positive_or(params.get("limit").map(String::as_str), 100.0);
    let offset = positive_or(params.get("offset").map(String::as_str), 0.0);
    with_connection(&state, &uri, |database| async move {
        db::peek_sample(&database, &table, limit, offset)
            .await
            .map(|sample| merge(json!({ "ok": true }), sample))
    })
    .await
}

/// One caller-written statement.
///
/// The only route here that answers a failed *read* with a 400 rather than a
/// 500: bad SQL and a read-only violation are things the person typing did, so
/// the reference surfaces them inline in the editor instead of as a server
/// error. A missing `sql` is still a 500, because that check sits outside the
/// same try/catch as everywhere else in this file.
async fn query(State(state): State<AppState>, uri: Uri, body: Bytes) -> Response {
    let form = parse_form(&body);
    let sql = match form
        .get("sql")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        Some(sql) => sql.to_string(),
        None => return throw("sql is required"),
    };
    // Not `js_number_or`: a query's cap refuses a negative outright rather than
    // clamping it, so `Number.isFinite(n) && n > 0` is the whole test.
    let limit = positive_or(form.get("limit").map(String::as_str), 100.0);

    let config = match state.config_store.load().await {
        Ok(config) => config,
        Err(reason) => return config_failure(&reason),
    };
    let Some(name) = name_from(&uri) else {
        return error(StatusCode::NOT_FOUND, "Not found");
    };
    let outcome = match connection(&config, &name) {
        Ok(database) => db::run_capped_query(&database, &sql, limit).await,
        Err(reason) => Err(reason),
    };
    match outcome {
        Ok(result) => Json(merge(json!({ "ok": true }), result)).into_response(),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason),
    }
}

/// Resolve the connection named in the URI, then answer with it.
///
/// Both failures land where the reference's do: a connection that is not
/// registered and a driver that refused are alike a throw out of the route, so
/// both are a 500 carrying their own sentence.
async fn with_connection<F, Fut>(state: &AppState, uri: &Uri, answer: F) -> Response
where
    F: FnOnce(DatabaseDef) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    let Some(name) = name_from(uri) else {
        return error(StatusCode::NOT_FOUND, "Not found");
    };
    let config = match state.config_store.load().await {
        Ok(config) => config,
        Err(reason) => return config_failure(&reason),
    };
    let database = match connection(&config, &name) {
        Ok(database) => database,
        Err(reason) => return throw(&reason),
    };
    match answer(database).await {
        Ok(body) => Json(body).into_response(),
        Err(reason) => throw(&reason),
    }
}

fn connection(config: &Config, name: &str) -> Result<DatabaseDef, String> {
    db::peek_connection(&config.databases, name).cloned()
}

/// The browser's filter and sort controls, as they arrive on the URL.
///
/// `filters` is a JSON document in a query parameter, so a malformed one is a
/// parse failure rather than a validation one, and the reference reports the
/// parser's own words. `sortDirection` is checked here and the column is
/// checked against the live catalog later — a direction is knowable without
/// asking the engine anything, and a column is not.
fn row_browse_query(
    params: &std::collections::HashMap<String, String>,
) -> Result<RowBrowseQuery, String> {
    let filters = match params.get("filters").filter(|raw| !raw.is_empty()) {
        Some(raw) => {
            let parsed = js_json::parse(raw)?;
            if !parsed.is_array() {
                return Err("filters must be a JSON array".to_string());
            }
            serde_json::from_value::<Vec<RowFilter>>(parsed).map_err(|error| error.to_string())?
        }
        None => Vec::new(),
    };
    let direction = params
        .get("sortDirection")
        .filter(|value| !value.is_empty());
    if let Some(direction) = direction {
        if direction != "asc" && direction != "desc" {
            return Err("sortDirection must be asc or desc".to_string());
        }
    }
    let sort = params
        .get("sortColumn")
        .filter(|column| !column.is_empty())
        .map(|column| RowSort {
            column: column.clone(),
            // A column with no direction sorts ascending, and so does one whose
            // direction is anything but `desc` -- which cannot happen, because
            // an unreadable direction was refused above.
            direction: if direction.map(String::as_str) == Some("desc") {
                "desc".to_string()
            } else {
                "asc".to_string()
            },
        });
    Ok(RowBrowseQuery { filters, sort })
}

/// `Number.isFinite(n) && n > 0 ? n : fallback`.
fn positive_or(value: Option<&str>, fallback: f64) -> i64 {
    let parsed = js_number(value);
    if parsed.is_finite() && parsed > 0.0 {
        parsed as i64
    } else {
        fallback as i64
    }
}

/// A query parameter the route cannot proceed without.
///
/// Absent and empty are the same thing, because the reference tests the value
/// for truth rather than for presence.
fn require_param(uri: &Uri, key: &str) -> Result<String, String> {
    parse_query(uri)
        .remove(key)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{key} query param is required"))
}

/// The `:name` segment, decoded once.
fn name_from(uri: &Uri) -> Option<String> {
    let path = uri.path().strip_prefix("/api/databases/")?;
    let segment = path.split('/').next()?;
    if segment.is_empty() {
        return None;
    }
    Some(percent_decode(segment))
}

/// `{ ok: true, ...result }`, with `ok` written first.
fn merge(mut head: Value, tail: Value) -> Value {
    if let (Some(head), Value::Object(tail)) = (head.as_object_mut(), tail) {
        for (key, value) in tail {
            head.insert(key, value);
        }
    }
    head
}

/// What an uncaught throw becomes in the reference's dispatcher.
fn throw(message: &str) -> Response {
    error(StatusCode::INTERNAL_SERVER_ERROR, message)
}
