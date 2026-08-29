//! Import a JetBrains project's run configurations and data sources.
//!
//! The Rust half of `src/core/jetbrains-import.ts`. A scan reads the project's
//! `.idea` (and `.run`) files and returns a **preview** plus a session id; an
//! apply spends that id and writes the chosen entries into config. Nothing is
//! registered until someone has looked at the preview.
//!
//! **The XML is read with regexes, not a parser, and that is deliberate.** A
//! file carrying a DTD or an entity declaration is refused outright rather than
//! parsed — someone else's project file is untrusted input, and an XML parser
//! that resolves entities is an XXE hole. Refusing first means no parser ever
//! sees one.
//!
//! Every path that comes out of a configuration is resolved and then checked to
//! be **inside the project root**. A run configuration that points at
//! `../../etc` is reported as unsupported rather than imported.

use crate::config::{Config, DatabaseDef, ServiceDef};
use crate::db::is_sensitive_connection_parameter;
use chrono::{DateTime, SecondsFormat, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

/// Caps, all of them the reference's. A project with more than this is a
/// mistake or an attack, and either way is refused rather than chewed on.
const MAX_FILES: usize = 100;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 6 * 1024 * 1024;
/// How long a preview stays spendable. Long enough to read, short enough that
/// a stale one cannot be applied against a project that has since changed.
const SESSION_TTL: Duration = Duration::from_secs(10 * 60);

// --- the wire shapes ---------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPreview {
    pub id: String,
    pub name: String,
    pub run_type: String,
    pub source: String,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    pub cwd: String,
    pub env_keys: Vec<String>,
    pub conflict: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsupportedRun {
    pub name: String,
    pub run_type: String,
    pub source: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabasePreview {
    pub id: String,
    pub name: String,
    pub engine: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    pub conflict: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsupportedDatabase {
    pub name: String,
    pub source: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub session_id: String,
    pub project_root: String,
    pub candidates: Vec<RunPreview>,
    pub unsupported: Vec<UnsupportedRun>,
    pub databases: Vec<DatabasePreview>,
    pub unsupported_databases: Vec<UnsupportedDatabase>,
    pub expires_at: String,
}

/// What a caller chose to do with one previewed entry.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSelection {
    pub id: String,
    /// `add`, `skip`, `replace` or `rename`.
    pub conflict: String,
    pub name: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSelection {
    pub id: String,
    pub conflict: String,
    pub name: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub test: Option<bool>,
}

pub struct ImportedService {
    pub definition: ServiceDef,
    /// `error` or `replace`.
    pub on_conflict: String,
}

pub struct ImportedDatabase {
    pub definition: DatabaseDef,
    pub on_conflict: String,
    pub test: bool,
}

// --- the session store -------------------------------------------------------

struct Candidate {
    id: String,
    run_type: String,
    source: String,
    definition: ServiceDef,
}

struct DatabaseCandidate {
    id: String,
    source: String,
    definition: DatabaseDef,
    username: Option<String>,
}

struct Session {
    project_root: String,
    candidates: Vec<Candidate>,
    unsupported: Vec<UnsupportedRun>,
    databases: Vec<DatabaseCandidate>,
    unsupported_databases: Vec<UnsupportedDatabase>,
    expires_at: SystemTime,
}

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn prune() {
    if let Ok(mut held) = sessions().lock() {
        let now = SystemTime::now();
        held.retain(|_, session| session.expires_at > now);
    }
}

// --- scanning ----------------------------------------------------------------

pub struct ScanRequest<'a> {
    pub project_root: &'a str,
    pub include_personal: bool,
    pub existing_names: HashSet<String>,
    pub existing_database_names: HashSet<String>,
}

/// Read a project and hand back a preview plus the session id that spends it.
pub async fn scan(request: ScanRequest<'_>) -> Result<ImportPreview, String> {
    prune();
    let project_root = tokio::fs::canonicalize(request.project_root)
        .await
        .map_err(|error| node_fs_error(&error, "realpath", request.project_root))?;
    if !tokio::fs::metadata(&project_root)
        .await
        .map_err(|error| node_fs_error(&error, "stat", &project_root.to_string_lossy()))?
        .is_dir()
    {
        return Err("Project root must be a directory.".to_string());
    }
    let root = project_root.to_string_lossy().into_owned();

    let files = known_files(&project_root, request.include_personal).await?;
    let mut candidates = Vec::new();
    let mut unsupported = Vec::new();
    let mut total_bytes: u64 = 0;

    for file in files {
        let Ok(metadata) = tokio::fs::metadata(&file.path).await else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        if metadata.len() > MAX_FILE_BYTES {
            unsupported.push(UnsupportedRun {
                name: file.source.clone(),
                run_type: "file".to_string(),
                source: file.source,
                reason: "File exceeds the 2 MB import limit.".to_string(),
            });
            continue;
        }
        total_bytes += metadata.len();
        if total_bytes > MAX_TOTAL_BYTES {
            return Err("JetBrains configuration files exceed the 6 MB import limit.".to_string());
        }
        let Ok(xml) = tokio::fs::read_to_string(&file.path).await else {
            continue;
        };
        // Refused before any parsing: an entity declaration in someone else's
        // project file is an XXE waiting for a permissive parser.
        if declares_dtd(&xml) {
            unsupported.push(UnsupportedRun {
                name: file.source.clone(),
                run_type: "file".to_string(),
                source: file.source,
                reason: "DTD and entity declarations are not allowed.".to_string(),
            });
            continue;
        }
        for configuration in extract_configurations(&xml) {
            match adapt(&configuration, &root, &file.source).await {
                Ok(candidate) => candidates.push(candidate),
                Err(entry) => unsupported.push(entry),
            }
        }
    }

    let scanned = scan_data_sources(&root).await;
    if total_bytes + scanned.bytes > MAX_TOTAL_BYTES {
        return Err("JetBrains configuration files exceed the 6 MB import limit.".to_string());
    }

    let session_id = uuid::Uuid::new_v4().to_string();
    let expires_at = SystemTime::now() + SESSION_TTL;
    let session = Session {
        project_root: root.clone(),
        candidates,
        unsupported,
        databases: scanned.candidates,
        unsupported_databases: scanned.unsupported,
        expires_at,
    };
    let preview = render_preview(
        &session_id,
        &session,
        &request.existing_names,
        &request.existing_database_names,
        expires_at,
    );
    if let Ok(mut held) = sessions().lock() {
        held.insert(session_id, session);
    }
    Ok(preview)
}

fn render_preview(
    session_id: &str,
    session: &Session,
    existing: &HashSet<String>,
    existing_databases: &HashSet<String>,
    expires_at: SystemTime,
) -> ImportPreview {
    ImportPreview {
        session_id: session_id.to_string(),
        project_root: session.project_root.clone(),
        candidates: session
            .candidates
            .iter()
            .map(|candidate| RunPreview {
                id: candidate.id.clone(),
                name: candidate.definition.name.clone(),
                run_type: candidate.run_type.clone(),
                source: candidate.source.clone(),
                command: candidate.definition.command.clone().unwrap_or_default(),
                args: candidate.definition.args.clone(),
                cwd: candidate
                    .definition
                    .cwd
                    .clone()
                    .unwrap_or_else(|| session.project_root.clone()),
                // Sorted, because a config's key order is an accident of how it
                // was written and two projects should preview the same.
                env_keys: candidate
                    .definition
                    .env
                    .as_ref()
                    .map(|env| {
                        let mut keys: Vec<String> = env.keys().cloned().collect();
                        keys.sort();
                        keys
                    })
                    .unwrap_or_default(),
                conflict: existing.contains(&candidate.definition.name),
            })
            .collect(),
        unsupported: session.unsupported.clone(),
        databases: session
            .databases
            .iter()
            .map(|candidate| database_preview(candidate, existing_databases))
            .collect(),
        unsupported_databases: session.unsupported_databases.clone(),
        expires_at: iso(expires_at),
    }
}

/// A filesystem failure worded the way Node words it.
///
/// The reference lets `fs.realpath`'s own error reach the caller, and its text
/// is part of the answer: `ENOENT: no such file or directory, realpath '/x'`.
/// Rust's `io::Error` says the same thing differently, so the shape is rebuilt
/// here rather than the message being approximated.
fn node_fs_error(error: &std::io::Error, syscall: &str, path: &str) -> String {
    let (code, message) = match error.raw_os_error() {
        Some(2) => ("ENOENT", "no such file or directory"),
        Some(13) => ("EACCES", "permission denied"),
        Some(20) => ("ENOTDIR", "not a directory"),
        Some(21) => ("EISDIR", "is a directory"),
        Some(62) | Some(40) => ("ELOOP", "too many symbolic links encountered"),
        // Anything unmapped keeps the platform's own words rather than being
        // dressed up as a code this did not recognise.
        _ => return error.to_string(),
    };
    format!("{code}: {message}, {syscall} '{path}'")
}

fn iso(at: SystemTime) -> String {
    DateTime::<Utc>::from(at).to_rfc3339_opts(SecondsFormat::Millis, true)
}

// --- applying ----------------------------------------------------------------

/// Spend a session: turn the caller's selections into definitions to write.
///
/// The session is **not** consumed here — the caller completes it only after
/// the config write succeeds, so a failed write leaves the preview spendable.
pub fn consume(
    session_id: &str,
    selections: &[ImportSelection],
    database_selections: &[DatabaseSelection],
) -> Result<(Vec<ImportedService>, Vec<ImportedDatabase>), String> {
    prune();
    let held = sessions().lock().map_err(|_| "import store is poisoned")?;
    let session = held
        .get(session_id)
        .ok_or("Import preview expired. Scan the project again.")?;

    let mut services = Vec::new();
    let mut names: HashSet<String> = HashSet::new();
    for selection in selections {
        let candidate = session
            .candidates
            .iter()
            .find(|candidate| candidate.id == selection.id)
            .ok_or_else(|| format!("Unknown import candidate: {}", selection.id))?;
        if selection.conflict == "skip" {
            continue;
        }
        let requested = if selection.conflict == "rename" {
            selection.name.as_deref().map(str::trim).unwrap_or_default()
        } else {
            candidate.definition.name.as_str()
        };
        if requested.is_empty() {
            return Err("Renamed services require a name.".to_string());
        }
        if !names.insert(requested.to_string()) {
            return Err(format!(
                "Import contains duplicate service name: {requested}"
            ));
        }
        let command = selection
            .command
            .as_deref()
            .map(str::trim)
            .filter(|command| !command.is_empty())
            .map(str::to_string)
            .or_else(|| candidate.definition.command.clone())
            .ok_or("Imported services require a command.")?;
        let requested_cwd = selection
            .cwd
            .as_deref()
            .map(str::trim)
            .filter(|cwd| !cwd.is_empty())
            .map(str::to_string)
            .or_else(|| candidate.definition.cwd.clone())
            .unwrap_or_else(|| session.project_root.clone());
        let cwd = contained_path(&requested_cwd, &session.project_root).ok_or_else(|| {
            format!("Imported working directory escapes the project: {requested_cwd}")
        })?;

        let mut definition = candidate.definition.clone();
        definition.name = requested.to_string();
        definition.command = Some(command);
        definition.cwd = Some(cwd);
        if let Some(args) = &selection.args {
            definition.args = Some(args.clone());
        }
        services.push(ImportedService {
            definition,
            on_conflict: if selection.conflict == "replace" {
                "replace".to_string()
            } else {
                "error".to_string()
            },
        });
    }

    let mut databases = Vec::new();
    let mut database_names: HashSet<String> = HashSet::new();
    for selection in database_selections {
        let candidate = session
            .databases
            .iter()
            .find(|candidate| candidate.id == selection.id)
            .ok_or_else(|| format!("Unknown database import candidate: {}", selection.id))?;
        if selection.conflict == "skip" {
            continue;
        }
        let name = if selection.conflict == "rename" {
            selection.name.as_deref().map(str::trim).unwrap_or_default()
        } else {
            candidate.definition.name.as_str()
        };
        if name.is_empty() {
            return Err("Renamed database connections require a name.".to_string());
        }
        if !database_names.insert(name.to_string()) {
            return Err(format!("Import contains duplicate database name: {name}"));
        }
        databases.push(ImportedDatabase {
            definition: database_definition(candidate, selection, name)?,
            on_conflict: if selection.conflict == "replace" {
                "replace".to_string()
            } else {
                "error".to_string()
            },
            test: selection.test == Some(true),
        });
    }
    Ok((services, databases))
}

/// Drop a spent session, so a preview cannot be applied twice.
pub fn complete(session_id: &str) {
    if let Ok(mut held) = sessions().lock() {
        held.remove(session_id);
    }
}

/// Write an import into config as one mutation — no partial registration.
///
/// A name that already exists is an error unless the selection said `replace`,
/// and a replaced entry keeps its **position** rather than moving to the end:
/// the list is what a person reads, and reordering it on an import would be a
/// change nobody asked for.
pub fn apply_to_config(
    config: &mut Config,
    services: &[ImportedService],
    databases: &[ImportedDatabase],
) -> Result<(), String> {
    for service in services {
        let name = &service.definition.name;
        match config.services.iter().position(|item| &item.name == name) {
            Some(index) if service.on_conflict == "replace" => {
                config.services[index] = service.definition.clone();
            }
            Some(_) => return Err(format!("Service \"{name}\" is already registered.")),
            None => config.services.push(service.definition.clone()),
        }
    }
    for database in databases {
        let name = &database.definition.name;
        match config.databases.iter().position(|item| &item.name == name) {
            Some(index) if database.on_conflict == "replace" => {
                config.databases[index] = database.definition.clone();
            }
            Some(_) => {
                return Err(format!(
                    "Database connection \"{name}\" is already registered."
                ))
            }
            None => config.databases.push(database.definition.clone()),
        }
    }
    Ok(())
}

// --- file discovery ----------------------------------------------------------

struct KnownFile {
    path: PathBuf,
    source: String,
}

/// Where run configurations live, and what counts as one in each place.
///
/// **The two directories take different names**: `.run` accepts only
/// `*.run.xml`, while `.idea/runConfigurations` accepts any `.xml`. That is the
/// reference's rule, and a port that treated them alike would import a file
/// JetBrains itself ignores.
async fn known_files(
    project_root: &Path,
    include_personal: bool,
) -> Result<Vec<KnownFile>, String> {
    let mut requested: Vec<PathBuf> = Vec::new();
    for directory in [
        project_root.join(".run"),
        project_root.join(".idea").join("runConfigurations"),
    ] {
        let dot_run = directory.file_name().is_some_and(|name| name == ".run");
        let mut entries = match tokio::fs::read_dir(&directory).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        };
        let mut found: Vec<PathBuf> = Vec::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            let wanted = if dot_run {
                name.ends_with(".run.xml")
            } else {
                name.ends_with(".xml")
            };
            let is_file = entry
                .file_type()
                .await
                .map(|kind| kind.is_file() || kind.is_symlink())
                .unwrap_or(false);
            if wanted && is_file {
                found.push(entry.path());
            }
        }
        requested.extend(found);
    }
    if include_personal {
        requested.push(project_root.join(".idea").join("workspace.xml"));
    }
    if requested.len() > MAX_FILES {
        return Err(format!(
            "Found more than {MAX_FILES} JetBrains config files."
        ));
    }

    let mut files = Vec::new();
    for path in requested {
        // Canonicalised and then checked: a symlink out of the project is the
        // one way a file inside it can read one outside.
        let Ok(canonical) = tokio::fs::canonicalize(&path).await else {
            continue;
        };
        if !canonical.starts_with(project_root) {
            return Err("JetBrains config path escapes the project.".to_string());
        }
        let source = path
            .strip_prefix(project_root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        files.push(KnownFile {
            path: canonical,
            source,
        });
    }
    files.sort_by(|left, right| left.source.cmp(&right.source));
    Ok(files)
}

// --- XML ---------------------------------------------------------------------

fn regex_for(pattern: &str) -> Regex {
    Regex::new(pattern).expect("static pattern compiles")
}

/// A DTD or entity declaration anywhere in the document.
fn declares_dtd(xml: &str) -> bool {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN
        .get_or_init(|| regex_for(r"(?i)<!DOCTYPE|<!ENTITY"))
        .is_match(xml)
}

struct XmlConfiguration {
    name: String,
    kind: String,
    body: String,
    options: BTreeMap<String, String>,
    env: BTreeMap<String, String>,
}

fn extract_configurations(xml: &str) -> Vec<XmlConfiguration> {
    static BLOCK: OnceLock<Regex> = OnceLock::new();
    static OPTION: OnceLock<Regex> = OnceLock::new();
    static ENV: OnceLock<Regex> = OnceLock::new();
    let block =
        BLOCK.get_or_init(|| regex_for(r"(?is)<configuration\b([^>]*)>(.*?)</configuration>"));
    let option = OPTION.get_or_init(|| regex_for(r"(?is)<option\b([^>]*?)/?\s*>"));
    let env = ENV.get_or_init(|| regex_for(r"(?is)<env\b([^>]*?)/?\s*>"));

    block
        .captures_iter(xml)
        .map(|captures| {
            let attributes = attributes_of(captures.get(1).map_or("", |m| m.as_str()));
            let body = captures.get(2).map_or("", |m| m.as_str()).to_string();
            let mut options = BTreeMap::new();
            for found in option.captures_iter(&body) {
                let attrs = attributes_of(found.get(1).map_or("", |m| m.as_str()));
                if let (Some(name), Some(value)) = (attrs.get("name"), attrs.get("value")) {
                    options.insert(name.clone(), value.clone());
                }
            }
            let mut environment = BTreeMap::new();
            for found in env.captures_iter(&body) {
                let attrs = attributes_of(found.get(1).map_or("", |m| m.as_str()));
                if let (Some(name), Some(value)) = (attrs.get("name"), attrs.get("value")) {
                    if is_env_key(name) {
                        environment.insert(name.clone(), value.clone());
                    }
                }
            }
            XmlConfiguration {
                name: attributes
                    .get("name")
                    .cloned()
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| "Unnamed configuration".to_string()),
                kind: attributes
                    .get("type")
                    .or_else(|| attributes.get("factoryName"))
                    .cloned()
                    .filter(|kind| !kind.is_empty())
                    .unwrap_or_else(|| "unknown".to_string()),
                body,
                options,
                env: environment,
            }
        })
        .collect()
}

/// `name="value"` and `name='value'`.
///
/// Two alternatives rather than one backreference, because this engine has no
/// backreferences — and the pair is what the reference's `(["'])…\2` means.
fn attributes_of(input: &str) -> BTreeMap<String, String> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern =
        PATTERN.get_or_init(|| regex_for(r#"(?s)([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')"#));
    let mut result = BTreeMap::new();
    for captures in pattern.captures_iter(input) {
        let value = captures
            .get(2)
            .or_else(|| captures.get(3))
            .map_or("", |m| m.as_str());
        result.insert(
            captures.get(1).map_or("", |m| m.as_str()).to_string(),
            decode_xml(value),
        );
    }
    result
}

fn decode_xml(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#36;", "$")
        .replace("&amp;", "&")
}

/// A shell-legal environment name. The `.env` editor is looser; this is the
/// stricter of the two rules on purpose — see the note in `env_file`.
fn is_env_key(key: &str) -> bool {
    let mut characters = key.chars();
    characters
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && characters.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

// --- adapting a configuration to a service -----------------------------------

/// Turn one configuration into a service definition, or say why it cannot be.
///
/// The type is matched case-insensitively against the spellings JetBrains uses
/// across its IDEs; anything unrecognised is reported rather than guessed at,
/// because a wrong command is worse than no import.
async fn adapt(
    config: &XmlConfiguration,
    project_root: &str,
    source: &str,
) -> Result<Candidate, UnsupportedRun> {
    let refuse = |reason: &str| UnsupportedRun {
        name: config.name.clone(),
        run_type: config.kind.clone(),
        source: source.to_string(),
        reason: reason.to_string(),
    };

    let declared_cwd = option(
        config,
        &[
            "workingDirectory",
            "WORKING_DIRECTORY",
            "working-dir",
            "externalProjectPath",
        ],
    )
    .unwrap_or_else(|| project_root.to_string());
    let cwd = contained_path(&declared_cwd, project_root)
        .ok_or_else(|| refuse("Working directory resolves outside the project."))?;

    let kind = config.kind.to_lowercase();
    let definition = if kind.contains("npm") {
        let script = option(config, &["scripts", "scriptName", "SCRIPT_NAME"])
            .or_else(|| first_tag_attribute(&config.body, "script", "value"))
            .ok_or_else(|| refuse("npm script name is missing."))?;
        // The command runs where the `package.json` is, which is not always
        // the configuration's working directory.
        let package_cwd = match option(config, &["package-json", "packageJson"]) {
            Some(manifest) => {
                let expanded = expand(&manifest, project_root);
                let parent = Path::new(&expanded)
                    .parent()
                    .map(|path| path.to_string_lossy().into_owned())
                    .unwrap_or_else(|| project_root.to_string());
                contained_path(&parent, project_root)
                    .ok_or_else(|| refuse("package.json resolves outside the project."))?
            }
            None => cwd.clone(),
        };
        local_definition(
            config,
            "npm",
            Some(vec!["run".to_string(), script]),
            &package_cwd,
        )
    } else if kind.contains("nodejsconfigurationtype") || kind.contains("node.js") {
        let script = option(config, &["path-to-js-file", "pathToJsFile", "JS_FILE"])
            .ok_or_else(|| refuse("Node entry file is missing."))?;
        let script_path = contained_path(&script, project_root)
            .ok_or_else(|| refuse("Node entry file resolves outside the project."))?;
        let mut args = vec![script_path];
        args.extend(
            tokenize(
                &option(config, &["application-parameters", "applicationParameters"])
                    .unwrap_or_default(),
            )
            .map_err(|reason| refuse(&reason))?,
        );
        local_definition(config, "node", Some(args), &cwd)
    } else if kind.contains("shconfigurationtype") || kind.contains("shell script") {
        let text = option(config, &["SCRIPT_TEXT", "scriptText"]);
        let path = option(config, &["SCRIPT_PATH", "scriptPath"]);
        if let Some(text) = text {
            // Script *text* is a shell line, so it becomes the command with no
            // argument vector — splitting it would change what runs.
            local_definition(config, &text, None, &cwd)
        } else if let Some(path) = path {
            let script_path = contained_path(&path, project_root)
                .ok_or_else(|| refuse("Shell script resolves outside the project."))?;
            let mut args = vec![script_path];
            args.extend(
                tokenize(&option(config, &["SCRIPT_OPTIONS"]).unwrap_or_default())
                    .map_err(|reason| refuse(&reason))?,
            );
            local_definition(config, "/bin/sh", Some(args), &cwd)
        } else {
            return Err(refuse("Shell script text or path is missing."));
        }
    } else if kind.contains("mavenrunconfiguration") {
        let goals = option(config, &["goals", "commandLine"])
            .ok_or_else(|| refuse("Maven goals are missing."))?;
        local_definition(
            config,
            "mvn",
            Some(tokenize(&goals).map_err(|reason| refuse(&reason))?),
            &cwd,
        )
    } else if kind.contains("gradlerunconfiguration") {
        let tasks = list_option(&config.body, "taskNames");
        if tasks.is_empty() {
            return Err(refuse("Gradle task names are missing."));
        }
        // The project's own wrapper when it has one, so an import runs the
        // version the project pinned rather than whatever is on PATH.
        let wrapper = match tokio::fs::metadata(Path::new(project_root).join("gradlew")).await {
            Ok(_) => contained_path("gradlew", project_root)
                .ok_or_else(|| refuse("Gradle wrapper resolves outside the project."))?,
            Err(_) => "gradle".to_string(),
        };
        local_definition(config, &wrapper, Some(tasks), &cwd)
    } else if kind.contains("cargocommandrunconfiguration") {
        let command =
            option(config, &["command"]).ok_or_else(|| refuse("Cargo command is missing."))?;
        local_definition(
            config,
            "cargo",
            Some(tokenize(&command).map_err(|reason| refuse(&reason))?),
            &cwd,
        )
    } else {
        return Err(refuse(
            "This JetBrains run configuration type is not supported.",
        ));
    };

    Ok(Candidate {
        id: uuid::Uuid::new_v4().to_string(),
        run_type: config.kind.clone(),
        source: source.to_string(),
        definition,
    })
}

fn local_definition(
    config: &XmlConfiguration,
    command: &str,
    args: Option<Vec<String>>,
    cwd: &str,
) -> ServiceDef {
    // Written out rather than spread from a default: `ServiceDef` carries
    // fields an import must leave unset — a compose file, a port, an ssh host —
    // and naming each one keeps a field added later from silently arriving here
    // with a value nobody chose.
    ServiceDef {
        name: config.name.clone(),
        kind: None,
        command: Some(command.to_string()),
        args,
        cwd: Some(cwd.to_string()),
        port: None,
        description: Some(format!("Imported from JetBrains ({})", config.kind)),
        project_path: None,
        env: (!config.env.is_empty()).then(|| {
            config
                .env
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        }),
        test: None,
        depends_on: None,
        compose_file: None,
        compose_service: None,
        host: None,
    }
}

/// The first of these option names that carries a non-blank value.
fn option(config: &XmlConfiguration, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        config
            .options
            .get(*name)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

/// The `value` attributes of the options nested inside a named list option.
fn list_option(body: &str, name: &str) -> Vec<String> {
    let escaped = regex::escape(name);
    let Ok(outer) = Regex::new(&format!(
        r#"(?is)<option\b[^>]*name=["']{escaped}["'][^>]*>(.*?)</option>"#
    )) else {
        return Vec::new();
    };
    let Some(captures) = outer.captures(body) else {
        return Vec::new();
    };
    let inner = captures.get(1).map_or("", |m| m.as_str());
    static ITEM: OnceLock<Regex> = OnceLock::new();
    ITEM.get_or_init(|| regex_for(r"(?is)<option\b([^>]*?)/?\s*>"))
        .captures_iter(inner)
        .filter_map(|found| {
            attributes_of(found.get(1).map_or("", |m| m.as_str()))
                .get("value")
                .cloned()
        })
        .collect()
}

fn first_tag_attribute(body: &str, tag: &str, attribute: &str) -> Option<String> {
    let pattern = Regex::new(&format!(r"(?is)<{}\b([^>]*?)/?\s*>", regex::escape(tag))).ok()?;
    let captures = pattern.captures(body)?;
    attributes_of(captures.get(1).map_or("", |m| m.as_str()))
        .get(attribute)
        .cloned()
}

/// Split a command line the way a shell would, honouring quotes and escapes.
///
/// An unterminated quote is an error rather than a best guess: the argument
/// vector it would produce is not the one the person wrote.
fn tokenize(value: &str) -> Result<Vec<String>, String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for character in value.chars() {
        if escaped {
            current.push(character);
            escaped = false;
        } else if character == '\\' && quote != Some('\'') {
            escaped = true;
        } else if let Some(open) = quote {
            if character == open {
                quote = None;
            } else {
                current.push(character);
            }
        } else if character == '\'' || character == '"' {
            quote = Some(character);
        } else if character.is_whitespace() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
        } else {
            current.push(character);
        }
    }
    if quote.is_some() {
        return Err("Run configuration contains an unterminated quoted argument.".to_string());
    }
    if escaped {
        current.push('\\');
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    Ok(tokens)
}

/// JetBrains' project macros.
fn expand(value: &str, project_root: &str) -> String {
    value
        .replace("$PROJECT_DIR$", project_root)
        .replace("$MODULE_WORKING_DIR$", project_root)
}

/// Resolve a configured path and require it to stay inside the project.
///
/// Lexical, then checked against the canonical root — a path that climbs out
/// with `..`, or an absolute one pointing elsewhere, returns `None` and the
/// caller reports the entry as unsupported rather than importing it.
fn contained_path(value: &str, project_root: &str) -> Option<String> {
    let expanded = expand(value, project_root);
    let candidate = Path::new(&expanded);
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        Path::new(project_root).join(candidate)
    };
    let mut resolved = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::ParentDir => {
                resolved.pop();
            }
            Component::CurDir => {}
            other => resolved.push(other),
        }
    }
    let root = Path::new(project_root);
    (resolved == root || resolved.starts_with(root))
        .then(|| resolved.to_string_lossy().into_owned())
}

// --- data sources ------------------------------------------------------------

struct ScannedDataSources {
    candidates: Vec<DatabaseCandidate>,
    unsupported: Vec<UnsupportedDatabase>,
    bytes: u64,
}

const DATA_SOURCES: &str = ".idea/dataSources.xml";

async fn scan_data_sources(project_root: &str) -> ScannedDataSources {
    let empty = || ScannedDataSources {
        candidates: Vec::new(),
        unsupported: Vec::new(),
        bytes: 0,
    };
    let requested = Path::new(project_root)
        .join(".idea")
        .join("dataSources.xml");
    let Ok(path) = tokio::fs::canonicalize(&requested).await else {
        return empty();
    };
    if !path.starts_with(project_root) {
        return empty();
    }
    let Ok(metadata) = tokio::fs::metadata(&path).await else {
        return empty();
    };
    if !metadata.is_file() {
        return empty();
    }
    let refuse = |reason: &str| ScannedDataSources {
        candidates: Vec::new(),
        unsupported: vec![UnsupportedDatabase {
            name: "dataSources.xml".to_string(),
            source: DATA_SOURCES.to_string(),
            reason: reason.to_string(),
        }],
        bytes: metadata.len(),
    };
    if metadata.len() > MAX_FILE_BYTES {
        return refuse("File exceeds the 2 MB import limit.");
    }
    let Ok(xml) = tokio::fs::read_to_string(&path).await else {
        return empty();
    };
    if declares_dtd(&xml) {
        return refuse("DTD and entity declarations are not allowed.");
    }

    static BLOCK: OnceLock<Regex> = OnceLock::new();
    let block = BLOCK.get_or_init(|| regex_for(r"(?is)<data-source\b([^>]*)>(.*?)</data-source>"));
    let mut candidates = Vec::new();
    let mut unsupported = Vec::new();
    for captures in block.captures_iter(&xml) {
        let attributes = attributes_of(captures.get(1).map_or("", |m| m.as_str()));
        let body = captures.get(2).map_or("", |m| m.as_str());
        let name = attributes
            .get("name")
            .cloned()
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "Unnamed data source".to_string());
        let Some(jdbc_url) = tag_text(body, "jdbc-url") else {
            unsupported.push(UnsupportedDatabase {
                name,
                source: DATA_SOURCES.to_string(),
                reason: "JDBC URL is missing.".to_string(),
            });
            continue;
        };
        let driver = tag_text(body, "driver-ref")
            .or_else(|| tag_text(body, "jdbc-driver"))
            .unwrap_or_default();
        match parse_jdbc(&name, &jdbc_url, &driver, project_root) {
            Ok((definition, username)) => candidates.push(DatabaseCandidate {
                id: uuid::Uuid::new_v4().to_string(),
                source: DATA_SOURCES.to_string(),
                definition,
                username,
            }),
            Err(reason) => unsupported.push(UnsupportedDatabase {
                name,
                source: DATA_SOURCES.to_string(),
                reason,
            }),
        }
    }
    ScannedDataSources {
        candidates,
        unsupported,
        bytes: metadata.len(),
    }
}

fn tag_text(body: &str, tag: &str) -> Option<String> {
    let pattern = Regex::new(&format!(
        r"(?is)<{}\b[^>]*>(.*?)</{}>",
        regex::escape(tag),
        regex::escape(tag)
    ))
    .ok()?;
    let captures = pattern.captures(body)?;
    let value = decode_xml(captures.get(1).map_or("", |m| m.as_str()));
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// A JDBC URL as a connection this daemon can hold.
///
/// **The password never survives.** Whatever the URL carried is dropped here,
/// along with every parameter that could hold one — an imported connection is
/// unusable until a person supplies the secret, which is the point.
fn parse_jdbc(
    name: &str,
    jdbc_url: &str,
    driver: &str,
    project_root: &str,
) -> Result<(DatabaseDef, Option<String>), String> {
    let lower_driver = driver.to_lowercase();
    let lower_url = jdbc_url.to_lowercase();
    if lower_driver.contains("sqlite") || lower_url.starts_with("jdbc:sqlite:") {
        let raw = &jdbc_url[jdbc_url
            .char_indices()
            .nth("jdbc:sqlite:".len())
            .map_or(jdbc_url.len(), |(index, _)| index)..];
        let path = contained_path(&expand(raw, project_root), project_root)
            .ok_or("SQLite path resolves outside the project.")?;
        return Ok((
            DatabaseDef {
                name: name.to_string(),
                engine: "sqlite".to_string(),
                url: path,
                write_unlocked: Some(false),
                project_path: Some(project_root.to_string()),
            },
            None,
        ));
    }

    let engine = if lower_driver.contains("postgres") || lower_url.starts_with("jdbc:postgresql:") {
        "postgres"
    } else if lower_driver.contains("mysql") || lower_url.starts_with("jdbc:mysql:") {
        "mysql"
    } else {
        return Err("Only PostgreSQL, MySQL, and SQLite data sources are supported.".to_string());
    };

    let without_prefix = jdbc_url.strip_prefix("jdbc:").unwrap_or(jdbc_url);
    let mut url =
        url::Url::parse(without_prefix).map_err(|_| "JDBC URL is invalid.".to_string())?;
    let username = {
        let from_userinfo = urlencoding::decode(url.username())
            .map(|value| value.into_owned())
            .unwrap_or_default();
        if from_userinfo.is_empty() {
            url.query_pairs()
                .find(|(key, _)| key == "user")
                .map(|(_, value)| value.into_owned())
                .unwrap_or_default()
        } else {
            from_userinfo
        }
    };
    let _ = url.set_username(&username);
    let _ = url.set_password(None);
    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| {
            !key.eq_ignore_ascii_case("user")
                && !key.eq_ignore_ascii_case("username")
                && !is_sensitive_connection_parameter(key)
        })
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    {
        let mut pairs = url.query_pairs_mut();
        pairs.clear();
        for (key, value) in &kept {
            pairs.append_pair(key, value);
        }
    }
    if url.query() == Some("") {
        url.set_query(None);
    }
    Ok((
        DatabaseDef {
            name: name.to_string(),
            engine: engine.to_string(),
            url: url.to_string(),
            write_unlocked: Some(false),
            project_path: Some(project_root.to_string()),
        },
        (!username.is_empty()).then_some(username),
    ))
}

fn database_preview(candidate: &DatabaseCandidate, existing: &HashSet<String>) -> DatabasePreview {
    let conflict = existing.contains(&candidate.definition.name);
    if candidate.definition.engine == "sqlite" {
        return DatabasePreview {
            id: candidate.id.clone(),
            name: candidate.definition.name.clone(),
            engine: candidate.definition.engine.clone(),
            source: candidate.source.clone(),
            host: None,
            port: None,
            database: None,
            path: Some(candidate.definition.url.clone()),
            username: None,
            conflict,
        };
    }
    let parsed = url::Url::parse(&candidate.definition.url).ok();
    DatabasePreview {
        id: candidate.id.clone(),
        name: candidate.definition.name.clone(),
        engine: candidate.definition.engine.clone(),
        source: candidate.source.clone(),
        host: parsed
            .as_ref()
            .and_then(|url| url.host_str().map(str::to_string)),
        port: parsed.as_ref().and_then(url::Url::port),
        database: parsed
            .as_ref()
            .map(|url| url.path().trim_start_matches('/').to_string()),
        path: None,
        username: candidate.username.clone(),
        conflict,
    }
}

/// The definition to write, with the secret the caller supplied put back in.
///
/// A server connection **requires** a username and password at this point:
/// the import stripped whatever the JetBrains file held, and a connection
/// saved without them would be one that cannot connect.
fn database_definition(
    candidate: &DatabaseCandidate,
    selection: &DatabaseSelection,
    name: &str,
) -> Result<DatabaseDef, String> {
    let mut definition = candidate.definition.clone();
    definition.name = name.to_string();
    definition.write_unlocked = Some(false);
    if definition.engine == "sqlite" {
        return Ok(definition);
    }
    let username = selection
        .username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| candidate.username.clone())
        .unwrap_or_default();
    let password = selection.password.clone().unwrap_or_default();
    if username.is_empty() {
        return Err(format!("Username is required for database \"{name}\"."));
    }
    if password.is_empty() {
        return Err(format!("Password is required for database \"{name}\"."));
    }
    let mut url =
        url::Url::parse(&definition.url).map_err(|_| "JDBC URL is invalid.".to_string())?;
    let _ = url.set_username(&username);
    let _ = url.set_password(Some(&password));
    definition.url = url.to_string();
    Ok(definition)
}
