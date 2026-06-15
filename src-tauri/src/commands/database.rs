use tauri::State;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub row_count: usize,
}

#[tauri::command]
pub async fn list_databases(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    Ok(config.databases.iter()
        .map(|d| json!({
            "name": d.name,
            "engine": d.engine,
            "writeUnlocked": d.write_unlocked.unwrap_or(false),
        }))
        .collect())
}

#[tauri::command]
pub async fn query_database(
    state: State<'_, AppState>,
    name: String,
    sql: String,
    limit: Option<i64>,
) -> Result<QueryResult, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let db = config.databases.iter()
        .find(|d| d.name == name)
        .ok_or_else(|| format!("Database '{name}' not found"))?;

    let limited_sql = if let Some(lim) = limit {
        format!("SELECT * FROM ({sql}) _q LIMIT {lim}")
    } else {
        sql
    };

    run_query(&db.engine, &db.url, &limited_sql).await
}

#[tauri::command]
pub async fn execute_database(
    state: State<'_, AppState>,
    name: String,
    sql: String,
) -> Result<u64, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let db = config.databases.iter()
        .find(|d| d.name == name)
        .ok_or_else(|| format!("Database '{name}' not found"))?;

    if !db.write_unlocked.unwrap_or(false) {
        return Err("Write access is locked for this database".to_string());
    }

    run_execute(&db.engine, &db.url, &sql).await
}

#[tauri::command]
pub async fn list_tables(
    state: State<'_, AppState>,
    name: String,
) -> Result<Vec<String>, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let db = config.databases.iter()
        .find(|d| d.name == name)
        .ok_or_else(|| format!("Database '{name}' not found"))?;

    list_db_tables(&db.engine, &db.url).await
}

async fn run_query(engine: &str, url: &str, sql: &str) -> Result<QueryResult, String> {
    match engine {
        "postgres" => query_postgres(url, sql).await,
        "sqlite" => query_sqlite(url, sql).await,
        "mysql" => query_mysql(url, sql).await,
        _ => Err(format!("Unsupported engine: {engine}")),
    }
}

async fn run_execute(engine: &str, url: &str, sql: &str) -> Result<u64, String> {
    match engine {
        "postgres" => execute_postgres(url, sql).await,
        "sqlite" => execute_sqlite(url, sql).await,
        "mysql" => execute_mysql(url, sql).await,
        _ => Err(format!("Unsupported engine: {engine}")),
    }
}

async fn list_db_tables(engine: &str, url: &str) -> Result<Vec<String>, String> {
    let sql = match engine {
        "postgres" => "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
        "mysql" => "SHOW TABLES",
        "sqlite" => "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        _ => return Err(format!("Unsupported engine: {engine}")),
    };
    let result = run_query(engine, url, sql).await?;
    Ok(result.rows.into_iter()
        .filter_map(|row| row.into_iter().next().and_then(|v| match v {
            Value::String(s) => Some(s),
            _ => None,
        }))
        .collect())
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

async fn query_postgres(url: &str, sql: &str) -> Result<QueryResult, String> {
    use sqlx::postgres::PgPool;
    use sqlx::{Column, Row, TypeInfo};

    let pool = PgPool::connect(url).await.map_err(|e| e.to_string())?;
    let rows = sqlx::query(sql).fetch_all(&pool).await.map_err(|e| e.to_string())?;

    if rows.is_empty() {
        return Ok(QueryResult { columns: vec![], rows: vec![], row_count: 0 });
    }

    let columns: Vec<String> = rows[0].columns().iter().map(|c| c.name().to_string()).collect();
    let result_rows: Vec<Vec<Value>> = rows.iter().map(|row| {
        (0..columns.len()).map(|i| {
            let type_name = row.column(i).type_info().name().to_uppercase();
            match type_name.as_str() {
                "BOOL" => row.try_get::<Option<bool>, _>(i)
                    .ok().flatten().map(Value::Bool).unwrap_or(Value::Null),
                "INT2" | "SMALLINT" | "SMALLSERIAL" => row.try_get::<Option<i16>, _>(i)
                    .ok().flatten().map(|v| json!(v)).unwrap_or(Value::Null),
                "INT4" | "INT" | "INTEGER" | "SERIAL" => row.try_get::<Option<i32>, _>(i)
                    .ok().flatten().map(|v| json!(v)).unwrap_or(Value::Null),
                "INT8" | "BIGINT" | "BIGSERIAL" => row.try_get::<Option<i64>, _>(i)
                    .ok().flatten().map(|v| json!(v)).unwrap_or(Value::Null),
                "FLOAT4" | "REAL" => row.try_get::<Option<f32>, _>(i)
                    .ok().flatten().map(|v| json!(v)).unwrap_or(Value::Null),
                "FLOAT8" | "DOUBLE PRECISION" => row.try_get::<Option<f64>, _>(i)
                    .ok().flatten().map(|v| json!(v)).unwrap_or(Value::Null),
                "JSONB" | "JSON" => row.try_get::<Option<Value>, _>(i)
                    .ok().flatten().unwrap_or(Value::Null),
                _ => row.try_get::<Option<String>, _>(i)
                    .ok().flatten().map(Value::String).unwrap_or(Value::Null),
            }
        }).collect()
    }).collect();

    let count = result_rows.len();
    Ok(QueryResult { columns, rows: result_rows, row_count: count })
}

async fn execute_postgres(url: &str, sql: &str) -> Result<u64, String> {
    use sqlx::postgres::PgPool;
    let pool = PgPool::connect(url).await.map_err(|e| e.to_string())?;
    let result = sqlx::query(sql).execute(&pool).await.map_err(|e| e.to_string())?;
    Ok(result.rows_affected())
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

async fn query_sqlite(url: &str, sql: &str) -> Result<QueryResult, String> {
    use sqlx::sqlite::SqlitePool;
    use sqlx::{Column, Row, TypeInfo};

    let pool = SqlitePool::connect(url).await.map_err(|e| e.to_string())?;
    let rows = sqlx::query(sql).fetch_all(&pool).await.map_err(|e| e.to_string())?;

    if rows.is_empty() {
        return Ok(QueryResult { columns: vec![], rows: vec![], row_count: 0 });
    }

    let columns: Vec<String> = rows[0].columns().iter().map(|c| c.name().to_string()).collect();
    let result_rows: Vec<Vec<Value>> = rows.iter().map(|row| {
        (0..columns.len()).map(|i| {
            let type_name = row.column(i).type_info().name().to_uppercase();
            match type_name.as_str() {
                "INTEGER" | "INT" => row.try_get::<Option<i64>, _>(i)
                    .ok().flatten().map(|v| json!(v)).unwrap_or(Value::Null),
                "REAL" => row.try_get::<Option<f64>, _>(i)
                    .ok().flatten().map(|v| json!(v)).unwrap_or(Value::Null),
                "BLOB" => row.try_get::<Option<Vec<u8>>, _>(i)
                    .ok().flatten()
                    .map(|v| Value::String(format!("<blob {} bytes>", v.len())))
                    .unwrap_or(Value::Null),
                _ => row.try_get::<Option<String>, _>(i)
                    .ok().flatten().map(Value::String).unwrap_or(Value::Null),
            }
        }).collect()
    }).collect();

    let count = result_rows.len();
    Ok(QueryResult { columns, rows: result_rows, row_count: count })
}

async fn execute_sqlite(url: &str, sql: &str) -> Result<u64, String> {
    use sqlx::sqlite::SqlitePool;
    let pool = SqlitePool::connect(url).await.map_err(|e| e.to_string())?;
    let result = sqlx::query(sql).execute(&pool).await.map_err(|e| e.to_string())?;
    Ok(result.rows_affected())
}

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

async fn query_mysql(url: &str, sql: &str) -> Result<QueryResult, String> {
    use sqlx::mysql::MySqlPool;
    use sqlx::{Column, Row, TypeInfo};

    let pool = MySqlPool::connect(url).await.map_err(|e| e.to_string())?;
    let rows = sqlx::query(sql).fetch_all(&pool).await.map_err(|e| e.to_string())?;

    if rows.is_empty() {
        return Ok(QueryResult { columns: vec![], rows: vec![], row_count: 0 });
    }

    let columns: Vec<String> = rows[0].columns().iter().map(|c| c.name().to_string()).collect();
    let result_rows: Vec<Vec<Value>> = rows.iter().map(|row| {
        (0..columns.len()).map(|i| {
            let type_name = row.column(i).type_info().name().to_uppercase();
            match type_name.as_str() {
                "BOOLEAN" | "TINYINT(1)" => row.try_get::<Option<bool>, _>(i)
                    .ok().flatten().map(Value::Bool).unwrap_or(Value::Null),
                "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" => {
                    row.try_get::<Option<i64>, _>(i)
                        .ok().flatten().map(|v| json!(v)).unwrap_or(Value::Null)
                }
                "FLOAT" => row.try_get::<Option<f32>, _>(i)
                    .ok().flatten().map(|v| json!(v)).unwrap_or(Value::Null),
                "DOUBLE" => row.try_get::<Option<f64>, _>(i)
                    .ok().flatten().map(|v| json!(v)).unwrap_or(Value::Null),
                "JSON" => row.try_get::<Option<Value>, _>(i)
                    .ok().flatten().unwrap_or(Value::Null),
                "BLOB" | "MEDIUMBLOB" | "LONGBLOB" | "TINYBLOB" => {
                    row.try_get::<Option<Vec<u8>>, _>(i)
                        .ok().flatten()
                        .map(|v| Value::String(format!("<blob {} bytes>", v.len())))
                        .unwrap_or(Value::Null)
                }
                _ => row.try_get::<Option<String>, _>(i)
                    .ok().flatten().map(Value::String).unwrap_or(Value::Null),
            }
        }).collect()
    }).collect();

    let count = result_rows.len();
    Ok(QueryResult { columns, rows: result_rows, row_count: count })
}

async fn execute_mysql(url: &str, sql: &str) -> Result<u64, String> {
    use sqlx::mysql::MySqlPool;
    let pool = MySqlPool::connect(url).await.map_err(|e| e.to_string())?;
    let result = sqlx::query(sql).execute(&pool).await.map_err(|e| e.to_string())?;
    Ok(result.rows_affected())
}
