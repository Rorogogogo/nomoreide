//! Reading rows out of one catalog object, with the browser's filters and sort.
//!
//! The filter and sort a caller sends name columns and an operator, never SQL:
//! a column is matched against the object's real columns before it is quoted
//! into a clause, so a filter cannot become a statement of its own.
//!
//! Moved out of the Tauri command module unchanged.

use super::catalog::{columns_for, resolve_object};
use super::engine::run_query;
use super::sql::{
    is_sensitive_preview_column, quote_identifier, sample_column_expression, sql_literal,
};
use super::types::{ColumnInfo, ObjectRows, RowBrowseQuery};
use crate::config::DatabaseDef;
use serde_json::{json, Value};
use std::collections::HashSet;

pub fn row_browse_clauses(
    engine: &str,
    columns: &[ColumnInfo],
    query: RowBrowseQuery,
) -> Result<(String, String), String> {
    if query.filters.len() > 8 {
        return Err("A maximum of 8 row filters is supported.".into());
    }
    let column_names = columns
        .iter()
        .map(|column| column.name.as_str())
        .collect::<HashSet<_>>();
    let mut filters = Vec::with_capacity(query.filters.len());
    for filter in query.filters {
        if !column_names.contains(filter.column.as_str()) {
            return Err(format!("Unknown filter column: {}", filter.column));
        }
        let column = quote_identifier(&filter.column, engine);
        let expression = match filter.operator.as_str() {
            "isNull" => format!("{column} IS NULL"),
            "isNotNull" => format!("{column} IS NOT NULL"),
            operator => {
                let mut value = filter
                    .value
                    .ok_or_else(|| "This row filter requires a value.".to_string())?;
                if value.chars().count() > 2_000 {
                    return Err("Row filter values must be 2,000 characters or fewer.".into());
                }
                let sql_operator = match operator {
                    "eq" => "=",
                    "neq" => "<>",
                    "gt" => ">",
                    "gte" => ">=",
                    "lt" => "<",
                    "lte" => "<=",
                    "contains" | "startsWith" | "endsWith" => {
                        value = value
                            .replace('!', "!!")
                            .replace('%', "!%")
                            .replace('_', "!_");
                        if operator != "startsWith" {
                            value.insert(0, '%');
                        }
                        if operator != "endsWith" {
                            value.push('%');
                        }
                        "LIKE"
                    }
                    _ => return Err(format!("Unsupported row filter operator: {operator}")),
                };
                let like_escape = if sql_operator == "LIKE" {
                    " ESCAPE '!'"
                } else {
                    ""
                };
                format!(
                    "{column} {sql_operator} {}{like_escape}",
                    sql_literal(&value)
                )
            }
        };
        filters.push(expression);
    }

    let mut order = Vec::new();
    if let Some(sort) = query.sort {
        if !column_names.contains(sort.column.as_str()) {
            return Err(format!("Unknown sort column: {}", sort.column));
        }
        let direction = match sort.direction.as_str() {
            "asc" => "ASC",
            "desc" => "DESC",
            _ => return Err("Sort direction must be asc or desc.".into()),
        };
        order.push((sort.column, direction));
    }
    for column in columns.iter().filter(|column| column.primary_key) {
        if !order.iter().any(|(name, _)| name == &column.name) {
            order.push((column.name.clone(), "ASC"));
        }
    }

    Ok((
        if filters.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", filters.join(" AND "))
        },
        if order.is_empty() {
            String::new()
        } else {
            format!(
                " ORDER BY {}",
                order
                    .into_iter()
                    .map(|(column, direction)| format!(
                        "{} {direction}",
                        quote_identifier(&column, engine)
                    ))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        },
    ))
}

/// Rows from one object, with the browser's filters and sort applied and any
/// column that looks like a secret bulleted out.
pub async fn sample_object(
    database: &DatabaseDef,
    key: &str,
    limit: Option<i64>,
    offset: Option<i64>,
    query: Option<RowBrowseQuery>,
) -> Result<ObjectRows, String> {
    let object = resolve_object(database, key).await?;
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
    let columns = columns_for(database, &object).await?;
    let projection = columns
        .iter()
        .map(|column| sample_column_expression(&database.engine, column))
        .collect::<Vec<_>>()
        .join(", ");
    let (where_sql, order_by_sql) =
        row_browse_clauses(&database.engine, &columns, query.unwrap_or_default())?;
    let result = run_query(
        &database.engine,
        &database.url,
        &format!(
            "SELECT {projection} FROM {table}{where_sql}{order_by_sql} LIMIT {limit} OFFSET {offset}"
        ),
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
        engine: database.engine.clone(),
        object: object.clone(),
        table: json!({ "schema": if object.schema == "main" { Value::Null } else { json!(object.schema) }, "name": object.name, "qualifiedName": object.qualified_name }),
        columns,
        rows,
        row_count,
        limit,
        offset,
    })
}
