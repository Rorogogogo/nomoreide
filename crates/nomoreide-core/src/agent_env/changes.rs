//! A batch of staged changes: what it would do, and doing it.
//!
//! The dashboard stages edits before committing to them, so every rule here is
//! written once and read twice — [`preview`] reports it, and [`apply`] refuses
//! on it. Validation is whole-batch: if any change would fail, nothing is
//! written and every change comes back unapplied, because a half-applied batch
//! is the state nobody asked for. A *write* that fails mid-batch is different:
//! what already landed stays, and the batch stops there.
//!
//! Two categories are deliberately lopsided. A **plugin** can only be removed —
//! it is a managed install, and copying its files somewhere else produces a
//! directory the other agent's plugin machinery does not know about. A **skill**
//! going to project scope cannot go to Antigravity, which has no project-scoped
//! skills directory to put it in.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::spec::ServerSpec;
use super::writers::{self, Change};
use super::{backup, home, Agent, AgentConfigView, Scope, SkillEntry, AGENTS};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
    Mcp,
    Skill,
    Plugin,
}

impl Category {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "mcp" => Some(Self::Mcp),
            "skill" => Some(Self::Skill),
            "plugin" => Some(Self::Plugin),
            _ => None,
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Mcp => "mcp",
            Self::Skill => "skill",
            Self::Plugin => "plugin",
        }
    }

    /// How the category is spelled in a sentence: an acronym stays shouted.
    fn label(self) -> &'static str {
        match self {
            Self::Mcp => "MCP",
            Self::Skill => "skill",
            Self::Plugin => "plugin",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Copy,
    Move,
    Remove,
}

impl Action {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "copy" => Some(Self::Copy),
            "move" => Some(Self::Move),
            "remove" => Some(Self::Remove),
            _ => None,
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Copy => "copy",
            Self::Move => "move",
            Self::Remove => "remove",
        }
    }

    /// The verb a summary opens with.
    fn verb(self) -> &'static str {
        match self {
            Self::Copy => "Copy",
            Self::Move => "Move",
            Self::Remove => "Remove",
        }
    }
}

/// One staged mutation, after the route has checked its shape.
#[derive(Debug, Clone)]
pub struct PendingChange {
    pub category: Category,
    pub action: Action,
    pub name: String,
    pub source_agent: Agent,
    pub source_scope: Scope,
    pub target_agent: Option<Agent>,
    pub target_scope: Option<Scope>,
}

impl PendingChange {
    /// Echoed back in every answer, in the order the schema declares.
    fn echo(&self) -> Change {
        Change {
            category: self.category.id(),
            action: self.action.id(),
            name: self.name.clone(),
            source_agent: self.source_agent.id(),
            source_scope: self.source_scope.id(),
            target_agent: self.target_agent.map(Agent::id),
            target_scope: self.target_scope.map(Scope::id),
        }
    }

    /// Where a copy or a move puts things when the caller did not say.
    fn target_scope_or_default(&self) -> Scope {
        self.target_scope.unwrap_or(Scope::User)
    }

    fn summary(&self) -> String {
        let from = format!(
            "{} ({})",
            self.source_agent.display_name(),
            self.source_scope.id()
        );
        if self.action == Action::Remove {
            if self.category == Category::Plugin {
                return format!(
                    "Uninstall plugin \"{}\" from {}",
                    self.name,
                    self.source_agent.display_name()
                );
            }
            return format!(
                "Remove {} \"{}\" from {from}",
                self.category.label(),
                self.name
            );
        }
        let target = self
            .target_agent
            .map(Agent::display_name)
            // A copy with no target agent is refused, but it is still described
            // — the summary sits beside the refusal that explains it.
            .unwrap_or("?");
        format!(
            "{} {} \"{}\" from {from} to {target} ({})",
            self.action.verb(),
            self.category.label(),
            self.name,
            self.target_scope_or_default().id()
        )
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewItem {
    pub change: Change,
    pub ok: bool,
    pub summary: String,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// What one agent gains and loses across the whole batch.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentDiff {
    pub agent: &'static str,
    pub add: Vec<String>,
    pub remove: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChangePreview {
    pub valid: bool,
    pub items: Vec<PreviewItem>,
    pub agents: Vec<AgentDiff>,
}

/// What the batch would do, without doing any of it.
pub fn preview(changes: &[PendingChange], cwd: &Path) -> ChangePreview {
    let configs = super::read_configs(Some(cwd));
    let items: Vec<PreviewItem> = changes
        .iter()
        .map(|change| preview_one(change, &configs))
        .collect();

    let mut agents: Vec<AgentDiff> = AGENTS
        .iter()
        .map(|agent| AgentDiff {
            agent: agent.id(),
            add: Vec::new(),
            remove: Vec::new(),
        })
        .collect();
    for (item, change) in items.iter().zip(changes) {
        if !item.ok {
            continue;
        }
        let label = format!("{} \"{}\"", change.category.id(), change.name);
        if change.action != Action::Remove {
            if let Some(target) = change.target_agent {
                if let Some(diff) = agents.iter_mut().find(|diff| diff.agent == target.id()) {
                    diff.add.push(label.clone());
                }
            }
        }
        if change.action != Action::Copy {
            if let Some(diff) = agents
                .iter_mut()
                .find(|diff| diff.agent == change.source_agent.id())
            {
                diff.remove.push(label);
            }
        }
    }

    ChangePreview {
        valid: items.iter().all(|item| item.ok),
        items,
        agents: agents
            .into_iter()
            .filter(|diff| !diff.add.is_empty() || !diff.remove.is_empty())
            .collect(),
    }
}

fn view_for(configs: &[AgentConfigView], agent: Agent) -> Option<&AgentConfigView> {
    configs.iter().find(|view| view.agent == agent.id())
}

fn preview_one(change: &PendingChange, configs: &[AgentConfigView]) -> PreviewItem {
    let mut warnings: Vec<String> = Vec::new();
    let ok = |warnings: Vec<String>| PreviewItem {
        change: change.echo(),
        ok: true,
        summary: change.summary(),
        warnings,
        error: None,
    };
    let fail = |warnings: Vec<String>, error: String| PreviewItem {
        change: change.echo(),
        ok: false,
        summary: change.summary(),
        warnings,
        error: Some(error),
    };

    let Some(source) = view_for(configs, change.source_agent) else {
        return fail(
            warnings,
            format!("Unknown agent \"{}\".", change.source_agent.id()),
        );
    };

    if change.category == Category::Plugin {
        if change.action != Action::Remove {
            return fail(warnings, format!(
                "Plugins are managed installs; install \"{}\" through the target agent's plugin marketplace instead of copying files.",
                change.name
            ));
        }
        if change.target_agent.is_some() {
            return fail(warnings, "A remove cannot have a target agent.".to_string());
        }
        let Some(plugin) = source
            .skills
            .iter()
            .find(|entry| entry.kind == "plugin" && entry.name == change.name)
        else {
            return fail(
                warnings,
                format!(
                    "Plugin \"{}\" not found in {}.",
                    change.name,
                    change.source_agent.display_name()
                ),
            );
        };
        if !removable_plugin(change.source_agent, plugin) {
            return fail(warnings, format!(
                "Plugin \"{}\" can't be uninstalled from here — no install path or marketplace source was detected.",
                change.name
            ));
        }
        if let Some(contents) = plugin_contents(plugin) {
            warnings.push(format!(
                "Uninstalling \"{}\" removes {contents}.",
                change.name
            ));
        }
        return ok(warnings);
    }

    if change.action != Action::Remove {
        let Some(target_agent) = change.target_agent else {
            return fail(
                warnings,
                format!("A {} needs a target agent.", change.action.id()),
            );
        };
        let target_scope = change.target_scope_or_default();
        if target_agent == change.source_agent && target_scope == change.source_scope {
            return fail(
                warnings,
                format!(
                    "Source and target are the same; nothing to {}.",
                    change.action.id()
                ),
            );
        }
        if change.category == Category::Skill
            && target_scope == Scope::Project
            && target_agent == Agent::Antigravity
        {
            return fail(warnings, format!(
                "{} has no project-scoped skills; Claude, Codex, Cursor, and Windsurf support project skills.",
                target_agent.display_name()
            ));
        }
    } else if change.target_agent.is_some() {
        return fail(warnings, "A remove cannot have a target agent.".to_string());
    }

    if change.category == Category::Mcp {
        if ServerSpec::from_view(source, change.source_scope, &change.name).is_none() {
            return fail(
                warnings,
                format!(
                    "MCP \"{}\" not found in {} {} scope.",
                    change.name,
                    change.source_agent.display_name(),
                    change.source_scope.id()
                ),
            );
        }
        if let Some(target_agent) = change.target_agent {
            let target_scope = change.target_scope_or_default();
            if let Some(target) = view_for(configs, target_agent) {
                if ServerSpec::from_view(target, target_scope, &change.name).is_some() {
                    warnings.push(format!(
                        "{} already has an MCP named \"{}\"; it will be overwritten.",
                        target_agent.display_name(),
                        change.name
                    ));
                }
            }
            if target_agent == Agent::Codex
                && target_scope == Scope::User
                && drops_detail(source, change.source_scope, &change.name)
            {
                warnings.push(
                    "Codex config only stores a URL for remote MCPs; transport and headers will be dropped."
                        .to_string(),
                );
            }
        }
    } else {
        let Some(skill) = source
            .skills
            .iter()
            .find(|entry| entry.name == change.name && entry.scope == change.source_scope.id())
        else {
            return fail(
                warnings,
                format!(
                    "Skill \"{}\" not found in {} {} scope.",
                    change.name,
                    change.source_agent.display_name(),
                    change.source_scope.id()
                ),
            );
        };
        if skill.kind == "plugin" {
            return fail(warnings, format!(
                "\"{}\" is a plugin managed by {}; install it through the plugin marketplace instead of copying files.",
                change.name,
                change.source_agent.display_name()
            ));
        }
        if let Some(target_agent) = change.target_agent {
            let target_scope = change.target_scope_or_default();
            if let Some(target) = view_for(configs, target_agent) {
                if target
                    .skills
                    .iter()
                    .any(|entry| entry.name == change.name && entry.scope == target_scope.id())
                {
                    warnings.push(format!(
                        "{} already has a skill named \"{}\"; it will be replaced.",
                        target_agent.display_name(),
                        change.name
                    ));
                }
            }
        }
    }

    ok(warnings)
}

/// Whether the remote entry behind `key` carries anything Codex's config
/// cannot hold: it stores a bare URL and nothing else.
fn drops_detail(view: &AgentConfigView, scope: Scope, key: &str) -> bool {
    let remote = match scope {
        Scope::User => &view.remote_mcp_servers,
        Scope::Project => &view.project_remote_mcp_servers,
    };
    remote
        .get(key)
        .is_some_and(|server| server.headers.is_some() || server.transport == "sse")
}

/// Apply the batch, or refuse it whole.
pub fn apply(changes: &[PendingChange], cwd: &Path) -> writers::ChangeReport {
    let preview = preview(changes, cwd);
    if !preview.valid {
        let failed = preview.items.iter().filter(|item| !item.ok).count() as u32;
        return writers::ChangeReport {
            ok: false,
            applied: 0,
            failed,
            results: preview
                .items
                .into_iter()
                .map(|item| writers::ChangeResult {
                    change: item.change,
                    ok: false,
                    summary: item.summary,
                    backups: Vec::new(),
                    error: Some(item.error.unwrap_or_else(|| {
                        "Not applied — another staged change failed validation.".to_string()
                    })),
                })
                .collect(),
            backups: Vec::new(),
        };
    }

    let configs = super::read_configs(Some(cwd));
    let mut results: Vec<writers::ChangeResult> = Vec::new();
    for change in changes {
        let summary = change.summary();
        match apply_one(change, &configs, cwd) {
            Ok(backups) => results.push(writers::ChangeResult {
                change: change.echo(),
                ok: true,
                summary,
                backups,
                error: None,
            }),
            Err(message) => {
                results.push(writers::ChangeResult {
                    change: change.echo(),
                    ok: false,
                    summary,
                    backups: Vec::new(),
                    error: Some(message),
                });
                // One failed write stops the batch; what already landed stays.
                break;
            }
        }
    }

    let applied = results.iter().filter(|result| result.ok).count() as u32;
    let backups: Vec<String> = results
        .iter()
        .flat_map(|result| result.backups.clone())
        .collect();
    writers::ChangeReport {
        ok: applied as usize == changes.len(),
        applied,
        failed: results.len() as u32 - applied,
        results,
        backups,
    }
}

fn apply_one(
    change: &PendingChange,
    configs: &[AgentConfigView],
    cwd: &Path,
) -> Result<Vec<String>, String> {
    let source = view_for(configs, change.source_agent)
        .ok_or_else(|| format!("Unknown agent \"{}\".", change.source_agent.id()))?;

    match change.category {
        Category::Plugin => {
            let plugin = source
                .skills
                .iter()
                .find(|entry| entry.kind == "plugin" && entry.name == change.name)
                .ok_or_else(|| {
                    format!(
                        "Plugin \"{}\" not found in {}.",
                        change.name,
                        change.source_agent.display_name()
                    )
                })?;
            remove_plugin(change.source_agent, plugin)
        }
        Category::Mcp => {
            if change.action == Action::Remove {
                return backups_of(writers::remove_mcp(
                    change.source_agent,
                    &change.name,
                    change.source_scope,
                    cwd,
                ));
            }
            let spec = ServerSpec::from_view(source, change.source_scope, &change.name)
                .ok_or_else(|| {
                    format!(
                        "MCP \"{}\" not found in {} {} scope.",
                        change.name,
                        change.source_agent.display_name(),
                        change.source_scope.id()
                    )
                })?;
            let target_agent = change
                .target_agent
                .ok_or_else(|| format!("A {} needs a target agent.", change.action.id()))?;
            let added = writers::add_mcp(
                target_agent,
                &change.name,
                &spec,
                change.target_scope_or_default(),
                cwd,
            )?;
            if change.action == Action::Copy {
                return Ok(added.backups);
            }
            let removed = backups_of(writers::remove_mcp(
                change.source_agent,
                &change.name,
                change.source_scope,
                cwd,
            ))?;
            Ok(added.backups.into_iter().chain(removed).collect())
        }
        Category::Skill => {
            if change.action == Action::Remove {
                return remove_skill(change.source_agent, change.source_scope, &change.name, cwd);
            }
            let target_agent = change
                .target_agent
                .ok_or_else(|| format!("A {} needs a target agent.", change.action.id()))?;
            transfer_skill(
                change.source_agent,
                change.source_scope,
                target_agent,
                change.target_scope_or_default(),
                &change.name,
                cwd,
                change.action == Action::Move,
            )
        }
    }
}

/// Where an agent keeps the skills it was given, in one scope.
fn skills_directory(agent: Agent, scope: Scope, cwd: &Path) -> Result<PathBuf, String> {
    match scope {
        Scope::User => agent.user_skills_directory(&home()),
        Scope::Project => agent.project_skills_directory(cwd),
    }
    .ok_or_else(|| {
        format!(
            "{} has no project-scoped skills; Claude, Codex, Cursor, and Windsurf support project skills.",
            agent.display_name()
        )
    })
}

/// Where a skill actually is, which for user scope may not be the directory
/// its name would suggest.
fn installed_skill(agent: Agent, scope: Scope, name: &str, cwd: &Path) -> Result<PathBuf, String> {
    if scope == Scope::User {
        if let Some(path) = agent.installed_user_skill(&home(), name) {
            return Ok(path);
        }
    }
    Ok(skills_directory(agent, scope, cwd)?.join(name))
}

fn transfer_skill(
    source_agent: Agent,
    source_scope: Scope,
    target_agent: Agent,
    target_scope: Scope,
    name: &str,
    cwd: &Path,
    remove_source: bool,
) -> Result<Vec<String>, String> {
    let source = installed_skill(source_agent, source_scope, name, cwd)?;
    let target = skills_directory(target_agent, target_scope, cwd)?.join(name);
    if !source.is_dir() {
        return Err(format!(
            "Skill \"{name}\" not found in {} {} scope.",
            source_agent.display_name(),
            source_scope.id()
        ));
    }

    let mut backups: Vec<String> = Vec::new();
    // A skill being *replaced* is not backed up — the copy that overwrites it
    // is the same skill under the same name, and the reference keeps no copy.
    // Only a move takes one, because a move's source stops existing.
    if remove_source {
        backups.push(text(backup::directory(&source, name)?));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    std::fs::remove_dir_all(&target).ok();
    backup::copy_tree(&source, &target)?;
    if remove_source {
        std::fs::remove_dir_all(&source)
            .map_err(|error| format!("Failed to remove {}: {error}", source.display()))?;
    }
    Ok(backups)
}

fn remove_skill(agent: Agent, scope: Scope, name: &str, cwd: &Path) -> Result<Vec<String>, String> {
    let directory = installed_skill(agent, scope, name, cwd)?;
    if !directory.is_dir() {
        return Err(format!(
            "Skill \"{name}\" not found in {} {} scope.",
            agent.display_name(),
            scope.id()
        ));
    }
    let taken = backup::directory(&directory, name)?;
    std::fs::remove_dir_all(&directory)
        .map_err(|error| format!("Failed to remove {}: {error}", directory.display()))?;
    Ok(vec![text(taken)])
}

fn text(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

/// A single-change report, read back as the backups it took or the reason it
/// did not. The writers answer in report form because the MCP tools return one;
/// a staged batch only wants the two halves.
fn backups_of(report: writers::ChangeReport) -> Result<Vec<String>, String> {
    if report.ok {
        return Ok(report.backups);
    }
    Err(report
        .results
        .into_iter()
        .next()
        .and_then(|result| result.error)
        .unwrap_or_else(|| "The change could not be applied.".to_string()))
}

/// A plugin can be uninstalled when something says where it came from: an
/// install path *and* a marketplace, and an agent whose CLI knows how.
fn removable_plugin(agent: Agent, plugin: &SkillEntry) -> bool {
    matches!(agent, Agent::Claude | Agent::Codex)
        && plugin.install_path.is_some()
        && plugin.source.is_some()
}

/// What an uninstall takes with it, counted. Nothing at all when the plugin
/// contributes nothing, in which case the warning is left off entirely.
fn plugin_contents(plugin: &SkillEntry) -> Option<String> {
    let counted = [
        (plugin.plugin_skills.as_ref(), "skills"),
        (plugin.plugin_mcps.as_ref(), "MCPs"),
        (plugin.plugin_agents.as_ref(), "agents"),
        (plugin.plugin_commands.as_ref(), "commands"),
    ]
    .into_iter()
    .filter_map(|(values, label)| match values.map(Vec::len).unwrap_or(0) {
        0 => None,
        // Not singularised, because the reference does not do it either.
        count => Some(format!("{count} {label}")),
    })
    .collect::<Vec<_>>();
    if counted.is_empty() {
        None
    } else {
        Some(counted.join(", "))
    }
}

/// Uninstalling is the agent's own job.
///
/// Claude is asked to do it through its CLI rather than having its files taken
/// out from under it — the plugin's record lives somewhere this does not own,
/// and a directory removed behind the agent's back leaves it listing something
/// that is gone.
fn remove_plugin(agent: Agent, plugin: &SkillEntry) -> Result<Vec<String>, String> {
    let (Some(source), Some(_)) = (plugin.source.as_deref(), plugin.install_path.as_deref()) else {
        return Err(format!(
            "Plugin \"{}\" can't be uninstalled from here — no install path or marketplace source was detected.",
            plugin.name
        ));
    };
    match agent {
        Agent::Claude => {
            let key = format!("{}@{}", plugin.name, source);
            run_claude(&["plugin", "uninstall", &key, "--scope", "user"])?;
            Ok(Vec::new())
        }
        other => Err(format!(
            "Plugin uninstall is not supported for {}.",
            other.id()
        )),
    }
}

/// The `claude` on PATH, not the one a login shell would find: the reference
/// spawns the bare name and inherits the environment it was started with.
fn run_claude(args: &[&str]) -> Result<(), String> {
    let output = std::process::Command::new("claude")
        .args(args)
        .output()
        .map_err(|error| {
            format!("Failed to invoke `claude` CLI: {error}. Is Claude Code on PATH?")
        })?;
    if output.status.success() {
        return Ok(());
    }
    let mut detail = String::from_utf8_lossy(&output.stdout).into_owned();
    detail.push_str(&String::from_utf8_lossy(&output.stderr));
    let detail = detail.trim();
    let code = output
        .status
        .code()
        .map_or_else(|| "null".to_string(), |code| code.to_string());
    Err(if detail.is_empty() {
        format!("`claude {}` exited {code}", args.join(" "))
    } else {
        format!("`claude {}` exited {code}: {detail}", args.join(" "))
    })
}
