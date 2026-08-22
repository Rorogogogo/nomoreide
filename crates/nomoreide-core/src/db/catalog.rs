//! Reading a live database's catalog: schemas, objects, and one object's shape.
//!
//! Every engine keeps this information somewhere different — `pg_catalog`,
//! `information_schema`, `sqlite_master` — so each branch here is that engine's
//! own way of answering the same question. The answers are normalised into the
//! shared types so a caller never has to know which engine it asked.
//!
//! Moved out of the Tauri command module unchanged.

use super::engine::run_query;
use super::sql::{
    first_strings, first_value, make_object, sql_literal, terminate_statement, value_as_bool,
};
use super::types::{CatalogIdentity, CatalogObject, ColumnInfo};
use crate::config::DatabaseDef;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::Value;

pub async fn schemas_for(database: &DatabaseDef) -> Result<Vec<String>, String> {
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

pub async fn objects_for(
    database: &DatabaseDef,
    schema: &str,
) -> Result<Vec<CatalogObject>, String> {
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

pub async fn resolve_object(database: &DatabaseDef, key: &str) -> Result<CatalogObject, String> {
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

pub async fn columns_for(
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

pub(crate) async fn postgres_table_script(
    database: &DatabaseDef,
    oid: u64,
) -> Result<Option<String>, String> {
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
