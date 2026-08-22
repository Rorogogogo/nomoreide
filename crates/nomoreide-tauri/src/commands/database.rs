//! The desktop app's database commands.
//!
//! Thin wrappers now: the read-safe half lives in `nomoreide_core::db` and the
//! write-capable half in `nomoreide_actions::db`, so the dashboard and the MCP
//! server answer with the same catalog rather than two that drifted.
//!
//! What stays here is exporting an object to a file, which is the one operation
//! that is neither: it reads rows, but it streams them to disk and can be
//! cancelled, so it holds Tauri's own cancellation state.

use crate::AppState;
use futures_util::TryStreamExt;
use nomoreide_actions::db::{
    delete_rows_bound, delete_sql, run_execute, validate_delete_keys, DeleteDatabaseRowsInput,
    WriteOutcome,
};
use nomoreide_core::config::DatabaseDef;
use nomoreide_core::db::{
    capabilities, columns_for, connection as find_connection, hex_bytes,
    is_sensitive_preview_column, list_connections, list_db_tables, lossless_json_integer,
    object_details, objects_for, quote_identifier, resolve_object, run_query, sample_object,
    schemas_for, test_connection, CatalogCapabilities, CatalogObject, ColumnInfo, ObjectDetails,
    ObjectRows, QueryResult, RowBrowseQuery,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::State;
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::sync::watch;

/// The connection a command names, read fresh from config each time.
async fn connection(state: &State<'_, AppState>, name: &str) -> Result<DatabaseDef, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    find_connection(&config, name).cloned()
}

#[tauri::command]
pub async fn list_databases(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    Ok(list_connections(&config))
}

#[tauri::command]
pub async fn query_database(
    state: State<'_, AppState>,
    name: String,
    sql: String,
    limit: Option<i64>,
) -> Result<QueryResult, String> {
    let keyword = sql
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        keyword.as_str(),
        "select" | "show" | "explain" | "pragma" | "describe" | "desc"
    ) {
        return Err("This connection is read-only.".to_string());
    }
    let database = connection(&state, &name).await?;
    let limited_sql = if let Some(lim) = limit {
        format!("SELECT * FROM ({sql}) _q LIMIT {lim}")
    } else {
        sql
    };
    run_query(&database.engine, &database.url, &limited_sql).await
}

#[tauri::command]
pub async fn execute_database(
    state: State<'_, AppState>,
    name: String,
    sql: String,
    mode: Option<String>,
) -> Result<WriteOutcome, String> {
    let database = connection(&state, &name).await?;
    if !database.write_unlocked.unwrap_or(false) {
        return Err("Write access is locked for this database".to_string());
    }

    let commit = mode.as_deref() == Some("commit");
    if database.engine == "mysql" && !commit {
        let keyword = sql
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        if matches!(
            keyword.as_str(),
            "create" | "alter" | "drop" | "truncate" | "rename" | "grant" | "revoke"
        ) {
            return Ok(WriteOutcome {
                engine: database.engine.clone(),
                preview_unavailable: true,
                affected_rows: None,
                committed: None,
            });
        }
    }
    let affected = run_execute(&database.engine, &database.url, &sql, commit).await?;
    Ok(WriteOutcome {
        engine: database.engine.clone(),
        preview_unavailable: false,
        affected_rows: Some(affected),
        committed: Some(commit),
    })
}

#[tauri::command]
pub async fn list_tables(state: State<'_, AppState>, name: String) -> Result<Vec<String>, String> {
    let database = connection(&state, &name).await?;
    list_db_tables(&database.engine, &database.url).await
}

#[tauri::command]
pub async fn test_database_connection(engine: String, url: String) -> Result<(), String> {
    test_connection(&engine, &url).await
}

#[tauri::command]
pub async fn database_capabilities(
    state: State<'_, AppState>,
    name: String,
) -> Result<CatalogCapabilities, String> {
    let database = connection(&state, &name).await?;
    capabilities(&database.engine)
}

#[tauri::command]
pub async fn list_database_schemas(
    state: State<'_, AppState>,
    name: String,
) -> Result<Vec<Value>, String> {
    let database = connection(&state, &name).await?;
    Ok(schemas_for(&database)
        .await?
        .into_iter()
        .map(|name| json!({ "name": name }))
        .collect())
}

#[tauri::command]
pub async fn list_database_objects(
    state: State<'_, AppState>,
    name: String,
    schema: String,
) -> Result<Vec<CatalogObject>, String> {
    let database = connection(&state, &name).await?;
    objects_for(&database, &schema).await
}

#[tauri::command]
pub async fn get_database_object_details(
    state: State<'_, AppState>,
    name: String,
    key: String,
) -> Result<ObjectDetails, String> {
    let database = connection(&state, &name).await?;
    object_details(&database, &key).await
}

#[tauri::command]
pub async fn sample_database_object(
    state: State<'_, AppState>,
    name: String,
    key: String,
    limit: Option<i64>,
    offset: Option<i64>,
    query: Option<RowBrowseQuery>,
) -> Result<ObjectRows, String> {
    let database = connection(&state, &name).await?;
    sample_object(&database, &key, limit, offset, query).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseExportSummary {
    rows_written: usize,
    bytes_written: usize,
    masked_columns: Vec<String>,
}

#[tauri::command]
pub async fn export_database_object(
    state: State<'_, AppState>,
    request_id: String,
    name: String,
    key: String,
    format: String,
    path: String,
) -> Result<DatabaseExportSummary, String> {
    if format != "csv" && format != "json" {
        return Err("format must be csv or json".into());
    }
    let (cancel_tx, cancel_rx) = watch::channel(false);
    {
        let mut exports = state.database_exports.lock().await;
        match exports.remove(&request_id) {
            Some(None) => return Err("Database export cancelled".into()),
            Some(Some(existing)) => {
                exports.insert(request_id, Some(existing));
                return Err("A database export with this request ID already exists".into());
            }
            None => {
                exports.insert(request_id.clone(), Some(cancel_tx));
            }
        }
    }
    let outcome = async {
        let database = connection(&state, &name).await?;
        let object = resolve_object(&database, &key).await?;
        if !matches!(object.kind.as_str(), "table" | "view" | "materializedView") {
            return Err("This database object cannot be exported".into());
        }
        let columns = columns_for(&database, &object).await?;
        let destination = PathBuf::from(path);
        if destination.file_name().is_none() || destination.is_dir() {
            return Err("A valid export file path is required".into());
        }
        export_object_to_file(
            &database,
            &object,
            &columns,
            &format,
            &destination,
            &request_id,
            cancel_rx,
        )
        .await
    }
    .await;
    state.database_exports.lock().await.remove(&request_id);
    outcome
}

#[tauri::command]
pub async fn cancel_database_export(
    state: State<'_, AppState>,
    request_id: String,
) -> Result<(), String> {
    let mut exports = state.database_exports.lock().await;
    match exports.get(&request_id) {
        Some(Some(cancel)) => {
            let _ = cancel.send(true);
        }
        Some(None) => {}
        None => {
            if exports.len() >= 128 {
                if let Some(stale) = exports
                    .iter()
                    .find_map(|(id, sender)| sender.is_none().then(|| id.clone()))
                {
                    exports.remove(&stale);
                }
            }
            exports.insert(request_id, None);
        }
    }
    Ok(())
}

async fn export_object_to_file(
    database: &DatabaseDef,
    object: &CatalogObject,
    columns: &[ColumnInfo],
    format: &str,
    destination: &Path,
    request_id: &str,
    cancel: watch::Receiver<bool>,
) -> Result<DatabaseExportSummary, String> {
    let filename = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "A valid UTF-8 export filename is required".to_string())?;
    let part = destination.with_file_name(format!(".{filename}.{request_id}.part"));
    let outcome = async {
        if *cancel.borrow() {
            return Err("Database export cancelled".to_string());
        }
        let file = tokio::fs::File::create(&part)
            .await
            .map_err(|error| error.to_string())?;
        let mut writer = ExportFileWriter::new(file, format, columns).await?;
        export_engine_rows(database, object, columns, &mut writer, cancel.clone()).await?;
        if *cancel.borrow() {
            return Err("Database export cancelled".to_string());
        }
        writer.finish().await?;
        if *cancel.borrow() {
            return Err("Database export cancelled".to_string());
        }
        let summary = writer.summary();
        publish_export_file(&part, destination).await?;
        Ok(summary)
    }
    .await;
    if outcome.is_err() {
        let _ = tokio::fs::remove_file(&part).await;
    }
    outcome
}

#[cfg(not(target_os = "windows"))]
async fn publish_export_file(part: &Path, destination: &Path) -> Result<(), String> {
    tokio::fs::rename(part, destination)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
async fn publish_export_file(part: &Path, destination: &Path) -> Result<(), String> {
    if !destination.exists() {
        return tokio::fs::rename(part, destination)
            .await
            .map_err(|error| error.to_string());
    }
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_IGNORE_MERGE_ERRORS};
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>()
    };
    let destination = wide(destination);
    let replacement = wide(part);
    let replaced = unsafe {
        ReplaceFileW(
            destination.as_ptr(),
            replacement.as_ptr(),
            std::ptr::null(),
            REPLACEFILE_IGNORE_MERGE_ERRORS,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if replaced == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

async fn export_engine_rows(
    database: &DatabaseDef,
    object: &CatalogObject,
    columns: &[ColumnInfo],
    writer: &mut ExportFileWriter,
    cancel: watch::Receiver<bool>,
) -> Result<(), String> {
    let table = if database.engine == "sqlite" {
        quote_identifier(&object.name, &database.engine)
    } else {
        format!(
            "{}.{}",
            quote_identifier(&object.schema, &database.engine),
            quote_identifier(&object.name, &database.engine)
        )
    };
    let projection = columns
        .iter()
        .map(|column| export_column_expression(&database.engine, column))
        .collect::<Vec<_>>()
        .join(", ");
    let primary_keys = columns
        .iter()
        .filter(|column| column.primary_key)
        .map(|column| quote_identifier(&column.name, &database.engine))
        .collect::<Vec<_>>();
    let order_columns = if primary_keys.is_empty() {
        columns
            .iter()
            .map(|column| export_order_expression(&database.engine, column))
            .collect::<Vec<_>>()
    } else {
        primary_keys
    };
    let order = if order_columns.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", order_columns.join(", "))
    };
    let sql = format!("SELECT {projection} FROM {table}{order}");
    match database.engine.as_str() {
        "postgres" => export_postgres_rows(&database.url, &sql, writer, cancel).await,
        "mysql" => export_mysql_rows(&database.url, &sql, writer, cancel).await,
        "sqlite" => export_sqlite_rows(&database.url, &sql, writer, cancel).await,
        _ => Err(format!("Unsupported engine: {}", database.engine)),
    }
}

fn export_column_expression(engine: &str, column: &ColumnInfo) -> String {
    let identifier = quote_identifier(&column.name, engine);
    let data_type = column.data_type.to_ascii_lowercase();
    let native = match engine {
        "postgres" => [
            "boolean",
            "bool",
            "smallint",
            "int2",
            "integer",
            "int4",
            "bigint",
            "int8",
            "real",
            "float4",
            "double precision",
            "float8",
            "json",
            "jsonb",
            "bytea",
            "text",
            "name",
            "character",
            "char",
            "character varying",
            "varchar",
        ]
        .iter()
        .any(|kind| data_type == *kind || data_type.starts_with(&format!("{kind}("))),
        "mysql" => {
            !data_type.contains("unsigned")
                && ([
                    "tinyint",
                    "smallint",
                    "mediumint",
                    "int",
                    "integer",
                    "bigint",
                    "float",
                    "double",
                    "json",
                ]
                .iter()
                .any(|kind| data_type == *kind || data_type.starts_with(&format!("{kind}(")))
                    || data_type.contains("char")
                    || data_type.contains("text")
                    || data_type.contains("blob")
                    || data_type.contains("binary")
                    || data_type.starts_with("enum(")
                    || data_type.starts_with("set("))
        }
        "sqlite" => {
            data_type.contains("int")
                || data_type.contains("real")
                || data_type.contains("floa")
                || data_type.contains("doub")
                || data_type.contains("blob")
                || data_type.contains("char")
                || data_type.contains("clob")
                || data_type.contains("text")
        }
        _ => false,
    };
    if native {
        identifier
    } else {
        match engine {
            "mysql" => format!("CAST({identifier} AS CHAR) AS {identifier}"),
            _ => format!("CAST({identifier} AS TEXT) AS {identifier}"),
        }
    }
}

fn export_order_expression(engine: &str, column: &ColumnInfo) -> String {
    let identifier = quote_identifier(&column.name, engine);
    match engine {
        "postgres" => format!(
            "({identifier} IS NOT NULL), encode(convert_to(CAST({identifier} AS TEXT), 'UTF8'), 'hex') COLLATE \"C\""
        ),
        "mysql" => format!(
            "({identifier} IS NOT NULL), HEX(CAST({identifier} AS BINARY))"
        ),
        _ => format!("typeof({identifier}), hex({identifier})"),
    }
}

struct ExportFileWriter {
    writer: BufWriter<tokio::fs::File>,
    format: String,
    columns: Vec<String>,
    first_json_row: bool,
    rows_written: usize,
    bytes_written: usize,
    masked_columns: Vec<String>,
}

impl ExportFileWriter {
    async fn new(
        file: tokio::fs::File,
        format: &str,
        columns: &[ColumnInfo],
    ) -> Result<Self, String> {
        let names = columns
            .iter()
            .map(|column| column.name.clone())
            .collect::<Vec<_>>();
        let masked_columns = names
            .iter()
            .filter(|name| is_sensitive_preview_column(name))
            .cloned()
            .collect();
        let mut export = Self {
            writer: BufWriter::new(file),
            format: format.to_string(),
            columns: names,
            first_json_row: true,
            rows_written: 0,
            bytes_written: 0,
            masked_columns,
        };
        if format == "csv" {
            let header = format!(
                "{}\r\n",
                export
                    .columns
                    .iter()
                    .map(|name| csv_export_cell(name, true))
                    .collect::<Vec<_>>()
                    .join(",")
            );
            export.write(header.as_bytes()).await?;
        } else {
            export.write(b"[").await?;
        }
        Ok(export)
    }

    async fn row(&mut self, values: Vec<Value>) -> Result<(), String> {
        let masked = self
            .columns
            .iter()
            .cloned()
            .zip(values)
            .map(|(column, value)| {
                let value = if is_sensitive_preview_column(&column) && !value.is_null() {
                    Value::String("••••".into())
                } else {
                    value
                };
                (column, value)
            })
            .collect::<Vec<_>>();
        let chunk = if self.format == "csv" {
            format!(
                "{}\r\n",
                masked
                    .iter()
                    .map(|(_, value)| csv_export_value(value))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        } else {
            let row = masked
                .into_iter()
                .collect::<serde_json::Map<String, Value>>();
            format!(
                "{}{}",
                if self.first_json_row { "" } else { "," },
                serde_json::to_string(&row).map_err(|error| error.to_string())?
            )
        };
        self.first_json_row = false;
        self.write(chunk.as_bytes()).await?;
        self.rows_written += 1;
        Ok(())
    }

    async fn finish(&mut self) -> Result<(), String> {
        if self.format == "json" {
            self.write(b"]\n").await?;
        }
        self.writer.flush().await.map_err(|error| error.to_string())
    }

    async fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.writer
            .write_all(bytes)
            .await
            .map_err(|error| error.to_string())?;
        self.bytes_written += bytes.len();
        Ok(())
    }

    fn summary(&self) -> DatabaseExportSummary {
        DatabaseExportSummary {
            rows_written: self.rows_written,
            bytes_written: self.bytes_written,
            masked_columns: self.masked_columns.clone(),
        }
    }
}

fn csv_export_value(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => csv_export_cell(value, true),
        _ => csv_export_cell(&serde_json::to_string(value).unwrap_or_default(), false),
    }
}

fn csv_export_cell(value: &str, spreadsheet_safe: bool) -> String {
    let dangerous = spreadsheet_safe
        && (value.starts_with(['\t', '\r'])
            || value.trim_start().starts_with(['=', '+', '-', '@']));
    let text = if dangerous {
        format!("'{value}")
    } else {
        value.to_string()
    };
    if text.contains([',', '"', '\r', '\n']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text
    }
}

#[tauri::command]
pub async fn delete_database_rows(
    state: State<'_, AppState>,
    name: String,
    input: DeleteDatabaseRowsInput,
) -> Result<WriteOutcome, String> {
    let database = connection(&state, &name).await?;
    if !database.write_unlocked.unwrap_or(false) {
        return Err("Write access is locked for this database".to_string());
    }
    let commit = match input.mode.as_str() {
        "preview" => false,
        "commit" => true,
        _ => return Err("Delete mode must be 'preview' or 'commit'".into()),
    };
    let object = resolve_object(&database, &input.object_key).await?;
    if object.kind != "table" {
        return Err("Rows can only be deleted from a table".into());
    }
    let columns = columns_for(&database, &object).await?;
    let primary_keys = columns
        .iter()
        .filter(|column| column.primary_key)
        .collect::<Vec<_>>();
    validate_delete_keys(&input.keys, &primary_keys)?;

    let expected = if commit {
        Some(
            input
                .expected_affected_rows
                .ok_or_else(|| "Commit requires expectedAffectedRows from a preview".to_string())?,
        )
    } else {
        None
    };
    if let Some(expected) = expected {
        if expected != input.keys.len() as u64 {
            return Err("Expected affected-row count must match the selected row count".into());
        }
    }

    let sql = delete_sql(&database.engine, &object, &primary_keys);
    let affected = delete_rows_bound(
        &database.engine,
        &database.url,
        &sql,
        &input.keys,
        &primary_keys,
        commit,
        expected,
    )
    .await?;
    Ok(WriteOutcome {
        engine: database.engine,
        preview_unavailable: false,
        affected_rows: Some(affected),
        committed: Some(commit),
    })
}

async fn export_postgres_rows(
    url: &str,
    sql: &str,
    writer: &mut ExportFileWriter,
    mut cancel: watch::Receiver<bool>,
) -> Result<(), String> {
    use sqlx::postgres::PgPool;

    let pool = PgPool::connect(url)
        .await
        .map_err(|error| error.to_string())?;
    let mut transaction = pool.begin().await.map_err(|error| error.to_string())?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *transaction)
        .await
        .map_err(|error| error.to_string())?;
    sqlx::query("SET TRANSACTION READ ONLY")
        .execute(&mut *transaction)
        .await
        .map_err(|error| error.to_string())?;
    let mut rows = sqlx::query(sql).fetch(&mut *transaction);
    loop {
        if *cancel.borrow() {
            return Err("Database export cancelled".into());
        }
        let next = tokio::select! {
            changed = cancel.changed() => {
                changed.map_err(|error| error.to_string())?;
                return Err("Database export cancelled".into());
            }
            row = rows.try_next() => row.map_err(|error| error.to_string())?,
        };
        let Some(row) = next else { break };
        writer.row(postgres_export_values(&row)?).await?;
    }
    drop(rows);
    transaction
        .rollback()
        .await
        .map_err(|error| error.to_string())
}

fn postgres_export_values(row: &sqlx::postgres::PgRow) -> Result<Vec<Value>, String> {
    use sqlx::{Column, Row, TypeInfo};
    (0..row.len())
        .map(|index| {
            let type_name = row.column(index).type_info().name().to_uppercase();
            let decoded = match type_name.as_str() {
                "BOOL" => row
                    .try_get::<Option<bool>, _>(index)
                    .map(|value| value.map(Value::Bool)),
                "INT2" | "SMALLINT" | "SMALLSERIAL" => row
                    .try_get::<Option<i16>, _>(index)
                    .map(|value| value.map(|value| json!(value))),
                "INT4" | "INT" | "INTEGER" | "SERIAL" => row
                    .try_get::<Option<i32>, _>(index)
                    .map(|value| value.map(|value| json!(value))),
                "INT8" | "BIGINT" | "BIGSERIAL" => row
                    .try_get::<Option<i64>, _>(index)
                    .map(|value| value.map(|value| Value::String(value.to_string()))),
                "FLOAT4" | "REAL" => row
                    .try_get::<Option<f32>, _>(index)
                    .map(|value| value.map(|value| json!(value))),
                "FLOAT8" | "DOUBLE PRECISION" => row
                    .try_get::<Option<f64>, _>(index)
                    .map(|value| value.map(|value| json!(value))),
                "JSON" | "JSONB" => row.try_get::<Option<Value>, _>(index),
                "BYTEA" => row
                    .try_get::<Option<Vec<u8>>, _>(index)
                    .map(|value| value.map(|value| Value::String(hex_bytes(&value)))),
                _ => row
                    .try_get::<Option<String>, _>(index)
                    .map(|value| value.map(Value::String)),
            };
            decoded
                .map(|value| value.unwrap_or(Value::Null))
                .map_err(|error| {
                    format!(
                        "Could not decode PostgreSQL export column {}: {error}",
                        index + 1
                    )
                })
        })
        .collect()
}

async fn export_mysql_rows(
    url: &str,
    sql: &str,
    writer: &mut ExportFileWriter,
    mut cancel: watch::Receiver<bool>,
) -> Result<(), String> {
    use sqlx::mysql::MySqlPool;

    let pool = MySqlPool::connect(url)
        .await
        .map_err(|error| error.to_string())?;
    let mut connection = pool.acquire().await.map_err(|error| error.to_string())?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *connection)
        .await
        .map_err(|error| error.to_string())?;
    sqlx::query("START TRANSACTION READ ONLY")
        .execute(&mut *connection)
        .await
        .map_err(|error| error.to_string())?;
    let mut rows = sqlx::query(sql).fetch(&mut *connection);
    loop {
        if *cancel.borrow() {
            return Err("Database export cancelled".into());
        }
        let next = tokio::select! {
            changed = cancel.changed() => {
                changed.map_err(|error| error.to_string())?;
                return Err("Database export cancelled".into());
            }
            row = rows.try_next() => row.map_err(|error| error.to_string())?,
        };
        let Some(row) = next else { break };
        writer.row(mysql_export_values(&row)?).await?;
    }
    drop(rows);
    sqlx::query("ROLLBACK")
        .execute(&mut *connection)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn mysql_export_values(row: &sqlx::mysql::MySqlRow) -> Result<Vec<Value>, String> {
    use sqlx::{Column, Row, TypeInfo};
    (0..row.len())
        .map(|index| {
            let type_name = row.column(index).type_info().name().to_uppercase();
            let decoded = match type_name.as_str() {
                "BOOLEAN" | "TINYINT(1)" => row
                    .try_get::<Option<bool>, _>(index)
                    .map(|value| value.map(Value::Bool)),
                "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" => row
                    .try_get::<Option<i64>, _>(index)
                    .map(|value| value.map(|value| json!(value))),
                "BIGINT" => row
                    .try_get::<Option<i64>, _>(index)
                    .map(|value| value.map(|value| Value::String(value.to_string()))),
                "FLOAT" => row
                    .try_get::<Option<f32>, _>(index)
                    .map(|value| value.map(|value| json!(value))),
                "DOUBLE" => row
                    .try_get::<Option<f64>, _>(index)
                    .map(|value| value.map(|value| json!(value))),
                "JSON" => row.try_get::<Option<Value>, _>(index),
                "BLOB" | "MEDIUMBLOB" | "LONGBLOB" | "TINYBLOB" | "BINARY" | "VARBINARY" => row
                    .try_get::<Option<Vec<u8>>, _>(index)
                    .map(|value| value.map(|value| Value::String(hex_bytes(&value)))),
                _ => row
                    .try_get::<Option<String>, _>(index)
                    .map(|value| value.map(Value::String)),
            };
            decoded
                .map(|value| value.unwrap_or(Value::Null))
                .map_err(|error| {
                    format!(
                        "Could not decode MySQL export column {}: {error}",
                        index + 1
                    )
                })
        })
        .collect()
}

async fn export_sqlite_rows(
    url: &str,
    sql: &str,
    writer: &mut ExportFileWriter,
    mut cancel: watch::Receiver<bool>,
) -> Result<(), String> {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    let options = if url.starts_with("sqlite:") {
        SqliteConnectOptions::from_str(url).map_err(|error| error.to_string())?
    } else {
        SqliteConnectOptions::new().filename(url)
    }
    .read_only(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|error| error.to_string())?;
    let mut rows = sqlx::query(sql).fetch(&pool);
    loop {
        if *cancel.borrow() {
            return Err("Database export cancelled".into());
        }
        let next = tokio::select! {
            changed = cancel.changed() => {
                changed.map_err(|error| error.to_string())?;
                return Err("Database export cancelled".into());
            }
            row = rows.try_next() => row.map_err(|error| error.to_string())?,
        };
        let Some(row) = next else { break };
        writer.row(sqlite_export_values(&row)?).await?;
    }
    Ok(())
}

fn sqlite_export_values(row: &sqlx::sqlite::SqliteRow) -> Result<Vec<Value>, String> {
    use sqlx::{Row, TypeInfo, ValueRef};
    (0..row.len())
        .map(|index| {
            let raw = row.try_get_raw(index).map_err(|error| {
                format!("Could not read SQLite export column {}: {error}", index + 1)
            })?;
            if raw.is_null() {
                return Ok(Value::Null);
            }
            let type_name = raw.type_info().name().to_uppercase();
            let decoded = match type_name.as_str() {
                "INTEGER" | "INT" | "INT64" => {
                    row.try_get::<i64, _>(index).map(lossless_json_integer)
                }
                "REAL" => row.try_get::<f64, _>(index).map(|value| json!(value)),
                "BLOB" => row
                    .try_get::<Vec<u8>, _>(index)
                    .map(|value| Value::String(hex_bytes(&value))),
                _ => row.try_get::<String, _>(index).map(Value::String),
            };
            decoded.map_err(|error| {
                format!(
                    "Could not decode SQLite export column {}: {error}",
                    index + 1
                )
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use nomoreide_actions::db::run_execute;
    use nomoreide_core::config::DatabaseDef;

    fn sqlite_fixture_url() -> (std::path::PathBuf, String) {
        let path =
            std::env::temp_dir().join(format!("nomoreide-catalog-{}.db", uuid::Uuid::new_v4()));
        std::fs::File::create(&path).unwrap();
        let url = format!("sqlite://{}", path.display());
        (path, url)
    }

    #[tokio::test]
    async fn sqlite_export_preserves_native_values_and_replaces_safely() {
        let (path, url) = sqlite_fixture_url();
        run_execute(
            "sqlite",
            &url,
            "CREATE TABLE values_table (id INTEGER PRIMARY KEY, score REAL, label TEXT, payload BLOB, amount NUMERIC, missing TEXT); INSERT INTO values_table VALUES (1, -42.5, '=safe', X'00ff', 12.25, NULL); INSERT INTO values_table VALUES (2, 1.5, X'80ff', NULL, 3, 'present'); INSERT INTO values_table VALUES (9007199254740993, 0, 'large', NULL, NULL, NULL)",
            true,
        )
        .await
        .unwrap();
        let database = DatabaseDef {
            name: "app".into(),
            engine: "sqlite".into(),
            url,
            write_unlocked: None,
            project_path: None,
        };
        let object = objects_for(&database, "main")
            .await
            .unwrap()
            .into_iter()
            .find(|object| object.name == "values_table")
            .unwrap();
        let columns = columns_for(&database, &object).await.unwrap();
        let destination = path.with_extension("json");
        std::fs::write(&destination, "old export").unwrap();
        let (_cancel_tx, cancel_rx) = watch::channel(false);

        let summary = export_object_to_file(
            &database,
            &object,
            &columns,
            "json",
            &destination,
            "test-request",
            cancel_rx,
        )
        .await
        .unwrap();
        let rows: Value =
            serde_json::from_str(&std::fs::read_to_string(&destination).unwrap()).unwrap();
        assert_eq!(summary.rows_written, 3);
        assert_eq!(rows[0]["id"], json!(1));
        assert_eq!(rows[0]["score"], json!(-42.5));
        assert_eq!(rows[0]["label"], json!("=safe"));
        assert_eq!(rows[0]["payload"], json!("\\x00ff"));
        assert_eq!(rows[0]["amount"], json!("12.25"));
        assert!(rows[0]["missing"].is_null());
        assert_eq!(rows[1]["label"], json!("\\x80ff"));
        assert_eq!(rows[2]["id"], json!("9007199254740993"));
        let _ = std::fs::remove_file(destination);
        let _ = std::fs::remove_file(path);
    }
}
