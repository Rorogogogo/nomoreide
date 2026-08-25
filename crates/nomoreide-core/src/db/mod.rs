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
mod peek;
mod rows;
mod sql;
mod types;

pub use catalog::{columns_for, objects_for, resolve_object, schemas_for};
pub use details::object_details;
pub use engine::{hex_bytes, list_db_tables, lossless_json_integer, run_query};
pub use peek::{
    connection as peek_connection, details as peek_details, is_read_statement,
    objects as peek_objects, query as peek_query, sample as peek_sample, schemas as peek_schemas,
    tables as peek_tables, write_staging_guidance, QueryOutcome, TableRef, DEFAULT_ROW_LIMIT,
};
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
    config.databases.iter().map(public_connection).collect()
}

/// One connection as every surface reports it: no raw URL, and no key at all
/// for a project path the connection does not have. An absent field and a null
/// one read differently to whatever is on the other end.
pub fn public_connection(database: &DatabaseDef) -> Value {
    let mut entry = json!({
        "name": database.name,
        "engine": database.engine,
        "url": mask_url(&database.engine, &database.url),
        "writeUnlocked": database.write_unlocked.unwrap_or(false),
    });
    if let Some(path) = &database.project_path {
        entry["projectPath"] = json!(path);
    }
    entry
}

/// One connection string found in a service's `.env`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedConnection {
    pub service: String,
    pub cwd: String,
    pub key: String,
    pub engine: String,
    /// **Unmasked, on purpose.** This is the one place a raw connection string
    /// leaves the server: the client has just been told a connection exists and
    /// needs the real value to register it, and has nowhere else to get it.
    pub url: String,
    pub masked_url: String,
}

/// Scan registered services' `.env` files for anything that looks like a
/// connection string.
///
/// Deduplicated by engine *and* value, so the same database named twice in one
/// file -- or shared between two services -- is offered once. The first
/// sighting wins, which keeps the result in the order the services are
/// registered rather than in whichever order the filesystem answered.
pub async fn detect_from_env(config: &Config) -> Vec<DetectedConnection> {
    let mut found = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for service in &config.services {
        let Some(cwd) = service.cwd.as_deref() else {
            continue;
        };
        let Ok(Some(lines)) = crate::env_file::read(std::path::Path::new(cwd).join(".env")).await
        else {
            continue;
        };
        for entry in crate::env_file::entries(&lines) {
            let Some(engine) = engine_from_url(&entry.value) else {
                continue;
            };
            if !seen.insert(format!("{engine}:{}", entry.value)) {
                continue;
            }
            found.push(DetectedConnection {
                service: service.name.clone(),
                cwd: cwd.to_string(),
                key: entry.key,
                engine: engine.to_string(),
                masked_url: mask_url(engine, &entry.value),
                url: entry.value,
            });
        }
    }
    found
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

/// A connection URL with its password removed.
///
/// A URL that parses keeps every part a person needs to recognise it — scheme,
/// user, host, port, database — and loses only the secret. One that does not
/// parse cannot be edited that precisely, so it is blanked down to its first
/// and last few characters: enough to tell two connections apart, not enough to
/// reconstruct either. Anything short enough that those two ends would be most
/// of it is replaced outright.
///
/// SQLite is left alone. Its "URL" is a path on the user's own disk and carries
/// no credential, and masking it would hide which file a connection reads.
pub fn mask_url(engine: &str, url: &str) -> String {
    if engine == "sqlite" {
        return url.to_string();
    }
    const KEPT_EDGE: usize = 4;
    match url::Url::parse(url) {
        Ok(mut parsed) => {
            if parsed
                .password()
                .is_some_and(|password| !password.is_empty())
            {
                let _ = parsed.set_password(Some("****"));
            }
            mask_sensitive_query(&mut parsed);
            parsed.to_string()
        }
        Err(_) => {
            let characters: Vec<char> = url.chars().collect();
            if characters.len() <= KEPT_EDGE * 2 {
                return "****".to_string();
            }
            let head: String = characters[..KEPT_EDGE].iter().collect();
            let tail: String = characters[characters.len() - KEPT_EDGE..].iter().collect();
            format!("{head}****{tail}")
        }
    }
}

/// Query-string fields that must never leave the machine in the clear.
///
/// The password is not always in the password slot. A connection string can
/// carry a second credential in its query -- `?password=`, `?token=`,
/// `?api_key=` -- and a mask that only rewrites the userinfo section hands that
/// one straight to the client. The pattern matches the reference's:
/// `password|passwd|secret|token|api[_-]?key`, case-insensitively, anywhere in
/// the key, so `apiKey` and `X-API-KEY` are both caught.
pub fn is_sensitive_connection_parameter(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    if lower.contains("password")
        || lower.contains("passwd")
        || lower.contains("secret")
        || lower.contains("token")
    {
        return true;
    }
    // `api key`, with an optional single `_` or `-` between the halves.
    let bytes = lower.as_bytes();
    for (index, _) in lower.match_indices("api") {
        let rest = &bytes[index + 3..];
        let rest = match rest.first() {
            Some(b'_') | Some(b'-') => &rest[1..],
            _ => rest,
        };
        if rest.starts_with(b"key") {
            return true;
        }
    }
    false
}

fn mask_sensitive_query(parsed: &mut url::Url) {
    let masked: Vec<(String, String)> = parsed
        .query_pairs()
        .map(|(key, value)| {
            let key = key.into_owned();
            let value = if is_sensitive_connection_parameter(&key) {
                "****".to_string()
            } else {
                value.into_owned()
            };
            (key, value)
        })
        .collect();
    if masked.is_empty() {
        return;
    }
    // Rebuilt wholesale rather than edited in place: the reference sets each
    // sensitive value through the same URLSearchParams object, which re-encodes
    // the whole query, so a value that arrived oddly encoded comes back
    // normalised on both sides.
    let mut serializer = parsed.query_pairs_mut();
    serializer.clear();
    for (key, value) in &masked {
        serializer.append_pair(key, value);
    }
    drop(serializer);
}

/// Guess an engine from a connection string or a bare file path.
pub fn engine_from_url(value: &str) -> Option<&'static str> {
    let trimmed = value.trim();
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("postgres://") || lower.starts_with("postgresql://") {
        return Some("postgres");
    }
    if lower.starts_with("mysql://") || lower.starts_with("mariadb://") {
        return Some("mysql");
    }
    if lower.starts_with("sqlite://") {
        return Some("sqlite");
    }
    // `file:` followed by at least one character and then a database suffix
    // *anywhere* after it -- the reference does not anchor this one to the end,
    // so `file:./app.db?mode=ro` still counts.
    if let Some(rest) = lower.strip_prefix("file:") {
        if !rest.is_empty()
            && [".db", ".sqlite", ".sqlite3"]
                .iter()
                .any(|ext| rest.contains(ext))
        {
            return Some("sqlite");
        }
    }
    if [".db", ".sqlite", ".sqlite3"]
        .iter()
        .any(|ext| lower.ends_with(ext))
    {
        return Some("sqlite");
    }
    None
}

/// Put the stored password back into an edited connection string.
///
/// The client only ever holds the masked URL, so an edit that did not change
/// the password arrives without one. Taking that at face value would silently
/// wipe the credential. A password that *is* supplied always wins, SQLite has
/// none to carry, and a string that does not parse cannot be spliced -- it is
/// returned untouched rather than guessed at.
pub fn merge_stored_password(engine: &str, next_url: &str, existing_url: &str) -> String {
    if engine == "sqlite" {
        return next_url.to_string();
    }
    let (Ok(mut next), Ok(existing)) = (url::Url::parse(next_url), url::Url::parse(existing_url))
    else {
        return next_url.to_string();
    };
    if next.password().is_some_and(|value| !value.is_empty()) {
        return next_url.to_string();
    }
    let Some(password) = existing.password().filter(|value| !value.is_empty()) else {
        return next_url.to_string();
    };
    let decoded = percent_decode(password);
    if next.set_password(Some(&decoded)).is_err() {
        return next_url.to_string();
    }
    next.to_string()
}

/// Take the connection string, and any password inside it, out of an error.
///
/// Drivers put the URL they failed to open into their message, so the error a
/// user sees would otherwise carry the credential the mask exists to hide.
pub fn redact_database_error(engine: &str, url: &str, message: &str) -> String {
    let mut message = message.replace(url, &mask_url(engine, url));
    if engine == "sqlite" {
        return message;
    }
    if let Ok(parsed) = url::Url::parse(url) {
        if let Some(password) = parsed.password().filter(|value| !value.is_empty()) {
            // Both spellings: a driver may quote the password as it appeared in
            // the URL (encoded) or as it used it (decoded).
            let decoded = percent_decode(password);
            if !decoded.is_empty() {
                message = message.replace(&decoded, "****");
            }
            message = message.replace(password, "****");
        }
    }
    message
}

/// `decodeURIComponent`, near enough: `urlencoding` also leaves `+` alone,
/// where a form decoder would turn it into a space.
fn percent_decode(value: &str) -> String {
    urlencoding::decode(value)
        .map(|decoded| decoded.into_owned())
        .unwrap_or_else(|_| value.to_string())
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
