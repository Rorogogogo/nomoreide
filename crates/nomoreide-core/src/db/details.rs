//! One object's full shape, assembled from whatever the engine can tell us.
//!
//! Each engine answers a different subset — SQLite keeps the original DDL,
//! Postgres can reconstruct one, MySQL reports its own — so this asks each in
//! its own dialect and normalises the answers into [`ObjectDetails`]. A
//! definition is capped rather than truncated silently: a generated create
//! script for a wide table can be enormous, and an agent reading a cut-off one
//! should be able to see that it was cut.

use super::catalog::{columns_for, postgres_table_script, resolve_object};
use super::engine::run_query;
use super::sql::{cap_definition, first_value, quote_identifier, sql_literal, terminate_statement};
use super::types::{NamedDefinition, ObjectDetails};
use crate::config::DatabaseDef;
use serde_json::Value;

/// Columns, indexes, constraints, triggers, and a capped create script for one
/// object named by the opaque key a listing handed out.
pub async fn object_details(database: &DatabaseDef, key: &str) -> Result<ObjectDetails, String> {
    let object = resolve_object(database, key).await?;
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
        details.columns = columns_for(database, &object).await?;
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
            _ => postgres_table_script(database, oid).await?,
        };
        details.create_script = script.and_then(cap_definition);
    }
    Ok(details)
}
