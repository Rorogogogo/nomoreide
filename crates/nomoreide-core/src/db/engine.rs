//! Running one read-only statement against whichever engine a connection names.
//!
//! Every query in the read-safe half goes through [`run_query`]. Connections
//! are opened per statement rather than pooled: a peek is occasional, and a
//! pool would hold a socket open against someone's production database for as
//! long as the process lives.
//!
//! Moved out of the Tauri command module unchanged.

use super::types::QueryResult;
use serde_json::{json, Map, Value};

/// One statement to run, with whatever the caller wants bound into it.
///
/// The bind exists for the agent surface's row cap: a value that came from a
/// request belongs in a parameter rather than in the statement text, even when
/// it has already been validated as a small integer.
pub struct QueryPlan<'a> {
    pub sql: &'a str,
    pub bind: Option<i64>,
}

impl<'a> QueryPlan<'a> {
    pub fn peek(sql: &'a str, bind: Option<i64>) -> Self {
        Self { sql, bind }
    }
}

/// What the database itself said, without sqlx's framing around it.
///
/// A caller reading "no such table: books" can act on it; the same message
/// behind "error returned from database: (code: 1)" tells them nothing more and
/// leaks which driver happens to be underneath. Errors that never reached a
/// database — a bad URL, a refused socket — keep their own wording, because
/// there is no database message to prefer.
pub fn driver_message(error: sqlx::Error) -> String {
    match error {
        sqlx::Error::Database(failure) => failure.message().to_string(),
        other => other.to_string(),
    }
}

/// A float as JSON can carry it.
///
/// Negative zero is written as zero: no reader distinguishes `-0` from `0` once
/// it has been through a JSON text, so writing `-0.0` would only mean the two
/// runtimes disagreed about a value neither can actually deliver. Infinities
/// and NaN need no handling here — JSON has no spelling for them and `json!`
/// already writes them as null.
fn json_number(value: f64) -> Value {
    json!(if value == 0.0 { 0.0 } else { value })
}

/// One SQLite cell, read by what it actually holds rather than by what its
/// column was declared to hold.
///
/// SQLite columns are only loosely typed, and a `PRAGMA` has no declared types
/// at all — so a reader that trusts the declaration silently turns a catalog
/// listing into a column of nulls. Each storage class is tried in turn and the
/// first that decodes wins; `NULL` decodes as the first of them, which is why
/// it does not fall through to the end.
fn sqlite_cell(row: &sqlx::sqlite::SqliteRow, index: usize) -> Value {
    use sqlx::Row;
    if let Ok(value) = row.try_get::<Option<i64>, _>(index) {
        return value.map_or(Value::Null, |value| json!(value));
    }
    if let Ok(Some(value)) = row.try_get::<Option<f64>, _>(index) {
        return json_number(value);
    }
    if let Ok(Some(value)) = row.try_get::<Option<String>, _>(index) {
        return Value::String(value);
    }
    if let Ok(Some(value)) = row.try_get::<Option<Vec<u8>>, _>(index) {
        return bytes_value(&value);
    }
    Value::Null
}

/// The plan's statement with its bind applied, ready to run on any engine.
fn bound<'a, DB>(
    plan: &'a QueryPlan<'a>,
) -> sqlx::query::Query<'a, DB, <DB as sqlx::Database>::Arguments<'a>>
where
    DB: sqlx::Database,
    i64: sqlx::Encode<'a, DB> + sqlx::Type<DB>,
{
    let query = sqlx::query(plan.sql);
    match plan.bind {
        Some(value) => query.bind(value),
        None => query,
    }
}

pub async fn run_query(engine: &str, url: &str, sql: &str) -> Result<QueryResult, String> {
    run_plan(engine, url, QueryPlan { sql, bind: None }).await
}

pub async fn run_plan(engine: &str, url: &str, plan: QueryPlan<'_>) -> Result<QueryResult, String> {
    match engine {
        "postgres" => query_postgres(url, plan).await,
        "sqlite" => query_sqlite(url, plan).await,
        "mysql" => query_mysql(url, plan).await,
        _ => Err(format!("Unsupported engine: {engine}")),
    }
}

/// Bytes, spelled the way a typed array reaches JSON — an object keyed by
/// index.
///
/// It reads like an accident, and in the reference it is one: its SQLite driver
/// hands back a `Uint8Array`, which is neither a `Buffer` (so the hex branch
/// misses it) nor a scalar (so it survives to `JSON.stringify` as an object of
/// numeric keys). Both surfaces that read a row show it that way, so both are
/// given it here. A short human label instead would read better and would be a
/// different payload than every client has been written against.
fn bytes_value(bytes: &[u8]) -> Value {
    Value::Object(
        bytes
            .iter()
            .enumerate()
            .map(|(index, byte)| (index.to_string(), json!(byte)))
            .collect::<Map<String, Value>>(),
    )
}

pub fn hex_bytes(bytes: &[u8]) -> String {
    let mut encoded = String::from("\\x");
    for byte in bytes {
        encoded.push_str(&format!("{byte:02x}"));
    }
    encoded
}

pub fn lossless_json_integer(value: i64) -> Value {
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    if (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&value) {
        json!(value)
    } else {
        Value::String(value.to_string())
    }
}

pub async fn list_db_tables(engine: &str, url: &str) -> Result<Vec<String>, String> {
    let sql = match engine {
        "postgres" => {
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
        }
        "mysql" => "SHOW TABLES",
        "sqlite" => "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        _ => return Err(format!("Unsupported engine: {engine}")),
    };
    let result = run_query(engine, url, sql).await?;
    Ok(result
        .rows
        .into_iter()
        .filter_map(|row| {
            row.into_iter().next().and_then(|v| match v {
                Value::String(s) => Some(s),
                _ => None,
            })
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

async fn query_postgres(url: &str, plan: QueryPlan<'_>) -> Result<QueryResult, String> {
    use sqlx::postgres::PgPool;
    use sqlx::{Column, Row, TypeInfo};

    let pool = PgPool::connect(url).await.map_err(driver_message)?;
    let mut transaction = pool.begin().await.map_err(driver_message)?;
    sqlx::query("SET TRANSACTION READ ONLY")
        .execute(&mut *transaction)
        .await
        .map_err(driver_message)?;
    let rows = bound(&plan)
        .fetch_all(&mut *transaction)
        .await
        .map_err(driver_message)?;
    transaction.rollback().await.map_err(driver_message)?;

    if rows.is_empty() {
        return Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            row_count: 0,
        });
    }

    let columns: Vec<String> = rows[0]
        .columns()
        .iter()
        .map(|c| c.name().to_string())
        .collect();
    let result_rows: Vec<Vec<Value>> = rows
        .iter()
        .map(|row| {
            (0..columns.len())
                .map(|i| {
                    let type_name = row.column(i).type_info().name().to_uppercase();
                    match type_name.as_str() {
                        "BOOL" => row
                            .try_get::<Option<bool>, _>(i)
                            .ok()
                            .flatten()
                            .map(Value::Bool)
                            .unwrap_or(Value::Null),
                        "INT2" | "SMALLINT" | "SMALLSERIAL" => row
                            .try_get::<Option<i16>, _>(i)
                            .ok()
                            .flatten()
                            .map(|v| json!(v))
                            .unwrap_or(Value::Null),
                        "INT4" | "INT" | "INTEGER" | "SERIAL" => row
                            .try_get::<Option<i32>, _>(i)
                            .ok()
                            .flatten()
                            .map(|v| json!(v))
                            .unwrap_or(Value::Null),
                        "INT8" | "BIGINT" | "BIGSERIAL" => row
                            .try_get::<Option<i64>, _>(i)
                            .ok()
                            .flatten()
                            .map(|v| json!(v))
                            .unwrap_or(Value::Null),
                        "FLOAT4" | "REAL" => row
                            .try_get::<Option<f32>, _>(i)
                            .ok()
                            .flatten()
                            .map(|v| json_number(f64::from(v)))
                            .unwrap_or(Value::Null),
                        "FLOAT8" | "DOUBLE PRECISION" => row
                            .try_get::<Option<f64>, _>(i)
                            .ok()
                            .flatten()
                            .map(json_number)
                            .unwrap_or(Value::Null),
                        "JSONB" | "JSON" => row
                            .try_get::<Option<Value>, _>(i)
                            .ok()
                            .flatten()
                            .unwrap_or(Value::Null),
                        _ => row
                            .try_get::<Option<String>, _>(i)
                            .ok()
                            .flatten()
                            .map(Value::String)
                            .unwrap_or(Value::Null),
                    }
                })
                .collect()
        })
        .collect();

    let count = result_rows.len();
    Ok(QueryResult {
        columns,
        rows: result_rows,
        row_count: count,
    })
}

async fn query_sqlite(url: &str, plan: QueryPlan<'_>) -> Result<QueryResult, String> {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::{Column, Row};
    use std::str::FromStr;

    let options = if url.starts_with("sqlite:") {
        SqliteConnectOptions::from_str(url).map_err(driver_message)?
    } else {
        SqliteConnectOptions::new().filename(url)
    }
    .read_only(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(driver_message)?;
    let rows = bound(&plan)
        .fetch_all(&pool)
        .await
        .map_err(driver_message)?;

    if rows.is_empty() {
        return Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            row_count: 0,
        });
    }

    let columns: Vec<String> = rows[0]
        .columns()
        .iter()
        .map(|c| c.name().to_string())
        .collect();
    let result_rows: Vec<Vec<Value>> = rows
        .iter()
        .map(|row| (0..columns.len()).map(|i| sqlite_cell(row, i)).collect())
        .collect();

    let count = result_rows.len();
    Ok(QueryResult {
        columns,
        rows: result_rows,
        row_count: count,
    })
}

async fn query_mysql(url: &str, plan: QueryPlan<'_>) -> Result<QueryResult, String> {
    use sqlx::mysql::MySqlPool;
    use sqlx::{Column, Row, TypeInfo};

    let pool = MySqlPool::connect(url).await.map_err(driver_message)?;
    let mut connection = pool.acquire().await.map_err(driver_message)?;
    sqlx::query("START TRANSACTION READ ONLY")
        .execute(&mut *connection)
        .await
        .map_err(driver_message)?;
    let rows = bound(&plan)
        .fetch_all(&mut *connection)
        .await
        .map_err(driver_message)?;
    sqlx::query("ROLLBACK")
        .execute(&mut *connection)
        .await
        .map_err(driver_message)?;

    if rows.is_empty() {
        return Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            row_count: 0,
        });
    }

    let columns: Vec<String> = rows[0]
        .columns()
        .iter()
        .map(|c| c.name().to_string())
        .collect();
    let result_rows: Vec<Vec<Value>> = rows
        .iter()
        .map(|row| {
            (0..columns.len())
                .map(|i| {
                    let type_name = row.column(i).type_info().name().to_uppercase();
                    match type_name.as_str() {
                        "BOOLEAN" | "TINYINT(1)" => row
                            .try_get::<Option<bool>, _>(i)
                            .ok()
                            .flatten()
                            .map(Value::Bool)
                            .unwrap_or(Value::Null),
                        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" => row
                            .try_get::<Option<i64>, _>(i)
                            .ok()
                            .flatten()
                            .map(|v| json!(v))
                            .unwrap_or(Value::Null),
                        "FLOAT" => row
                            .try_get::<Option<f32>, _>(i)
                            .ok()
                            .flatten()
                            .map(|v| json!(v))
                            .unwrap_or(Value::Null),
                        "DOUBLE" => row
                            .try_get::<Option<f64>, _>(i)
                            .ok()
                            .flatten()
                            .map(|v| json!(v))
                            .unwrap_or(Value::Null),
                        "JSON" => row
                            .try_get::<Option<Value>, _>(i)
                            .ok()
                            .flatten()
                            .unwrap_or(Value::Null),
                        "BLOB" | "MEDIUMBLOB" | "LONGBLOB" | "TINYBLOB" => row
                            .try_get::<Option<Vec<u8>>, _>(i)
                            .ok()
                            .flatten()
                            .map(|v| bytes_value(&v))
                            .unwrap_or(Value::Null),
                        _ => row
                            .try_get::<Option<String>, _>(i)
                            .ok()
                            .flatten()
                            .map(Value::String)
                            .unwrap_or(Value::Null),
                    }
                })
                .collect()
        })
        .collect();

    let count = result_rows.len();
    Ok(QueryResult {
        columns,
        rows: result_rows,
        row_count: count,
    })
}
