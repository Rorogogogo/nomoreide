//! The nine tools an agent uses to read a registered database.
//!
//! Every one of them is a read, and the one that looks like it might not be —
//! `nomoreide_db_query` — cannot write either: the connection it runs on is
//! opened read-only, so a write is refused by the engine rather than by a list
//! of forbidden words here. What this module adds on top of that refusal is the
//! *answer*: an agent that tried to change something is told how a human stages
//! a change, instead of being handed a driver error it can only retry.
//!
//! Registration is the exception that proves the split. It writes config, so it
//! lives beside the other registration tools in spirit — but what it writes is a
//! connection, and the URL it is given carries a password. That password is
//! stored and never reported: every payload here reports a masked URL, and the
//! tool that registers one reports the masked form of what it just saved.

use super::render;
use nomoreide_core::config::{ConfigStore, DatabaseDef};
use nomoreide_core::db::{
    capabilities, peek_connection, peek_details, peek_objects, peek_query, peek_sample,
    peek_schemas, peek_tables, public_connection, test_connection, QueryOutcome,
};
use serde_json::{json, Value};

pub(super) async fn list_databases(store: &ConfigStore) -> Result<String, String> {
    let config = store.load().await.map_err(|error| error.to_string())?;
    render(&nomoreide_core::db::list_connections(&config))
}

pub(super) async fn register_database(
    store: &ConfigStore,
    definition: DatabaseDef,
    check: bool,
    replace: bool,
) -> Result<String, String> {
    let config = store.load().await.map_err(|error| error.to_string())?;
    if !replace
        && config
            .databases
            .iter()
            .any(|existing| existing.name == definition.name)
    {
        return Err(format!(
            "Database connection \"{}\" already exists. Set replace=true to replace it.",
            definition.name
        ));
    }
    // Checked before it is saved, not after: a connection that cannot be
    // reached is more likely a typo than a database that is briefly down, and
    // saving it first would leave the typo in the config to be found later.
    if check {
        test_connection(&definition.engine, &definition.url).await?;
    }
    let saved = public_connection(&definition);
    store
        .register_database(definition)
        .await
        .map_err(|error| error.to_string())?;
    render(&saved)
}

pub(super) async fn check_database(store: &ConfigStore, name: &str) -> Result<String, String> {
    let config = store.load().await.map_err(|error| error.to_string())?;
    let database = peek_connection(&config.databases, name)?;
    test_connection(&database.engine, &database.url).await?;
    render(&json!({ "ok": true, "connection": public_connection(database) }))
}

pub(super) async fn db_schemas(store: &ConfigStore, name: &str) -> Result<String, String> {
    let config = store.load().await.map_err(|error| error.to_string())?;
    let database = peek_connection(&config.databases, name)?;
    let schemas: Vec<Value> = peek_schemas(database)
        .await?
        .into_iter()
        .map(|schema| json!({ "name": schema }))
        .collect();
    render(&json!({
        "schemas": schemas,
        "capabilities": capabilities(&database.engine)?,
    }))
}

pub(super) async fn db_objects(
    store: &ConfigStore,
    name: &str,
    schema: &str,
) -> Result<String, String> {
    let config = store.load().await.map_err(|error| error.to_string())?;
    let database = peek_connection(&config.databases, name)?;
    render(&peek_objects(database, schema).await?)
}

pub(super) async fn db_object_details(
    store: &ConfigStore,
    name: &str,
    key: &str,
) -> Result<String, String> {
    let config = store.load().await.map_err(|error| error.to_string())?;
    let database = peek_connection(&config.databases, name)?;
    render(&peek_details(database, key).await?)
}

pub(super) async fn db_tables(store: &ConfigStore, name: &str) -> Result<String, String> {
    let config = store.load().await.map_err(|error| error.to_string())?;
    let database = peek_connection(&config.databases, name)?;
    render(&peek_tables(database).await?)
}

pub(super) async fn db_sample(
    store: &ConfigStore,
    name: &str,
    table: &str,
    limit: i64,
) -> Result<String, String> {
    let config = store.load().await.map_err(|error| error.to_string())?;
    let database = peek_connection(&config.databases, name)?;
    // The tool takes no offset. The field is still reported, so that a caller
    // paging through the dashboard's row browser and a caller sampling here
    // read the same shape.
    render(&peek_sample(database, table, limit, 0).await?)
}

pub(super) async fn db_query(
    store: &ConfigStore,
    name: &str,
    sql: &str,
    limit: i64,
) -> Result<String, String> {
    let config = store.load().await.map_err(|error| error.to_string())?;
    let database = peek_connection(&config.databases, name)?;
    match peek_query(database, sql, limit).await? {
        QueryOutcome::Rows(rows) => render(&rows),
        // Prose, not JSON, and not an error either. The agent is being told
        // what to do next, and an error would only invite it to try again.
        QueryOutcome::Guidance(guidance) => Ok(guidance),
    }
}
