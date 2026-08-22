//! The write-capable half of the database layer.
//!
//! This is to `db` what [`crate::git`] is to `git_manager`: the operations that
//! change someone's data, kept out of the read-safe module so that widening the
//! agent surface cannot reach them by accident. No MCP tool calls anything in
//! here — the dashboard's SQL console does, after a human has unlocked writes
//! on that specific connection and reviewed an affected-rows preview.
//!
//! Two habits are worth keeping when editing this file. A delete is bounded:
//! it is built from primary keys, capped at [`MAX_DELETE_ROWS`], and refuses
//! when the rows it would touch are not the number the caller expected. And a
//! statement runs inside a transaction that is only committed when the caller
//! asked to commit, so the preview path can count rows and roll back.
//!
//! Moved out of the Tauri command module unchanged.

use nomoreide_core::db::{quote_identifier, CatalogObject, ColumnInfo};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOutcome {
    pub engine: String,
    pub preview_unavailable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affected_rows: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub committed: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteDatabaseRowsInput {
    pub object_key: String,
    pub keys: Vec<serde_json::Map<String, Value>>,
    pub mode: String,
    pub expected_affected_rows: Option<u64>,
}

const MAX_DELETE_ROWS: usize = 500;

pub fn validate_delete_keys(
    keys: &[serde_json::Map<String, Value>],
    primary_keys: &[&ColumnInfo],
) -> Result<(), String> {
    if keys.is_empty() || keys.len() > MAX_DELETE_ROWS {
        return Err(format!(
            "Delete requires between 1 and {MAX_DELETE_ROWS} rows"
        ));
    }
    if primary_keys.is_empty() {
        return Err("Rows can only be deleted from a table with a primary key".to_string());
    }

    let expected_names = primary_keys
        .iter()
        .map(|column| column.name.as_str())
        .collect::<HashSet<_>>();
    let mut tuples = HashSet::new();
    for key in keys {
        if key.len() != primary_keys.len()
            || key
                .keys()
                .any(|name| !expected_names.contains(name.as_str()))
        {
            return Err("Each row key must contain exactly the live primary-key columns".into());
        }
        let mut canonical = Vec::with_capacity(primary_keys.len());
        for column in primary_keys {
            let value = key.get(&column.name).ok_or_else(|| {
                "Each row key must contain exactly the live primary-key columns".to_string()
            })?;
            match value {
                Value::String(value) if value != "••••" => canonical.push(json!(["s", value])),
                Value::Bool(value) => canonical.push(json!(["b", value])),
                Value::Number(value) if value.as_i64().is_some() => {
                    canonical.push(json!(["i", value]))
                }
                Value::Number(value) if value.as_f64().is_some() => {
                    canonical.push(json!(["f", value]))
                }
                _ => {
                    return Err(
                        "Primary-key values must be non-null, unmasked scalar values within supported numeric bounds"
                            .into(),
                    )
                }
            }
        }
        let tuple = serde_json::to_string(&canonical).map_err(|error| error.to_string())?;
        if !tuples.insert(tuple) {
            return Err("Duplicate primary-key tuple".into());
        }
    }
    Ok(())
}

pub fn delete_sql(engine: &str, object: &CatalogObject, primary_keys: &[&ColumnInfo]) -> String {
    let table = if engine == "sqlite" {
        quote_identifier(&object.name, engine)
    } else {
        format!(
            "{}.{}",
            quote_identifier(&object.schema, engine),
            quote_identifier(&object.name, engine)
        )
    };
    let predicates = primary_keys
        .iter()
        .enumerate()
        .map(|(index, column)| {
            let placeholder = if engine == "postgres" {
                format!("${}", index + 1)
            } else {
                "?".to_string()
            };
            let identifier = quote_identifier(&column.name, engine);
            match engine {
                "postgres" => format!("{identifier}::text = {placeholder}"),
                "mysql" => format!("CAST({identifier} AS CHAR) = {placeholder}"),
                _ => format!("CAST({identifier} AS TEXT) = {placeholder}"),
            }
        })
        .collect::<Vec<_>>()
        .join(" AND ");
    format!("DELETE FROM {table} WHERE {predicates}")
}

pub async fn run_execute(engine: &str, url: &str, sql: &str, commit: bool) -> Result<u64, String> {
    match engine {
        "postgres" => execute_postgres(url, sql, commit).await,
        "sqlite" => execute_sqlite(url, sql, commit).await,
        "mysql" => execute_mysql(url, sql, commit).await,
        _ => Err(format!("Unsupported engine: {engine}")),
    }
}

pub fn key_value_as_text(value: &Value, engine: &str) -> Result<String, String> {
    match value {
        Value::String(value) => Ok(value.clone()),
        Value::Bool(value) if engine == "postgres" => Ok(value.to_string()),
        Value::Bool(value) => Ok(if *value { "1" } else { "0" }.to_string()),
        Value::Number(value) => Ok(value.to_string()),
        _ => Err("Unsupported primary-key value".to_string()),
    }
}

pub async fn delete_rows_bound(
    engine: &str,
    url: &str,
    sql: &str,
    keys: &[serde_json::Map<String, Value>],
    primary_keys: &[&ColumnInfo],
    commit: bool,
    expected: Option<u64>,
) -> Result<u64, String> {
    match engine {
        "postgres" => delete_postgres_rows(url, sql, keys, primary_keys, commit, expected).await,
        "mysql" => delete_mysql_rows(url, sql, keys, primary_keys, commit, expected).await,
        "sqlite" => delete_sqlite_rows(url, sql, keys, primary_keys, commit, expected).await,
        _ => Err(format!("Unsupported engine: {engine}")),
    }
}

pub fn ensure_expected_affected(affected: u64, expected: Option<u64>) -> Result<(), String> {
    if let Some(expected) = expected {
        if affected != expected {
            return Err(format!(
                "Delete affected {affected} rows, but the preview expected {expected}; no changes were committed"
            ));
        }
    }
    Ok(())
}

async fn execute_postgres(url: &str, sql: &str, commit: bool) -> Result<u64, String> {
    use sqlx::postgres::PgPool;
    let pool = PgPool::connect(url).await.map_err(|e| e.to_string())?;
    let mut transaction = pool.begin().await.map_err(|e| e.to_string())?;
    let result = sqlx::query(sql)
        .execute(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?;
    if commit {
        transaction.commit().await
    } else {
        transaction.rollback().await
    }
    .map_err(|e| e.to_string())?;
    Ok(result.rows_affected())
}

async fn delete_postgres_rows(
    url: &str,
    sql: &str,
    keys: &[serde_json::Map<String, Value>],
    primary_keys: &[&ColumnInfo],
    commit: bool,
    expected: Option<u64>,
) -> Result<u64, String> {
    use sqlx::postgres::PgPool;
    let pool = PgPool::connect(url)
        .await
        .map_err(|error| error.to_string())?;
    let mut transaction = pool.begin().await.map_err(|error| error.to_string())?;
    let mut affected = 0_u64;
    for key in keys {
        let mut query = sqlx::query(sql);
        for column in primary_keys {
            query = query.bind(key_value_as_text(
                key.get(&column.name)
                    .ok_or_else(|| "Missing primary-key value".to_string())?,
                "postgres",
            )?);
        }
        affected = affected
            .checked_add(
                query
                    .execute(&mut *transaction)
                    .await
                    .map_err(|error| error.to_string())?
                    .rows_affected(),
            )
            .ok_or_else(|| "Affected-row count overflow".to_string())?;
    }
    if let Err(error) = ensure_expected_affected(affected, expected) {
        transaction
            .rollback()
            .await
            .map_err(|rollback| format!("{error}; rollback failed: {rollback}"))?;
        return Err(error);
    }
    if commit {
        transaction.commit().await
    } else {
        transaction.rollback().await
    }
    .map_err(|error| error.to_string())?;
    Ok(affected)
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

async fn execute_sqlite(url: &str, sql: &str, commit: bool) -> Result<u64, String> {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;
    let options = if url.starts_with("sqlite:") {
        SqliteConnectOptions::from_str(url).map_err(|e| e.to_string())?
    } else {
        SqliteConnectOptions::new().filename(url)
    }
    .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|e| e.to_string())?;
    let mut transaction = pool.begin().await.map_err(|e| e.to_string())?;
    let result = sqlx::query(sql)
        .execute(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?;
    if commit {
        transaction.commit().await
    } else {
        transaction.rollback().await
    }
    .map_err(|e| e.to_string())?;
    Ok(result.rows_affected())
}

async fn delete_sqlite_rows(
    url: &str,
    sql: &str,
    keys: &[serde_json::Map<String, Value>],
    primary_keys: &[&ColumnInfo],
    commit: bool,
    expected: Option<u64>,
) -> Result<u64, String> {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;
    let options = if url.starts_with("sqlite:") {
        SqliteConnectOptions::from_str(url).map_err(|error| error.to_string())?
    } else {
        SqliteConnectOptions::new().filename(url)
    };
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|error| error.to_string())?;
    let mut transaction = pool.begin().await.map_err(|error| error.to_string())?;
    let mut affected = 0_u64;
    for key in keys {
        let mut query = sqlx::query(sql);
        for column in primary_keys {
            query = query.bind(key_value_as_text(
                key.get(&column.name)
                    .ok_or_else(|| "Missing primary-key value".to_string())?,
                "sqlite",
            )?);
        }
        affected = affected
            .checked_add(
                query
                    .execute(&mut *transaction)
                    .await
                    .map_err(|error| error.to_string())?
                    .rows_affected(),
            )
            .ok_or_else(|| "Affected-row count overflow".to_string())?;
    }
    if let Err(error) = ensure_expected_affected(affected, expected) {
        transaction
            .rollback()
            .await
            .map_err(|rollback| format!("{error}; rollback failed: {rollback}"))?;
        return Err(error);
    }
    if commit {
        transaction.commit().await
    } else {
        transaction.rollback().await
    }
    .map_err(|error| error.to_string())?;
    Ok(affected)
}

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

async fn execute_mysql(url: &str, sql: &str, commit: bool) -> Result<u64, String> {
    use sqlx::mysql::MySqlPool;
    let pool = MySqlPool::connect(url).await.map_err(|e| e.to_string())?;
    let mut transaction = pool.begin().await.map_err(|e| e.to_string())?;
    let result = sqlx::query(sql)
        .execute(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?;
    if commit {
        transaction.commit().await
    } else {
        transaction.rollback().await
    }
    .map_err(|e| e.to_string())?;
    Ok(result.rows_affected())
}

async fn delete_mysql_rows(
    url: &str,
    sql: &str,
    keys: &[serde_json::Map<String, Value>],
    primary_keys: &[&ColumnInfo],
    commit: bool,
    expected: Option<u64>,
) -> Result<u64, String> {
    use sqlx::mysql::MySqlPool;
    let pool = MySqlPool::connect(url)
        .await
        .map_err(|error| error.to_string())?;
    let mut transaction = pool.begin().await.map_err(|error| error.to_string())?;
    let mut affected = 0_u64;
    for key in keys {
        let mut query = sqlx::query(sql);
        for column in primary_keys {
            query = query.bind(key_value_as_text(
                key.get(&column.name)
                    .ok_or_else(|| "Missing primary-key value".to_string())?,
                "mysql",
            )?);
        }
        affected = affected
            .checked_add(
                query
                    .execute(&mut *transaction)
                    .await
                    .map_err(|error| error.to_string())?
                    .rows_affected(),
            )
            .ok_or_else(|| "Affected-row count overflow".to_string())?;
    }
    if let Err(error) = ensure_expected_affected(affected, expected) {
        transaction
            .rollback()
            .await
            .map_err(|rollback| format!("{error}; rollback failed: {rollback}"))?;
        return Err(error);
    }
    if commit {
        transaction.commit().await
    } else {
        transaction.rollback().await
    }
    .map_err(|error| error.to_string())?;
    Ok(affected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nomoreide_core::db::run_query;

    static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

    fn sqlite_fixture_url() -> (std::path::PathBuf, String) {
        let path = std::env::temp_dir().join(format!(
            "nomoreide-db-write-{}-{}.db",
            std::process::id(),
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::File::create(&path).unwrap();
        let url = format!("sqlite://{}", path.display());
        (path, url)
    }

    #[tokio::test]
    async fn sqlite_write_preview_rolls_back() {
        let (path, url) = sqlite_fixture_url();
        execute_sqlite(&url, "CREATE TABLE users (id INTEGER PRIMARY KEY)", true)
            .await
            .unwrap();
        execute_sqlite(&url, "INSERT INTO users DEFAULT VALUES", true)
            .await
            .unwrap();
        assert_eq!(
            execute_sqlite(&url, "DELETE FROM users", false)
                .await
                .unwrap(),
            1
        );
        let result = run_query("sqlite", &url, "SELECT id FROM users")
            .await
            .unwrap();
        assert_eq!(result.row_count, 1);
        assert_eq!(result.rows[0][0], json!(1));
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn sqlite_structured_delete_previews_and_count_checks_commit() {
        let (path, url) = sqlite_fixture_url();
        execute_sqlite(
            &url,
            "CREATE TABLE memberships (team_id INTEGER, user_id TEXT, PRIMARY KEY (team_id, user_id)); INSERT INTO memberships VALUES (1, 'a'), (1, 'b')",
            true,
        )
        .await
        .unwrap();
        let columns = [
            ColumnInfo {
                name: "team_id".into(),
                data_type: "INTEGER".into(),
                nullable: false,
                primary_key: true,
            },
            ColumnInfo {
                name: "user_id".into(),
                data_type: "TEXT".into(),
                nullable: false,
                primary_key: true,
            },
        ];
        let primary_keys = columns.iter().collect::<Vec<_>>();
        let keys = vec![serde_json::from_value(json!({
            "team_id": 1,
            "user_id": "a"
        }))
        .unwrap()];
        validate_delete_keys(&keys, &primary_keys).unwrap();
        let object = CatalogObject {
            key: "opaque".into(),
            schema: "main".into(),
            name: "memberships".into(),
            kind: "table".into(),
            qualified_name: "memberships".into(),
            native_id: None,
        };
        let sql = delete_sql("sqlite", &object, &primary_keys);
        assert_eq!(
            delete_sqlite_rows(&url, &sql, &keys, &primary_keys, false, None)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            run_query("sqlite", &url, "SELECT team_id FROM memberships")
                .await
                .unwrap()
                .row_count,
            2
        );
        assert!(
            delete_sqlite_rows(&url, &sql, &keys, &primary_keys, true, Some(2))
                .await
                .is_err()
        );
        assert_eq!(
            run_query("sqlite", &url, "SELECT team_id FROM memberships")
                .await
                .unwrap()
                .row_count,
            2
        );
        assert_eq!(
            delete_sqlite_rows(&url, &sql, &keys, &primary_keys, true, Some(1))
                .await
                .unwrap(),
            1
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn structured_delete_rejects_duplicate_and_masked_keys() {
        let columns = [ColumnInfo {
            name: "id".into(),
            data_type: "TEXT".into(),
            nullable: false,
            primary_key: true,
        }];
        let primary_keys = columns.iter().collect::<Vec<_>>();
        let duplicate: serde_json::Map<String, Value> =
            serde_json::from_value(json!({ "id": "one" })).unwrap();
        assert!(validate_delete_keys(&[duplicate.clone(), duplicate], &primary_keys).is_err());
        let masked: serde_json::Map<String, Value> =
            serde_json::from_value(json!({ "id": "••••" })).unwrap();
        assert!(validate_delete_keys(&[masked], &primary_keys).is_err());
    }
}
