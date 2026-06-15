use tauri::State;
use serde::{Deserialize, Serialize};
use serde_json::Value;
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
        .map(|d| serde_json::json!({
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
        .filter_map(|row| row.into_iter().next().and_then(|v| v.as_str().map(str::to_string)))
        .collect())
}

async fn query_postgres(url: &str, sql: &str) -> Result<QueryResult, String> {
    use sqlx::postgres::PgPool;
    use sqlx::Row;
    let pool = PgPool::connect(url).await.map_err(|e| e.to_string())?;
    let rows = sqlx::query(sql).fetch_all(&pool).await.map_err(|e| e.to_string())?;
    if rows.is_empty() {
        return Ok(QueryResult { columns: vec![], rows: vec![], row_count: 0 });
    }
    let columns: Vec<String> = rows[0].columns().iter().map(|c| c.name().to_string()).collect();
    let result_rows: Vec<Vec<Value>> = rows.iter().map(|row| {
        columns.iter().enumerate().map(|(i, _)| {
            row.try_get::<Value, _>(i).unwrap_or(Value::Null)
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

async fn query_sqlite(url: &str, sql: &str) -> Result<QueryResult, String> {
    use sqlx::sqlite::SqlitePool;
    use sqlx::Row;
    let pool = SqlitePool::connect(url).await.map_err(|e| e.to_string())?;
    let rows = sqlx::query(sql).fetch_all(&pool).await.map_err(|e| e.to_string())?;
    if rows.is_empty() {
        return Ok(QueryResult { columns: vec![], rows: vec![], row_count: 0 });
    }
    let columns: Vec<String> = rows[0].columns().iter().map(|c| c.name().to_string()).collect();
    let result_rows: Vec<Vec<Value>> = rows.iter().map(|row| {
        columns.iter().enumerate().map(|(i, _)| {
            row.try_get::<Value, _>(i).unwrap_or(Value::Null)
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

async fn query_mysql(url: &str, sql: &str) -> Result<QueryResult, String> {
    use sqlx::mysql::MySqlPool;
    use sqlx::Row;
    let pool = MySqlPool::connect(url).await.map_err(|e| e.to_string())?;
    let rows = sqlx::query(sql).fetch_all(&pool).await.map_err(|e| e.to_string())?;
    if rows.is_empty() {
        return Ok(QueryResult { columns: vec![], rows: vec![], row_count: 0 });
    }
    let columns: Vec<String> = rows[0].columns().iter().map(|c| c.name().to_string()).collect();
    let result_rows: Vec<Vec<Value>> = rows.iter().map(|row| {
        columns.iter().enumerate().map(|(i, _)| {
            row.try_get::<Value, _>(i).unwrap_or(Value::Null)
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
