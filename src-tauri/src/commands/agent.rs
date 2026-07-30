//! Agent (Claude Code / Codex) introspection — the Rust port of the Node
//! `src/web/agent-info.ts`. Reads the agent CLIs' on-disk config (skills, MCP
//! servers, plugins, hooks, project memory) so the desktop app's Agent panel
//! shows the same profile the web build does. Read-only; no agent MCPs borrowed.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::AppState;

const PREVIEW_BYTES: usize = 1200;

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFile {
    path: String,
    name: String,
    size: u64,
    preview: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    name: String,
    scope: String,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    name: String,
    scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    args: Option<Vec<String>>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Plugin {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    marketplace: Option<String>,
    scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    install_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    skills: Vec<String>,
    commands: Vec<String>,
    agents: Vec<String>,
    mcp_servers: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Hook {
    id: String,
    event: String,
    scope: String,
    settings_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    matcher: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    trusted: Option<bool>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntry {
    path: String,
    current: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_session_first_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_session_modified: Option<String>,
    mcp_server_count: usize,
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    instruction_file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    instruction_file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    instruction_file_preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    claude_md_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    claude_md_preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    memory_dir: Option<String>,
    memory_files: Vec<MemoryFile>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfile {
    project: ProjectInfo,
    skills: Vec<Skill>,
    mcp_servers: Vec<McpServer>,
    plugins: Vec<Plugin>,
    hooks: Vec<Hook>,
    projects: Vec<ProjectEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detected {
    name: String,
    label: String,
    signals: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_process: Option<String>,
}

#[derive(Serialize)]
pub struct Agents {
    #[serde(rename = "claude-code")]
    claude_code: AgentProfile,
    codex: AgentProfile,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    #[serde(flatten)]
    profile: AgentProfile,
    detected: Detected,
    agents: Agents,
}

#[tauri::command]
pub async fn get_agent_info(state: State<'_, AppState>) -> Result<AgentInfo, String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    // The desktop app has no per-request cwd, so the project context is the
    // selected git repo (else the first repo, else home).
    let cwd = config
        .selected_git_repository
        .as_ref()
        .and_then(|name| config.git_repositories.iter().find(|r| &r.name == name))
        .or_else(|| config.git_repositories.first())
        .map(|r| r.active_worktree_path.clone().unwrap_or_else(|| r.path.clone()))
        .unwrap_or_else(|| home_dir().to_string_lossy().into_owned());

    let home = home_dir();
    let codex_home = std::env::var("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join(".codex"));

    let detected = detect_agent();

    let claude_codex_config = read_codex_config(&codex_home);
    let claude_profile = AgentProfile {
        project: claude_project_memory(&cwd, &home),
        skills: claude_skills(&home, &cwd),
        mcp_servers: claude_mcp_servers(&home, &cwd),
        plugins: claude_plugins(&home),
        hooks: claude_hooks(&home, &cwd),
        projects: claude_projects(&home, &cwd),
    };
    let codex_profile = AgentProfile {
        project: codex_project_memory(&cwd, &codex_home),
        skills: codex_skills(&codex_home, &cwd),
        mcp_servers: codex_mcp_servers(&claude_codex_config),
        plugins: vec![],
        hooks: codex_hooks(&codex_home, &cwd, &claude_codex_config),
        projects: codex_projects(&claude_codex_config, &codex_home, &cwd),
    };

    let active = if detected.name == "codex" {
        codex_profile.clone()
    } else {
        claude_profile.clone()
    };

    Ok(AgentInfo {
        profile: active,
        detected,
        agents: Agents {
            claude_code: claude_profile,
            codex: codex_profile,
        },
    })
}

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

// ---- agent detection ----

fn detect_agent() -> Detected {
    let mut signals: Vec<String> = Vec::new();
    let mut name = "unknown".to_string();
    let mut label = "Unknown agent".to_string();

    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());

    if env("CLAUDECODE").as_deref() == Some("1")
        || env("CLAUDE_CODE_ENTRYPOINT").is_some()
        || env("CLAUDE_PROJECT_DIR").is_some()
    {
        name = "claude-code".into();
        label = "Claude Code".into();
        if env("CLAUDECODE").as_deref() == Some("1") {
            signals.push("CLAUDECODE=1".into());
        }
        if let Some(v) = env("CLAUDE_CODE_ENTRYPOINT") {
            signals.push(format!("CLAUDE_CODE_ENTRYPOINT={v}"));
        }
        if env("CLAUDE_PROJECT_DIR").is_some() {
            signals.push("CLAUDE_PROJECT_DIR set".into());
        }
    } else if env("CODEX_HOME").is_some() || env("CODEX_SANDBOX").is_some() || env("CODEX_CLI").is_some() {
        name = "codex".into();
        label = "OpenAI Codex CLI".into();
        if env("CODEX_HOME").is_some() {
            signals.push("CODEX_HOME set".into());
        }
        if env("CODEX_SANDBOX").is_some() {
            signals.push("CODEX_SANDBOX set".into());
        }
    } else if env("GEMINI_API_KEY").is_some() || env("GEMINI_CLI").is_some() || env("GOOGLE_GENAI_USE_VERTEXAI").is_some() {
        name = "gemini".into();
        label = "Gemini CLI".into();
        if env("GEMINI_CLI").is_some() {
            signals.push("GEMINI_CLI set".into());
        }
    }

    let parent_process = parent_command();
    if let Some(parent) = &parent_process {
        if name == "unknown" {
            let lower = parent.to_lowercase();
            if lower.contains("claude") {
                name = "claude-code".into();
                label = "Claude Code".into();
                signals.push(format!("parent: {parent}"));
            } else if lower.contains("codex") {
                name = "codex".into();
                label = "OpenAI Codex CLI".into();
                signals.push(format!("parent: {parent}"));
            } else if lower.contains("gemini") {
                name = "gemini".into();
                label = "Gemini CLI".into();
                signals.push(format!("parent: {parent}"));
            }
        }
    }

    Detected {
        name,
        label,
        signals,
        parent_process,
    }
}

#[cfg(unix)]
fn parent_command() -> Option<String> {
    let ppid = unsafe { libc::getppid() };
    if ppid <= 1 {
        return None;
    }
    let out = std::process::Command::new("ps")
        .args(["-o", "command=", "-p", &ppid.to_string()])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let line = s.trim().lines().next()?;
    Some(line.chars().take(240).collect())
}

#[cfg(not(unix))]
fn parent_command() -> Option<String> {
    None
}

// ---- Claude: project memory ----

fn project_slug(cwd: &str) -> String {
    let replaced: String = cwd
        .chars()
        .map(|c| if c == '/' || c == '\\' { '-' } else { c })
        .collect();
    // Collapse whitespace runs to a single '-'.
    let mut out = String::with_capacity(replaced.len());
    let mut in_ws = false;
    for c in replaced.chars() {
        if c.is_whitespace() {
            if !in_ws {
                out.push('-');
                in_ws = true;
            }
        } else {
            out.push(c);
            in_ws = false;
        }
    }
    out
}

fn claude_project_memory(cwd: &str, home: &Path) -> ProjectInfo {
    let mut result = ProjectInfo {
        cwd: cwd.to_string(),
        ..Default::default()
    };

    let claude_md = Path::new(cwd).join("CLAUDE.md");
    if let Some(content) = safe_read_preview(&claude_md, PREVIEW_BYTES) {
        let path_str = claude_md.to_string_lossy().into_owned();
        result.claude_md_path = Some(path_str.clone());
        result.claude_md_preview = Some(content.clone());
        result.instruction_file_path = Some(path_str);
        result.instruction_file_name = Some("CLAUDE.md".into());
        result.instruction_file_preview = Some(content);
    }

    let slug = project_slug(cwd);
    let memory_dir = home.join(".claude").join("projects").join(&slug).join("memory");
    if let Ok(entries) = fs::read_dir(&memory_dir) {
        result.memory_dir = Some(memory_dir.to_string_lossy().into_owned());
        let mut files = read_md_memory_files(entries);
        files.sort_by(|a, b| {
            if a.name == "MEMORY.md" {
                return std::cmp::Ordering::Less;
            }
            if b.name == "MEMORY.md" {
                return std::cmp::Ordering::Greater;
            }
            a.name.cmp(&b.name)
        });
        result.memory_files = files;
    }

    result
}

fn read_md_memory_files(entries: fs::ReadDir) -> Vec<MemoryFile> {
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".md") {
            continue;
        }
        let path = entry.path();
        let meta = match fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let preview = match safe_read_preview(&path, PREVIEW_BYTES) {
            Some(p) => p,
            None => continue,
        };
        files.push(MemoryFile {
            path: path.to_string_lossy().into_owned(),
            name,
            size: meta.len(),
            preview,
        });
    }
    files
}

fn codex_project_memory(cwd: &str, codex_home: &Path) -> ProjectInfo {
    let mut result = ProjectInfo {
        cwd: cwd.to_string(),
        ..Default::default()
    };

    let agents_md = Path::new(cwd).join("AGENTS.md");
    if let Some(content) = safe_read_preview(&agents_md, PREVIEW_BYTES) {
        result.instruction_file_path = Some(agents_md.to_string_lossy().into_owned());
        result.instruction_file_name = Some("AGENTS.md".into());
        result.instruction_file_preview = Some(content);
    }

    read_codex_memory_dir(&codex_home.join("memories"), &mut result);
    read_codex_memory_dir(&Path::new(cwd).join(".codex").join("memories"), &mut result);
    result.memory_files.sort_by(|a, b| a.name.cmp(&b.name));

    result
}

fn read_codex_memory_dir(dir: &Path, out: &mut ProjectInfo) {
    if let Ok(entries) = fs::read_dir(dir) {
        if out.memory_dir.is_none() {
            out.memory_dir = Some(dir.to_string_lossy().into_owned());
        }
        out.memory_files.extend(read_md_memory_files(entries));
    }
}

// ---- skills ----

fn claude_skills(home: &Path, cwd: &str) -> Vec<Skill> {
    let mut skills = Vec::new();
    read_skills_dir(&home.join(".claude").join("skills"), "user", &mut skills, false);
    read_skills_dir(&Path::new(cwd).join(".claude").join("skills"), "project", &mut skills, false);
    read_plugin_skills(&home.join(".claude").join("plugins").join("data"), &mut skills);
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

fn codex_skills(codex_home: &Path, cwd: &str) -> Vec<Skill> {
    let mut skills = Vec::new();
    read_skills_dir(&codex_home.join("skills"), "user", &mut skills, true);
    read_skills_dir(&codex_home.join("skills").join(".system"), "system", &mut skills, false);
    read_skills_dir(&Path::new(cwd).join(".codex").join("skills"), "project", &mut skills, false);
    skills.sort_by(|a, b| {
        if a.scope != b.scope {
            return a.scope.cmp(&b.scope);
        }
        a.name.cmp(&b.name)
    });
    skills
}

fn read_skills_dir(dir: &Path, scope: &str, out: &mut Vec<Skill>, skip_dot_dirs: bool) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if skip_dot_dirs && name.starts_with('.') {
            continue;
        }
        let skill_dir = entry.path();
        let description = read_skill_description(&skill_dir);
        out.push(Skill {
            name,
            scope: scope.to_string(),
            path: skill_dir.to_string_lossy().into_owned(),
            description,
        });
    }
}

fn read_plugin_skills(plugins_data_dir: &Path, out: &mut Vec<Skill>) {
    let entries = match fs::read_dir(plugins_data_dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let plugin_name = entry.file_name().to_string_lossy().into_owned();
        let skills_dir = entry.path().join("skills");
        let skill_entries = match fs::read_dir(&skills_dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for skill_entry in skill_entries.flatten() {
            if !skill_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let skill_name = skill_entry.file_name().to_string_lossy().into_owned();
            let skill_dir = skill_entry.path();
            let description = read_skill_description(&skill_dir);
            out.push(Skill {
                name: format!("{plugin_name}:{skill_name}"),
                scope: "plugin".to_string(),
                path: skill_dir.to_string_lossy().into_owned(),
                description,
            });
        }
    }
}

fn read_skill_description(skill_dir: &Path) -> Option<String> {
    let content = safe_read_preview(&skill_dir.join("SKILL.md"), 400)?;
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("description:") {
            let trimmed = rest.trim();
            let unquoted = trimmed.trim_matches(|c| c == '"' || c == '\'');
            return Some(unquoted.to_string());
        }
    }
    None
}

// ---- Claude: plugins ----

fn claude_plugins(home: &Path) -> Vec<Plugin> {
    let registry = home.join(".claude").join("plugins").join("installed_plugins.json");
    let raw = match fs::read_to_string(&registry) {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    let data: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let plugins_obj = match data.get("plugins").and_then(|v| v.as_object()) {
        Some(o) => o,
        None => return vec![],
    };

    let mut plugins = Vec::new();
    for (key, records) in plugins_obj {
        let at_index = key.rfind('@');
        let (name, marketplace) = match at_index {
            Some(i) if i > 0 => (key[..i].to_string(), Some(key[i + 1..].to_string())),
            _ => (key.clone(), None),
        };
        let record = records.as_array().and_then(|a| a.first());
        let install_path = record
            .and_then(|r| r.get("installPath"))
            .and_then(|v| v.as_str())
            .map(PathBuf::from);
        let scope = record
            .and_then(|r| r.get("scope"))
            .and_then(|v| v.as_str())
            .filter(|s| *s == "project")
            .map(|_| "project")
            .unwrap_or("user")
            .to_string();
        let version = record
            .and_then(|r| r.get("version"))
            .and_then(|v| v.as_str())
            .map(String::from);

        let (skills, commands, agents, mcp_servers, description) = match &install_path {
            Some(p) => (
                read_plugin_entry_names(&p.join("skills"), true),
                read_plugin_entry_names(&p.join("commands"), false),
                read_plugin_entry_names(&p.join("agents"), false),
                read_plugin_mcp_keys(p),
                read_plugin_description(p),
            ),
            None => (vec![], vec![], vec![], vec![], None),
        };

        plugins.push(Plugin {
            name,
            marketplace,
            scope,
            version,
            install_path: install_path.map(|p| p.to_string_lossy().into_owned()),
            description,
            skills,
            commands,
            agents,
            mcp_servers,
        });
    }

    plugins.sort_by(|a, b| a.name.cmp(&b.name));
    plugins
}

fn read_plugin_entry_names(dir: &Path, want_dirs: bool) -> Vec<String> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return vec![],
    };
    let mut names: HashSet<String> = HashSet::new();
    for entry in entries.flatten() {
        let raw_name = entry.file_name().to_string_lossy().into_owned();
        if raw_name.starts_with('.') {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if want_dirs {
            if file_type.is_dir() {
                names.insert(raw_name);
            }
        } else if file_type.is_file() && raw_name.ends_with(".md") {
            names.insert(raw_name.trim_end_matches(".md").to_string());
        }
    }
    let mut sorted: Vec<String> = names.into_iter().collect();
    sorted.sort();
    sorted
}

fn read_plugin_mcp_keys(install_path: &Path) -> Vec<String> {
    let raw = match fs::read_to_string(install_path.join(".mcp.json")) {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let servers = parsed
        .get("mcpServers")
        .filter(|v| v.is_object())
        .unwrap_or(&parsed);
    let mut keys: Vec<String> = match servers.as_object() {
        Some(o) => o.keys().cloned().collect(),
        None => vec![],
    };
    keys.sort();
    keys
}

fn read_plugin_description(install_path: &Path) -> Option<String> {
    let content = safe_read_preview(
        &install_path.join(".claude-plugin").join("plugin.json"),
        4000,
    )?;
    let parsed: serde_json::Value = serde_json::from_str(&content).ok()?;
    parsed
        .get("description")
        .and_then(|v| v.as_str())
        .map(String::from)
}

// ---- Claude: ~/.claude.json (mcp servers + projects) ----

fn read_claude_json(home: &Path) -> Option<serde_json::Value> {
    let raw = fs::read_to_string(home.join(".claude.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

fn claude_mcp_servers(home: &Path, cwd: &str) -> Vec<McpServer> {
    let claude_json = match read_claude_json(home) {
        Some(v) => v,
        None => return vec![],
    };
    let mut results = Vec::new();

    if let Some(obj) = claude_json.get("mcpServers").and_then(|v| v.as_object()) {
        for (name, raw) in obj {
            results.push(mcp_entry(name, "user", raw));
        }
    }
    if let Some(project) = claude_json
        .get("projects")
        .and_then(|v| v.as_object())
        .and_then(|p| p.get(cwd))
    {
        if let Some(obj) = project.get("mcpServers").and_then(|v| v.as_object()) {
            for (name, raw) in obj {
                results.push(mcp_entry(name, "project", raw));
            }
        }
    }

    results.sort_by(|a, b| a.name.cmp(&b.name));
    results
}

fn mcp_entry(name: &str, scope: &str, raw: &serde_json::Value) -> McpServer {
    let command = raw.get("command").and_then(|v| v.as_str()).map(String::from);
    let args = raw.get("args").and_then(|v| v.as_array()).map(|a| {
        a.iter()
            .filter_map(|x| x.as_str().map(String::from))
            .collect::<Vec<_>>()
    });
    let kind = raw.get("type").and_then(|v| v.as_str()).map(String::from);
    let url = raw.get("url").and_then(|v| v.as_str()).map(String::from);
    McpServer {
        name: name.to_string(),
        scope: scope.to_string(),
        command,
        args,
        kind,
        url,
    }
}

fn claude_projects(home: &Path, cwd: &str) -> Vec<ProjectEntry> {
    let claude_json = match read_claude_json(home) {
        Some(v) => v,
        None => return vec![],
    };
    let obj = match claude_json.get("projects").and_then(|v| v.as_object()) {
        Some(o) => o,
        None => return vec![],
    };

    let mut entries: Vec<ProjectEntry> = obj
        .iter()
        .map(|(path, value)| ProjectEntry {
            path: path.clone(),
            current: path == cwd,
            last_session_first_prompt: value
                .get("lastSessionFirstPrompt")
                .and_then(|v| v.as_str())
                .map(String::from),
            last_session_modified: value
                .get("lastSessionModified")
                .and_then(|v| v.as_str())
                .map(String::from),
            mcp_server_count: value
                .get("mcpServers")
                .and_then(|v| v.as_object())
                .map(|o| o.len())
                .unwrap_or(0),
        })
        .collect();

    sort_project_entries(&mut entries);
    entries.truncate(25);
    entries
}

fn sort_project_entries(entries: &mut [ProjectEntry]) {
    entries.sort_by(|a, b| {
        if a.current && !b.current {
            return std::cmp::Ordering::Less;
        }
        if !a.current && b.current {
            return std::cmp::Ordering::Greater;
        }
        let at = parse_time(a.last_session_modified.as_deref());
        let bt = parse_time(b.last_session_modified.as_deref());
        if at != bt {
            return bt.cmp(&at);
        }
        base_name(&a.path).cmp(&base_name(&b.path))
    });
}

fn parse_time(value: Option<&str>) -> i64 {
    value
        .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
        .map(|d| d.timestamp_millis())
        .unwrap_or(0)
}

fn base_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

// ---- hooks ----

fn claude_hooks(home: &Path, cwd: &str) -> Vec<Hook> {
    let mut hooks = Vec::new();
    read_hooks_file(&home.join(".claude").join("settings.json"), "user", &mut hooks);
    read_hooks_file(&home.join(".claude").join("settings.local.json"), "user", &mut hooks);
    read_hooks_file(&Path::new(cwd).join(".claude").join("settings.json"), "project", &mut hooks);
    read_hooks_file(&Path::new(cwd).join(".claude").join("settings.local.json"), "project", &mut hooks);
    sort_hooks(&mut hooks);
    hooks
}

fn read_hooks_file(settings_path: &Path, scope: &str, out: &mut Vec<Hook>) {
    let raw = match fs::read_to_string(settings_path) {
        Ok(r) => r,
        Err(_) => return,
    };
    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return,
    };
    let hooks_root = match parsed.get("hooks").and_then(|v| v.as_object()) {
        Some(o) => o,
        None => return,
    };
    let path_str = settings_path.to_string_lossy().into_owned();

    for (event, raw_entries) in hooks_root {
        let entries = match raw_entries.as_array() {
            Some(a) => a,
            None => continue,
        };
        for (entry_index, raw_entry) in entries.iter().enumerate() {
            let entry = match raw_entry.as_object() {
                Some(o) => o,
                None => continue,
            };
            let matcher = entry.get("matcher").and_then(|v| v.as_str()).map(String::from);
            let raw_hooks = entry.get("hooks").and_then(|v| v.as_array());
            let raw_hooks = match raw_hooks {
                Some(h) => h,
                None => continue,
            };
            for (hook_index, raw_hook) in raw_hooks.iter().enumerate() {
                let hook = match raw_hook.as_object() {
                    Some(o) => o,
                    None => continue,
                };
                out.push(Hook {
                    id: format!("{path_str}:{event}:{entry_index}:{hook_index}"),
                    event: event.clone(),
                    scope: scope.to_string(),
                    settings_path: path_str.clone(),
                    matcher: matcher.clone(),
                    kind: hook.get("type").and_then(|v| v.as_str()).map(String::from),
                    command: hook.get("command").and_then(|v| v.as_str()).map(String::from),
                    status: "default".to_string(),
                    trusted: None,
                });
            }
        }
    }
}

fn sort_hooks(hooks: &mut [Hook]) {
    hooks.sort_by(|a, b| {
        let event = a.event.cmp(&b.event);
        if event != std::cmp::Ordering::Equal {
            return event;
        }
        let matcher = a.matcher.clone().unwrap_or_default().cmp(&b.matcher.clone().unwrap_or_default());
        if matcher != std::cmp::Ordering::Equal {
            return matcher;
        }
        a.command.clone().unwrap_or_default().cmp(&b.command.clone().unwrap_or_default())
    });
}

// ---- Codex: config.toml (hand-rolled parser, ported from agent-info.ts) ----

#[derive(Default)]
struct CodexConfig {
    mcp_servers: HashMap<String, serde_json::Value>,
    projects: HashMap<String, serde_json::Value>,
    hooks_state: HashMap<String, serde_json::Value>,
}

fn read_codex_config(codex_home: &Path) -> CodexConfig {
    let mut result = CodexConfig::default();
    let raw = match fs::read_to_string(codex_home.join("config.toml")) {
        Ok(r) => r,
        Err(_) => return result,
    };
    let sections = parse_toml_sections(&raw);
    for (section, values) in sections {
        let parts = split_toml_section(&section);
        if parts.first().map(|s| s.as_str()) == Some("mcp_servers") && parts.len() == 2 {
            result.mcp_servers.insert(parts[1].clone(), values);
        } else if parts.first().map(|s| s.as_str()) == Some("projects") && parts.len() == 2 {
            result.projects.insert(parts[1].clone(), values);
        } else if parts.len() == 3
            && parts[0] == "hooks"
            && parts[1] == "state"
        {
            result.hooks_state.insert(parts[2].clone(), values);
        }
    }
    result
}

fn parse_toml_sections(raw: &str) -> HashMap<String, serde_json::Value> {
    let mut sections: HashMap<String, serde_json::Value> = HashMap::new();
    let mut current: Option<String> = None;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            let inner = trimmed[1..trimmed.len() - 1].to_string();
            sections.entry(inner.clone()).or_insert_with(|| serde_json::json!({}));
            current = Some(inner);
            continue;
        }
        let current_section = match &current {
            Some(c) => c.clone(),
            None => continue,
        };
        if let Some((key, value)) = parse_toml_key_value(trimmed) {
            if let Some(obj) = sections
                .entry(current_section)
                .or_insert_with(|| serde_json::json!({}))
                .as_object_mut()
            {
                obj.insert(key, value);
            }
        }
    }
    sections
}

fn parse_toml_key_value(line: &str) -> Option<(String, serde_json::Value)> {
    let eq = line.find('=')?;
    let key_raw = line[..eq].trim();
    let value_raw = line[eq + 1..].trim();
    if key_raw.is_empty() {
        return None;
    }
    Some((unquote_toml(key_raw), parse_toml_value(value_raw)))
}

fn split_toml_section(section: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for ch in section.chars() {
        if ch == '"' {
            quoted = !quoted;
            current.push(ch);
        } else if ch == '.' && !quoted {
            parts.push(unquote_toml(&current));
            current.clear();
        } else {
            current.push(ch);
        }
    }
    if !current.is_empty() {
        parts.push(unquote_toml(&current));
    }
    parts
}

fn parse_toml_value(value: &str) -> serde_json::Value {
    let trimmed = strip_toml_comment(value.trim());
    let trimmed = trimmed.trim();
    if trimmed.starts_with('[') && trimmed.ends_with(']') {
        let body = trimmed[1..trimmed.len() - 1].trim();
        if body.is_empty() {
            return serde_json::json!([]);
        }
        let items: Vec<serde_json::Value> = body
            .split(',')
            .filter_map(|item| {
                let v = parse_toml_value(item.trim());
                if v.is_string() {
                    Some(v)
                } else {
                    None
                }
            })
            .collect();
        return serde_json::Value::Array(items);
    }
    if trimmed == "true" {
        return serde_json::Value::Bool(true);
    }
    if trimmed == "false" {
        return serde_json::Value::Bool(false);
    }
    serde_json::Value::String(unquote_toml(trimmed))
}

fn strip_toml_comment(value: &str) -> String {
    let mut quoted = false;
    for (i, ch) in value.char_indices() {
        if ch == '"' {
            quoted = !quoted;
        }
        if ch == '#' && !quoted {
            return value[..i].trim().to_string();
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

fn codex_mcp_servers(config: &CodexConfig) -> Vec<McpServer> {
    let mut servers: Vec<McpServer> = config
        .mcp_servers
        .iter()
        .map(|(name, raw)| mcp_entry(name, "user", raw))
        .collect();
    servers.sort_by(|a, b| a.name.cmp(&b.name));
    servers
}

fn codex_hooks(codex_home: &Path, cwd: &str, config: &CodexConfig) -> Vec<Hook> {
    let mut hooks = Vec::new();
    read_hooks_file(&codex_home.join("hooks.json"), "user", &mut hooks);
    read_hooks_file(&Path::new(cwd).join(".codex").join("hooks.json"), "project", &mut hooks);

    for hook in &mut hooks {
        let state = config
            .hooks_state
            .get(&hook.id)
            .or_else(|| config.hooks_state.get(&normalize_hook_state_id(&hook.id)));
        if let Some(state) = state {
            hook.status = hook_status(state);
            if state.get("trusted_hash").and_then(|v| v.as_str()).is_some() {
                hook.trusted = Some(true);
            } else {
                hook.trusted = Some(false);
            }
        }
    }

    sort_hooks(&mut hooks);
    hooks
}

fn normalize_hook_state_id(id: &str) -> String {
    let parts: Vec<&str> = id.split(':').collect();
    if parts.len() < 4 {
        return id.to_string();
    }
    let hook_index = parts[parts.len() - 1];
    let entry_index = parts[parts.len() - 2];
    let event = parts[parts.len() - 3];
    let prefix = parts[..parts.len() - 3].join(":");
    format!(
        "{prefix}:{}:{entry_index}:{hook_index}",
        camel_to_snake(event).to_lowercase()
    )
}

fn camel_to_snake(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 4);
    let chars: Vec<char> = value.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        if c.is_ascii_uppercase() {
            if i > 0 {
                let prev = chars[i - 1];
                if prev.is_ascii_lowercase() || prev.is_ascii_digit() {
                    out.push('_');
                }
            }
            out.push(c);
        } else {
            out.push(c);
        }
    }
    out
}

fn hook_status(state: &serde_json::Value) -> String {
    match state.get("enabled").and_then(|v| v.as_bool()) {
        Some(true) => "enabled".to_string(),
        Some(false) => "disabled".to_string(),
        None => "default".to_string(),
    }
}

// ---- Codex: projects (config + session jsonl) ----

fn codex_projects(config: &CodexConfig, codex_home: &Path, cwd: &str) -> Vec<ProjectEntry> {
    let session_projects = codex_session_projects(codex_home, cwd);

    let mut by_path: HashMap<String, ProjectEntry> = HashMap::new();
    for path in config.projects.keys() {
        by_path.insert(
            path.clone(),
            ProjectEntry {
                path: path.clone(),
                current: path == cwd,
                last_session_first_prompt: None,
                last_session_modified: None,
                mcp_server_count: 0,
            },
        );
    }
    for project in session_projects {
        by_path.insert(
            project.path.clone(),
            ProjectEntry {
                current: project.path == cwd,
                ..project
            },
        );
    }

    let mut entries: Vec<ProjectEntry> = by_path.into_values().collect();
    sort_project_entries(&mut entries);
    entries.truncate(25);
    entries
}

fn codex_session_projects(codex_home: &Path, cwd: &str) -> Vec<ProjectEntry> {
    let mut files = Vec::new();
    collect_jsonl_files(&codex_home.join("sessions"), &mut files);

    let mut by_path: HashMap<String, ProjectEntry> = HashMap::new();
    for file in files {
        let (meta_cwd, timestamp) = match read_codex_session_meta(&file) {
            Some(m) => m,
            None => continue,
        };
        let meta_cwd = match meta_cwd {
            Some(c) => c,
            None => continue,
        };
        let next_time = parse_time(timestamp.as_deref());
        let existing_time = by_path
            .get(&meta_cwd)
            .map(|e| parse_time(e.last_session_modified.as_deref()))
            .unwrap_or(i64::MIN);
        if next_time >= existing_time {
            by_path.insert(
                meta_cwd.clone(),
                ProjectEntry {
                    path: meta_cwd.clone(),
                    current: meta_cwd == cwd,
                    last_session_first_prompt: None,
                    last_session_modified: timestamp,
                    mcp_server_count: 0,
                },
            );
        }
    }

    by_path.into_values().collect()
}

fn collect_jsonl_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            collect_jsonl_files(&path, out);
        } else if file_type.is_file()
            && path.extension().map(|e| e == "jsonl").unwrap_or(false)
        {
            out.push(path);
        }
    }
}

fn read_codex_session_meta(path: &Path) -> Option<(Option<String>, Option<String>)> {
    let first_line = read_first_line(path)?;
    let event: serde_json::Value = serde_json::from_str(&first_line).ok()?;
    if event.get("type").and_then(|v| v.as_str()) != Some("session_meta") {
        return None;
    }
    let payload = event.get("payload");
    let cwd = payload
        .and_then(|p| p.get("cwd"))
        .and_then(|v| v.as_str())
        .map(String::from);
    let timestamp = payload
        .and_then(|p| p.get("timestamp"))
        .and_then(|v| v.as_str())
        .or_else(|| event.get("timestamp").and_then(|v| v.as_str()))
        .map(String::from);
    Some((cwd, timestamp))
}

fn read_first_line(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let mut buffer = vec![0u8; 64 * 1024];
    let bytes_read = file.read(&mut buffer).ok()?;
    if bytes_read == 0 {
        return None;
    }
    let text = String::from_utf8_lossy(&buffer[..bytes_read]);
    text.split(['\n', '\r']).next().map(|s| s.to_string())
}

// ---- shared ----

fn safe_read_preview(path: &Path, bytes: usize) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    if content.chars().count() <= bytes {
        Some(content)
    } else {
        let truncated: String = content.chars().take(bytes).collect();
        Some(format!("{truncated}\n…[truncated]"))
    }
}
