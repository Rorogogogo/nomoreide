//! `nomoreide db <subcommand>` — the Rust half of `src/cli/database.ts`.
//!
//! Read-only, like everything on the agent-reachable side of the database
//! split. Registering a connection and removing one are config edits, not data
//! edits; there is no `UPDATE` to reach from here. Writes live behind
//! `nomoreide-actions`, which this crate does not depend on, and which requires
//! a per-connection unlock a human performs in the dashboard.

use nomoreide_core::config::{ConfigStore, DatabaseDef};
use nomoreide_core::db;

use crate::commands::{CliError, CliResult};
use crate::flags::{parse_flags, positional_args_with_value_flags, Flags};

const USAGE: &str = concat!(
    "Usage: nomoreide db <command>\n",
    "  list\n",
    "  add <name> --engine <postgres|mysql|sqlite> --url <url> [--project-path <path>] [--replace] [--no-check]\n",
    "  check <connection>\n",
    "  remove <connection>\n",
    "  schemas <connection>\n",
    "  objects <connection> --schema <schema>\n",
    "  describe <connection> --key <opaque-key>\n",
    "  script <connection> --key <opaque-key>\n",
    "  sample <connection> <table> [--limit <rows>] [--offset <rows>]\n",
    "  query <connection> --sql <select> [--limit <rows>]",
);

/// Flags that consume the argument after them. The `db` reader is told rather
/// than guessing, so `--replace <name>` keeps `<name>` as a positional where
/// the `git` reader would swallow it.
const VALUE_FLAGS: &[&str] = &[
    "--engine",
    "--url",
    "--project-path",
    "--schema",
    "--key",
    "--limit",
    "--offset",
    "--sql",
];

const ENGINES: [&str; 3] = ["postgres", "mysql", "sqlite"];

pub async fn run(subcommand: Option<&str>, args: &[String], store: &ConfigStore) -> CliResult {
    let flags = parse_flags(args);
    let positional = positional_args_with_value_flags(args, VALUE_FLAGS);
    let connection = positional.first().map(String::as_str);

    match subcommand {
        Some("list") => {
            let config = store.load().await?;
            print_json(&serde_json::Value::Array(db::list_connections(&config)))
        }
        Some("add") => add(connection, args, &flags, store).await,
        Some("check") => check(required(connection, "connection")?, store).await,
        Some("remove") => {
            let name = required(connection, "connection")?;
            store.remove_database(name).await?;
            println!("Removed database connection {name}");
            Ok(())
        }
        Some("schemas") => schemas(required(connection, "connection")?, store).await,
        Some("objects") => {
            let database = resolve(required(connection, "connection")?, store).await?;
            let schema = required(flags.truthy("schema"), "--schema")?;
            let objects = db::peek_objects(&database, schema).await.map_err(fail)?;
            print_json(&serde_json::to_value(objects).map_err(json_fail)?)
        }
        Some(command @ ("describe" | "script")) => {
            describe(command, required(connection, "connection")?, &flags, store).await
        }
        Some("sample") => sample(&positional, &flags, store).await,
        Some("query") => query(required(connection, "connection")?, &flags, store).await,
        _ => Err(CliError::usage(USAGE)),
    }
}

async fn add(
    connection: Option<&str>,
    args: &[String],
    flags: &Flags,
    store: &ConfigStore,
) -> CliResult {
    let name = required(connection, "connection name")?;
    let engine = required(flags.truthy("engine"), "--engine")?;
    if !ENGINES.contains(&engine) {
        return Err(CliError::usage(
            "--engine must be one of: postgres, mysql, sqlite",
        ));
    }
    let url = required(flags.truthy("url"), "--url")?;
    let project_path = flags.nullish("projectPath");
    // Both are bare presence tests on the raw arguments, not parsed flags: the
    // reference reads `args.includes(...)`, so `--replace=false` is still a
    // replace. Reproduced rather than corrected — a script passing that today
    // gets a replace today.
    let replace = args.iter().any(|arg| arg == "--replace");
    let check_first = !args.iter().any(|arg| arg == "--no-check");

    let name = name.trim();
    if name.is_empty() {
        return Err(CliError::Failure(
            "Database connection name is required.".into(),
        ));
    }
    let config = store.load().await?;
    let existing = config
        .databases
        .iter()
        .find(|database| database.name == name)
        .cloned();
    if existing.is_some() && !replace {
        return Err(CliError::Failure(format!(
            "Database connection \"{name}\" already exists. Set replace=true to replace it."
        )));
    }
    if check_first {
        if let Err(reason) = db::test_connection(engine, url).await {
            return Err(CliError::Failure(db::redact_database_error(
                engine, url, &reason,
            )));
        }
    }
    // A blank `--project-path` clears rather than stores: the reference's
    // `?.trim() || undefined` turns an all-whitespace value into no value.
    let project_path = project_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_string);
    let stored = DatabaseDef {
        name: name.to_string(),
        engine: engine.to_string(),
        url: url.to_string(),
        // Registering a connection never carries write authorization, however
        // the previous registration of this name was unlocked. Re-pointing a
        // name at a new database would otherwise inherit an unlock granted for
        // a different target.
        write_unlocked: Some(false),
        project_path: project_path.clone(),
    };
    store.register_database(stored).await?;
    let mut answer = serde_json::json!({
        "name": name,
        "engine": engine,
        "url": db::mask_url(engine, url),
        "writeUnlocked": false,
    });
    if let Some(path) = &project_path {
        answer["projectPath"] = serde_json::json!(path);
    }
    print_json(&answer)
}

async fn check(name: &str, store: &ConfigStore) -> CliResult {
    let database = resolve(name, store).await?;
    if let Err(reason) = db::test_connection(&database.engine, &database.url).await {
        return Err(CliError::Failure(db::redact_database_error(
            &database.engine,
            &database.url,
            &reason,
        )));
    }
    print_json(&serde_json::json!({
        "ok": true,
        "connection": db::public_connection(&database),
    }))
}

async fn schemas(name: &str, store: &ConfigStore) -> CliResult {
    let database = resolve(name, store).await?;
    let schemas = db::peek_schemas(&database).await.map_err(fail)?;
    let capabilities = db::capabilities(&database.engine).map_err(fail)?;
    print_json(&serde_json::json!({
        "schemas": schemas,
        "capabilities": serde_json::to_value(capabilities).map_err(json_fail)?,
    }))
}

async fn describe(command: &str, name: &str, flags: &Flags, store: &ConfigStore) -> CliResult {
    let database = resolve(name, store).await?;
    let key = required(flags.truthy("key"), "--key")?;
    let details = db::peek_details(&database, key).await.map_err(fail)?;
    let value = serde_json::to_value(details).map_err(json_fail)?;
    if command == "script" {
        // A create script is the one answer here that is *not* JSON: it is
        // meant to be piped into a SQL client.
        let script = value
            .get("createScript")
            .and_then(serde_json::Value::as_str)
            .filter(|script| !script.is_empty())
            .ok_or_else(|| {
                CliError::Failure("No create script is available for this database object.".into())
            })?;
        println!("{script}");
        return Ok(());
    }
    print_json(&value)
}

async fn sample(positional: &[String], flags: &Flags, store: &ConfigStore) -> CliResult {
    let database = resolve(
        required(positional.first().map(String::as_str), "connection")?,
        store,
    )
    .await?;
    let table = required(positional.get(1).map(String::as_str), "table")?;
    let limit = positive_integer(flags.nullish("limit"), "--limit", 100)?;
    let offset = non_negative_integer(flags.nullish("offset"), "--offset", 0)?;
    let rows = db::peek_sample(&database, table, limit, offset)
        .await
        .map_err(fail)?;
    print_json(&rows)
}

async fn query(name: &str, flags: &Flags, store: &ConfigStore) -> CliResult {
    let database = resolve(name, store).await?;
    let sql = required(flags.truthy("sql"), "--sql")?;
    let limit = positive_integer(flags.nullish("limit"), "--limit", 100)?;
    // `run_capped_query`, not `peek::query`: the agent-facing wrapper turns a
    // refusal into staging guidance, which is right for an agent and wrong for
    // a person at a terminal who wants the driver's own complaint.
    let rows = db::run_capped_query(&database, sql, limit)
        .await
        .map_err(fail)?;
    print_json(&rows)
}

/// `peek_connection`, not `db::connection`. Core carries two refusals for the
/// same question: the dashboard's `Database 'x' not found` and the read-safe
/// surface's `Database connection "x" is not registered.` The CLI resolves
/// through `DbPeek`, so it gets the second one — and the wording is the
/// message a script greps for.
async fn resolve(name: &str, store: &ConfigStore) -> Result<DatabaseDef, CliError> {
    let config = store.load().await?;
    db::peek_connection(&config.databases, name)
        .cloned()
        .map_err(fail)
}

fn print_json(value: &serde_json::Value) -> CliResult {
    println!(
        "{}",
        serde_json::to_string_pretty(value).map_err(json_fail)?
    );
    Ok(())
}

fn fail(message: String) -> CliError {
    CliError::Failure(message)
}

fn json_fail(error: serde_json::Error) -> CliError {
    CliError::Failure(error.to_string())
}

fn required<'a>(value: Option<&'a str>, label: &str) -> Result<&'a str, CliError> {
    value
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| CliError::usage(format!("{label} is required")))
}

fn positive_integer(value: Option<&str>, label: &str, fallback: i64) -> Result<i64, CliError> {
    match value {
        None => Ok(fallback),
        Some(value) => {
            let parsed = nomoreide_core::js_number::parse(value);
            if parsed.is_nan() || parsed.fract() != 0.0 || parsed <= 0.0 {
                return Err(CliError::usage(format!(
                    "{label} must be a positive integer"
                )));
            }
            Ok(parsed as i64)
        }
    }
}

fn non_negative_integer(value: Option<&str>, label: &str, fallback: i64) -> Result<i64, CliError> {
    match value {
        None => Ok(fallback),
        Some(value) => {
            let parsed = nomoreide_core::js_number::parse(value);
            if parsed.is_nan() || parsed.fract() != 0.0 || parsed < 0.0 {
                return Err(CliError::usage(format!(
                    "{label} must be a non-negative integer"
                )));
            }
            Ok(parsed as i64)
        }
    }
}
