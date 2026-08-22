//! Building the SQL the catalog reads are made of, safely.
//!
//! Nothing here interpolates a value it has not quoted: a schema or table name
//! arrives from a catalog listing, but the listing itself is driven by a name
//! the caller chose, so every one of them goes through `sql_literal` or
//! `quote_identifier` on the way into a statement.

use super::types::{CatalogIdentity, CatalogObject, ColumnInfo, QueryResult};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::Value;

pub(crate) fn make_object(identity: CatalogIdentity) -> Result<CatalogObject, String> {
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

pub(crate) fn sql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

pub fn quote_identifier(value: &str, engine: &str) -> String {
    if engine == "mysql" {
        format!("`{}`", value.replace('`', "``"))
    } else {
        format!("\"{}\"", value.replace('"', "\"\""))
    }
}

pub(crate) fn cap_definition(value: String) -> Option<String> {
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

pub(crate) fn terminate_statement(value: &str) -> String {
    let statement = value.trim().trim_end_matches(';');
    format!("{statement};")
}

pub(crate) fn value_as_bool(value: Option<&Value>) -> bool {
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

pub(crate) fn first_value(result: QueryResult) -> Option<String> {
    result
        .rows
        .first()
        .and_then(|row| row.first())
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub(crate) fn first_strings(result: QueryResult) -> Vec<String> {
    result
        .rows
        .into_iter()
        .filter_map(|row| row.into_iter().next()?.as_str().map(str::to_string))
        .collect()
}

pub fn sample_column_expression(engine: &str, column: &ColumnInfo) -> String {
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

pub fn is_sensitive_preview_column(column: &str) -> bool {
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
