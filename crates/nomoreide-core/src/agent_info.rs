//! Everything the two agents have on this machine.
//!
//! The Rust half of `src/web/agent-info.ts`. One endpoint's worth of answer,
//! assembled from files each agent writes for itself: instructions, memory,
//! skills, MCP servers, plugins, hooks, and the projects each has seen. Both
//! profiles are always built, whichever agent is running, because the dashboard
//! lets a person look at either.
//!
//! **Nothing here fails.** Every read is best-effort: an unreadable directory
//! contributes nothing, a settings file that does not parse contributes no
//! hooks, and a plugin whose install path has been deleted still appears with
//! empty contributions. A panel that reports what an agent has is worth less
//! than nothing if one stale path blanks the page.
//!
//! **Key order is part of the answer.** These objects are built field by field
//! in the reference and serialised as they were built, so a `Map` is filled in
//! the same order here rather than a struct being derived — see
//! `merge_codex_projects`, where a spread puts `lastSessionModified` *after*
//! `mcpServerCount` for a project the config already knew about and before it
//! for one only a session mentions.

use crate::locale;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

/// How much of an instruction file or memory note is sent. Enough to read the
/// top of a CLAUDE.md, not enough to ship a repository through an API.
const PREVIEW_BYTES: usize = 1200;

/// Projects listed per agent. The list is a recency panel, not an inventory.
const MAX_PROJECTS: usize = 25;

fn object() -> Map<String, Value> {
    Map::new()
}

fn text(value: &str) -> Value {
    Value::String(value.to_string())
}

/// A property read that works on anything: a field of a non-object is absent.
fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    field(value, key).as_str().map(str::to_string)
}

/// `String.prototype.slice(0, n)` — UTF-16 code units, not characters.
fn slice_units(value: &str, units: usize) -> String {
    String::from_utf16_lossy(&value.encode_utf16().take(units).collect::<Vec<u16>>())
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// The head of a file, or nothing if it cannot be read.
///
/// The truncation marker is part of the payload the dashboard renders, so it is
/// appended exactly as the reference appends it rather than being left to the
/// client to notice a cut.
async fn safe_read_preview(path: &Path, bytes: usize) -> Option<String> {
    let content = tokio::fs::read_to_string(path).await.ok()?;
    if utf16_len(&content) <= bytes {
        return Some(content);
    }
    Some(format!("{}\n…[truncated]", slice_units(&content, bytes)))
}

/// Directory entries, or nothing. Sorted by name so two machines with the same
/// files agree before any of the reference's own sorts run.
///
/// The reference does not sort here, and for every collector below that does
/// not matter because a total order is applied afterwards. Sorting anyway costs
/// nothing and removes filesystem order from the answer entirely.
async fn read_dir_names(dir: &Path) -> Vec<(String, bool)> {
    try_read_dir_names(dir).await.unwrap_or_default()
}

/// The same listing, but able to say the directory was not there at all —
/// which one caller has to distinguish, because it reports the directory's
/// path only when the directory exists.
async fn try_read_dir_names(dir: &Path) -> Option<Vec<(String, bool)>> {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return None;
    };
    let mut names = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let Ok(kind) = entry.file_type().await else {
            continue;
        };
        names.push((
            entry.file_name().to_string_lossy().into_owned(),
            kind.is_dir(),
        ));
    }
    names.sort_by(|left, right| locale::code_unit_cmp(&left.0, &right.0));
    Some(names)
}

pub fn codex_home() -> PathBuf {
    crate::usage_info::codex_home()
}

// --- which agent is running --------------------------------------------------

fn signal(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

/// The agent this daemon is running under, and why it thinks so.
///
/// The environment is checked first and in a fixed order — Claude Code, then
/// Codex, then Gemini — so a shell that carries more than one agent's variables
/// resolves the same way every time. The parent process is only consulted when
/// the environment said nothing, and it is reported either way: knowing what
/// launched the daemon is useful even when it was not an agent.
/// Just the name from [`detect_agent`], for callers choosing a chat provider.
///
/// The full detection carries signals and a parent process for the agent panel;
/// picking a provider needs one word of it.
pub async fn detected_agent_name() -> String {
    detect_agent()
        .await
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string()
}

async fn detect_agent() -> Value {
    let mut signals: Vec<Value> = Vec::new();
    let mut name = "unknown";
    let mut label = "Unknown agent";

    if signal("CLAUDECODE").as_deref() == Some("1")
        || signal("CLAUDE_CODE_ENTRYPOINT").is_some()
        || signal("CLAUDE_PROJECT_DIR").is_some()
    {
        name = "claude-code";
        label = "Claude Code";
        if signal("CLAUDECODE").as_deref() == Some("1") {
            signals.push(text("CLAUDECODE=1"));
        }
        if let Some(entrypoint) = signal("CLAUDE_CODE_ENTRYPOINT") {
            signals.push(text(&format!("CLAUDE_CODE_ENTRYPOINT={entrypoint}")));
        }
        if signal("CLAUDE_PROJECT_DIR").is_some() {
            signals.push(text("CLAUDE_PROJECT_DIR set"));
        }
    } else if signal("CODEX_HOME").is_some()
        || signal("CODEX_SANDBOX").is_some()
        || signal("CODEX_CLI").is_some()
    {
        name = "codex";
        label = "OpenAI Codex CLI";
        if signal("CODEX_HOME").is_some() {
            signals.push(text("CODEX_HOME set"));
        }
        if signal("CODEX_SANDBOX").is_some() {
            signals.push(text("CODEX_SANDBOX set"));
        }
    } else if signal("GEMINI_API_KEY").is_some()
        || signal("GEMINI_CLI").is_some()
        || signal("GOOGLE_GENAI_USE_VERTEXAI").is_some()
    {
        name = "gemini";
        label = "Gemini CLI";
        // Only one of the three is reported, which is the reference's own
        // asymmetry: an API key is not evidence that a CLI is driving this.
        if signal("GEMINI_CLI").is_some() {
            signals.push(text("GEMINI_CLI set"));
        }
    }

    let parent = parent_command().await;
    if let Some(command) = parent.as_deref() {
        if !command.is_empty() && name == "unknown" {
            let lowered = command.to_lowercase();
            let matched = if lowered.contains("claude") {
                Some(("claude-code", "Claude Code"))
            } else if lowered.contains("codex") {
                Some(("codex", "OpenAI Codex CLI"))
            } else if lowered.contains("gemini") {
                Some(("gemini", "Gemini CLI"))
            } else {
                None
            };
            if let Some((detected, detected_label)) = matched {
                name = detected;
                label = detected_label;
                signals.push(text(&format!("parent: {command}")));
            }
        }
    }

    let mut detected = object();
    detected.insert("name".into(), text(name));
    detected.insert("label".into(), text(label));
    detected.insert("signals".into(), Value::Array(signals));
    if let Some(command) = parent {
        detected.insert("parentProcess".into(), Value::String(command));
    }
    Value::Object(detected)
}

/// What launched this daemon, as `ps` spells it.
///
/// Init is not a parent worth asking about, and a `ps` that fails or is missing
/// is not worth reporting — both leave the field off entirely.
async fn parent_command() -> Option<String> {
    let ppid = std::os::unix::process::parent_id();
    if ppid <= 1 {
        return None;
    }
    let output = crate::exec_file::exec_file(
        &[
            "ps".to_string(),
            "-o".to_string(),
            "command=".to_string(),
            "-p".to_string(),
            ppid.to_string(),
        ],
        &crate::exec_file::ExecOptions {
            timeout: std::time::Duration::from_millis(1_000),
            max_buffer: 1 << 20,
            cwd: None,
        },
    )
    .await
    .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let first = stdout.trim().split('\n').next().unwrap_or_default();
    Some(slice_units(first, 240))
}

// --- instructions and memory -------------------------------------------------

/// Claude Code's encoding of a project directory into one path segment.
fn project_slug(cwd: &str) -> String {
    let replaced: String = cwd
        .chars()
        .map(|c| if c == '/' || c == '\\' { '-' } else { c })
        .collect();
    // `\s+` collapses a run of whitespace to a single dash.
    let mut slug = String::with_capacity(replaced.len());
    let mut in_space = false;
    for c in replaced.chars() {
        if c.is_whitespace() {
            if !in_space {
                slug.push('-');
                in_space = true;
            }
        } else {
            in_space = false;
            slug.push(c);
        }
    }
    slug
}

/// One memory note: its path, name, size, and head.
async fn memory_file(dir: &Path, name: &str) -> Option<Value> {
    let path = dir.join(name);
    // Both have to succeed. A file that vanished between the listing and the
    // read is not reported at zero bytes.
    let metadata = tokio::fs::metadata(&path).await.ok()?;
    let preview = safe_read_preview(&path, PREVIEW_BYTES).await?;
    let mut entry = object();
    entry.insert(
        "path".into(),
        Value::String(path.to_string_lossy().into_owned()),
    );
    entry.insert("name".into(), text(name));
    entry.insert("size".into(), Value::from(metadata.len()));
    entry.insert("preview".into(), Value::String(preview));
    Some(Value::Object(entry))
}

async fn read_memory_files(dir: &Path, memory_dir: &mut Option<String>, out: &mut Vec<Value>) {
    let Some(names) = try_read_dir_names(dir).await else {
        return;
    };
    // Set even when the directory is empty: it exists, and the dashboard offers
    // to open it. Only the first directory that exists gets to name it.
    if memory_dir.is_none() {
        *memory_dir = Some(dir.to_string_lossy().into_owned());
    }
    for (name, _) in names.iter().filter(|(name, _)| name.ends_with(".md")) {
        if let Some(entry) = memory_file(dir, name).await {
            out.push(entry);
        }
    }
}

fn name_of(entry: &Value) -> &str {
    field(entry, "name").as_str().unwrap_or_default()
}

/// `CLAUDE.md` plus whatever the per-project memory directory holds.
///
/// `MEMORY.md` is pinned to the top because it is the index the others hang
/// off; everything else is alphabetical.
async fn collect_claude_project_memory(cwd: &str, home: &Path) -> Value {
    let mut project = object();
    project.insert("cwd".into(), text(cwd));
    project.insert("memoryFiles".into(), Value::Array(Vec::new()));

    let claude_md = Path::new(cwd).join("CLAUDE.md");
    if let Some(content) = safe_read_preview(&claude_md, PREVIEW_BYTES).await {
        let path = claude_md.to_string_lossy().into_owned();
        project.insert("claudeMdPath".into(), Value::String(path.clone()));
        project.insert("claudeMdPreview".into(), Value::String(content.clone()));
        project.insert("instructionFilePath".into(), Value::String(path));
        project.insert("instructionFileName".into(), text("CLAUDE.md"));
        project.insert("instructionFilePreview".into(), Value::String(content));
    }

    let memory_dir = home
        .join(".claude")
        .join("projects")
        .join(project_slug(cwd))
        .join("memory");
    let mut files = Vec::new();
    let mut recorded: Option<String> = None;
    read_memory_files(&memory_dir, &mut recorded, &mut files).await;
    if let Some(dir) = recorded {
        project.insert("memoryDir".into(), Value::String(dir));
    }
    files.sort_by(|left, right| {
        let (left_name, right_name) = (name_of(left), name_of(right));
        if left_name == "MEMORY.md" {
            return std::cmp::Ordering::Less;
        }
        if right_name == "MEMORY.md" {
            return std::cmp::Ordering::Greater;
        }
        locale::compare(left_name, right_name)
    });
    project.insert("memoryFiles".into(), Value::Array(files));
    Value::Object(project)
}

/// `AGENTS.md`, and memory from both the Codex home and the project.
///
/// The home directory is read first, so it is the one `memoryDir` names when
/// both exist — the project's notes still appear in the list.
async fn collect_codex_project_memory(cwd: &str, codex_home: &Path) -> Value {
    let mut project = object();
    project.insert("cwd".into(), text(cwd));
    project.insert("memoryFiles".into(), Value::Array(Vec::new()));

    let agents_md = Path::new(cwd).join("AGENTS.md");
    if let Some(content) = safe_read_preview(&agents_md, PREVIEW_BYTES).await {
        project.insert(
            "instructionFilePath".into(),
            Value::String(agents_md.to_string_lossy().into_owned()),
        );
        project.insert("instructionFileName".into(), text("AGENTS.md"));
        project.insert("instructionFilePreview".into(), Value::String(content));
    }

    let mut files = Vec::new();
    let mut recorded: Option<String> = None;
    read_memory_files(&codex_home.join("memories"), &mut recorded, &mut files).await;
    read_memory_files(
        &Path::new(cwd).join(".codex").join("memories"),
        &mut recorded,
        &mut files,
    )
    .await;
    if let Some(dir) = recorded {
        project.insert("memoryDir".into(), Value::String(dir));
    }
    files.sort_by(|left, right| locale::compare(name_of(left), name_of(right)));
    project.insert("memoryFiles".into(), Value::Array(files));
    Value::Object(project)
}

// --- skills ------------------------------------------------------------------

/// The `description:` line out of a skill's front matter.
///
/// Read from the first four hundred units only: a skill's front matter is at
/// the top, and this runs once per skill directory on a page load.
///
/// The pattern is the reference's, character for character, because its `\s*`
/// crosses newlines: a `description:` with nothing after it takes the *next*
/// non-empty line as its value. That is surprising enough that reimplementing
/// it line-by-line would quietly disagree.
fn description_pattern() -> &'static regex::Regex {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    PATTERN.get_or_init(|| {
        regex::Regex::new(r"(?m)^description:\s*(.+)$").expect("valid description pattern")
    })
}

async fn read_skill_description(skill_dir: &Path) -> Option<String> {
    let content = safe_read_preview(&skill_dir.join("SKILL.md"), 400).await?;
    // An empty file is falsy in the reference, and never reaches the pattern.
    if content.is_empty() {
        return None;
    }
    let found = description_pattern().captures(&content)?;
    let trimmed = found[1].trim();
    // One leading quote and one trailing quote, of either kind.
    let stripped = trimmed.strip_prefix(['"', '\'']).unwrap_or(trimmed);
    Some(
        stripped
            .strip_suffix(['"', '\''])
            .unwrap_or(stripped)
            .to_string(),
    )
}

fn skill_entry(name: &str, scope: &str, path: &Path, description: Option<String>) -> Value {
    let mut skill = object();
    skill.insert("name".into(), text(name));
    skill.insert("scope".into(), text(scope));
    skill.insert(
        "path".into(),
        Value::String(path.to_string_lossy().into_owned()),
    );
    if let Some(description) = description {
        skill.insert("description".into(), Value::String(description));
    }
    Value::Object(skill)
}

/// Every child directory of `dir`, as a skill of the given scope.
///
/// `skip_dot_dirs` is for the two roots that also hold machinery — `.system`
/// under the Codex skills directory is a scope of its own, read separately, and
/// would otherwise appear twice.
async fn read_skills_dir(dir: &Path, scope: &str, skip_dot_dirs: bool, out: &mut Vec<Value>) {
    for (name, is_dir) in read_dir_names(dir).await {
        if !is_dir || (skip_dot_dirs && name.starts_with('.')) {
            continue;
        }
        let skill_dir = dir.join(&name);
        let description = read_skill_description(&skill_dir).await;
        out.push(skill_entry(&name, scope, &skill_dir, description));
    }
}

/// Skills a plugin ships, named `<plugin>:<skill>` so two plugins can both
/// ship a `review` without colliding in the list.
async fn read_plugin_skills(plugins_data: &Path, out: &mut Vec<Value>) {
    for (plugin, is_dir) in read_dir_names(plugins_data).await {
        if !is_dir {
            continue;
        }
        let skills_dir = plugins_data.join(&plugin).join("skills");
        for (name, is_dir) in read_dir_names(&skills_dir).await {
            if !is_dir {
                continue;
            }
            let skill_dir = skills_dir.join(&name);
            let description = read_skill_description(&skill_dir).await;
            out.push(skill_entry(
                &format!("{plugin}:{name}"),
                "plugin",
                &skill_dir,
                description,
            ));
        }
    }
}

async fn collect_claude_skills(home: &Path, cwd: &str) -> Vec<Value> {
    let mut skills = Vec::new();
    read_skills_dir(
        &home.join(".claude").join("skills"),
        "user",
        false,
        &mut skills,
    )
    .await;
    read_skills_dir(
        &Path::new(cwd).join(".claude").join("skills"),
        "project",
        false,
        &mut skills,
    )
    .await;
    read_plugin_skills(
        &home.join(".claude").join("plugins").join("data"),
        &mut skills,
    )
    .await;
    skills.sort_by(|left, right| locale::compare(name_of(left), name_of(right)));
    skills
}

/// Codex reads both the Agent Skills standard directories and its own.
///
/// A skill of the same name in both is one skill, and the standard location
/// wins because it is read first.
async fn collect_codex_skills(codex_home: &Path, cwd: &str, home: &Path) -> Vec<Value> {
    let mut skills = Vec::new();
    read_skills_dir(
        &home.join(".agents").join("skills"),
        "user",
        true,
        &mut skills,
    )
    .await;
    read_skills_dir(&codex_home.join("skills"), "user", true, &mut skills).await;
    read_skills_dir(
        &codex_home.join("skills").join(".system"),
        "system",
        false,
        &mut skills,
    )
    .await;
    read_skills_dir(
        &Path::new(cwd).join(".agents").join("skills"),
        "project",
        false,
        &mut skills,
    )
    .await;
    read_skills_dir(
        &Path::new(cwd).join(".codex").join("skills"),
        "project",
        false,
        &mut skills,
    )
    .await;

    let mut seen = std::collections::HashSet::new();
    skills.retain(|skill| {
        let key = format!(
            "{}:{}",
            field(skill, "scope").as_str().unwrap_or_default(),
            name_of(skill)
        );
        seen.insert(key)
    });
    skills.sort_by(|left, right| {
        let scopes = locale::compare(
            field(left, "scope").as_str().unwrap_or_default(),
            field(right, "scope").as_str().unwrap_or_default(),
        );
        if scopes != std::cmp::Ordering::Equal {
            return scopes;
        }
        locale::compare(name_of(left), name_of(right))
    });
    skills
}

// --- plugins -----------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum EntryKind {
    Directory,
    Markdown,
}

/// What a plugin sub-directory contributes: child directories, or the basenames
/// of its `.md` files. Dot-prefixed entries are machinery, not contributions.
async fn read_plugin_entry_names(dir: &Path, kind: EntryKind) -> Vec<Value> {
    let mut names: Vec<String> = Vec::new();
    for (name, is_dir) in read_dir_names(dir).await {
        if name.starts_with('.') {
            continue;
        }
        match kind {
            EntryKind::Directory if is_dir => names.push(name),
            EntryKind::Markdown if !is_dir && name.ends_with(".md") => {
                // One suffix, not every repetition of it: `notes.md.md` keeps
                // its inner `.md` the way the reference's anchored replace does.
                names.push(name.strip_suffix(".md").unwrap_or(&name).to_string());
            }
            _ => {}
        }
    }
    let mut seen = std::collections::HashSet::new();
    names.retain(|name| seen.insert(name.clone()));
    names.sort_by(|left, right| locale::compare(left, right));
    names.into_iter().map(Value::String).collect()
}

/// The MCP servers a plugin bundles.
///
/// Two shapes are accepted because both are written in practice: a document
/// with an `mcpServers` object, and a document that *is* the server map.
async fn read_plugin_mcp_keys(install: &Path) -> Vec<Value> {
    let Ok(raw) = tokio::fs::read_to_string(install.join(".mcp.json")).await else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    let wrapped = parsed.get("mcpServers").filter(|value| value.is_object());
    let servers = wrapped.unwrap_or(&parsed);
    let mut keys: Vec<String> = match servers {
        Value::Object(map) => map.keys().cloned().collect(),
        Value::Array(items) => (0..items.len()).map(|index| index.to_string()).collect(),
        _ => Vec::new(),
    };
    keys.sort_by(|left, right| locale::compare(left, right));
    keys.into_iter().map(Value::String).collect()
}

/// A plugin's own description, out of its manifest.
///
/// Read through the same preview reader as everything else, which means a
/// manifest larger than four thousand units arrives truncated and then fails to
/// parse — so an enormous manifest yields no description rather than a
/// half-read one.
async fn read_plugin_description(install: &Path) -> Option<String> {
    let content =
        safe_read_preview(&install.join(".claude-plugin").join("plugin.json"), 4_000).await?;
    if content.is_empty() {
        return None;
    }
    let parsed = serde_json::from_str::<Value>(&content).ok()?;
    parsed.get("description")?.as_str().map(str::to_string)
}

/// Claude's plugin registry, keyed by `<name>@<marketplace>`.
///
/// A leading `@` is not a separator — `@scoped` is a whole name — which is why
/// the separator has to be found at a positive index rather than merely found.
async fn collect_claude_plugins(home: &Path) -> Vec<Value> {
    let registry = home
        .join(".claude")
        .join("plugins")
        .join("installed_plugins.json");
    let Ok(raw) = tokio::fs::read_to_string(&registry).await else {
        return Vec::new();
    };
    let Ok(document) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    let Some(Value::Object(plugins)) = document.get("plugins") else {
        return Vec::new();
    };

    let mut result = Vec::new();
    for (key, records) in plugins {
        let separator = key.rfind('@').filter(|index| *index > 0);
        let (name, marketplace) = match separator {
            Some(index) => (key[..index].to_string(), Some(key[index + 1..].to_string())),
            None => (key.clone(), None),
        };
        let record = records.get(0).cloned().unwrap_or(Value::Null);
        let install = string_field(&record, "installPath");

        let mut plugin = object();
        plugin.insert("name".into(), Value::String(name));
        if let Some(marketplace) = marketplace {
            plugin.insert("marketplace".into(), Value::String(marketplace));
        }
        plugin.insert(
            "scope".into(),
            text(if field(&record, "scope").as_str() == Some("project") {
                "project"
            } else {
                "user"
            }),
        );
        if let Some(version) = string_field(&record, "version") {
            plugin.insert("version".into(), Value::String(version));
        }
        if let Some(install) = install.as_deref() {
            plugin.insert("installPath".into(), text(install));
        }
        let (skills, commands, agents, servers, description) = match install.as_deref() {
            Some(install) => {
                let install = Path::new(install);
                (
                    read_plugin_entry_names(&install.join("skills"), EntryKind::Directory).await,
                    read_plugin_entry_names(&install.join("commands"), EntryKind::Markdown).await,
                    read_plugin_entry_names(&install.join("agents"), EntryKind::Markdown).await,
                    read_plugin_mcp_keys(install).await,
                    read_plugin_description(install).await,
                )
            }
            None => (Vec::new(), Vec::new(), Vec::new(), Vec::new(), None),
        };
        if let Some(description) = description {
            plugin.insert("description".into(), Value::String(description));
        }
        plugin.insert("skills".into(), Value::Array(skills));
        plugin.insert("commands".into(), Value::Array(commands));
        plugin.insert("agents".into(), Value::Array(agents));
        plugin.insert("mcpServers".into(), Value::Array(servers));
        result.push(Value::Object(plugin));
    }
    result.sort_by(|left, right| locale::compare(name_of(left), name_of(right)));
    result
}

// --- hooks -------------------------------------------------------------------

/// Every hook one settings file declares.
///
/// The two indices in a hook's id count *every* entry, including the ones this
/// skips for being the wrong shape — the id has to keep naming the same
/// position in the file after a malformed neighbour is fixed.
async fn read_hooks_file(settings_path: &Path, scope: &str) -> Vec<Value> {
    let Ok(raw) = tokio::fs::read_to_string(settings_path).await else {
        return Vec::new();
    };
    let Ok(document) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    let Some(Value::Object(events)) = document.get("hooks") else {
        return Vec::new();
    };
    let settings = settings_path.to_string_lossy().into_owned();

    let mut hooks = Vec::new();
    for (event, raw_entries) in events {
        let Value::Array(entries) = raw_entries else {
            continue;
        };
        for (entry_index, entry) in entries.iter().enumerate() {
            // Arrays are objects too, and reach the `hooks` lookup below, which
            // then finds nothing — the same outcome by a different route.
            if !(entry.is_object() || entry.is_array()) {
                continue;
            }
            let matcher = string_field(entry, "matcher");
            let Some(Value::Array(entry_hooks)) = entry.get("hooks") else {
                continue;
            };
            for (hook_index, raw_hook) in entry_hooks.iter().enumerate() {
                if !(raw_hook.is_object() || raw_hook.is_array()) {
                    continue;
                }
                let mut hook = object();
                hook.insert(
                    "id".into(),
                    text(&format!("{settings}:{event}:{entry_index}:{hook_index}")),
                );
                hook.insert("event".into(), text(event));
                hook.insert("scope".into(), text(scope));
                hook.insert("settingsPath".into(), text(&settings));
                if let Some(matcher) = matcher.clone() {
                    hook.insert("matcher".into(), Value::String(matcher));
                }
                if let Some(kind) = string_field(raw_hook, "type") {
                    hook.insert("type".into(), Value::String(kind));
                }
                if let Some(command) = string_field(raw_hook, "command") {
                    hook.insert("command".into(), Value::String(command));
                }
                hook.insert("status".into(), text("default"));
                hooks.push(Value::Object(hook));
            }
        }
    }
    hooks
}

fn sort_hooks(hooks: &mut [Value]) {
    hooks.sort_by(|left, right| {
        let by = |key: &str, fallback: &str| {
            let take = |value: &Value| {
                value
                    .get(key)
                    .and_then(Value::as_str)
                    .unwrap_or(fallback)
                    .to_string()
            };
            locale::compare(&take(left), &take(right))
        };
        by("event", "")
            .then_with(|| by("matcher", ""))
            .then_with(|| by("command", ""))
    });
}

async fn collect_claude_hooks(home: &Path, cwd: &str) -> Vec<Value> {
    let mut hooks = Vec::new();
    for (path, scope) in [
        (home.join(".claude").join("settings.json"), "user"),
        (home.join(".claude").join("settings.local.json"), "user"),
        (
            Path::new(cwd).join(".claude").join("settings.json"),
            "project",
        ),
        (
            Path::new(cwd).join(".claude").join("settings.local.json"),
            "project",
        ),
    ] {
        hooks.extend(read_hooks_file(&path, scope).await);
    }
    sort_hooks(&mut hooks);
    hooks
}

/// Codex hooks carry a trust decision the config file records separately.
///
/// The state is looked up by the hook's id and then by a normalised form of it,
/// because Codex writes the event in snake case where the settings file spells
/// it in camel case.
async fn collect_codex_hooks(codex_home: &Path, cwd: &str, config: &CodexConfig) -> Vec<Value> {
    let mut hooks = Vec::new();
    hooks.extend(read_hooks_file(&codex_home.join("hooks.json"), "user").await);
    hooks.extend(
        read_hooks_file(&Path::new(cwd).join(".codex").join("hooks.json"), "project").await,
    );

    for hook in &mut hooks {
        let id = field(hook, "id").as_str().unwrap_or_default().to_string();
        let state = config
            .hooks_state
            .get(&id)
            .or_else(|| config.hooks_state.get(&normalize_hook_state_id(&id)));
        let status = match state.map(|state| state.get("enabled")) {
            Some(Some(Value::Bool(true))) => "enabled",
            Some(Some(Value::Bool(false))) => "disabled",
            _ => "default",
        };
        if let Some(hook) = hook.as_object_mut() {
            hook.insert("status".into(), text(status));
            if let Some(state) = state {
                hook.insert(
                    "trusted".into(),
                    Value::Bool(matches!(state.get("trusted_hash"), Some(Value::String(_)))),
                );
            }
        }
    }
    sort_hooks(&mut hooks);
    hooks
}

/// `<path>:<event>:<entry>:<hook>` with the event in snake case.
fn normalize_hook_state_id(id: &str) -> String {
    let parts: Vec<&str> = id.split(':').collect();
    if parts.len() < 4 {
        return id.to_string();
    }
    let hook_index = parts[parts.len() - 1];
    let entry_index = parts[parts.len() - 2];
    let event = parts[parts.len() - 3];
    let head = parts[..parts.len() - 3].join(":");
    format!(
        "{head}:{}:{entry_index}:{hook_index}",
        camel_to_snake(event).to_lowercase()
    )
}

/// `PreToolUse` → `Pre_Tool_Use`, which the caller then lowercases.
fn camel_to_snake(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::with_capacity(value.len());
    for (index, current) in chars.iter().enumerate() {
        if index > 0 {
            let previous = chars[index - 1];
            if (previous.is_ascii_lowercase() || previous.is_ascii_digit())
                && current.is_ascii_uppercase()
            {
                out.push('_');
            }
        }
        out.push(*current);
    }
    out
}

// --- MCP servers -------------------------------------------------------------

/// One server as the dashboard shows it. Fields that are the wrong type are
/// dropped rather than coerced: a `command` that is a number is not a command.
fn mcp_entry(name: &str, scope: &str, raw: &Value) -> Value {
    let mut entry = object();
    entry.insert("name".into(), text(name));
    entry.insert("scope".into(), text(scope));
    if raw.is_object() || raw.is_array() {
        if let Some(command) = string_field(raw, "command") {
            entry.insert("command".into(), Value::String(command));
        }
        if let Some(Value::Array(args)) = raw.get("args") {
            entry.insert(
                "args".into(),
                Value::Array(
                    args.iter()
                        .filter(|item| item.is_string())
                        .cloned()
                        .collect(),
                ),
            );
        }
        if let Some(kind) = string_field(raw, "type") {
            entry.insert("type".into(), Value::String(kind));
        }
        if let Some(url) = string_field(raw, "url") {
            entry.insert("url".into(), Value::String(url));
        }
    }
    Value::Object(entry)
}

fn collect_claude_mcp_servers(claude_json: Option<&Value>, cwd: &str) -> Vec<Value> {
    let Some(document) = claude_json else {
        return Vec::new();
    };
    let mut servers = Vec::new();
    if let Some(Value::Object(user)) = document.get("mcpServers") {
        for (name, raw) in user {
            servers.push(mcp_entry(name, "user", raw));
        }
    }
    let project = field(field(document, "projects"), cwd).clone();
    if let Some(Value::Object(scoped)) = project.get("mcpServers") {
        for (name, raw) in scoped {
            servers.push(mcp_entry(name, "project", raw));
        }
    }
    // Stable, so a name declared in both scopes keeps the user one first.
    servers.sort_by(|left, right| locale::compare(name_of(left), name_of(right)));
    servers
}

fn collect_codex_mcp_servers(config: &CodexConfig) -> Vec<Value> {
    let mut servers: Vec<Value> = config
        .mcp_servers
        .iter()
        .map(|(name, raw)| mcp_entry(name, "user", raw))
        .collect();
    servers.sort_by(|left, right| locale::compare(name_of(left), name_of(right)));
    servers
}

// --- projects ----------------------------------------------------------------

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// `Date.parse`, narrowed to the ISO instants these files hold.
///
/// Unreadable is `NaN`, which the ordering below turns into "no opinion" —
/// exactly what the reference does, because a comparator that returns `NaN` is
/// read as zero and a stable sort then leaves the pair alone.
fn date_parse_ms(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Null) => 0.0,
        Some(Value::String(text)) if text.is_empty() => 0.0,
        Some(Value::String(text)) => chrono::DateTime::parse_from_rfc3339(text)
            .map(|parsed| parsed.timestamp_millis() as f64)
            .unwrap_or(f64::NAN),
        Some(_) => f64::NAN,
    }
}

/// Current directory first, then most recently used, then by directory name.
fn project_order(left: &Value, right: &Value) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let current = |value: &Value| field(value, "current").as_bool().unwrap_or(false);
    match (current(left), current(right)) {
        (true, false) => return Ordering::Less,
        (false, true) => return Ordering::Greater,
        _ => {}
    }
    let left_time = date_parse_ms(left.get("lastSessionModified"));
    let right_time = date_parse_ms(right.get("lastSessionModified"));
    if left_time != right_time {
        let difference = right_time - left_time;
        return if difference.is_nan() {
            Ordering::Equal
        } else if difference < 0.0 {
            Ordering::Less
        } else if difference > 0.0 {
            Ordering::Greater
        } else {
            Ordering::Equal
        };
    }
    locale::compare(
        basename(field(left, "path").as_str().unwrap_or_default()),
        basename(field(right, "path").as_str().unwrap_or_default()),
    )
}

fn collect_claude_projects(claude_json: Option<&Value>, cwd: &str) -> Vec<Value> {
    let Some(Value::Object(projects)) = claude_json.and_then(|json| json.get("projects")) else {
        return Vec::new();
    };
    let mut entries: Vec<Value> = projects
        .iter()
        .map(|(path, value)| {
            let mut entry = object();
            entry.insert("path".into(), text(path));
            entry.insert("current".into(), Value::Bool(path == cwd));
            // Copied through rather than validated: the reference puts whatever
            // is there straight into the answer.
            for key in ["lastSessionFirstPrompt", "lastSessionModified"] {
                if let Some(found) = value.get(key) {
                    entry.insert(key.into(), found.clone());
                }
            }
            // `Object.keys(...).length`, which counts an array's indices and a
            // string's code units as readily as an object's keys.
            let count = match value.get("mcpServers") {
                Some(Value::Object(servers)) => servers.len(),
                Some(Value::Array(servers)) => servers.len(),
                Some(Value::String(servers)) => servers.encode_utf16().count(),
                _ => 0,
            };
            entry.insert("mcpServerCount".into(), Value::from(count));
            Value::Object(entry)
        })
        .collect();
    entries.sort_by(project_order);
    entries.truncate(MAX_PROJECTS);
    entries
}

/// The last line of every rollout's opening `session_meta`, one per directory.
async fn collect_codex_projects(codex_home: &Path, cwd: &str) -> Vec<Value> {
    let mut files = Vec::new();
    collect_jsonl_files(&codex_home.join("sessions"), &mut files).await;

    let mut by_path: Map<String, Value> = Map::new();
    for file in files {
        let Some((project_cwd, timestamp)) = read_session_meta(&file).await else {
            continue;
        };
        // `>=`, so the later of two readings for one directory wins -- and an
        // unreadable instant compares false against everything, which leaves
        // whatever was already there in place.
        let replaces = match by_path.get(&project_cwd) {
            None => true,
            Some(entry) => {
                date_parse_ms(timestamp.as_ref()) >= date_parse_ms(entry.get("lastSessionModified"))
            }
        };
        if !replaces {
            continue;
        }
        let mut entry = object();
        entry.insert("path".into(), text(&project_cwd));
        entry.insert("current".into(), Value::Bool(project_cwd == cwd));
        if let Some(timestamp) = timestamp {
            entry.insert("lastSessionModified".into(), timestamp);
        }
        entry.insert("mcpServerCount".into(), Value::from(0));
        by_path.insert(project_cwd, Value::Object(entry));
    }
    by_path.into_iter().map(|(_, entry)| entry).collect()
}

/// Directories Codex has been configured for, plus directories it has run in.
///
/// A project the config already knew about keeps its own key order and gains
/// `lastSessionModified` at the end; one only a session mentions carries the
/// session's order. That is a spread's doing in the reference, and it is
/// visible in the response.
fn merge_codex_projects(config: &CodexConfig, sessions: Vec<Value>, cwd: &str) -> Vec<Value> {
    let mut by_path: Map<String, Value> = Map::new();
    for path in config.projects.keys() {
        let mut entry = object();
        entry.insert("path".into(), text(path));
        entry.insert("current".into(), Value::Bool(path == cwd));
        entry.insert("mcpServerCount".into(), Value::from(0));
        by_path.insert(path.clone(), Value::Object(entry));
    }
    for session in sessions {
        let path = field(&session, "path")
            .as_str()
            .unwrap_or_default()
            .to_string();
        let mut merged = match by_path.get(&path) {
            Some(Value::Object(existing)) => existing.clone(),
            _ => object(),
        };
        if let Value::Object(session) = &session {
            for (key, value) in session {
                merged.insert(key.clone(), value.clone());
            }
        }
        merged.insert("current".into(), Value::Bool(path == cwd));
        by_path.insert(path, Value::Object(merged));
    }
    let mut entries: Vec<Value> = by_path.into_iter().map(|(_, entry)| entry).collect();
    entries.sort_by(project_order);
    entries.truncate(MAX_PROJECTS);
    entries
}

async fn collect_jsonl_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for (name, is_dir) in read_dir_names(dir).await {
        let path = dir.join(&name);
        if is_dir {
            Box::pin(collect_jsonl_files(&path, out)).await;
        } else if name.ends_with(".jsonl") {
            out.push(path);
        }
    }
}

/// The directory and instant a rollout opened with, if it opened with one.
async fn read_session_meta(path: &Path) -> Option<(String, Option<Value>)> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path).await.ok()?;
    let mut buffer = vec![0u8; 64 * 1024];
    let read = file.read(&mut buffer).await.ok()?;
    if read == 0 {
        return None;
    }
    let head = String::from_utf8_lossy(&buffer[..read]);
    let first = head.split('\n').next().unwrap_or_default();
    let first = first.strip_suffix('\r').unwrap_or(first);
    let event: Value = serde_json::from_str(first).ok()?;
    if field(&event, "type").as_str() != Some("session_meta") {
        return None;
    }
    let payload = field(&event, "payload");
    // A blank `cwd` is no directory at all, not the root.
    let project_cwd = string_field(payload, "cwd").filter(|value| !value.is_empty())?;
    let timestamp = payload
        .get("timestamp")
        .filter(|value| !value.is_null())
        .or_else(|| event.get("timestamp").filter(|value| !value.is_null()))
        .cloned();
    Some((project_cwd, timestamp))
}

// --- Codex's config.toml -----------------------------------------------------

/// The three tables of `config.toml` this reads, each keyed in file order.
///
/// Deliberately not a TOML library. The reference parses by hand, and the
/// subset it accepts — and quietly ignores — is the behaviour: a real parser
/// would reject documents this reads happily, and read documents this skips.
#[derive(Default)]
pub struct CodexConfig {
    pub mcp_servers: Map<String, Value>,
    pub projects: Map<String, Value>,
    pub hooks_state: Map<String, Value>,
}

fn section_pattern() -> &'static regex::Regex {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    PATTERN.get_or_init(|| regex::Regex::new(r"^\[([^\]]+)\]$").expect("valid section pattern"))
}

fn assignment_pattern() -> &'static regex::Regex {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    PATTERN.get_or_init(|| {
        regex::Regex::new(r#"^("[^"]+"|[\w.-]+)\s*=\s*(.+)$"#).expect("valid assignment pattern")
    })
}

/// Sections in the order the file declares them, each a flat map of values.
///
/// A key outside any section is dropped, and a section declared twice keeps its
/// first position while gaining the later keys.
fn parse_toml_sections(raw: &str) -> Map<String, Value> {
    let mut sections: Map<String, Value> = Map::new();
    let mut current: Option<String> = None;
    for line in raw.split('\n') {
        let trimmed = line.strip_suffix('\r').unwrap_or(line).trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(found) = section_pattern().captures(trimmed) {
            let name = found[1].to_string();
            sections
                .entry(name.clone())
                .or_insert_with(|| Value::Object(object()));
            current = Some(name);
            continue;
        }
        let Some(section) = current.as_ref() else {
            continue;
        };
        let Some(found) = assignment_pattern().captures(trimmed) else {
            continue;
        };
        if let Some(Value::Object(values)) = sections.get_mut(section) {
            values.insert(unquote_toml(&found[1]), parse_toml_value(&found[2]));
        }
    }
    sections
}

/// `a.b."c.d"` into its parts, with a quoted part kept whole.
fn split_toml_section(section: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for character in section.chars() {
        match character {
            '"' => {
                quoted = !quoted;
                current.push(character);
            }
            '.' if !quoted => {
                parts.push(unquote_toml(&current));
                current.clear();
            }
            _ => current.push(character),
        }
    }
    if !current.is_empty() {
        parts.push(unquote_toml(&current));
    }
    parts
}

/// An array of strings, a boolean, or a string. Nothing else has a spelling
/// here — a number arrives as the text it was written as.
fn parse_toml_value(value: &str) -> Value {
    let trimmed = strip_toml_comment(value.trim());
    if trimmed.starts_with('[') && trimmed.ends_with(']') {
        let body = trimmed[1..trimmed.len() - 1].trim().to_string();
        if body.is_empty() {
            return Value::Array(Vec::new());
        }
        return Value::Array(
            body.split(',')
                .map(|item| parse_toml_value(item.trim()))
                .filter(Value::is_string)
                .collect(),
        );
    }
    match trimmed.as_str() {
        "true" => Value::Bool(true),
        "false" => Value::Bool(false),
        other => Value::String(unquote_toml(other)),
    }
}

/// Everything from an unquoted `#` onwards.
fn strip_toml_comment(value: &str) -> String {
    let mut quoted = false;
    for (index, character) in value.char_indices() {
        if character == '"' {
            quoted = !quoted;
        }
        if character == '#' && !quoted {
            return value[..index].trim().to_string();
        }
    }
    value.to_string()
}

fn unquote_toml(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
        return trimmed[1..trimmed.len() - 1].to_string();
    }
    trimmed.to_string()
}

/// The three tables, out of `config.toml`. A missing file is an empty config.
pub async fn read_codex_config(codex_home: &Path) -> CodexConfig {
    let mut config = CodexConfig::default();
    let Ok(raw) = tokio::fs::read_to_string(codex_home.join("config.toml")).await else {
        return config;
    };
    for (section, values) in parse_toml_sections(&raw) {
        let parts = split_toml_section(&section);
        match parts.as_slice() {
            [head, name] if head == "mcp_servers" => {
                config.mcp_servers.insert(name.clone(), values);
            }
            [head, name] if head == "projects" => {
                config.projects.insert(name.clone(), values);
            }
            [head, state, id] if head == "hooks" && state == "state" => {
                config.hooks_state.insert(id.clone(), values);
            }
            _ => {}
        }
    }
    config
}

// --- the whole answer --------------------------------------------------------

async fn read_claude_json(home: &Path) -> Option<Value> {
    let raw = tokio::fs::read_to_string(home.join(".claude.json"))
        .await
        .ok()?;
    serde_json::from_str(&raw).ok()
}

fn build_profile(
    project: Value,
    skills: Vec<Value>,
    mcp_servers: Vec<Value>,
    plugins: Vec<Value>,
    hooks: Vec<Value>,
    projects: Vec<Value>,
) -> Value {
    let mut profile = object();
    profile.insert("project".into(), project);
    profile.insert("skills".into(), Value::Array(skills));
    profile.insert("mcpServers".into(), Value::Array(mcp_servers));
    profile.insert("plugins".into(), Value::Array(plugins));
    profile.insert("hooks".into(), Value::Array(hooks));
    profile.insert("projects".into(), Value::Array(projects));
    Value::Object(profile)
}

/// Both profiles, plus whichever one is active spread across the top level.
///
/// The duplication is the reference's contract: a client that knows which agent
/// it is talking to reads the top level, and the settings page that offers both
/// reads `agents`. Building the active profile twice would be cheaper to write
/// and would let the two answers drift.
pub async fn build_agent_info(cwd: &str) -> Value {
    let detected = detect_agent().await;
    let home = crate::home::home_directory();
    let codex_root = codex_home();

    let claude_json = read_claude_json(&home).await;
    let claude_profile = build_profile(
        collect_claude_project_memory(cwd, &home).await,
        collect_claude_skills(&home, cwd).await,
        collect_claude_mcp_servers(claude_json.as_ref(), cwd),
        collect_claude_plugins(&home).await,
        collect_claude_hooks(&home, cwd).await,
        collect_claude_projects(claude_json.as_ref(), cwd),
    );

    let config = read_codex_config(&codex_root).await;
    let codex_sessions = collect_codex_projects(&codex_root, cwd).await;
    let codex_profile = build_profile(
        collect_codex_project_memory(cwd, &codex_root).await,
        collect_codex_skills(&codex_root, cwd, &home).await,
        collect_codex_mcp_servers(&config),
        Vec::new(),
        collect_codex_hooks(&codex_root, cwd, &config).await,
        merge_codex_projects(&config, codex_sessions, cwd),
    );

    let active = if field(&detected, "name").as_str() == Some("codex") {
        codex_profile.clone()
    } else {
        claude_profile.clone()
    };

    let mut result = object();
    result.insert("detected".into(), detected);
    if let Value::Object(active) = active {
        for (key, value) in active {
            result.insert(key, value);
        }
    }
    let mut agents = object();
    agents.insert("claude-code".into(), claude_profile);
    agents.insert("codex".into(), codex_profile);
    result.insert("agents".into(), Value::Object(agents));
    Value::Object(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unit-tested rather than gated: the array filter cannot be seen through
    /// `/api/agent`. The only arrays that reach the response are an MCP
    /// server's `args`, and `mcp_entry` filters those to strings itself — so a
    /// parser that kept a boolean and a parser that dropped it produce the same
    /// answer. The masking is the reason this lives here.
    #[test]
    fn a_toml_array_keeps_only_its_strings() {
        assert_eq!(
            parse_toml_value(r#"["keep", true, "also-keep"]"#),
            serde_json::json!(["keep", "also-keep"])
        );
        assert_eq!(parse_toml_value("[]"), serde_json::json!([]));
        assert_eq!(parse_toml_value("[  ]"), serde_json::json!([]));
        // Bare words are text, so a number survives as the text it was written
        // as rather than being dropped for not being a string.
        assert_eq!(parse_toml_value("[1, 2]"), serde_json::json!(["1", "2"]));
    }

    #[test]
    fn a_hash_inside_quotes_is_not_a_comment() {
        assert_eq!(
            parse_toml_value(r#""https://x/docs#usage"  # but this is"#),
            serde_json::json!("https://x/docs#usage")
        );
        assert_eq!(
            parse_toml_value("bare # trailing"),
            serde_json::json!("bare")
        );
    }

    #[test]
    fn a_quoted_section_part_keeps_its_dots() {
        assert_eq!(
            split_toml_section(r#"hooks.state."/a/b/hooks.json:Pre:0:0""#),
            ["hooks", "state", "/a/b/hooks.json:Pre:0:0"]
        );
        assert_eq!(
            split_toml_section("mcp_servers.zulu"),
            ["mcp_servers", "zulu"]
        );
    }

    #[test]
    fn an_event_name_becomes_snake_case_only_between_a_lower_and_an_upper() {
        assert_eq!(camel_to_snake("PreToolUse"), "Pre_Tool_Use");
        assert_eq!(camel_to_snake("SessionEnd"), "Session_End");
        assert_eq!(camel_to_snake("ALLCAPS"), "ALLCAPS");
        assert_eq!(camel_to_snake(""), "");
    }

    #[test]
    fn a_preview_longer_than_its_limit_says_so() {
        assert_eq!(slice_units("abcdef", 3), "abc");
        assert_eq!(utf16_len("a\u{1F600}"), 3, "a surrogate pair is two units");
    }
}
