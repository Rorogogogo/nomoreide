//! The database domain's two write routes: run a statement, and delete rows by
//! primary key.
//!
//! Everything else under `/api/databases` reads. These two are the reason the
//! connection carries a `writeUnlocked` flag at all, and the flag is the whole
//! point: it is set by a person through the dashboard and is reachable from no
//! agent surface, so a route that honours it cannot be talked into a write.
//!
//! Both routes answer a refusal with **400**, including refusals that read like
//! server errors, because everything they refuse is something the person typing
//! did. The one exception is `execute`'s missing `sql`, which the reference
//! checks outside its own try/catch and so reports as a 500.
//!
//! The order the two routes check things in is not the same, and both orders
//! are the reference's:
//!
//! * `execute` checks the **lock first**, before it looks at the statement at
//!   all -- so a locked connection refuses a `SELECT` and refuses malformed SQL
//!   with the same sentence, saying nothing about what was sent.
//! * `catalog/rows/delete` parses its **form first**, so a malformed `tuples`
//!   is reported even on a locked connection. The tuples never reach the
//!   database either way.
//!
//! A delete is confirmed twice over. `expectedAffectedRows` is the count a
//! person read off a preview: before anything runs it has to match the number
//! of tuples being sent, and after the delete runs it has to match the number
//! of rows that actually went, or the transaction rolls back. A commit with no
//! confirmed count at all is refused outright.

use crate::server::app::AppState;
use crate::server::body::{parse_form, percent_decode};
use crate::server::errors::{config_failure, error};
use crate::server::query::js_number;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use nomoreide_actions::db::{
    delete_rows_bound, delete_sql, ensure_confirmed_count, run_execute, validate_delete_keys,
};
use nomoreide_core::config::DatabaseDef;
use nomoreide_core::db;
use nomoreide_core::js_json;
use serde_json::{json, Map, Value};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/databases/:name/execute",
            post(execute).fallback(crate::server::errors::method_not_allowed),
        )
        .route(
            "/api/databases/:name/catalog/rows/delete",
            post(delete_rows).fallback(crate::server::errors::method_not_allowed),
        )
}

async fn execute(State(state): State<AppState>, uri: Uri, body: Bytes) -> Response {
    let form = parse_form(&body);
    // Outside the reference's try/catch, and so a 500 where everything below is
    // a 400.
    let sql = match form
        .get("sql")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        Some(sql) => sql.to_string(),
        None => return error(StatusCode::INTERNAL_SERVER_ERROR, "sql is required"),
    };
    // Only the first statement runs, as the reference's `prepare` does. A
    // second statement is dropped rather than executed.
    let sql = db::first_statement(&sql).trim().to_string();
    let commit = form.get("mode").map(String::as_str) == Some("commit");

    let database = match unlocked_connection(&state, &uri).await {
        Ok(database) => database,
        Err(response) => return response,
    };

    // A read is run as a read and reports the rows it found; anything else is
    // run as a write and reports the rows it changed.
    let outcome = if db::is_read_statement(&sql) {
        db::run_query(&database.engine, &database.url, &sql)
            .await
            .map(|result| {
                let rows = objectify(&result.columns, result.rows);
                json!({
                    "affectedRows": rows.len(),
                    "rows": rows,
                    // A statement names its own columns, so nothing here knows
                    // their declared types.
                    "columns": result
                        .columns
                        .iter()
                        .map(|name| json!({
                            "name": name,
                            "dataType": "",
                            "nullable": true,
                            "primaryKey": false,
                        }))
                        .collect::<Vec<_>>(),
                })
            })
    } else {
        run_execute(&database.engine, &database.url, &sql, commit)
            .await
            .map(|affected| json!({ "affectedRows": affected, "rows": [], "columns": [] }))
    };

    match outcome {
        Ok(result) => Json(merge(
            json!({
                "ok": true,
                "engine": database.engine,
                "previewUnavailable": false,
            }),
            result,
            json!({ "committed": commit }),
        ))
        .into_response(),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason),
    }
}

async fn delete_rows(State(state): State<AppState>, uri: Uri, body: Bytes) -> Response {
    let form = parse_form(&body);
    let key = match required(&form, "key") {
        Ok(key) => key,
        Err(reason) => return error(StatusCode::BAD_REQUEST, &reason),
    };
    let mode = match required(&form, "mode") {
        Ok(mode) => mode,
        Err(reason) => return error(StatusCode::BAD_REQUEST, &reason),
    };
    if mode != "preview" && mode != "commit" {
        return error(
            StatusCode::BAD_REQUEST,
            "mode must be either \"preview\" or \"commit\"",
        );
    }
    let commit = mode == "commit";
    let raw_tuples = match required(&form, "tuples") {
        Ok(tuples) => tuples,
        Err(reason) => return error(StatusCode::BAD_REQUEST, &reason),
    };
    // The parser's own words are never shown here -- a malformed `tuples` is
    // the client's bug, not the person's, so one sentence covers every shape.
    let Ok(parsed) = js_json::parse(&raw_tuples) else {
        return error(StatusCode::BAD_REQUEST, "tuples must be a valid JSON array");
    };
    // Anything that is not an array holds no tuples, which is the refusal an
    // empty array gets.
    let keys: Vec<Map<String, Value>> = match parsed {
        Value::Array(entries) => {
            let mut out = Vec::with_capacity(entries.len());
            for entry in entries {
                match entry {
                    Value::Object(map) => out.push(map),
                    _ => {
                        return error(StatusCode::BAD_REQUEST, "tuples must be a valid JSON array")
                    }
                }
            }
            out
        }
        _ => Vec::new(),
    };
    let expected = form
        .get("expectedAffectedRows")
        .filter(|value| !value.is_empty())
        .map(|value| js_number(Some(value.as_str())) as u64);

    let database = match unlocked_connection(&state, &uri).await {
        Ok(database) => database,
        Err(response) => return response,
    };

    match delete(&database, &key, keys, commit, expected).await {
        Ok(result) => Json(merge(
            json!({
                "ok": true,
                "engine": database.engine,
                "previewUnavailable": false,
            }),
            result,
            json!({ "rows": [], "columns": [], "committed": commit }),
        ))
        .into_response(),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason),
    }
}

/// Resolve the object, check it can be deleted from, and run the delete.
async fn delete(
    database: &DatabaseDef,
    key: &str,
    keys: Vec<Map<String, Value>>,
    commit: bool,
    expected: Option<u64>,
) -> Result<Value, String> {
    let object = db::resolve_object(database, key).await?;
    // A view has rows on screen and no rows of its own. Refusing by kind rather
    // than letting the engine refuse keeps the message about the catalog.
    if object.kind != "table" {
        return Err("Only live catalog tables support row deletion.".to_string());
    }
    let columns = db::columns_for(database, &object).await?;
    let primary_keys = columns
        .iter()
        .filter(|column| column.primary_key)
        .collect::<Vec<_>>();
    validate_delete_keys(&keys, &primary_keys, &object)?;
    ensure_confirmed_count(keys.len(), expected, commit)?;

    let sql = delete_sql(&database.engine, &object, &primary_keys);
    let affected = delete_rows_bound(
        &database.engine,
        &database.url,
        &sql,
        &keys,
        &primary_keys,
        commit,
        expected,
    )
    .await?;
    Ok(json!({
        "primaryKeys": primary_keys
            .iter()
            .map(|column| column.name.clone())
            .collect::<Vec<_>>(),
        "affectedRows": affected,
    }))
}

/// The connection named in the URI, refused unless a person has unlocked it.
async fn unlocked_connection(state: &AppState, uri: &Uri) -> Result<DatabaseDef, Response> {
    let Some(name) = name_from(uri) else {
        return Err(error(StatusCode::NOT_FOUND, "Not found"));
    };
    let config = match state.config_store.load().await {
        Ok(config) => config,
        Err(reason) => return Err(config_failure(&reason)),
    };
    let database = db::peek_connection(&config.databases, &name)
        .cloned()
        .map_err(|reason| error(StatusCode::BAD_REQUEST, &reason))?;
    if database.write_unlocked != Some(true) {
        return Err(error(
            StatusCode::BAD_REQUEST,
            &format!("Write access is locked for \"{name}\". Unlock it before running writes."),
        ));
    }
    Ok(database)
}

fn objectify(columns: &[String], rows: Vec<Vec<Value>>) -> Vec<Map<String, Value>> {
    rows.into_iter()
        .map(|row| columns.iter().cloned().zip(row).collect())
        .collect()
}

fn required(form: &std::collections::HashMap<String, String>, key: &str) -> Result<String, String> {
    form.get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{key} is required"))
}

fn name_from(uri: &Uri) -> Option<String> {
    let segment = uri
        .path()
        .strip_prefix("/api/databases/")?
        .split('/')
        .next()?;
    if segment.is_empty() {
        return None;
    }
    Some(percent_decode(segment))
}

/// `{ ...head, ...body, ...tail }`, so the response reads in the reference's
/// order rather than in whichever order the pieces were computed.
fn merge(mut head: Value, body: Value, tail: Value) -> Value {
    if let Some(target) = head.as_object_mut() {
        for part in [body, tail] {
            if let Value::Object(part) = part {
                for (key, value) in part {
                    target.insert(key, value);
                }
            }
        }
    }
    head
}
