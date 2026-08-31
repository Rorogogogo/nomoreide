//! `nomoreide setup <agent>` — putting this program's MCP server and its
//! debugging skill into a coding agent, leaving nothing behind that needs
//! Node.js to start.
//!
//! The npm package wrote `npx -y nomoreide` into every agent's config, so each
//! agent session began by asking a package manager to find a runtime. A native
//! install writes the path of *this* binary and `mcp` instead: the agent
//! launches the program directly. That is the whole point of the cutover, and
//! it is the one deliberate difference from what the reference wrote.
//!
//! The skill is compiled into the binary rather than read from a `profiles/`
//! directory beside it. A binary downloaded by `install.sh` has no package
//! around it to read from, and a setup command that only works inside a
//! checkout would not be a distribution.
//!
//! One further difference from the reference, and the reason for it: the
//! reference refused, pending `--force`, whenever the installed skill differed
//! from the bundled one. Every upgrade differs from the version before it, so
//! that rule made `--force` the normal way to run the command, which is not
//! what a guard is for. Here the guard covers the case it was written for — an
//! MCP server named `nomoreide` that is somebody else's — and a skill that
//! differs is copied aside and replaced, with the backup named in the result.

use std::path::{Path, PathBuf};

use crate::agent_env::{
    add_mcp, backup_config_file, backup_skill_directory, home, install_user_skill, read_configs,
    Agent, Scope, ServerSpec,
};
use crate::filesystem::{atomic_write, AtomicWriteOptions};
use crate::js_json;

/// The name the skill is installed under, and the key the MCP server takes in
/// an agent's config. Both are the reference's, so an install over an npm one
/// replaces it rather than sitting beside it.
pub const SKILL_NAME: &str = "nomoreide-debug";
pub const MCP_KEY: &str = "nomoreide";

/// The bundled skill, file by file, compiled in.
///
/// Listed rather than globbed because `include_str!` needs a literal path, and
/// because a skill quietly losing a file when someone moves it is worse than a
/// build that stops. `skill_is_installed_exactly_as_it_is_bundled` checks the
/// list still matches the directory on disk.
///
/// Read out of `OUT_DIR` rather than straight from `profiles/`: the source
/// lives at the workspace root, which a packaged crate does not carry, so
/// `build.rs` stages it here first. The file contents are unchanged.
const SKILL_FILES: &[(&str, &str)] = &[
    (
        "SKILL.md",
        include_str!(concat!(env!("OUT_DIR"), "/debug-skill/SKILL.md")),
    ),
    (
        "agents/openai.yaml",
        include_str!(concat!(env!("OUT_DIR"), "/debug-skill/agents/openai.yaml")),
    ),
    (
        "evals/evals.json",
        include_str!(concat!(env!("OUT_DIR"), "/debug-skill/evals/evals.json")),
    ),
];

/// The three agents `setup` knows how to configure.
///
/// Not [`Agent`]: Gemini keeps its MCP servers in `~/.gemini/settings.json`
/// and its skills in `~/.gemini/skills`, which is Antigravity's directory —
/// so one name here maps to two different answers, and collapsing them into
/// [`Agent`] would lose that.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupAgent {
    Claude,
    Codex,
    Gemini,
}

impl SetupAgent {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "gemini" => Some(Self::Gemini),
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Gemini => "gemini",
        }
    }

    /// Whose skills directory the skill goes into. Gemini has no agent of its
    /// own here; its skills live where Antigravity's do.
    fn skill_agent(self) -> Agent {
        match self {
            Self::Claude => Agent::Claude,
            Self::Codex => Agent::Codex,
            Self::Gemini => Agent::Antigravity,
        }
    }
}

/// What the command did to one of the two things it installs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupStatus {
    Added,
    Identical,
    Replaced,
}

impl SetupStatus {
    pub fn id(self) -> &'static str {
        match self {
            Self::Added => "added",
            Self::Identical => "identical",
            Self::Replaced => "replaced",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupResult {
    pub agent: SetupAgent,
    pub mcp: SetupStatus,
    pub skill: SetupStatus,
    /// The command written into the agent's config, so the caller can print
    /// what the agent will actually run.
    pub command: String,
    pub backups: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetupError {
    /// Something already named `nomoreide` that this did not put there.
    Conflict(String),
    Failed(String),
}

impl std::fmt::Display for SetupError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Conflict(detail) => write!(formatter, "{detail}"),
            Self::Failed(detail) => write!(formatter, "{detail}"),
        }
    }
}

impl std::error::Error for SetupError {}

/// The MCP entry a native install writes: this binary, and `mcp`.
///
/// An absolute path rather than the bare name because an agent launched from a
/// desktop session does not necessarily inherit the shell PATH that `setup`
/// ran under, and an entry the agent cannot resolve fails at the point where
/// the user has the least idea why.
///
/// Symlinks are deliberately *not* resolved. A packaging scheme that puts a
/// link in `bin` pointing at a versioned directory expects the link to be what
/// gets recorded; resolving it would pin every agent to the version installed
/// on the day setup ran, and the next upgrade would silently not take. Only a
/// path that somehow arrives relative is resolved, because a relative one is
/// no better than the bare name.
pub fn native_server_command() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|path| {
            if path.is_absolute() {
                Some(path)
            } else {
                std::fs::canonicalize(&path).ok()
            }
        })
        .map(|path| path.to_string_lossy().into_owned())
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| "nomoreide".to_string())
}

fn desired_server(command: &str) -> ServerSpec {
    ServerSpec {
        command: Some(command.to_string()),
        args: vec!["mcp".to_string()],
        ..ServerSpec::default()
    }
}

/// Install the MCP server and the skill for one agent.
pub fn install(
    agent: SetupAgent,
    cwd: &Path,
    force: bool,
    command: &str,
) -> Result<SetupResult, SetupError> {
    let home = home();
    let desired = desired_server(command);

    let existing = read_existing(agent, cwd, &home)?;
    let mcp = match &existing {
        None => SetupStatus::Added,
        Some(found) if same_server(found, &desired) => SetupStatus::Identical,
        Some(_) => SetupStatus::Replaced,
    };
    if mcp == SetupStatus::Replaced && !force {
        let ours = existing.as_ref().is_some_and(is_ours);
        if !ours {
            return Err(SetupError::Conflict(format!(
                "An MCP server named \"{MCP_KEY}\" is already configured for {} and was not \
                 installed by NoMoreIDE. Re-run with --force to replace it; a backup of the \
                 config will be created.",
                agent.id()
            )));
        }
    }

    let (install_dir, existing_dirs) = skill_directories(agent, &home);
    let found_skill = existing_dirs.into_iter().find(|dir| dir.is_dir());
    let skill = match &found_skill {
        None => SetupStatus::Added,
        Some(dir) if skill_matches(dir) => SetupStatus::Identical,
        Some(_) => SetupStatus::Replaced,
    };

    let mut backups = Vec::new();
    if mcp != SetupStatus::Identical {
        backups.extend(write_server(agent, cwd, &home, &desired)?);
    }
    if skill != SetupStatus::Identical {
        // A copy left in Codex's own directory would be a second, older skill
        // under the same name, which is what the reference cleared too.
        if let Some(stale) = found_skill.filter(|dir| dir != &install_dir) {
            let taken = backup_skill_directory(&stale, SKILL_NAME).map_err(SetupError::Failed)?;
            std::fs::remove_dir_all(&stale).map_err(|error| {
                SetupError::Failed(format!("Failed to remove {}: {error}", stale.display()))
            })?;
            backups.push(taken.to_string_lossy().into_owned());
        }
        backups.extend(write_skill(agent)?);
    }

    Ok(SetupResult {
        agent,
        mcp,
        skill,
        command: command.to_string(),
        backups,
    })
}

/// Where the skill goes, and every directory an earlier copy could be in.
///
/// Codex has two user skill directories and installs into the first, so an
/// install has one destination but two places to look. The destination is
/// listed first, so it wins when both hold a copy.
fn skill_directories(agent: SetupAgent, home: &Path) -> (PathBuf, Vec<PathBuf>) {
    let relative: &[&str] = match agent {
        SetupAgent::Claude => &[".claude/skills"],
        SetupAgent::Codex => &[".agents/skills", ".codex/skills"],
        SetupAgent::Gemini => &[".gemini/skills"],
    };
    let candidates: Vec<PathBuf> = relative
        .iter()
        .map(|path| home.join(path).join(SKILL_NAME))
        .collect();
    (candidates[0].clone(), candidates)
}

/// Whether the directory holds exactly the bundled skill: every file, the same
/// bytes, and nothing else.
///
/// Compared by content rather than by a digest, because the digest would have
/// to be spelled the same way the reference's was — down to which collation
/// sorted the filenames — for a skill the npm package installed to be
/// recognised. Comparing the files answers that question directly.
fn skill_matches(directory: &Path) -> bool {
    let mut present = Vec::new();
    if collect_files(directory, Path::new(""), &mut present).is_err() {
        return false;
    }
    if present.len() != SKILL_FILES.len() {
        return false;
    }
    SKILL_FILES.iter().all(|(relative, body)| {
        std::fs::read(directory.join(relative)).is_ok_and(|found| found == body.as_bytes())
    })
}

fn collect_files(root: &Path, relative: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(root.join(relative))? {
        let entry = entry?;
        let child = relative.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            collect_files(root, &child, out)?;
        } else {
            out.push(child);
        }
    }
    Ok(())
}

/// Write the bundled skill out where the agent will find it.
///
/// Staged through a temporary directory so the install goes through the same
/// path — and takes the same backup — as a skill copied from anywhere else.
fn write_skill(agent: SetupAgent) -> Result<Vec<String>, SetupError> {
    let staging = std::env::temp_dir().join(format!(
        "nomoreide-setup-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let result = (|| -> Result<Vec<String>, SetupError> {
        for (relative, body) in SKILL_FILES {
            let target = staging.join(relative);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|error| {
                    SetupError::Failed(format!("Failed to create {}: {error}", parent.display()))
                })?;
            }
            std::fs::write(&target, body).map_err(|error| {
                SetupError::Failed(format!("Failed to write {}: {error}", target.display()))
            })?;
        }
        let taken = install_user_skill(agent.skill_agent(), SKILL_NAME, &staging)
            .map_err(SetupError::Failed)?;
        Ok(taken
            .map(|path| path.to_string_lossy().into_owned())
            .into_iter()
            .collect())
    })();
    std::fs::remove_dir_all(&staging).ok();
    result
}

fn write_server(
    agent: SetupAgent,
    cwd: &Path,
    home: &Path,
    desired: &ServerSpec,
) -> Result<Vec<String>, SetupError> {
    match agent {
        SetupAgent::Gemini => write_gemini_server(home, desired),
        SetupAgent::Claude => add_mcp(Agent::Claude, MCP_KEY, desired, Scope::User, cwd)
            .map(|outcome| outcome.backups)
            .map_err(SetupError::Failed),
        SetupAgent::Codex => add_mcp(Agent::Codex, MCP_KEY, desired, Scope::User, cwd)
            .map(|outcome| outcome.backups)
            .map_err(SetupError::Failed),
    }
}

fn gemini_settings_path(home: &Path) -> PathBuf {
    home.join(".gemini").join("settings.json")
}

/// Gemini's `settings.json`, which holds far more than MCP servers.
///
/// Read, edited, written back — never rebuilt — so the rest of a file the user
/// maintains by hand survives, in the order they wrote it.
fn write_gemini_server(home: &Path, desired: &ServerSpec) -> Result<Vec<String>, SetupError> {
    let path = gemini_settings_path(home);
    let mut document = match std::fs::read_to_string(&path) {
        Ok(source) => match js_json::parse(&source) {
            Ok(serde_json::Value::Object(map)) => map,
            Ok(_) => {
                return Err(SetupError::Failed(format!(
                    "Gemini CLI settings must contain a JSON object: {}",
                    path.display()
                )))
            }
            Err(_) => {
                return Err(SetupError::Failed(format!(
                    "Gemini CLI settings contain invalid JSON: {}",
                    path.display()
                )))
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::Map::new(),
        Err(error) => {
            return Err(SetupError::Failed(format!(
                "Failed to read {}: {error}",
                path.display()
            )))
        }
    };

    // Read rather than remove: re-inserting a key that was taken out appends
    // it, which would shuffle the settings file every time setup ran.
    let servers = match document.get("mcpServers") {
        None | Some(serde_json::Value::Null) => serde_json::Map::new(),
        Some(serde_json::Value::Object(map)) => map.clone(),
        Some(_) => {
            return Err(SetupError::Failed(format!(
                "Gemini CLI mcpServers must contain a JSON object: {}",
                path.display()
            )))
        }
    };

    let backups = backup_config_file(&path)
        .map_err(SetupError::Failed)?
        .map(|taken| taken.to_string_lossy().into_owned())
        .into_iter()
        .collect();

    let mut servers = servers;
    servers.insert(
        MCP_KEY.to_string(),
        serde_json::json!({
            "command": desired.command.clone().unwrap_or_default(),
            "args": desired.args.clone(),
        }),
    );
    document.insert("mcpServers".to_string(), serde_json::Value::Object(servers));

    let mut body =
        serde_json::to_string_pretty(&serde_json::Value::Object(document)).map_err(|error| {
            SetupError::Failed(format!("Failed to render {}: {error}", path.display()))
        })?;
    body.push('\n');
    atomic_write(&path, body, AtomicWriteOptions::default()).map_err(|error| {
        SetupError::Failed(format!("Failed to write {}: {error}", path.display()))
    })?;
    Ok(backups)
}

/// The server already configured under this key, if any.
fn read_existing(
    agent: SetupAgent,
    cwd: &Path,
    home: &Path,
) -> Result<Option<ServerSpec>, SetupError> {
    if agent == SetupAgent::Gemini {
        return read_gemini_existing(home);
    }
    let wanted = agent.skill_agent().id();
    let configs = read_configs(Some(cwd));
    let Some(view) = configs.into_iter().find(|view| view.agent == wanted) else {
        return Ok(None);
    };
    Ok(ServerSpec::from_view(&view, Scope::User, MCP_KEY))
}

fn read_gemini_existing(home: &Path) -> Result<Option<ServerSpec>, SetupError> {
    let path = gemini_settings_path(home);
    let source = match std::fs::read_to_string(&path) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(SetupError::Failed(format!(
                "Failed to read {}: {error}",
                path.display()
            )))
        }
    };
    let document = match js_json::parse(&source) {
        Ok(serde_json::Value::Object(map)) => map,
        Ok(_) => return Ok(None),
        Err(_) => {
            return Err(SetupError::Failed(format!(
                "Gemini CLI settings contain invalid JSON: {}",
                path.display()
            )))
        }
    };
    let Some(entry) = document
        .get("mcpServers")
        .and_then(serde_json::Value::as_object)
        .and_then(|servers| servers.get(MCP_KEY))
    else {
        return Ok(None);
    };
    // An entry that is there but says nothing this can read is still an entry:
    // reported as a server with no command, so it counts as a conflict rather
    // than being silently written over.
    let object = entry.as_object();
    Ok(Some(ServerSpec {
        command: object
            .and_then(|entry| entry.get("command"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        args: object
            .and_then(|entry| entry.get("args"))
            .and_then(serde_json::Value::as_array)
            .map(|args| {
                args.iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        url: object
            .and_then(|entry| entry.get("url"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        ..ServerSpec::default()
    }))
}

/// Whether two entries would launch the same thing. An absent env and an empty
/// one are the same absence.
fn same_server(left: &ServerSpec, right: &ServerSpec) -> bool {
    fn env_of(spec: &ServerSpec) -> Vec<(String, crate::agent_env::Json)> {
        spec.env
            .as_ref()
            .map(|env| {
                env.iter()
                    .map(|(key, value)| (key.to_string(), value.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }
    left.command == right.command
        && left.args == right.args
        && left.url == right.url
        && env_of(left) == env_of(right)
}

/// Whether an entry is one *this program* wrote — a native install of some
/// other version, or the npm shim it replaces.
///
/// The `--force` guard exists to protect a server somebody else named
/// `nomoreide`. Refusing to replace our own previous entry would make every
/// upgrade need a flag.
fn is_ours(spec: &ServerSpec) -> bool {
    let Some(command) = spec.command.as_deref().filter(|value| !value.is_empty()) else {
        return false;
    };
    // Split on both separators rather than asking `Path`, which only knows
    // the one this build runs on. A config is copied between machines, and a
    // Windows entry read on Linux is still a Windows entry.
    let base = command.rsplit(['/', '\\']).next().unwrap_or(command);
    let base = base.strip_suffix(".exe").unwrap_or(base);
    if base == "nomoreide" {
        return true;
    }
    // `npx -y nomoreide`, and the same shape from every other package runner.
    matches!(
        base,
        "npx" | "npm" | "pnpm" | "pnpx" | "yarn" | "bun" | "bunx"
    ) && spec
        .args
        .iter()
        .any(|arg| arg == "nomoreide" || arg.starts_with("nomoreide@"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "nomoreide-setup-test-{name}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn spec(command: &str, args: &[&str]) -> ServerSpec {
        ServerSpec {
            command: Some(command.to_string()),
            args: args.iter().map(|arg| arg.to_string()).collect(),
            ..ServerSpec::default()
        }
    }

    /// The list of embedded files is written by hand, so it can fall behind the
    /// directory it was copied from. A skill missing a file still installs, and
    /// still looks like it worked.
    #[test]
    fn every_bundled_skill_file_is_compiled_in() {
        // The workspace copy, which is what the list is supposed to track.
        // A *published* crate has no workspace above it — it carries the
        // vendored copy `build.rs` staged instead — and there the comparison
        // has nothing to say, so it steps aside rather than failing.
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../profiles/nomoreide-debug/skills/nomoreide-debug");
        if !source.join("SKILL.md").is_file() {
            return;
        }
        let mut on_disk = Vec::new();
        collect_files(&source, Path::new(""), &mut on_disk).unwrap();
        let mut on_disk: Vec<String> = on_disk
            .iter()
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .collect();
        on_disk.sort();
        let mut embedded: Vec<String> = SKILL_FILES
            .iter()
            .map(|(relative, _)| (*relative).to_string())
            .collect();
        embedded.sort();
        assert_eq!(embedded, on_disk);
        for (relative, body) in SKILL_FILES {
            assert_eq!(
                std::fs::read_to_string(source.join(relative)).unwrap(),
                *body,
                "{relative} on disk differs from the compiled-in copy"
            );
        }
    }

    #[test]
    fn a_directory_holding_the_bundled_skill_is_recognised_and_a_changed_one_is_not() {
        let root = scratch("matches");
        let installed = root.join("nomoreide-debug");
        write_skill_into(&installed);
        assert!(skill_matches(&installed));

        // One byte different is a different skill.
        std::fs::write(installed.join("SKILL.md"), "not the bundled one").unwrap();
        assert!(!skill_matches(&installed));
        write_skill_into(&installed);

        // A file the bundle does not have is also a difference: an install
        // replaces the directory, so leaving it would be losing it silently.
        std::fs::write(installed.join("extra.md"), "left over").unwrap();
        assert!(!skill_matches(&installed));

        // And a directory that is not there at all is not a match.
        std::fs::remove_dir_all(&root).ok();
        assert!(!skill_matches(&installed));
    }

    fn write_skill_into(directory: &Path) {
        for (relative, body) in SKILL_FILES {
            let target = directory.join(relative);
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            std::fs::write(&target, body).unwrap();
        }
    }

    #[test]
    fn a_missing_file_alone_is_enough_to_fail_the_match() {
        let root = scratch("partial");
        let installed = root.join("nomoreide-debug");
        write_skill_into(&installed);
        std::fs::remove_file(installed.join("evals/evals.json")).unwrap();
        assert!(!skill_matches(&installed));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn each_agent_installs_into_its_own_directory_and_codex_looks_in_two() {
        let home = Path::new("/h");
        assert_eq!(
            skill_directories(SetupAgent::Claude, home),
            (
                PathBuf::from("/h/.claude/skills/nomoreide-debug"),
                vec![PathBuf::from("/h/.claude/skills/nomoreide-debug")]
            )
        );
        assert_eq!(
            skill_directories(SetupAgent::Gemini, home),
            (
                PathBuf::from("/h/.gemini/skills/nomoreide-debug"),
                vec![PathBuf::from("/h/.gemini/skills/nomoreide-debug")]
            )
        );
        // Codex installs into the portable directory and finds an older copy
        // in its own — in that order, so the installed one decides the status.
        assert_eq!(
            skill_directories(SetupAgent::Codex, home),
            (
                PathBuf::from("/h/.agents/skills/nomoreide-debug"),
                vec![
                    PathBuf::from("/h/.agents/skills/nomoreide-debug"),
                    PathBuf::from("/h/.codex/skills/nomoreide-debug"),
                ]
            )
        );
    }

    /// The destination above is computed here but written by `agent_env`. If
    /// the two ever disagree, setup would look for its skill somewhere it
    /// never puts one, and report `added` forever.
    #[test]
    fn the_computed_destination_is_where_agent_env_actually_installs() {
        for agent in [SetupAgent::Claude, SetupAgent::Codex, SetupAgent::Gemini] {
            let home = home();
            let (mine, _) = skill_directories(agent, &home);
            let theirs =
                crate::agent_env::install_skill_destination(agent.skill_agent(), SKILL_NAME);
            assert_eq!(mine, theirs, "for {}", agent.id());
        }
    }

    #[test]
    fn our_own_entries_are_recognised_and_other_peoples_are_not() {
        // The npm shim this replaces, in every spelling a package runner uses.
        assert!(is_ours(&spec("npx", &["-y", "nomoreide"])));
        assert!(is_ours(&spec("npx", &["-y", "nomoreide@0.1.100"])));
        assert!(is_ours(&spec("bunx", &["nomoreide"])));
        assert!(is_ours(&spec(
            "/opt/homebrew/bin/pnpm",
            &["dlx", "nomoreide"]
        )));
        // A native install, wherever it was installed to.
        assert!(is_ours(&spec("nomoreide", &["mcp"])));
        assert!(is_ours(&spec("/home/a/.local/bin/nomoreide", &["mcp"])));
        assert!(is_ours(&spec("C:\\tools\\nomoreide.exe", &["mcp"])));

        // Somebody else's server that happens to be filed under this key.
        assert!(!is_ours(&spec("some-other-tool", &["serve"])));
        // A package runner starting something that is not this.
        assert!(!is_ours(&spec("npx", &["-y", "some-other-tool"])));
        // A remote server has no command at all, and is nothing of ours.
        assert!(!is_ours(&ServerSpec {
            url: Some("https://example.test/mcp".to_string()),
            ..ServerSpec::default()
        }));
        // Neither is an entry with an empty command.
        assert!(!is_ours(&spec("", &["mcp"])));
    }

    #[test]
    fn an_absent_env_and_an_empty_one_are_the_same_server() {
        let bare = spec("nomoreide", &["mcp"]);
        let empty = ServerSpec {
            env: Some(crate::agent_env::OrderedMap::new()),
            ..bare.clone()
        };
        assert!(same_server(&bare, &empty));

        let mut populated = crate::agent_env::OrderedMap::new();
        populated.insert(
            "NOMOREIDE_AUTO_UI".to_string(),
            crate::agent_env::Json::String("0".to_string()),
        );
        let with_env = ServerSpec {
            env: Some(populated),
            ..bare.clone()
        };
        assert!(!same_server(&bare, &with_env));

        // Different arguments to the same binary are a different server: this
        // is what makes an upgrade from `npx -y nomoreide` register at all.
        assert!(!same_server(&bare, &spec("nomoreide", &["daemon"])));
        assert!(!same_server(&bare, &spec("nomoreide-old", &["mcp"])));
    }

    #[test]
    fn writing_the_gemini_server_keeps_the_rest_of_the_file_and_its_order() {
        let home = scratch("gemini");
        let path = gemini_settings_path(&home);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"theme":"dark","mcpServers":{"other":{"command":"other"}},"telemetry":false}"#,
        )
        .unwrap();

        assert_eq!(read_gemini_existing(&home).unwrap(), None);
        let backups = write_gemini_server(&home, &desired_server("/bin/nomoreide")).unwrap();
        assert_eq!(backups.len(), 1, "the previous file is copied aside");

        let written: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written["theme"], serde_json::json!("dark"));
        assert_eq!(written["telemetry"], serde_json::json!(false));
        assert_eq!(written["mcpServers"]["other"]["command"], "other");
        assert_eq!(
            written["mcpServers"]["nomoreide"],
            serde_json::json!({"command": "/bin/nomoreide", "args": ["mcp"]})
        );
        // The keys the user had are still in the order they wrote them, with
        // the settings key they never had appended rather than sorted in.
        let keys: Vec<&str> = written
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, ["theme", "mcpServers", "telemetry"]);

        // Read back: what was written is now what `install` would call identical.
        let existing = read_gemini_existing(&home).unwrap().unwrap();
        assert!(same_server(&existing, &desired_server("/bin/nomoreide")));
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn a_gemini_file_with_no_settings_yet_is_created_rather_than_refused() {
        let home = scratch("gemini-new");
        assert_eq!(read_gemini_existing(&home).unwrap(), None);
        let backups = write_gemini_server(&home, &desired_server("nomoreide")).unwrap();
        assert!(backups.is_empty(), "nothing existed to back up");
        assert!(gemini_settings_path(&home).is_file());
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn a_gemini_file_that_is_not_json_is_refused_rather_than_overwritten() {
        let home = scratch("gemini-broken");
        let path = gemini_settings_path(&home);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ this is not json").unwrap();

        let read = read_gemini_existing(&home).unwrap_err();
        assert!(matches!(read, SetupError::Failed(ref detail) if detail.contains("invalid JSON")));
        let written = write_gemini_server(&home, &desired_server("nomoreide")).unwrap_err();
        assert!(
            matches!(written, SetupError::Failed(ref detail) if detail.contains("invalid JSON"))
        );
        // Refused means untouched: the user's file is still theirs to fix.
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{ this is not json"
        );
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn an_existing_gemini_entry_is_read_back_whole() {
        let home = scratch("gemini-existing");
        let path = gemini_settings_path(&home);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"mcpServers":{"nomoreide":{"command":"npx","args":["-y","nomoreide"]}}}"#,
        )
        .unwrap();
        let existing = read_gemini_existing(&home).unwrap().unwrap();
        assert_eq!(existing.command.as_deref(), Some("npx"));
        assert_eq!(existing.args, ["-y", "nomoreide"]);
        assert!(is_ours(&existing));
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn the_three_agent_names_parse_and_nothing_else_does() {
        assert_eq!(SetupAgent::parse("claude"), Some(SetupAgent::Claude));
        assert_eq!(SetupAgent::parse("codex"), Some(SetupAgent::Codex));
        assert_eq!(SetupAgent::parse("gemini"), Some(SetupAgent::Gemini));
        // Not an alias for Gemini here: the skill goes to Antigravity's
        // directory, but the MCP server does not go to Antigravity's config.
        assert_eq!(SetupAgent::parse("antigravity"), None);
        assert_eq!(SetupAgent::parse("Claude"), None);
        assert_eq!(SetupAgent::parse(""), None);
    }

    #[test]
    fn the_written_entry_names_this_binary_and_the_mcp_subcommand() {
        let desired = desired_server(&native_server_command());
        assert_eq!(desired.args, ["mcp"]);
        let command = desired.command.unwrap();
        assert!(!command.is_empty());
        // Absolute, so an agent that does not inherit this PATH still finds
        // it. Under `cargo test` the current executable is the test binary,
        // which is enough to prove the path is resolved rather than guessed.
        assert!(Path::new(&command).is_absolute(), "{command}");
    }
}
