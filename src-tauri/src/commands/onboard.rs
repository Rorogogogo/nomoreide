use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Emitter, State};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use crate::AppState;
use crate::core::config::GitRepoDef;

// ---------------------------------------------------------------------------
// Output types (serialized to frontend)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardProfile {
    pub name: String,
    pub clone_path: String,
    pub languages: Vec<String>,
    pub node: Option<NodeSignal>,
    pub python: Option<PythonSignal>,
    pub docker: Option<DockerSignal>,
    pub env_keys: Vec<String>,
    pub readme_excerpt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeSignal {
    pub package_manager: String,
    pub scripts: HashMap<String, String>,
    pub has_dev_script: bool,
    pub has_start_script: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonSignal {
    pub has_requirements: bool,
    pub has_pyproject: bool,
    pub has_manage_py: bool,
    pub framework: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerSignal {
    pub has_dockerfile: bool,
    pub compose_file: Option<String>,
    pub compose_services: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardProposal {
    pub name: String,
    pub kind: String,
    pub command: Option<String>,
    pub cwd: String,
    pub port: Option<u16>,
    pub compose_file: Option<String>,
    pub compose_service: Option<String>,
    pub install_command: Option<String>,
    pub confidence: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardDatabaseProposal {
    pub name: String,
    pub engine: String,
    pub url: String,
    pub compose_service: Option<String>,
    pub confidence: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub profile: OnboardProfile,
    pub proposals: Vec<OnboardProposal>,
    pub databases: Vec<OnboardDatabaseProposal>,
}

// ---------------------------------------------------------------------------
// Internal-only compose service detail (not serialized to frontend)
// ---------------------------------------------------------------------------

struct ComposeServiceDetail {
    name: String,
    image: Option<String>,
    ports: Vec<String>,
    environment: HashMap<String, String>,
}

// ---------------------------------------------------------------------------
// URL parsing + clone
// ---------------------------------------------------------------------------

fn parse_repo_name(url: &str) -> String {
    let url = url.trim().trim_end_matches('/');
    let last = url.rsplit('/').next()
        .or_else(|| url.rsplit(':').next())
        .unwrap_or("service");
    let name = last.trim_end_matches(".git").to_lowercase();
    let sanitized: String = name.chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '-' })
        .collect();
    let sanitized = sanitized.trim_matches('-').to_string();
    if sanitized.is_empty() { "service".to_string() } else { sanitized }
}

fn repos_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".nomoreide")
        .join("repos")
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn scan_repo_url(url: String) -> Result<ScanResult, String> {
    let name = parse_repo_name(&url);
    let dest = repos_dir().join(&name);

    if !dest.exists() {
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        }
        let out = Command::new("git")
            .args(["clone", "--depth", "1", &url, dest.to_str().unwrap_or("")])
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .await
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
    }

    let (profile, service_details) = scan_repo_dir(&dest, &name).await?;
    let proposals = propose_services(&profile);
    let databases = propose_databases(&profile.name, &service_details);

    Ok(ScanResult { profile, proposals, databases })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClonedRepo {
    pub name: String,
    pub path: String,
}

/// Clone a remote repo (HTTPS or SSH) into the managed repos dir and register
/// it as a Git project. Mirrors the web/MCP `cloneRepository` path: SSH uses the
/// host's ssh-agent/keys and interactive prompts are disabled so private repos
/// fail fast instead of hanging.
#[tauri::command]
pub async fn clone_git_repository(
    state: State<'_, AppState>,
    url: String,
) -> Result<ClonedRepo, String> {
    let name = parse_repo_name(&url);
    let dest = repos_dir().join(&name);

    let non_empty = dest
        .read_dir()
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false);
    if non_empty {
        return Err(format!(
            "Destination already exists and is not empty: {}. Remove it or pick another repo.",
            dest.display()
        ));
    }

    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }

    // Reuse the app's stored GitHub token for HTTPS github.com clones so private
    // repos work without SSH keys. Passed via `git -c` (command-scoped) so the
    // token is never written into the cloned repo's .git/config.
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let mut args: Vec<String> = Vec::new();
    if url.starts_with("https://github.com/") {
        if let Some(token) = state.config_store.get_github_token(&config, "github.com") {
            let basic = BASE64.encode(format!("x-access-token:{token}"));
            args.push("-c".to_string());
            args.push(format!(
                "http.https://github.com/.extraheader=Authorization: Basic {basic}"
            ));
        }
    }
    args.extend([
        "clone".to_string(),
        "--depth".to_string(),
        "1".to_string(),
        url.clone(),
        dest.to_str().unwrap_or("").to_string(),
    ]);

    let out = Command::new("git")
        .args(&args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }

    let path = dest.to_str().unwrap_or("").to_string();
    state
        .config_store
        .register_git_repository(GitRepoDef {
            name: name.clone(),
            path: path.clone(),
            active_worktree_path: None,
        })
        .await
        .map_err(|e| e.to_string())?;
    state
        .config_store
        .select_git_repository(Some(name.clone()))
        .await
        .map_err(|e| e.to_string())?;

    Ok(ClonedRepo { name, path })
}

/// Stream a one-shot install command's output lines back as Tauri events.
/// Events: `{ type: "line", stream: "stdout"|"stderr", text }`,
///         `{ type: "done", exitCode }`,
///         `{ type: "error", message }`
#[tauri::command]
pub async fn run_install_command(
    app: AppHandle,
    cwd: String,
    command: String,
) -> Result<(), String> {
    let child = Command::new(if cfg!(windows) { "cmd" } else { "sh" })
        .args(if cfg!(windows) { vec!["/C", &command] } else { vec!["-c", &command] })
        .current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    tokio::spawn(run_install(app, child));
    Ok(())
}

async fn run_install(app: AppHandle, mut child: tokio::process::Child) {
    let emit = |payload: Value| { let _ = app.emit("install-output", payload); };

    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => { emit(json!({"type":"error","message":"No stdout pipe"})); return; }
    };
    let stderr = child.stderr.take();

    // Drain stderr in background.
    let app2 = app.clone();
    if let Some(stderr) = stderr {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app2.emit("install-output", json!({"type":"line","stream":"stderr","text": line}));
            }
        });
    }

    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        emit(json!({"type":"line","stream":"stdout","text": line}));
    }

    let exit_code = child.wait().await.ok().and_then(|s| s.code());
    emit(json!({"type":"done","exitCode": exit_code}));
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

async fn scan_repo_dir(
    path: &Path,
    name: &str,
) -> Result<(OnboardProfile, Vec<ComposeServiceDetail>), String> {
    let files = {
        let mut set = HashSet::new();
        let mut rd = tokio::fs::read_dir(path).await.map_err(|e| e.to_string())?;
        while let Ok(Some(entry)) = rd.next_entry().await {
            if let Ok(n) = entry.file_name().into_string() { set.insert(n); }
        }
        set
    };

    let node = scan_node(path, &files).await;
    let python = scan_python(path, &files).await;
    let (docker, service_details) = scan_docker(path, &files).await;

    // .env keys
    let mut env_keys = Vec::new();
    for candidate in [".env.example", ".env.sample", ".env.template"] {
        if files.contains(candidate) {
            if let Ok(raw) = tokio::fs::read_to_string(path.join(candidate)).await {
                env_keys = parse_env_keys(&raw);
                break;
            }
        }
    }

    // README excerpt
    let mut readme_excerpt = None;
    for candidate in ["README.md", "readme.md", "README.MD", "README"] {
        if files.contains(candidate) {
            if let Ok(raw) = tokio::fs::read_to_string(path.join(candidate)).await {
                readme_excerpt = Some(extract_readme_excerpt(&raw));
                break;
            }
        }
    }

    let mut languages = Vec::new();
    if node.is_some() { languages.push("node".to_string()); }
    if python.is_some() { languages.push("python".to_string()); }
    if docker.is_some() { languages.push("docker".to_string()); }

    let profile = OnboardProfile {
        name: name.to_string(),
        clone_path: path.to_str().unwrap_or("").to_string(),
        languages,
        node,
        python,
        docker,
        env_keys,
        readme_excerpt,
    };

    Ok((profile, service_details))
}

async fn scan_node(path: &Path, files: &HashSet<String>) -> Option<NodeSignal> {
    if !files.contains("package.json") { return None; }
    let raw = tokio::fs::read_to_string(path.join("package.json")).await.ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let scripts: HashMap<String, String> = parsed.get("scripts")
        .and_then(|s| s.as_object())
        .map(|obj| obj.iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
            .collect())
        .unwrap_or_default();

    let pm = if files.contains("pnpm-lock.yaml") { "pnpm" }
        else if files.contains("yarn.lock") { "yarn" }
        else if files.contains("bun.lockb") { "bun" }
        else { "npm" };

    Some(NodeSignal {
        has_dev_script: scripts.contains_key("dev"),
        has_start_script: scripts.contains_key("start"),
        scripts,
        package_manager: pm.to_string(),
    })
}

async fn scan_python(path: &Path, files: &HashSet<String>) -> Option<PythonSignal> {
    let has_requirements = files.contains("requirements.txt");
    let has_pyproject = files.contains("pyproject.toml");
    let has_manage_py = files.contains("manage.py");
    if !has_requirements && !has_pyproject && !has_manage_py { return None; }

    let framework = if has_manage_py {
        "django"
    } else {
        let deps = if has_requirements {
            tokio::fs::read_to_string(path.join("requirements.txt")).await.unwrap_or_default().to_lowercase()
        } else {
            tokio::fs::read_to_string(path.join("pyproject.toml")).await.unwrap_or_default().to_lowercase()
        };
        if deps.contains("fastapi") || deps.contains("uvicorn") { "fastapi" }
        else if deps.contains("flask") { "flask" }
        else if deps.contains("django") { "django" }
        else { "unknown" }
    };

    Some(PythonSignal {
        has_requirements,
        has_pyproject,
        has_manage_py,
        framework: framework.to_string(),
    })
}

const COMPOSE_FILES: &[&str] = &[
    "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml",
];

async fn scan_docker(
    path: &Path,
    files: &HashSet<String>,
) -> (Option<DockerSignal>, Vec<ComposeServiceDetail>) {
    let compose_file = COMPOSE_FILES.iter().find(|&&f| files.contains(f)).copied();
    let has_dockerfile = files.contains("Dockerfile");
    if compose_file.is_none() && !has_dockerfile {
        return (None, Vec::new());
    }

    let (compose_services, service_details) = if let Some(cf) = compose_file {
        match tokio::fs::read_to_string(path.join(cf)).await {
            Ok(raw) => {
                let details = parse_compose_service_details(&raw);
                let names = details.iter().map(|s| s.name.clone()).collect();
                (names, details)
            }
            Err(_) => (Vec::new(), Vec::new()),
        }
    } else {
        (Vec::new(), Vec::new())
    };

    (
        Some(DockerSignal {
            has_dockerfile,
            compose_file: compose_file.map(|s| s.to_string()),
            compose_services,
        }),
        service_details,
    )
}

// ---------------------------------------------------------------------------
// docker-compose YAML parser (manual — avoids serde_yaml dependency)
// ---------------------------------------------------------------------------

fn parse_compose_service_details(yaml: &str) -> Vec<ComposeServiceDetail> {
    // Simple state-machine YAML parser for the subset we need.
    // Handles the most common docker-compose formats without a full YAML library.
    let mut services: Vec<ComposeServiceDetail> = Vec::new();
    let mut in_services = false;
    let mut current: Option<ComposeServiceDetail> = None;
    let mut current_field: Option<&str> = None;

    for line in yaml.lines() {
        let stripped = line.trim_end();
        if stripped.is_empty() || stripped.starts_with('#') { continue; }

        let indent = line.len() - line.trim_start().len();

        if indent == 0 {
            // Top-level key
            if let Some(svc) = current.take() { services.push(svc); }
            current_field = None;
            in_services = stripped.starts_with("services:");
            continue;
        }

        if !in_services { continue; }

        if indent == 2 {
            // Service name
            if let Some(svc) = current.take() { services.push(svc); }
            current_field = None;
            let name = stripped.trim_end_matches(':').trim().to_string();
            if !name.is_empty() {
                current = Some(ComposeServiceDetail {
                    name,
                    image: None,
                    ports: Vec::new(),
                    environment: HashMap::new(),
                });
            }
            continue;
        }

        let svc = match current.as_mut() { Some(s) => s, None => continue };

        if indent == 4 {
            // Service field
            let trimmed = stripped.trim_start();
            if let Some(img) = trimmed.strip_prefix("image:") {
                svc.image = Some(img.trim().trim_matches('"').trim_matches('\'').to_string());
                current_field = None;
            } else if trimmed.starts_with("ports:") {
                current_field = Some("ports");
            } else if trimmed.starts_with("environment:") {
                current_field = Some("environment");
            } else {
                current_field = None;
            }
            continue;
        }

        if indent == 6 {
            // List/map item under ports or environment
            let trimmed = stripped.trim_start();
            match current_field {
                Some("ports") => {
                    let port_str = trimmed.trim_start_matches('-').trim()
                        .trim_matches('"').trim_matches('\'').to_string();
                    if !port_str.is_empty() { svc.ports.push(port_str); }
                }
                Some("environment") => {
                    let item = trimmed.trim_start_matches('-').trim();
                    if let Some(eq) = item.find('=') {
                        // Array form: KEY=VALUE
                        svc.environment.insert(
                            item[..eq].trim().to_string(),
                            item[eq+1..].trim().trim_matches('"').trim_matches('\'').to_string(),
                        );
                    } else if let Some(colon) = item.find(':') {
                        // Map form: KEY: VALUE
                        svc.environment.insert(
                            item[..colon].trim().to_string(),
                            item[colon+1..].trim().trim_matches('"').trim_matches('\'').to_string(),
                        );
                    }
                }
                _ => {}
            }
        }
    }

    if let Some(svc) = current { services.push(svc); }
    services
}

// ---------------------------------------------------------------------------
// Heuristic proposal generation
// ---------------------------------------------------------------------------

fn propose_services(profile: &OnboardProfile) -> Vec<OnboardProposal> {
    let mut proposals: Vec<OnboardProposal> = Vec::new();
    let name = &profile.name;
    let cwd = &profile.clone_path;

    if let Some(ref docker) = profile.docker {
        if let Some(ref cf) = docker.compose_file {
            for svc in &docker.compose_services {
                let svc_name = sanitize_name(svc);
                let is_primary = svc_name == *name || docker.compose_services.first() == Some(svc);
                proposals.push(OnboardProposal {
                    name: if is_primary { name.clone() } else { format!("{name}-{svc_name}") },
                    kind: "docker-compose".to_string(),
                    command: None,
                    cwd: cwd.clone(),
                    port: None,
                    compose_file: Some(cf.clone()),
                    compose_service: Some(svc.clone()),
                    install_command: None,
                    confidence: if is_primary { "high" } else { "low" }.to_string(),
                    reason: format!("docker-compose service \"{svc}\""),
                });
            }
        }
    }

    if let Some(ref node) = profile.node {
        let script = if node.has_dev_script { Some("dev") } else if node.has_start_script { Some("start") } else { None };
        if let Some(script) = script {
            let cmd = run_script(&node.package_manager, script);
            let port = sniff_port(node.scripts.get(script).map(|s| s.as_str()).unwrap_or(""));
            proposals.push(OnboardProposal {
                name: name.clone(),
                kind: "local".to_string(),
                command: Some(cmd),
                cwd: cwd.clone(),
                port,
                compose_file: None,
                compose_service: None,
                install_command: Some(install_cmd(&node.package_manager)),
                confidence: if node.has_dev_script { "high" } else { "medium" }.to_string(),
                reason: format!("package.json \"{}\" script ({})", script, node.package_manager),
            });
        }
    }

    if let Some(ref python) = profile.python {
        proposals.push(OnboardProposal {
            name: name.clone(),
            kind: "local".to_string(),
            command: Some(python_command(&python.framework)),
            cwd: cwd.clone(),
            port: python_default_port(&python.framework),
            compose_file: None,
            compose_service: None,
            install_command: if python.has_requirements {
                Some("pip install -r requirements.txt".to_string())
            } else if python.has_pyproject {
                Some("pip install .".to_string())
            } else {
                None
            },
            confidence: if python.framework == "unknown" { "low" } else { "medium" }.to_string(),
            reason: format!("python {} project", python.framework),
        });
    }

    // Dedupe by name, highest confidence first.
    let mut seen = HashSet::new();
    let mut result: Vec<OnboardProposal> = Vec::new();
    let mut sorted = proposals;
    sorted.sort_by(|a, b| confidence_rank(&b.confidence).cmp(&confidence_rank(&a.confidence)));
    for p in sorted {
        if seen.insert(p.name.clone()) { result.push(p); }
    }
    result
}

fn propose_databases(repo_name: &str, services: &[ComposeServiceDetail]) -> Vec<OnboardDatabaseProposal> {
    let mut proposals = Vec::new();
    let mut seen = HashSet::new();

    for svc in services {
        let (engine, default_port) = match detect_db_image(svc.image.as_deref()) {
            Some(pair) => pair,
            None => continue,
        };
        let host_port = published_host_port(&svc.ports, default_port).unwrap_or(default_port);
        let (user, password, database) = db_credentials(engine, &svc.environment);
        let db_name = format!("{repo_name}-db");
        let url = build_db_url(engine, &user, &password, host_port, &database);
        if seen.insert(db_name.clone()) {
            proposals.push(OnboardDatabaseProposal {
                confidence: if database.is_empty() { "medium" } else { "high" }.to_string(),
                reason: format!("{engine} database from compose service \"{}\"", svc.name),
                name: db_name,
                engine: engine.to_string(),
                url,
                compose_service: Some(svc.name.clone()),
            });
        }
    }
    proposals
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

fn parse_env_keys(raw: &str) -> Vec<String> {
    raw.lines().filter_map(|line| {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') { return None; }
        let t = t.strip_prefix("export ").unwrap_or(t).trim_start();
        let end = t.find(['=', ':'])?;
        let key = &t[..end];
        if key.chars().all(|c| c.is_alphanumeric() || c == '_') { Some(key.to_string()) } else { None }
    }).collect()
}

fn extract_readme_excerpt(raw: &str) -> String {
    let heading = regex::Regex::new(r"(?im)^#{1,3}\s+.*(getting started|usage|quick\s?start|running|setup|develop|install)").unwrap();
    let lines: Vec<&str> = raw.lines().collect();
    let start = heading.find(raw)
        .and_then(|m| Some(raw[..m.start()].lines().count()));
    let slice = match start {
        Some(i) => &lines[i..(i + 40).min(lines.len())],
        None => &lines[..30_usize.min(lines.len())],
    };
    slice.join("\n").chars().take(2000).collect::<String>().trim().to_string()
}

fn sanitize_name(s: &str) -> String {
    let out: String = s.to_lowercase().chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '-' })
        .collect();
    out.trim_matches('-').to_string()
}

fn run_script(pm: &str, script: &str) -> String {
    match pm {
        "pnpm" => format!("pnpm {script}"),
        "yarn" => format!("yarn {script}"),
        "bun"  => format!("bun run {script}"),
        _      => format!("npm run {script}"),
    }
}

fn install_cmd(pm: &str) -> String {
    match pm {
        "pnpm" => "pnpm install".to_string(),
        "yarn" => "yarn install".to_string(),
        "bun"  => "bun install".to_string(),
        _      => "npm install".to_string(),
    }
}

fn python_command(framework: &str) -> String {
    match framework {
        "django"  => "python manage.py runserver".to_string(),
        "fastapi" => "uvicorn main:app --reload".to_string(),
        "flask"   => "flask run".to_string(),
        _         => "python main.py".to_string(),
    }
}

fn python_default_port(framework: &str) -> Option<u16> {
    match framework {
        "django" | "fastapi" => Some(8000),
        "flask" => Some(5000),
        _ => None,
    }
}

fn sniff_port(text: &str) -> Option<u16> {
    let patterns = [
        r"--port[ =](\d{2,5})",
        r"-p[ =](\d{2,5})",
        r"\bport[ =:](\d{2,5})",
        r":(\d{4,5})\b",
    ];
    for pattern in patterns {
        if let Ok(re) = regex::Regex::new(pattern) {
            if let Some(cap) = re.captures(text) {
                if let Some(m) = cap.get(1) {
                    if let Ok(port) = m.as_str().parse::<u16>() {
                        if port >= 1 { return Some(port); }
                    }
                }
            }
        }
    }
    None
}

fn confidence_rank(c: &str) -> u8 {
    match c { "high" => 2, "medium" => 1, _ => 0 }
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

fn detect_db_image(image: Option<&str>) -> Option<(&'static str, u16)> {
    let img = image?;
    if img.contains("postgres") || img.contains("pgvector") || img.contains("postgis") || img.contains("timescale") {
        return Some(("postgres", 5432));
    }
    if img.contains("mysql") || img.contains("mariadb") || img.contains("percona") {
        return Some(("mysql", 3306));
    }
    None
}

fn published_host_port(ports: &[String], container_port: u16) -> Option<u16> {
    for entry in ports {
        let parts: Vec<&str> = entry.split(':').collect();
        if parts.len() < 2 { continue; }
        let container = parts.last()?.replace("/tcp", "").replace("/udp", "");
        let container_n: u16 = container.parse().ok()?;
        if container_n == container_port {
            let host: u16 = parts[parts.len() - 2].parse().ok()?;
            return Some(host);
        }
    }
    // Fall back to first port's host side.
    for entry in ports {
        let parts: Vec<&str> = entry.split(':').collect();
        if parts.len() >= 2 {
            if let Ok(p) = parts[parts.len() - 2].parse::<u16>() { return Some(p); }
        }
    }
    None
}

fn db_credentials(engine: &str, env: &HashMap<String, String>) -> (String, String, String) {
    if engine == "postgres" {
        let user = env.get("POSTGRES_USER").cloned().unwrap_or_else(|| "postgres".to_string());
        let password = env.get("POSTGRES_PASSWORD").cloned().unwrap_or_default();
        let database = env.get("POSTGRES_DB").cloned().unwrap_or_else(|| user.clone());
        (user, password, database)
    } else {
        let user = env.get("MYSQL_USER").cloned().unwrap_or_else(|| "root".to_string());
        let password = env.get("MYSQL_PASSWORD")
            .or_else(|| env.get("MYSQL_ROOT_PASSWORD"))
            .cloned()
            .unwrap_or_default();
        let database = env.get("MYSQL_DATABASE").cloned().unwrap_or_default();
        (user, password, database)
    }
}

fn build_db_url(engine: &str, user: &str, password: &str, port: u16, database: &str) -> String {
    let scheme = if engine == "mysql" { "mysql" } else { "postgres" };
    let auth = if password.is_empty() {
        urlencoding::encode(user).to_string()
    } else {
        format!("{}:{}", urlencoding::encode(user), urlencoding::encode(password))
    };
    format!("{scheme}://{auth}@127.0.0.1:{port}/{database}")
}
