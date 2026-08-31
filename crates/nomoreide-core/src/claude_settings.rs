//! One setting inside `~/.claude/settings.json`, and nothing else in it.
//!
//! The Rust half of `src/core/claude-settings.ts`. That file belongs to Claude
//! Code and to whoever hand-edits it; this reads and writes exactly one key and
//! **leaves the rest verbatim**, because losing someone's `permissions` block
//! because they toggled a switch in a dashboard is not a recoverable mistake.
//!
//! Verbatim means the document's own key order too, which is why this edits a
//! parsed map rather than rebuilding a struct: a struct would reorder every
//! key it knows and drop every key it does not.

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

pub fn settings_path(home: &Path) -> PathBuf {
    home.join(".claude").join("settings.json")
}

/// A missing file is an empty document, not a failure — a machine where Claude
/// Code has never written settings is the common case, and it is exactly when
/// the default matters.
///
/// A file that is not an object is also empty. Anything else would mean writing
/// a `attribution` key into a document that is an array.
async fn read_settings(path: &Path) -> Result<Map<String, Value>, String> {
    let raw = match tokio::fs::read_to_string(path).await {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(error) => return Err(error.to_string()),
    };
    match crate::js_json::parse(&raw)? {
        Value::Object(document) => Ok(document),
        _ => Ok(Map::new()),
    }
}

async fn write_settings(path: &Path, settings: &Map<String, Value>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }
    let rendered = serde_json::to_string_pretty(&Value::Object(settings.clone()))
        .map_err(|error| error.to_string())?;
    tokio::fs::write(path, format!("{rendered}\n"))
        .await
        .map_err(|error| error.to_string())
}

/// Is the co-author trailer on?
///
/// Claude Code **defaults to on**, so a missing file, a missing `attribution`,
/// or an `attribution` with anything in it all read as on. Only the explicit
/// opt-out — both trailers blank — is off. An absent trailer is treated as
/// blank, so `{ "commit": "" }` alone is off too.
pub async fn get_co_author(home: &Path) -> Result<bool, String> {
    let settings = read_settings(&settings_path(home)).await?;
    let Some(attribution) = settings.get("attribution") else {
        return Ok(true);
    };
    // A non-object `attribution` has no trailers to read, so both are blank.
    let empty = Map::new();
    let attribution = attribution.as_object().unwrap_or(&empty);
    let commit = attribution
        .get("commit")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let pr = attribution
        .get("pr")
        .and_then(Value::as_str)
        .unwrap_or_default();
    Ok(!(commit.is_empty() && pr.is_empty()))
}

/// Turning it on **removes** the key; turning it off adds it back.
///
/// The asymmetry is the reference's and it is visible: a key that is removed
/// and later re-added lands at the **end** of the document rather than where it
/// started. Nothing in the response shows that, and a port that preserved the
/// original position would be diverging silently.
pub async fn set_co_author(home: &Path, enabled: bool) -> Result<bool, String> {
    let path = settings_path(home);
    let mut settings = read_settings(&path).await?;
    if enabled {
        settings.shift_remove("attribution");
    } else {
        let mut attribution = Map::new();
        attribution.insert("commit".into(), Value::String(String::new()));
        attribution.insert("pr".into(), Value::String(String::new()));
        settings.insert("attribution".into(), Value::Object(attribution));
    }
    write_settings(&path, &settings).await?;
    Ok(enabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "nomoreide-claude-settings-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join(".claude")).unwrap();
        root
    }

    async fn write(home: &Path, body: &str) {
        tokio::fs::write(settings_path(home), body).await.unwrap();
    }

    #[tokio::test]
    async fn a_missing_file_reads_as_on() {
        let root = std::env::temp_dir().join(format!("nomoreide-cs-none-{}", uuid::Uuid::new_v4()));
        assert!(get_co_author(&root).await.unwrap());
    }

    #[tokio::test]
    async fn only_two_blank_trailers_mean_off() {
        let home = scratch("read");
        write(&home, r#"{"attribution":{"commit":"","pr":""}}"#).await;
        assert!(!get_co_author(&home).await.unwrap());

        write(
            &home,
            r#"{"attribution":{"commit":"Co-authored-by: x","pr":""}}"#,
        )
        .await;
        assert!(get_co_author(&home).await.unwrap());

        // An absent trailer counts as blank, so this is still off.
        write(&home, r#"{"attribution":{"commit":""}}"#).await;
        assert!(!get_co_author(&home).await.unwrap());

        write(&home, r#"{"model":"x"}"#).await;
        assert!(get_co_author(&home).await.unwrap());
        std::fs::remove_dir_all(&home).ok();
    }

    #[tokio::test]
    async fn every_other_key_survives_a_write_in_its_own_order() {
        let home = scratch("write");
        write(
            &home,
            r#"{
  "model": "claude-sonnet-5",
  "attribution": { "commit": "", "pr": "" },
  "permissions": { "allow": ["Bash(ls:*)"], "deny": [] }
}
"#,
        )
        .await;

        set_co_author(&home, true).await.unwrap();
        let after_on = tokio::fs::read_to_string(settings_path(&home))
            .await
            .unwrap();
        assert!(
            !after_on.contains("attribution"),
            "turning it on removes the key"
        );
        assert!(
            after_on.contains("Bash(ls:*)"),
            "an unrelated key is untouched"
        );
        assert!(
            after_on.find("model").unwrap() < after_on.find("permissions").unwrap(),
            "the surviving keys keep their order"
        );

        set_co_author(&home, false).await.unwrap();
        let after_off = tokio::fs::read_to_string(settings_path(&home))
            .await
            .unwrap();
        assert!(
            after_off.find("permissions").unwrap() < after_off.find("attribution").unwrap(),
            "a re-added key lands at the end, not back where it started"
        );
        std::fs::remove_dir_all(&home).ok();
    }
}
