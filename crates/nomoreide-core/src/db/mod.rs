//! Read-only access to the databases a user has registered.
//!
//! The read-safe half of the database layer, and the one an agent reaches. It
//! can list connections, read a catalog, and sample rows; it cannot change
//! anything. Everything that can is in `nomoreide-actions`, behind a per
//! connection unlock and an affected-rows preview a human has to look at.
//!
//! Two things here are load-bearing rather than cosmetic. A connection URL is
//! masked before it leaves this module, because a registered database's URL
//! carries its password and the agent asking for the list has no business
//! reading it. And a column whose *name* suggests a secret is replaced with
//! bullets in a sample, so a peek at a users table does not hand back everyone's
//! password hash.
//!
//! Moved out of the Tauri command module; the desktop app now calls in here.

mod catalog;
mod details;
mod engine;
mod rows;
mod sql;
mod types;

pub use catalog::{columns_for, objects_for, resolve_object, schemas_for};
pub use details::object_details;
pub use engine::{hex_bytes, list_db_tables, lossless_json_integer, run_query};
pub use rows::{row_browse_clauses, sample_object};
pub use sql::{is_sensitive_preview_column, quote_identifier, sample_column_expression};
pub use types::{
    CatalogCapabilities, CatalogObject, ColumnInfo, NamedDefinition, ObjectDetails, ObjectRows,
    QueryResult, RowBrowseQuery, RowFilter, RowSort,
};

use crate::config::{Config, DatabaseDef};
use serde_json::{json, Value};

/// The connection a name refers to, or a refusal naming it.
pub fn connection<'a>(config: &'a Config, name: &str) -> Result<&'a DatabaseDef, String> {
    config
        .databases
        .iter()
        .find(|database| database.name == name)
        .ok_or_else(|| format!("Database '{name}' not found"))
}

/// Every registered connection, with its URL masked.
pub fn list_connections(config: &Config) -> Vec<Value> {
    config
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
        .collect()
}

/// Check that a connection can be reached, without saying anything about it.
pub async fn test_connection(engine: &str, url: &str) -> Result<(), String> {
    let sql = match engine {
        "postgres" | "mysql" | "sqlite" => "SELECT 1",
        _ => return Err(format!("Unsupported engine: {engine}")),
    };
    run_query(engine, url, sql).await.map(|_| ())
}

/// Which object kinds and table details this engine can be asked about.
pub fn capabilities(engine: &str) -> Result<CatalogCapabilities, String> {
    let object_kinds = match engine {
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

pub fn mask_url(engine: &str, url: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::DatabaseDef;

    fn sqlite_fixture_url() -> (std::path::PathBuf, String) {
        let path =
            std::env::temp_dir().join(format!("nomoreide-catalog-{}.db", uuid::Uuid::new_v4()));
        std::fs::File::create(&path).unwrap();
        let url = format!("sqlite://{}", path.display());
        (path, url)
    }

    /// Set a fixture up without borrowing the write-capable crate: these tests
    /// are about reading a catalog, and depending on `nomoreide-actions` to
    /// build one would invert the dependency the split exists to enforce.
    async fn seed(url: &str, statements: &[&str]) {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .connect(url)
            .await
            .unwrap();
        for statement in statements {
            sqlx::query(statement).execute(&pool).await.unwrap();
        }
        pool.close().await;
    }

    #[tokio::test]
    async fn sqlite_catalog_uses_opaque_live_keys() {
        let (path, url) = sqlite_fixture_url();
        seed(
            &url,
            &["CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL)"],
        )
        .await;
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
    async fn sqlite_columns_preserve_type_and_primary_key_metadata() {
        let (path, url) = sqlite_fixture_url();
        seed(&url, &["CREATE TABLE memberships (team_id INTEGER NOT NULL, user_id TEXT NOT NULL, label TEXT, PRIMARY KEY (team_id, user_id))"]).await;
        seed(
            &url,
            &["INSERT INTO memberships (team_id, user_id) VALUES (9007199254740993, 'one')"],
        )
        .await;
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
        let sampled = run_query(
            "sqlite",
            &database.url,
            &format!("SELECT {projection} FROM memberships"),
        )
        .await
        .unwrap();
        assert_eq!(sampled.rows[0][0], Value::String("9007199254740993".into()));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn browser_filters_validate_columns_and_escape_like_wildcards() {
        let columns = vec![
            ColumnInfo {
                name: "id".into(),
                data_type: "INTEGER".into(),
                nullable: false,
                primary_key: true,
            },
            ColumnInfo {
                name: "email".into(),
                data_type: "TEXT".into(),
                nullable: false,
                primary_key: false,
            },
        ];
        let (where_sql, order_sql) = row_browse_clauses(
            "sqlite",
            &columns,
            RowBrowseQuery {
                filters: vec![RowFilter {
                    column: "email".into(),
                    operator: "contains".into(),
                    value: Some("a%b_!".into()),
                }],
                sort: Some(RowSort {
                    column: "email".into(),
                    direction: "desc".into(),
                }),
            },
        )
        .unwrap();
        assert_eq!(where_sql, " WHERE \"email\" LIKE '%a!%b!_!!%' ESCAPE '!'");
        assert_eq!(order_sql, " ORDER BY \"email\" DESC, \"id\" ASC");
        assert!(row_browse_clauses(
            "sqlite",
            &columns,
            RowBrowseQuery {
                filters: vec![RowFilter {
                    column: "email; DROP TABLE users".into(),
                    operator: "eq".into(),
                    value: Some("x".into()),
                }],
                sort: None,
            },
        )
        .is_err());
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
