use crate::core::config::DatabaseDef;
use crate::AppState;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use tauri::State;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub row_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogObject {
    pub key: String,
    pub schema: String,
    pub name: String,
    pub kind: String,
    pub qualified_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogIdentity {
    schema: String,
    name: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCapabilities {
    pub object_kinds: Vec<String>,
    pub table_details: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedDefinition {
    pub name: String,
    pub definition: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unique: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectDetails {
    pub object: CatalogObject,
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<NamedDefinition>,
    pub constraints: Vec<NamedDefinition>,
    pub triggers: Vec<NamedDefinition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub definition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub create_script: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectRows {
    pub engine: String,
    pub object: CatalogObject,
    pub table: Value,
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<serde_json::Map<String, Value>>,
    pub row_count: usize,
    pub limit: i64,
    pub offset: i64,
}

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

fn make_object(identity: CatalogIdentity) -> Result<CatalogObject, String> {
    let key = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&identity).map_err(|e| e.to_string())?);
    let qualified_name = if identity.schema == "main" {
        identity.name.clone()
    } else {
        format!("{}.{}", identity.schema, identity.name)
    };
    Ok(CatalogObject {
        key,
        schema: identity.schema,
        name: identity.name,
        kind: identity.kind,
        qualified_name,
        native_id: identity.native_id,
    })
}

async fn connection(state: &State<'_, AppState>, name: &str) -> Result<DatabaseDef, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    config
        .databases
        .into_iter()
        .find(|database| database.name == name)
        .ok_or_else(|| format!("Database '{name}' not found"))
}

#[tauri::command]
pub async fn list_databases(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    Ok(config
        .databases
        .iter()
        .map(|d| {
            json!({
                "name": d.name,
                "engine": d.engine,
                "url": mask_url(&d.engine, &d.url),
                "writeUnlocked": d.write_unlocked.unwrap_or(false),
                "projectPath": d.project_path,
            })
        })
        .collect())
}

fn mask_url(engine: &str, url: &str) -> String {
    if engine == "sqlite" {
        return url.to_string();
    }
    let Some(scheme_end) = url.find("://") else {
        return "****".to_string();
    };
    let credentials_start = scheme_end + 3;
    let Some(at_offset) = url[credentials_start..].find('@') else {
        return url.to_string();
    };
    let at = credentials_start + at_offset;
    let credentials = &url[credentials_start..at];
    let Some(colon) = credentials.find(':') else {
        return url.to_string();
    };
    format!(
        "{}{}:****{}",
        &url[..credentials_start],
        &credentials[..colon],
        &url[at..]
    )
}

#[tauri::command]
pub async fn query_database(
    state: State<'_, AppState>,
    name: String,
    sql: String,
    limit: Option<i64>,
) -> Result<QueryResult, String> {
    let keyword = sql
        .trim_start()
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
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let db = config
        .databases
        .iter()
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
    mode: Option<String>,
) -> Result<WriteOutcome, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let db = config
        .databases
        .iter()
        .find(|d| d.name == name)
        .ok_or_else(|| format!("Database '{name}' not found"))?;

    if !db.write_unlocked.unwrap_or(false) {
        return Err("Write access is locked for this database".to_string());
    }

    let commit = mode.as_deref() == Some("commit");
    if db.engine == "mysql" && !commit {
        let keyword = sql
            .trim_start()
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        if matches!(
            keyword.as_str(),
            "create" | "alter" | "drop" | "truncate" | "rename" | "grant" | "revoke"
        ) {
            return Ok(WriteOutcome {
                engine: db.engine.clone(),
                preview_unavailable: true,
                affected_rows: None,
                committed: None,
            });
        }
    }
    let affected = run_execute(&db.engine, &db.url, &sql, commit).await?;
    Ok(WriteOutcome {
        engine: db.engine.clone(),
        preview_unavailable: false,
        affected_rows: Some(affected),
        committed: Some(commit),
    })
}

#[tauri::command]
pub async fn list_tables(state: State<'_, AppState>, name: String) -> Result<Vec<String>, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let db = config
        .databases
        .iter()
        .find(|d| d.name == name)
        .ok_or_else(|| format!("Database '{name}' not found"))?;

    list_db_tables(&db.engine, &db.url).await
}

#[tauri::command]
pub async fn test_database_connection(engine: String, url: String) -> Result<(), String> {
    let sql = match engine.as_str() {
        "postgres" | "mysql" | "sqlite" => "SELECT 1",
        _ => return Err(format!("Unsupported engine: {engine}")),
    };
    run_query(&engine, &url, sql).await.map(|_| ())
}

#[tauri::command]
pub async fn database_capabilities(
    state: State<'_, AppState>,
    name: String,
) -> Result<CatalogCapabilities, String> {
    let database = connection(&state, &name).await?;
    let object_kinds = match database.engine.as_str() {
        "postgres" => vec![
            "table",
            "view",
            "materializedView",
            "function",
            "procedure",
            "sequence",
        ],
        "mysql" => vec!["table", "view", "function", "procedure"],
        "sqlite" => vec!["table", "view"],
        other => return Err(format!("Unsupported engine: {other}")),
    };
    Ok(CatalogCapabilities {
        object_kinds: object_kinds.into_iter().map(str::to_string).collect(),
        table_details: ["columns", "indexes", "constraints", "triggers"]
            .into_iter()
            .map(str::to_string)
            .collect(),
    })
}

async fn schemas_for(database: &DatabaseDef) -> Result<Vec<String>, String> {
    match database.engine.as_str() {
        "sqlite" => {
            run_query("sqlite", &database.url, "SELECT 1").await?;
            Ok(vec!["main".to_string()])
        }
        "postgres" => {
            let result = run_query("postgres", &database.url,
                "SELECT schema_name FROM information_schema.schemata WHERE schema_name <> 'information_schema' AND schema_name NOT LIKE 'pg_%' ORDER BY schema_name").await?;
            Ok(first_strings(result))
        }
        "mysql" => {
            let result = run_query("mysql", &database.url, "SELECT DATABASE()").await?;
            Ok(first_strings(result))
        }
        other => Err(format!("Unsupported engine: {other}")),
    }
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

fn sql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn quote_identifier(value: &str, engine: &str) -> String {
    if engine == "mysql" {
        format!("`{}`", value.replace('`', "``"))
    } else {
        format!("\"{}\"", value.replace('"', "\"\""))
    }
}

fn cap_definition(value: String) -> Option<String> {
    if value.is_empty() {
        None
    } else if value.chars().count() <= 65_536 {
        Some(value)
    } else {
        Some(format!(
            "{}\n-- Definition truncated by NoMoreIDE.",
            value.chars().take(65_536).collect::<String>()
        ))
    }
}

fn terminate_statement(value: &str) -> String {
    let statement = value.trim().trim_end_matches(';');
    format!("{statement};")
}

async fn objects_for(database: &DatabaseDef, schema: &str) -> Result<Vec<CatalogObject>, String> {
    if !schemas_for(database)
        .await?
        .iter()
        .any(|candidate| candidate == schema)
    {
        return Err("Schema was not found in the live catalog".to_string());
    }
    let schema_literal = sql_literal(schema);
    let mut objects = Vec::new();
    match database.engine.as_str() {
        "sqlite" => {
            let result = run_query("sqlite", &database.url,
                "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name").await?;
            for row in result.rows {
                let Some(name) = row.first().and_then(Value::as_str) else {
                    continue;
                };
                let Some(kind) = row.get(1).and_then(Value::as_str) else {
                    continue;
                };
                objects.push(make_object(CatalogIdentity {
                    schema: "main".into(),
                    name: name.into(),
                    kind: kind.into(),
                    native_id: None,
                })?);
            }
        }
        "postgres" => {
            let sql = format!("SELECT c.relname, c.relkind::text, c.oid::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname={schema_literal} AND c.relkind IN ('r','p','v','m','S') ORDER BY c.relname");
            let result = run_query("postgres", &database.url, &sql).await?;
            for row in result.rows {
                let Some(name) = row.first().and_then(Value::as_str) else {
                    continue;
                };
                let kind = match row.get(1).and_then(Value::as_str) {
                    Some("v") => "view",
                    Some("m") => "materializedView",
                    Some("S") => "sequence",
                    _ => "table",
                };
                objects.push(make_object(CatalogIdentity {
                    schema: schema.into(),
                    name: name.into(),
                    kind: kind.into(),
                    native_id: row.get(2).and_then(Value::as_str).map(str::to_string),
                })?);
            }
            let sql = format!("SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', p.prokind::text, p.oid::text FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname={schema_literal} AND p.prokind IN ('f','p') ORDER BY p.proname");
            let result = run_query("postgres", &database.url, &sql).await?;
            for row in result.rows {
                let Some(name) = row.first().and_then(Value::as_str) else {
                    continue;
                };
                let kind = if row.get(1).and_then(Value::as_str) == Some("p") {
                    "procedure"
                } else {
                    "function"
                };
                objects.push(make_object(CatalogIdentity {
                    schema: schema.into(),
                    name: name.into(),
                    kind: kind.into(),
                    native_id: row.get(2).and_then(Value::as_str).map(str::to_string),
                })?);
            }
        }
        "mysql" => {
            let sql = format!("SELECT table_name, table_type FROM information_schema.tables WHERE table_schema={schema_literal} ORDER BY table_name");
            let result = run_query("mysql", &database.url, &sql).await?;
            for row in result.rows {
                let Some(name) = row.first().and_then(Value::as_str) else {
                    continue;
                };
                let kind = if row.get(1).and_then(Value::as_str) == Some("VIEW") {
                    "view"
                } else {
                    "table"
                };
                objects.push(make_object(CatalogIdentity {
                    schema: schema.into(),
                    name: name.into(),
                    kind: kind.into(),
                    native_id: None,
                })?);
            }
            let sql = format!("SELECT routine_name, routine_type FROM information_schema.routines WHERE routine_schema={schema_literal} ORDER BY routine_name");
            let result = run_query("mysql", &database.url, &sql).await?;
            for row in result.rows {
                let Some(name) = row.first().and_then(Value::as_str) else {
                    continue;
                };
                let kind = if row.get(1).and_then(Value::as_str) == Some("PROCEDURE") {
                    "procedure"
                } else {
                    "function"
                };
                objects.push(make_object(CatalogIdentity {
                    schema: schema.into(),
                    name: name.into(),
                    kind: kind.into(),
                    native_id: None,
                })?);
            }
        }
        other => return Err(format!("Unsupported engine: {other}")),
    }
    Ok(objects)
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

async fn resolve_object(database: &DatabaseDef, key: &str) -> Result<CatalogObject, String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(key)
        .map_err(|_| "Invalid database object key".to_string())?;
    let identity: CatalogIdentity =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid database object key".to_string())?;
    objects_for(database, &identity.schema)
        .await?
        .into_iter()
        .find(|object| object.key == key)
        .ok_or_else(|| "Database object was not found in the live catalog".to_string())
}

fn value_as_bool(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => value.as_i64().unwrap_or(0) != 0,
        Some(Value::String(value)) => {
            matches!(value.as_str(), "t" | "true" | "YES")
                || value.parse::<i64>().is_ok_and(|value| value != 0)
        }
        _ => false,
    }
}

async fn columns_for(
    database: &DatabaseDef,
    object: &CatalogObject,
) -> Result<Vec<ColumnInfo>, String> {
    match database.engine.as_str() {
        "sqlite" => {
            let result = run_query(
                "sqlite",
                &database.url,
                &format!(
                    "SELECT CAST(name AS TEXT), CAST(type AS TEXT), CAST(\"notnull\" AS TEXT), CAST(pk AS TEXT) FROM pragma_table_info({}) ORDER BY cid",
                    sql_literal(&object.name)
                ),
            )
            .await?;
            Ok(result
                .rows
                .into_iter()
                .filter_map(|row| {
                    Some(ColumnInfo {
                        name: row.first()?.as_str()?.to_string(),
                        data_type: row.get(1).and_then(Value::as_str).unwrap_or("").to_string(),
                        nullable: !value_as_bool(row.get(2)),
                        primary_key: value_as_bool(row.get(3)),
                    })
                })
                .collect())
        }
        "mysql" => {
            let result = run_query(
                "mysql",
                &database.url,
                &format!(
                    "SELECT column_name, column_type, IF(is_nullable='YES','1','0'), IF(column_key='PRI','1','0') FROM information_schema.columns WHERE table_schema={} AND table_name={} ORDER BY ordinal_position",
                    sql_literal(&object.schema),
                    sql_literal(&object.name)
                ),
            )
            .await?;
            Ok(result
                .rows
                .into_iter()
                .filter_map(|row| {
                    Some(ColumnInfo {
                        name: row.first()?.as_str()?.to_string(),
                        data_type: row.get(1).and_then(Value::as_str).unwrap_or("").to_string(),
                        nullable: value_as_bool(row.get(2)),
                        primary_key: value_as_bool(row.get(3)),
                    })
                })
                .collect())
        }
        "postgres" => {
            let oid = object
                .native_id
                .as_deref()
                .ok_or_else(|| "Postgres object has no live catalog identity".to_string())?;
            let oid = oid
                .parse::<u64>()
                .map_err(|_| "Invalid Postgres object identity".to_string())?;
            let result = run_query(
                "postgres",
                &database.url,
                &format!(
                    "SELECT a.attname, format_type(a.atttypid,a.atttypmod), NOT a.attnotnull, EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=a.attrelid AND i.indisprimary AND a.attnum=ANY(i.indkey)) FROM pg_attribute a WHERE a.attrelid={oid}::oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum"
                ),
            )
            .await?;
            Ok(result
                .rows
                .into_iter()
                .filter_map(|row| {
                    Some(ColumnInfo {
                        name: row.first()?.as_str()?.to_string(),
                        data_type: row.get(1).and_then(Value::as_str).unwrap_or("").to_string(),
                        nullable: value_as_bool(row.get(2)),
                        primary_key: value_as_bool(row.get(3)),
                    })
                })
                .collect())
        }
        other => Err(format!("Unsupported engine: {other}")),
    }
}

#[tauri::command]
pub async fn get_database_object_details(
    state: State<'_, AppState>,
    name: String,
    key: String,
) -> Result<ObjectDetails, String> {
    let database = connection(&state, &name).await?;
    let object = resolve_object(&database, &key).await?;
    let mut details = ObjectDetails {
        object: object.clone(),
        columns: vec![],
        indexes: vec![],
        constraints: vec![],
        triggers: vec![],
        definition: None,
        create_script: None,
    };
    if matches!(object.kind.as_str(), "table" | "view" | "materializedView") {
        details.columns = columns_for(&database, &object).await?;
    }
    if database.engine == "sqlite" {
        let quoted = quote_identifier(&object.name, "sqlite");
        let name_literal = sql_literal(&object.name);
        let definition = run_query("sqlite", &database.url, &format!("SELECT sql FROM sqlite_master WHERE name={name_literal} AND type IN ('table','view')")).await?;
        details.definition = definition
            .rows
            .first()
            .and_then(|row| row.first())
            .and_then(Value::as_str)
            .map(|value| value.chars().take(65_536).collect());
        let script_parts = run_query(
            "sqlite",
            &database.url,
            &format!(
                "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND ((type IN ('table','view') AND name={name_literal}) OR (type IN ('index','trigger') AND tbl_name={name_literal})) ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name"
            ),
        )
        .await?;
        details.create_script = cap_definition(
            script_parts
                .rows
                .iter()
                .filter_map(|row| row.first().and_then(Value::as_str))
                .map(terminate_statement)
                .collect::<Vec<_>>()
                .join("\n\n"),
        );
        let indexes = run_query(
            "sqlite",
            &database.url,
            &format!("PRAGMA index_list({quoted})"),
        )
        .await?;
        details.indexes = indexes
            .rows
            .into_iter()
            .filter_map(|row| {
                Some(NamedDefinition {
                    name: row.get(1)?.as_str()?.into(),
                    definition: String::new(),
                    unique: Some(row.get(2).and_then(Value::as_i64).unwrap_or(0) == 1),
                    r#type: None,
                })
            })
            .collect();
        let triggers = run_query("sqlite", &database.url, &format!("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name={name_literal} ORDER BY name")).await?;
        details.triggers = triggers
            .rows
            .into_iter()
            .filter_map(|row| {
                Some(NamedDefinition {
                    name: row.first()?.as_str()?.into(),
                    definition: row.get(1).and_then(Value::as_str).unwrap_or("").into(),
                    unique: None,
                    r#type: None,
                })
            })
            .collect();
        if details.columns.iter().any(|column| column.primary_key) {
            details.constraints.push(NamedDefinition {
                name: format!("pk_{}", object.name),
                definition: "PRIMARY KEY".into(),
                unique: None,
                r#type: Some("PRIMARY KEY".into()),
            });
        }
    } else if database.engine == "mysql" {
        let qualified = format!(
            "{}.{}",
            quote_identifier(&object.schema, "mysql"),
            quote_identifier(&object.name, "mysql")
        );
        let object_type = match object.kind.as_str() {
            "view" => "VIEW",
            "function" => "FUNCTION",
            "procedure" => "PROCEDURE",
            _ => "TABLE",
        };
        if let Ok(result) = run_query(
            "mysql",
            &database.url,
            &format!("SHOW CREATE {object_type} {qualified}"),
        )
        .await
        {
            details.create_script = result
                .rows
                .first()
                .and_then(|row| row.get(1))
                .and_then(Value::as_str)
                .map(terminate_statement)
                .and_then(cap_definition);
        }
    } else if database.engine == "postgres" {
        let oid = object
            .native_id
            .as_deref()
            .ok_or_else(|| "Postgres object has no live catalog identity".to_string())?;
        let oid = oid
            .parse::<u64>()
            .map_err(|_| "Invalid Postgres object identity".to_string())?;
        let qualified = format!(
            "{}.{}",
            quote_identifier(&object.schema, "postgres"),
            quote_identifier(&object.name, "postgres")
        );
        let script = match object.kind.as_str() {
            "function" | "procedure" => first_value(run_query(
                    "postgres",
                    &database.url,
                    &format!("SELECT pg_get_functiondef({oid}::oid)"),
                )
                .await?)
                .map(|value| terminate_statement(&value)),
            "view" | "materializedView" => {
                let definition = first_value(run_query(
                    "postgres",
                    &database.url,
                    &format!("SELECT pg_get_viewdef({oid}::oid, true)"),
                )
                .await?);
                definition.map(|body| {
                    let materialized = if object.kind == "materializedView" {
                        "MATERIALIZED "
                    } else {
                        ""
                    };
                    terminate_statement(&format!(
                        "CREATE {materialized}VIEW {qualified} AS\n{}",
                        body.trim().trim_end_matches(';')
                    ))
                })
            }
            "sequence" => first_value(run_query(
                "postgres",
                &database.url,
                &format!(
                    "SELECT 'CREATE SEQUENCE {qualified}' || E'\\n  AS ' || format_type(seqtypid,NULL) || E'\\n  INCREMENT BY ' || seqincrement || E'\\n  MINVALUE ' || seqmin || E'\\n  MAXVALUE ' || seqmax || E'\\n  START WITH ' || seqstart || E'\\n  CACHE ' || seqcache || CASE WHEN seqcycle THEN E'\\n  CYCLE;' ELSE E'\\n  NO CYCLE;' END FROM pg_catalog.pg_sequence WHERE seqrelid={oid}::oid"
                ),
            )
            .await?),
            _ => postgres_table_script(&database, oid).await?,
        };
        details.create_script = script.and_then(cap_definition);
    }
    Ok(details)
}

fn first_value(result: QueryResult) -> Option<String> {
    result
        .rows
        .first()
        .and_then(|row| row.first())
        .and_then(Value::as_str)
        .map(str::to_string)
}

async fn postgres_table_script(database: &DatabaseDef, oid: u64) -> Result<Option<String>, String> {
    let create = first_value(
        run_query(
            "postgres",
            &database.url,
            &format!(
                r#"SELECT 'CREATE TABLE ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname) || E' (\n' ||
                   string_agg(
                     '  ' || quote_ident(a.attname) || ' ' || format_type(a.atttypid,a.atttypmod) ||
                     CASE WHEN a.attgenerated='s' THEN ' GENERATED ALWAYS AS (' || pg_get_expr(d.adbin,d.adrelid) || ') STORED'
                          WHEN a.attidentity='a' THEN ' GENERATED ALWAYS AS IDENTITY'
                          WHEN a.attidentity='d' THEN ' GENERATED BY DEFAULT AS IDENTITY'
                          WHEN d.adbin IS NOT NULL THEN ' DEFAULT ' || pg_get_expr(d.adbin,d.adrelid)
                          ELSE '' END || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END,
                     E',\n' ORDER BY a.attnum
                   ) || COALESCE((
                     SELECT E',\n' || string_agg('  CONSTRAINT ' || quote_ident(k.conname) || ' ' || pg_get_constraintdef(k.oid,true), E',\n' ORDER BY k.conname)
                     FROM pg_constraint k WHERE k.conrelid=c.oid
                   ), '') || E'\n);'
              FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
              JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
              LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
             WHERE c.oid={oid}::oid GROUP BY c.oid,n.nspname,c.relname"#
            ),
        )
        .await?,
    );
    let Some(create) = create else {
        return Ok(None);
    };
    let indexes = run_query(
        "postgres",
        &database.url,
        &format!(
            "SELECT pg_get_indexdef(i.indexrelid) FROM pg_index i WHERE i.indrelid={oid}::oid AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid=i.indexrelid) ORDER BY i.indexrelid"
        ),
    )
    .await?;
    let triggers = run_query(
        "postgres",
        &database.url,
        &format!(
            "SELECT pg_get_triggerdef(t.oid,true) FROM pg_trigger t WHERE t.tgrelid={oid}::oid AND NOT t.tgisinternal ORDER BY t.tgname"
        ),
    )
    .await?;
    let mut parts = vec![create];
    parts.extend(
        indexes
            .rows
            .iter()
            .chain(triggers.rows.iter())
            .filter_map(|row| row.first().and_then(Value::as_str))
            .map(terminate_statement),
    );
    Ok(Some(parts.join("\n\n")))
}

#[tauri::command]
pub async fn sample_database_object(
    state: State<'_, AppState>,
    name: String,
    key: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<ObjectRows, String> {
    let database = connection(&state, &name).await?;
    let object = resolve_object(&database, &key).await?;
    if !matches!(object.kind.as_str(), "table" | "view" | "materializedView") {
        return Err("This database object cannot be sampled".into());
    }
    let limit = limit.unwrap_or(100).clamp(1, 5_000);
    let offset = offset.unwrap_or(0).max(0);
    let table = if database.engine == "sqlite" {
        quote_identifier(&object.name, &database.engine)
    } else {
        format!(
            "{}.{}",
            quote_identifier(&object.schema, &database.engine),
            quote_identifier(&object.name, &database.engine)
        )
    };
    let columns = columns_for(&database, &object).await?;
    let projection = columns
        .iter()
        .map(|column| sample_column_expression(&database.engine, column))
        .collect::<Vec<_>>()
        .join(", ");
    let result = run_query(
        &database.engine,
        &database.url,
        &format!("SELECT {projection} FROM {table} LIMIT {limit} OFFSET {offset}"),
    )
    .await?;
    let rows = result
        .rows
        .into_iter()
        .map(|row| {
            result
                .columns
                .iter()
                .cloned()
                .zip(row)
                .map(|(column, value)| {
                    let value = if is_sensitive_preview_column(&column) && !value.is_null() {
                        Value::String("••••".into())
                    } else {
                        value
                    };
                    (column, value)
                })
                .collect::<serde_json::Map<String, Value>>()
        })
        .collect::<Vec<_>>();
    let row_count = rows.len();
    Ok(ObjectRows {
        engine: database.engine,
        object: object.clone(),
        table: json!({ "schema": if object.schema == "main" { Value::Null } else { json!(object.schema) }, "name": object.name, "qualifiedName": object.qualified_name }),
        columns,
        rows,
        row_count,
        limit,
        offset,
    })
}

fn sample_column_expression(engine: &str, column: &ColumnInfo) -> String {
    let identifier = quote_identifier(&column.name, engine);
    if !column.primary_key {
        return identifier;
    }
    match engine {
        "postgres" => format!("{identifier}::text AS {identifier}"),
        "mysql" => format!("CAST({identifier} AS CHAR) AS {identifier}"),
        _ => format!("CAST({identifier} AS TEXT) AS {identifier}"),
    }
}

fn validate_delete_keys(
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

fn delete_sql(engine: &str, object: &CatalogObject, primary_keys: &[&ColumnInfo]) -> String {
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

fn is_sensitive_preview_column(column: &str) -> bool {
    let normalized = column.to_ascii_lowercase();
    let parts = normalized.split('_').collect::<Vec<_>>();
    parts.iter().any(|part| {
        matches!(
            *part,
            "password"
                | "passwd"
                | "pwd"
                | "secret"
                | "token"
                | "credential"
                | "authorization"
                | "cookie"
        )
    }) || normalized.contains("api_key")
        || normalized.contains("apikey")
        || normalized.contains("access_key")
        || normalized.contains("accesskey")
        || normalized.contains("private_key")
        || normalized.contains("privatekey")
}

fn first_strings(result: QueryResult) -> Vec<String> {
    result
        .rows
        .into_iter()
        .filter_map(|row| row.into_iter().next()?.as_str().map(str::to_string))
        .collect()
}

async fn run_query(engine: &str, url: &str, sql: &str) -> Result<QueryResult, String> {
    match engine {
        "postgres" => query_postgres(url, sql).await,
        "sqlite" => query_sqlite(url, sql).await,
        "mysql" => query_mysql(url, sql).await,
        _ => Err(format!("Unsupported engine: {engine}")),
    }
}

async fn run_execute(engine: &str, url: &str, sql: &str, commit: bool) -> Result<u64, String> {
    match engine {
        "postgres" => execute_postgres(url, sql, commit).await,
        "sqlite" => execute_sqlite(url, sql, commit).await,
        "mysql" => execute_mysql(url, sql, commit).await,
        _ => Err(format!("Unsupported engine: {engine}")),
    }
}

fn key_value_as_text(value: &Value, engine: &str) -> Result<String, String> {
    match value {
        Value::String(value) => Ok(value.clone()),
        Value::Bool(value) if engine == "postgres" => Ok(value.to_string()),
        Value::Bool(value) => Ok(if *value { "1" } else { "0" }.to_string()),
        Value::Number(value) => Ok(value.to_string()),
        _ => Err("Unsupported primary-key value".to_string()),
    }
}

async fn delete_rows_bound(
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

fn ensure_expected_affected(affected: u64, expected: Option<u64>) -> Result<(), String> {
    if let Some(expected) = expected {
        if affected != expected {
            return Err(format!(
                "Delete affected {affected} rows, but the preview expected {expected}; no changes were committed"
            ));
        }
    }
    Ok(())
}

async fn list_db_tables(engine: &str, url: &str) -> Result<Vec<String>, String> {
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

    fn sqlite_fixture_url() -> (std::path::PathBuf, String) {
        let path =
            std::env::temp_dir().join(format!("nomoreide-catalog-{}.db", uuid::Uuid::new_v4()));
        std::fs::File::create(&path).unwrap();
        let url = format!("sqlite://{}", path.display());
        (path, url)
    }

    #[tokio::test]
    async fn sqlite_catalog_uses_opaque_live_keys() {
        let (path, url) = sqlite_fixture_url();
        execute_sqlite(
            &url,
            "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL)",
            true,
        )
        .await
        .unwrap();
        let database = DatabaseDef {
            name: "app".into(),
            engine: "sqlite".into(),
            url: url.clone(),
            write_unlocked: None,
            project_path: Some("/workspace/app".into()),
        };
        let objects = objects_for(&database, "main").await.unwrap();
        let users = objects
            .iter()
            .find(|object| object.name == "users")
            .unwrap();
        assert!(!users.key.contains("users"));
        assert_eq!(resolve_object(&database, &users.key).await.unwrap(), *users);
        assert!(resolve_object(&database, "dXNlcnM").await.is_err());
        let _ = std::fs::remove_file(path);
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
        let result = query_sqlite(&url, "SELECT id FROM users").await.unwrap();
        assert_eq!(result.row_count, 1);
        assert_eq!(result.rows[0][0], json!(1));
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn sqlite_columns_preserve_type_and_primary_key_metadata() {
        let (path, url) = sqlite_fixture_url();
        execute_sqlite(
            &url,
            "CREATE TABLE memberships (team_id INTEGER NOT NULL, user_id TEXT NOT NULL, label TEXT, PRIMARY KEY (team_id, user_id))",
            true,
        )
        .await
        .unwrap();
        execute_sqlite(
            &url,
            "INSERT INTO memberships (team_id, user_id) VALUES (9007199254740993, 'one')",
            true,
        )
        .await
        .unwrap();
        let database = DatabaseDef {
            name: "app".into(),
            engine: "sqlite".into(),
            url,
            write_unlocked: Some(true),
            project_path: None,
        };
        let object = objects_for(&database, "main")
            .await
            .unwrap()
            .into_iter()
            .find(|object| object.name == "memberships")
            .unwrap();
        let columns = columns_for(&database, &object).await.unwrap();
        assert_eq!(columns[0].data_type, "INTEGER");
        assert!(columns[0].primary_key);
        assert!(columns[1].primary_key);
        assert!(!columns[2].primary_key);
        assert!(columns[2].nullable);
        let projection = columns
            .iter()
            .map(|column| sample_column_expression("sqlite", column))
            .collect::<Vec<_>>()
            .join(", ");
        let sampled = query_sqlite(
            &database.url,
            &format!("SELECT {projection} FROM memberships"),
        )
        .await
        .unwrap();
        assert_eq!(sampled.rows[0][0], Value::String("9007199254740993".into()));
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
        let columns = vec![
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
            query_sqlite(&url, "SELECT team_id FROM memberships")
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
            query_sqlite(&url, "SELECT team_id FROM memberships")
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

    #[test]
    fn primary_keys_are_sampled_as_lossless_text() {
        let column = ColumnInfo {
            name: "id".into(),
            data_type: "BIGINT".into(),
            nullable: false,
            primary_key: true,
        };
        assert_eq!(
            sample_column_expression("postgres", &column),
            "\"id\"::text AS \"id\"",
        );
        assert_eq!(
            sample_column_expression("sqlite", &column),
            "CAST(\"id\" AS TEXT) AS \"id\"",
        );
    }
}
