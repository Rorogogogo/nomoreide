//! Finding, browsing, and resolving a service's configuration files.
//!
//! "Configuration file" here is a **name rule, not a content check**: `.env`
//! and `.env.<anything>`, `appsettings*.json`, `application*.yml|yaml`. A
//! `config.json` sitting beside them is not one, and asking the editor for it
//! is refused rather than served as text — the editor knows how to parse and
//! re-serialise exactly these three shapes, and a file it guesses at is a file
//! it can corrupt.
//!
//! Every path a caller supplies is resolved and then checked to still be inside
//! the service's own directory. That check is on the *resolved* path, so `..`,
//! a symlink-free absolute path, and a nested climb are all the same question.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConfigFileFormat {
    Env,
    Json,
    Yaml,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFileInfo {
    pub path: String,
    pub relative_path: String,
    pub format: ConfigFileFormat,
}

/// The name rule. Case-insensitive for the two framework conventions, exact for
/// `.env`, which is how the reference's patterns are written.
pub fn format_from_name(name: &str) -> Option<ConfigFileFormat> {
    if name == ".env" || name.starts_with(".env.") {
        return Some(ConfigFileFormat::Env);
    }
    let lower = name.to_lowercase();
    // ^appsettings(\..+)?\.json$
    if let Some(stem) = lower.strip_suffix(".json") {
        if stem == "appsettings" || (stem.starts_with("appsettings.") && stem.len() > 12) {
            return Some(ConfigFileFormat::Json);
        }
    }
    // ^application(-.+)?\.ya?ml$
    for suffix in [".yaml", ".yml"] {
        if let Some(stem) = lower.strip_suffix(suffix) {
            if stem == "application" || (stem.starts_with("application-") && stem.len() > 12) {
                return Some(ConfigFileFormat::Yaml);
            }
        }
    }
    None
}

fn ignored_dirs() -> HashSet<&'static str> {
    [
        ".git",
        "node_modules",
        "dist",
        "build",
        "out",
        "bin",
        "obj",
        ".next",
        ".nuxt",
        ".turbo",
        ".vite",
        ".cache",
        "coverage",
        "target",
        "venv",
        ".venv",
        "__pycache__",
    ]
    .into_iter()
    .collect()
}

const MAX_DEPTH: usize = 4;
const MAX_FILES: usize = 200;

/// Walk a service directory for the files the editor understands.
///
/// Bounded twice — by depth and by count — because this runs on every visit to
/// the config panel and a service directory can be a monorepo.
pub async fn detect_config_files(cwd: &str) -> Vec<ConfigFileInfo> {
    let root = PathBuf::from(cwd);
    let mut results = Vec::new();
    walk(&root, &root, 0, &mut results).await;
    results.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    results
}

/// Recursion by hand: an `async fn` cannot recurse without boxing, and the
/// depth is capped anyway.
async fn walk(root: &Path, start: &Path, depth: usize, results: &mut Vec<ConfigFileInfo>) {
    let ignored = ignored_dirs();
    let mut stack: Vec<(PathBuf, usize)> = vec![(start.to_path_buf(), depth)];
    while let Some((current, depth)) = stack.pop() {
        if results.len() >= MAX_FILES {
            return;
        }
        let Ok(mut entries) = tokio::fs::read_dir(&current).await else {
            continue;
        };
        // Read the directory whole first: the reference walks entries in the
        // order the OS hands them back, and a sorted result is what makes two
        // runtimes comparable at all.
        let mut names: Vec<(String, bool)> = Vec::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            let Ok(kind) = entry.file_type().await else {
                continue;
            };
            names.push((
                entry.file_name().to_string_lossy().to_string(),
                kind.is_dir(),
            ));
        }
        names.sort();
        for (name, is_dir) in names {
            if results.len() >= MAX_FILES {
                return;
            }
            if is_dir {
                if ignored.contains(name.as_str()) || depth + 1 > MAX_DEPTH {
                    continue;
                }
                stack.push((current.join(&name), depth + 1));
                continue;
            }
            let Some(format) = format_from_name(&name) else {
                continue;
            };
            let path = current.join(&name);
            let Some(relative) = relative_path(root, &path) else {
                continue;
            };
            results.push(ConfigFileInfo {
                path: path.to_string_lossy().to_string(),
                relative_path: relative,
                format,
            });
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseEntry {
    pub name: String,
    pub relative_path: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<ConfigFileFormat>,
    pub supported: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseResult {
    pub cwd: String,
    pub current_path: String,
    pub relative_path: String,
    pub is_root: bool,
    pub entries: Vec<BrowseEntry>,
}

/// The path escaped the service directory. Its own type because the routes
/// answer it with a 400 while any other failure is a 500.
#[derive(Debug)]
pub struct ConfigFilePathError(pub String);

impl std::fmt::Display for ConfigFilePathError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConfigFilePathError {}

/// One directory's contents, directories first and then files, each sorted by
/// name.
///
/// A directory that cannot be read comes back **empty rather than as an
/// error** — the browser is exploring, and a folder it lacks permission on is
/// something to show as empty, not something to fail the panel over.
pub async fn browse_directory(
    cwd: &str,
    requested: Option<&str>,
) -> Result<BrowseResult, ConfigFilePathError> {
    let root = PathBuf::from(cwd);
    let current = match requested {
        Some(value) => within_root(&root, &resolve_against(&root, value))?,
        None => root.clone(),
    };
    let relative = relative_path(&root, &current).unwrap_or_default();

    let ignored = ignored_dirs();
    let mut items: Vec<BrowseEntry> = Vec::new();
    if let Ok(mut entries) = tokio::fs::read_dir(&current).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(kind) = entry.file_type().await else {
                continue;
            };
            if kind.is_dir() {
                if ignored.contains(name.as_str()) {
                    continue;
                }
                let full = current.join(&name);
                items.push(BrowseEntry {
                    relative_path: relative_path(&root, &full).unwrap_or_default(),
                    name,
                    kind: "directory",
                    format: None,
                    supported: true,
                });
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            let format = format_from_name(&name);
            let full = current.join(&name);
            items.push(BrowseEntry {
                relative_path: relative_path(&root, &full).unwrap_or_default(),
                name,
                kind: "file",
                format,
                supported: format.is_some(),
            });
        }
    }
    // Directories first, then files, each by name. `"directory" < "file"` puts
    // them in that order already, so the comparison is plain rather than
    // reversed.
    items.sort_by(|a, b| a.kind.cmp(b.kind).then(a.name.cmp(&b.name)));

    Ok(BrowseResult {
        cwd: root.to_string_lossy().to_string(),
        current_path: current.to_string_lossy().to_string(),
        relative_path: relative,
        is_root: current == root,
        entries: items,
    })
}

/// Resolve a requested config file and prove it is one, and is in bounds.
pub fn resolve_config_file(
    cwd: &str,
    requested: &str,
) -> Result<ConfigFileInfo, ConfigFilePathError> {
    if requested.is_empty() || requested.contains('\0') {
        return Err(ConfigFilePathError("Invalid config file path.".to_string()));
    }
    let root = PathBuf::from(cwd);
    let absolute = resolve_against(&root, requested);
    let Some(relative) = relative_path(&root, &absolute) else {
        return Err(ConfigFilePathError(
            "Config file must live inside the service directory.".to_string(),
        ));
    };
    if relative == ".." || relative.starts_with("../") || Path::new(&relative).is_absolute() {
        return Err(ConfigFilePathError(
            "Config file must live inside the service directory.".to_string(),
        ));
    }
    let name = absolute
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    let Some(format) = format_from_name(&name) else {
        return Err(ConfigFilePathError(format!(
            "Unsupported config file: {name}"
        )));
    };
    Ok(ConfigFileInfo {
        path: absolute.to_string_lossy().to_string(),
        relative_path: relative,
        format,
    })
}

fn within_root(root: &Path, candidate: &Path) -> Result<PathBuf, ConfigFilePathError> {
    match relative_path(root, candidate) {
        Some(relative)
            if relative != ".."
                && !relative.starts_with("../")
                && !Path::new(&relative).is_absolute() =>
        {
            Ok(candidate.to_path_buf())
        }
        _ => Err(ConfigFilePathError(
            "Path must live inside the service directory.".to_string(),
        )),
    }
}

/// `path.resolve(root, requested)`: an absolute request stands, a relative one
/// hangs off the root, and `.`/`..` are folded away **without touching the
/// filesystem**, so a path that does not exist still resolves.
fn resolve_against(root: &Path, requested: &str) -> PathBuf {
    let candidate = Path::new(requested);
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };
    normalize(&joined)
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `path.relative(root, target)`, on already-normalised paths.
fn relative_path(root: &Path, target: &Path) -> Option<String> {
    let root: Vec<_> = root.components().collect();
    let target: Vec<_> = target.components().collect();
    let shared = root
        .iter()
        .zip(target.iter())
        .take_while(|(a, b)| a == b)
        .count();
    let mut parts: Vec<String> = vec!["..".to_string(); root.len() - shared];
    parts.extend(
        target[shared..]
            .iter()
            .map(|c| c.as_os_str().to_string_lossy().to_string()),
    );
    Some(parts.join("/"))
}

/// Whether a document parses at all.
///
/// **The message is not the reference's.** The reference re-wraps its engine's
/// own parse diagnostic, and reproducing V8's wording is a job for the
/// daemon's `js_json`, which is where the HTTP route does its check. This stays
/// for callers that only need the verdict.
pub fn validate_json(text: &str) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(text)
        .map(|_| ())
        .map_err(|error| format!("Invalid JSON: {error}"))
}

/// A config file edited after the process that reads it started.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaleConfigFile {
    pub relative_path: String,
    pub path: String,
    pub format: ConfigFileFormat,
    pub modified_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEnvStatus {
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    /// Most recently modified first.
    pub stale_files: Vec<StaleConfigFile>,
    pub stale: bool,
}

/// Compare each detected config file's mtime against when the service started.
///
/// A **one-second skew guard** keeps a save that raced the spawn from reading
/// as stale. A service that is not running, or whose start time cannot be
/// parsed, is never stale: there is no live process for the old values to be
/// baked into.
pub async fn runtime_env_status(
    cwd: &str,
    running: bool,
    started_at: Option<&str>,
) -> RuntimeEnvStatus {
    let empty = RuntimeEnvStatus {
        running,
        started_at: started_at.map(str::to_string),
        stale_files: Vec::new(),
        stale: false,
    };
    if !running {
        return empty;
    }
    let Some(started) = started_at.and_then(parse_millis) else {
        return empty;
    };

    let mut stale_files = Vec::new();
    for file in detect_config_files(cwd).await {
        let Ok(metadata) = tokio::fs::metadata(&file.path).await else {
            continue; // vanished between detection and stat
        };
        let Some(modified) = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        else {
            continue;
        };
        let modified_ms = modified.as_millis() as i64;
        if modified_ms > started + 1000 {
            stale_files.push(StaleConfigFile {
                relative_path: file.relative_path,
                path: file.path,
                format: file.format,
                modified_at: iso_millis(modified_ms),
            });
        }
    }
    stale_files.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    RuntimeEnvStatus {
        running,
        started_at: started_at.map(str::to_string),
        stale: !stale_files.is_empty(),
        stale_files,
    }
}

fn parse_millis(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.timestamp_millis())
}

fn iso_millis(millis: i64) -> String {
    chrono::DateTime::from_timestamp_millis(millis)
        .map(|time| time.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_default()
}
