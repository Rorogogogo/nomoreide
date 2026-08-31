//! Machine-wide settings: `~/.config/nomoreide/settings.json`.
//!
//! One group today — the terminal — but the file is versioned and the loader
//! forgives only a missing file, so a settings.json that does not parse is an
//! error rather than a silent reset to defaults. Two fields carry defaults at
//! *parse* time instead, so a file written before they existed still loads.
//!
//! A patch is validated before it is merged, and the merge is one level deep:
//! `{terminal: {fontSize}}` keeps the rest of the terminal group. The patch
//! object is **strict**, so a key nobody knows is a refusal rather than
//! something quietly dropped — a typo in a settings write should not look like
//! a success.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::zod_report::{report, type_name, ZodIssue};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettings {
    pub font_size: i64,
    pub cursor_style: String,
    pub scrollback: i64,
    pub copy_on_select: bool,
    pub confirm_terminate: bool,
    #[serde(default = "yes")]
    pub smooth_scroll: bool,
    #[serde(default = "automatic")]
    pub external_terminal: String,
}

fn yes() -> bool {
    true
}

fn automatic() -> String {
    "automatic".to_string()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AppSettings {
    pub version: u32,
    pub terminal: TerminalSettings,
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            version: 1,
            terminal: TerminalSettings {
                font_size: 13,
                cursor_style: "block".to_string(),
                scrollback: 5_000,
                copy_on_select: false,
                confirm_terminate: true,
                smooth_scroll: true,
                external_terminal: "automatic".to_string(),
            },
        }
    }
}

const CURSOR_STYLES: [&str; 3] = ["block", "underline", "bar"];
const EXTERNAL_TERMINALS: [&str; 4] = ["automatic", "ghostty", "iterm2", "terminal"];

pub struct AppSettingsStore {
    path: PathBuf,
}

impl AppSettingsStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        AppSettingsStore { path: path.into() }
    }

    /// A missing file is the defaults. Anything else that goes wrong is an
    /// error: a settings file that exists and does not parse is a problem to
    /// report, not one to overwrite.
    pub async fn load(&self) -> Result<AppSettings, String> {
        match tokio::fs::read_to_string(&self.path).await {
            Ok(contents) => serde_json::from_str(&contents).map_err(|error| error.to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(AppSettings::default())
            }
            Err(error) => Err(error.to_string()),
        }
    }

    pub async fn update(&self, patch: &Value) -> Result<AppSettings, String> {
        let patch = validate_patch(patch)?;
        let mut settings = self.load().await?;
        if let Some(terminal) = patch.get("terminal").and_then(Value::as_object) {
            for (key, value) in terminal {
                apply(&mut settings.terminal, key, value);
            }
        }
        self.persist(&settings).await?;
        Ok(settings)
    }

    pub async fn reset(&self) -> Result<AppSettings, String> {
        let settings = AppSettings::default();
        self.persist(&settings).await?;
        Ok(settings)
    }

    async fn persist(&self, settings: &AppSettings) -> Result<(), String> {
        let body = format!(
            "{}\n",
            serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?
        );
        crate::filesystem::atomic_write_async(
            &self.path,
            body.as_bytes(),
            crate::filesystem::AtomicWriteOptions::default(),
        )
        .await
        .map_err(|error| error.to_string())
    }
}

fn apply(terminal: &mut TerminalSettings, key: &str, value: &Value) {
    match key {
        "fontSize" => terminal.font_size = value.as_i64().unwrap_or(terminal.font_size),
        "cursorStyle" => {
            terminal.cursor_style = value.as_str().unwrap_or_default().to_string();
        }
        "scrollback" => terminal.scrollback = value.as_i64().unwrap_or(terminal.scrollback),
        "copyOnSelect" => {
            terminal.copy_on_select = value.as_bool().unwrap_or(terminal.copy_on_select);
        }
        "confirmTerminate" => {
            terminal.confirm_terminate = value.as_bool().unwrap_or(terminal.confirm_terminate);
        }
        "smoothScroll" => {
            terminal.smooth_scroll = value.as_bool().unwrap_or(terminal.smooth_scroll);
        }
        "externalTerminal" => {
            terminal.external_terminal = value.as_str().unwrap_or_default().to_string();
        }
        _ => {}
    }
}

/// The patch schema: one optional group, itself strict and wholly optional.
fn validate_patch(patch: &Value) -> Result<Value, String> {
    let Some(object) = patch.as_object() else {
        return Err(report(&[ZodIssue::wrong_type(
            "object",
            type_name(patch),
            Vec::new(),
        )]));
    };
    let unknown: Vec<String> = object
        .keys()
        .filter(|key| key.as_str() != "terminal")
        .cloned()
        .collect();
    if !unknown.is_empty() {
        return Err(report(&[ZodIssue::unrecognized_keys(unknown, Vec::new())]));
    }
    let Some(terminal) = object.get("terminal") else {
        return Ok(patch.clone());
    };
    let Some(terminal) = terminal.as_object() else {
        return Err(report(&[ZodIssue::wrong_type(
            "object",
            type_name(terminal),
            vec![json!("terminal")],
        )]));
    };

    let known = [
        "fontSize",
        "cursorStyle",
        "scrollback",
        "copyOnSelect",
        "confirmTerminate",
        "smoothScroll",
        "externalTerminal",
    ];
    let unknown: Vec<String> = terminal
        .keys()
        .filter(|key| !known.contains(&key.as_str()))
        .cloned()
        .collect();
    if !unknown.is_empty() {
        return Err(report(&[ZodIssue::unrecognized_keys(
            unknown,
            vec![json!("terminal")],
        )]));
    }

    let mut issues = Vec::new();
    for key in known {
        let Some(value) = terminal.get(key) else {
            continue;
        };
        let path = vec![json!("terminal"), json!(key)];
        match key {
            "fontSize" => issues.extend(bounded(value, 10, 24, path)),
            "scrollback" => issues.extend(bounded(value, 500, 100_000, path)),
            "cursorStyle" => issues.extend(one_of(value, &CURSOR_STYLES, path)),
            "externalTerminal" => issues.extend(one_of(value, &EXTERNAL_TERMINALS, path)),
            _ => {
                if !value.is_boolean() {
                    issues.push(ZodIssue::wrong_type("boolean", type_name(value), path));
                }
            }
        }
    }
    if issues.is_empty() {
        Ok(patch.clone())
    } else {
        Err(report(&issues))
    }
}

/// An integer in a range, checked in zod's order: the base type, then the
/// integer refinement, then the bounds. Each stops the next, because zod's
/// checks short-circuit per field.
pub fn bounded(value: &Value, minimum: i64, maximum: i64, path: Vec<Value>) -> Vec<ZodIssue> {
    let Some(number) = value.as_f64() else {
        return vec![ZodIssue::wrong_type("number", type_name(value), path)];
    };
    if number.fract() != 0.0 {
        return vec![ZodIssue::not_an_integer(path)];
    }
    let number = number as i64;
    if number < minimum {
        return vec![ZodIssue::too_small(minimum, path)];
    }
    if number > maximum {
        return vec![ZodIssue::too_big(maximum, path)];
    }
    Vec::new()
}

pub fn one_of(value: &Value, options: &[&'static str], path: Vec<Value>) -> Vec<ZodIssue> {
    match value.as_str() {
        Some(text) if options.contains(&text) => Vec::new(),
        Some(text) => vec![ZodIssue::bad_enum(text, options, path)],
        None => vec![ZodIssue::wrong_type("string", type_name(value), path)],
    }
}

/// `$XDG_CONFIG_HOME/nomoreide/settings.json`, falling back to `~/.config`.
pub fn default_settings_path() -> PathBuf {
    let root = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let home = std::env::var("HOME").unwrap_or_default();
            Path::new(&home).join(".config")
        });
    root.join("nomoreide").join("settings.json")
}
