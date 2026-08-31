//! The database read path an agent reaches, as distinct from the dashboard's.
//!
//! Both halves of the read-safe layer answer the same questions, but not with
//! the same words, and the difference is not cosmetic. The dashboard renders a
//! catalog into a table a person scrolls; an agent is handed a payload it has
//! to reason over. So a row is an object keyed by column name rather than a
//! positional array, and a statement that is not a read is answered with
//! instructions instead of an error. Keeping that in its own module is what
//! lets the dashboard's shapes change without changing what an agent has
//! already learned to expect.
//!
//! Nothing here can write. The engines enforce that underneath — a read-only
//! transaction on Postgres and MySQL, a read-only connection on SQLite — so
//! [`query`] does not have to be trusted to recognise every way to spell a
//! write. What it recognises is only used to decide *how* to refuse.

use super::catalog::{columns_for, objects_for, resolve_object, schemas_for};
use super::details::details_for;
use super::engine::{run_plan, QueryPlan};
use super::sql::quote_identifier;
use super::types::{CatalogObject, ColumnInfo, ObjectDetails};
use crate::config::DatabaseDef;
use serde::Serialize;
use serde_json::{json, Map, Value};

/// The default row cap. Both `sample` and `query` share it.
pub const DEFAULT_ROW_LIMIT: i64 = 100;

/// A table or view as the tool listing spells it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRef {
    pub name: String,
    pub qualified_name: String,
}

/// What [`query`] came back with.
pub enum QueryOutcome {
    Rows(Value),
    /// The statement was not run, and this is what to tell the agent instead.
    Guidance(String),
}

/// The connection a name refers to, refused in the reference's own words.
pub fn connection<'a>(databases: &'a [DatabaseDef], name: &str) -> Result<&'a DatabaseDef, String> {
    databases
        .iter()
        .find(|database| database.name == name)
        .ok_or_else(|| format!("Database connection \"{name}\" is not registered."))
}

pub async fn schemas(database: &DatabaseDef) -> Result<Vec<String>, String> {
    schemas_for(database).await
}

/// The objects in one schema, or nothing when the schema is not one of this
/// connection's. An unknown schema is empty rather than an error: the agent
/// asked what is in a place, and the answer is that nothing is.
pub async fn objects(database: &DatabaseDef, schema: &str) -> Result<Vec<CatalogObject>, String> {
    if !schemas_for(database)
        .await?
        .iter()
        .any(|candidate| candidate == schema)
    {
        return Ok(Vec::new());
    }
    objects_for(database, schema).await
}

pub async fn details(database: &DatabaseDef, key: &str) -> Result<ObjectDetails, String> {
    details_for(database, &resolve_object(database, key).await?).await
}

/// Every table and view this connection holds, in one flat list ordered the
/// way a schema listing would be.
pub async fn tables(database: &DatabaseDef) -> Result<Vec<TableRef>, String> {
    Ok(catalog_tables(database)
        .await?
        .into_iter()
        .map(|object| TableRef {
            name: object.name,
            qualified_name: object.qualified_name,
        })
        .collect())
}

/// Rows from one named table, with the column schema that explains them.
///
/// Deliberately *not* [`crate::db::sample_object`]: that one resolves an opaque
/// catalog key and bullets out a column whose name looks like a secret. This
/// one is reached by a table's own name and reports what is stored. Both are
/// the reference's, one per route, and unifying them would either hide a column
/// from a caller who named it or expose one to a caller who did not.
pub async fn sample(
    database: &DatabaseDef,
    table: &str,
    limit: i64,
    offset: i64,
) -> Result<Value, String> {
    let object = catalog_tables(database)
        .await?
        .into_iter()
        .find(|candidate| candidate.qualified_name == table)
        .ok_or_else(|| format!("Table \"{table}\" not found."))?;
    // The same bounds the browser's own row reader uses. A caller naming a
    // table can ask for as many rows as one paging through a catalog can.
    let limit = limit.clamp(1, 5_000);
    let offset = offset.max(0);
    let columns = columns_for(database, &object).await?;
    let sql = format!(
        "SELECT * FROM {} LIMIT {} OFFSET {offset}",
        qualified_sql(database, &object),
        placeholder(&database.engine)
    );
    let result = run_plan(
        &database.engine,
        &database.url,
        QueryPlan::peek(&sql, Some(limit)),
    )
    .await?;
    let rows = objectify(&result.columns, &result.rows);
    Ok(json!({
        "engine": database.engine,
        "table": TableRef {
            name: object.name,
            qualified_name: object.qualified_name,
        },
        "columns": columns,
        "rows": rows,
        "rowCount": rows.len(),
        "limit": limit,
        "offset": offset,
    }))
}

/// One caller-written statement, capped and wrapped.
///
/// The cap travels as a bind rather than as text in the statement, which is the
/// habit worth keeping even though the value is a validated integer. It is not
/// a guarantee: a statement that closes the wrapper's parenthesis and comments
/// out the rest of the line takes the cap with it, and what happens then is the
/// driver's business — SQLite runs the shortened statement, and the reference's
/// driver refuses it because a parameter it was handed no longer has a place to
/// go. Either way the connection is still read-only, so the worst case is a
/// caller returning more of their own rows than they asked for.
pub async fn run_capped_query(
    database: &DatabaseDef,
    sql: &str,
    limit: i64,
) -> Result<Value, String> {
    let statement = prepare_user_query(sql)?;
    let wrapped = format!(
        "SELECT * FROM ({statement}) LIMIT {}",
        placeholder(&database.engine)
    );
    let plan = QueryPlan::peek(&wrapped, Some(limit + 1));
    let result = run_plan(&database.engine, &database.url, plan).await?;
    let mut rows = objectify(&result.columns, &result.rows);
    let truncated = rows.len() as i64 > limit;
    rows.truncate(limit.max(0) as usize);
    let columns: Vec<Value> = result
        .columns
        .iter()
        .map(|name| {
            json!(ColumnInfo {
                name: name.clone(),
                // A query's columns are named by the statement, not by the
                // catalog, so nothing here knows their declared types.
                data_type: String::new(),
                nullable: true,
                primary_key: false,
            })
        })
        .collect();
    Ok(json!({
        "engine": database.engine,
        "columns": columns,
        "rows": rows,
        "rowCount": rows.len(),
        "truncated": truncated,
    }))
}

/// The same statement, answered the way an *agent* is answered.
///
/// The only difference from [`run_capped_query`] is what a failure becomes: a
/// refusal is worth more to an agent than the driver's complaint, but only when
/// the statement is one this connection was never going to run. A malformed
/// read is still just malformed. The dashboard's own query route wants the
/// driver's wording instead, so it takes the raw function.
pub async fn query(database: &DatabaseDef, sql: &str, limit: i64) -> Result<QueryOutcome, String> {
    match run_capped_query(database, sql, limit).await {
        Ok(rows) => Ok(QueryOutcome::Rows(rows)),
        Err(message) => {
            if !is_read_statement(sql) || mentions_read_only(&message) {
                Ok(QueryOutcome::Guidance(write_staging_guidance(
                    &database.name,
                )))
            } else {
                Err(message)
            }
        }
    }
}

/// A caller's statement, ready to be wrapped.
///
/// One trailing semicolon is dropped, because that is what a person typing into
/// a SQL console types and the wrapper would choke on it. Only one: a statement
/// that ends in two is two statements, and the second is the caller's to
/// explain.
fn prepare_user_query(sql: &str) -> Result<String, String> {
    let trimmed = sql.trim();
    let trimmed = trimmed.strip_suffix(';').unwrap_or(trimmed).trim();
    if trimmed.is_empty() {
        return Err("Query is empty.".to_string());
    }
    Ok(trimmed.to_string())
}

/// Whether a statement is one this connection would have run.
///
/// Deliberately a look at the first word and nothing more. It never decides
/// whether a statement is *safe* — the connection already decided that — only
/// whether a failure is worth explaining as a refusal. Reading further would
/// make it look like a security boundary, which it is not.
pub fn is_read_statement(sql: &str) -> bool {
    const READS: [&str; 6] = ["select", "show", "describe", "desc", "explain", "pragma"];
    let trimmed = sql.trim_start();
    READS.iter().any(|keyword| {
        trimmed.len() >= keyword.len()
            && trimmed[..keyword.len()].eq_ignore_ascii_case(keyword)
            && !trimmed[keyword.len()..]
                .chars()
                .next()
                .is_some_and(|next| next.is_alphanumeric() || next == '_')
    })
}

/// What to say instead of running a write.
pub fn write_staging_guidance(connection: &str) -> String {
    format!(
        "This connection is read-only, so that statement was NOT executed.\n\
         Provide the exact SQL statement for the user to review in a standard SQL\n\
         fenced block, and identify the target connection as `{connection}`:\n\
         \n\
         ```sql\n\
         UPDATE … SET … WHERE …;\n\
         ```\n\
         \n\
         Direct the user to stage and run it through NoMoreIDE's locked SQL console,\n\
         where they explicitly unlock writes and review an affected-rows preview\n\
         before committing. Emit exactly one statement, and always scope\n\
         UPDATE/DELETE with a WHERE clause."
    )
}

// ---------------------------------------------------------------------------

/// Every table and view across every schema, ordered by qualified name so that
/// the listing reads the same whether one schema holds it all or ten do.
async fn catalog_tables(database: &DatabaseDef) -> Result<Vec<CatalogObject>, String> {
    let mut tables = Vec::new();
    for schema in schemas_for(database).await? {
        tables.extend(
            objects_for(database, &schema)
                .await?
                .into_iter()
                .filter(|object| matches!(object.kind.as_str(), "table" | "view")),
        );
    }
    tables.sort_by(|left, right| left.qualified_name.cmp(&right.qualified_name));
    Ok(tables)
}

/// How this engine spells a bound value.
fn placeholder(engine: &str) -> &'static str {
    if engine == "postgres" {
        "$1"
    } else {
        "?"
    }
}

fn qualified_sql(database: &DatabaseDef, object: &CatalogObject) -> String {
    let name = quote_identifier(&object.name, &database.engine);
    if database.engine == "sqlite" {
        name
    } else {
        format!(
            "{}.{name}",
            quote_identifier(&object.schema, &database.engine)
        )
    }
}

/// Positional rows as objects keyed by whatever the driver called each column.
///
/// Nothing is done here about two columns sharing a name. SQLite has already
/// dealt with it — it suffixes a repeated result name with `:1`, `:2` — and on
/// an engine that has not, inventing a different suffix would only mean the two
/// runtimes handed an agent different keys for the same query.
fn objectify(columns: &[String], rows: &[Vec<Value>]) -> Vec<Map<String, Value>> {
    rows.iter()
        .map(|row| {
            columns
                .iter()
                .cloned()
                .zip(row.iter().cloned())
                .collect::<Map<String, Value>>()
        })
        .collect()
}

fn mentions_read_only(message: &str) -> bool {
    let lowered = message.to_ascii_lowercase();
    ["read only", "read-only", "readonly"]
        .iter()
        .any(|needle| lowered.contains(needle))
}
