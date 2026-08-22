//! The shapes a catalog read answers with.
//!
//! Moved verbatim out of the Tauri command module so the read-safe half of the
//! database layer can live in the core crate. The desktop app and the MCP
//! server now describe an object the same way, because they describe it with
//! the same struct.

use serde::{Deserialize, Serialize};
use serde_json::Value;

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
pub(crate) struct CatalogIdentity {
    pub(crate) schema: String,
    pub(crate) name: String,
    pub(crate) kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) native_id: Option<String>,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowFilter {
    pub column: String,
    pub operator: String,
    pub value: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowSort {
    pub column: String,
    pub direction: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowBrowseQuery {
    #[serde(default)]
    pub filters: Vec<RowFilter>,
    pub sort: Option<RowSort>,
}
