//! Running one read-only statement against whichever engine a connection names.
//!
//! Every query in the read-safe half goes through [`run_query`]. Connections
//! are opened per statement rather than pooled: a peek is occasional, and a
//! pool would hold a socket open against someone's production database for as
//! long as the process lives.
//!
//! Moved out of the Tauri command module unchanged.

use super::types::QueryResult;
use serde_json::{json, Value};
pub async fn run_query(engine: &str, url: &str, sql: &str) -> Result<QueryResult, String> {
    match engine {
        "postgres" => query_postgres(url, sql).await,
        "sqlite" => query_sqlite(url, sql).await,
        "mysql" => query_mysql(url, sql).await,
        _ => Err(format!("Unsupported engine: {engine}")),
    }
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

async fn query_postgres(url: &str, sql: &str) -> Result<QueryResult, String> {
    use sqlx::postgres::PgPool;
    use sqlx::{Column, Row, TypeInfo};

    let pool = PgPool::connect(url).await.map_err(|e| e.to_string())?;
    let mut transaction = pool.begin().await.map_err(|e| e.to_string())?;
    sqlx::query("SET TRANSACTION READ ONLY")
        .execute(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?;
    let rows = sqlx::query(sql)
        .fetch_all(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?;
    transaction.rollback().await.map_err(|e| e.to_string())?;

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
                            .map(|v| json!(v))
                            .unwrap_or(Value::Null),
                        "FLOAT8" | "DOUBLE PRECISION" => row
                            .try_get::<Option<f64>, _>(i)
                            .ok()
                            .flatten()
                            .map(|v| json!(v))
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

async fn query_sqlite(url: &str, sql: &str) -> Result<QueryResult, String> {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::{Column, Row, TypeInfo};
    use std::str::FromStr;

    let options = if url.starts_with("sqlite:") {
        SqliteConnectOptions::from_str(url).map_err(|e| e.to_string())?
    } else {
        SqliteConnectOptions::new().filename(url)
    }
    .read_only(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|e| e.to_string())?;
    let rows = sqlx::query(sql)
        .fetch_all(&pool)
        .await
        .map_err(|e| e.to_string())?;

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
                        "INTEGER" | "INT" | "INT64" => row
                            .try_get::<Option<i64>, _>(i)
                            .ok()
                            .flatten()
                            .map(|v| json!(v))
                            .unwrap_or(Value::Null),
                        "REAL" => row
                            .try_get::<Option<f64>, _>(i)
                            .ok()
                            .flatten()
                            .map(|v| json!(v))
                            .unwrap_or(Value::Null),
                        "BLOB" => row
                            .try_get::<Option<Vec<u8>>, _>(i)
                            .ok()
                            .flatten()
                            .map(|v| Value::String(format!("<blob {} bytes>", v.len())))
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

async fn query_mysql(url: &str, sql: &str) -> Result<QueryResult, String> {
    use sqlx::mysql::MySqlPool;
    use sqlx::{Column, Row, TypeInfo};

    let pool = MySqlPool::connect(url).await.map_err(|e| e.to_string())?;
    let mut connection = pool.acquire().await.map_err(|e| e.to_string())?;
    sqlx::query("START TRANSACTION READ ONLY")
        .execute(&mut *connection)
        .await
        .map_err(|e| e.to_string())?;
    let rows = sqlx::query(sql)
        .fetch_all(&mut *connection)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("ROLLBACK")
        .execute(&mut *connection)
        .await
        .map_err(|e| e.to_string())?;

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
                            .map(|v| Value::String(format!("<blob {} bytes>", v.len())))
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
