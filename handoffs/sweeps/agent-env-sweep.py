#!/usr/bin/env python3
"""Seeded regression sweep for scripts/check-agent-env-parity.ts.

Each seed makes one behavioural change to the Rust source, rebuilds, and expects
the gate to fail on a *named* case. A seed the gate does not catch is a hole in
the gate, not a success.

Four clusters:

- **The plugin listing**, which is the part of this slice the Rust reader did
  not have at all before. Several of these seeds are only observable because the
  gate's fixture was extended to hold two plugin skills rather than one, a
  dot-directory, and a `.toml` beside a `.md` in both `agents/` and `commands/`.
- **The settings file pair**, where the format, the path and the model key each
  follow from the agent and nothing else, and where a write's refusal splits
  400 from 500 on the wording of the message.
- **The route's own checks**, including the two that run in opposite orders:
  `/settings/:agent` validates the agent first, `/settings/:agent/model`
  validates the method first.
- **Staged changes**, whose validation is whole-batch and whose warnings are
  each a sentence the drawer renders.

Run it alone: it mutates tracked sources and restores them from an in-memory
backup, so a second cargo build racing it tests a binary that is one edit behind
its source. Killing it mid-run leaves a seed on disk.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _runner import run_sweep, select  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

PLUGINS = "crates/nomoreide-core/src/agent_env/plugins.rs"
SETTINGS = "crates/nomoreide-core/src/agent_settings.rs"
CHANGES = "crates/nomoreide-core/src/agent_env/changes.rs"
BACKUP = "crates/nomoreide-core/src/agent_env/backup.rs"
SKILLS = "crates/nomoreide-core/src/agent_env/skills.rs"
ROUTE = "crates/nomoreide-daemon/src/server/routes/agent_env.rs"

GATE_SCRIPT = "scripts/check-agent-env-parity.ts"

#: Gate runs go in parallel; builds cannot. See handoffs/sweeps/_runner.py.
WORKERS = 3

SEEDS = [
    # --- the plugin listing ---------------------------------------------------
    ("plugins-are-not-listed", PLUGINS,
     """        Agent::Claude => claude(home),""",
     """        Agent::Claude => Vec::new(),""",
     "live/every-agent"),
    ("plugins-come-after-skills", SKILLS,
     """    let mut skills = super::plugins::discover(agent, home);""",
     """    let mut skills = Vec::new();""",
     "live/every-agent"),
    ("a-plugin-key-splits-at-the-last-at-sign", PLUGINS,
     """            let mut pieces = key.split('@');""",
     """            let mut pieces = key.rsplit('@');""",
     "live/every-agent"),
    # The bug this slice actually shipped, kept as a seed: `split_once` carries
    # everything after the first `@` as the source, where the reference keeps
    # only the piece between the first and the second.
    ("a-plugin-key-splits-only-once", PLUGINS,
     """            let mut pieces = key.split('@');
            let name = pieces.next().unwrap_or_default().to_string();
            let source = pieces.next().map(str::to_string);""",
     """            let (name, source) = match key.split_once('@') {
                Some((name, source)) => (name.to_string(), Some(source.to_string())),
                None => (key.clone(), None),
            };""",
     "live/every-agent"),
    ("an-empty-plugin-skill-list-is-omitted", PLUGINS,
     """        plugin_skills: Some(skills),""",
     """        plugin_skills: non_empty(skills),""",
     "live/every-agent"),
    ("an-empty-plugin-mcp-list-is-reported", PLUGINS,
     """        plugin_mcps: non_empty(mcps),""",
     """        plugin_mcps: Some(mcps),""",
     "live/every-agent"),
    ("plugin-skills-are-not-sorted", PLUGINS,
     """fn sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort_by(|left, right| locale::compare(left, right));
    values
}""",
     """fn sorted(values: Vec<String>) -> Vec<String> {
    values
}""",
     "live/every-agent"),
    ("plugin-skills-are-sorted-by-bytes", PLUGINS,
     """    values.sort_by(|left, right| locale::compare(left, right));""",
     """    values.sort();""",
     "live/every-agent"),
    ("a-hidden-plugin-skill-is-listed", PLUGINS,
     """            .filter(|name| !name.starts_with('.'))""",
     """""",
     "live/every-agent"),
    ("a-plugin-agent-may-not-be-toml", PLUGINS,
     """    named_files(root, "agents", &[".md", ".toml"])""",
     """    named_files(root, "agents", &[".md"])""",
     "live/every-agent"),
    ("a-plugin-command-may-be-toml", PLUGINS,
     """    named_files(root, "commands", &[".md"])""",
     """    named_files(root, "commands", &[".md", ".toml"])""",
     "live/every-agent"),
    ("a-plugin-mcp-file-has-no-wrapper", PLUGINS,
     """    let servers = match document.get("mcpServers") {""",
     """    let servers = match None::<&serde_json::Value> {""",
     "live/every-agent"),

    # --- the settings files ---------------------------------------------------
    ("codex-settings-are-json", SETTINGS,
     """        Agent::Codex => Format::Toml,""",
     """        Agent::Codex => Format::Json,""",
     "settings/codex"),
    ("antigravity-can-switch-models", SETTINGS,
     """    agent != Agent::Antigravity""",
     """    true""",
     "model/set-an-antigravity-model"),
    ("a-model-may-be-any-type", SETTINGS,
     """                Some(serde_json::Value::String(text)) => Some(text.clone()),""",
     """                Some(value) => Some(value.to_string()),""",
     "settings/get-a-file-whose-model-is-not-a-string"),
    ("a-written-file-keeps-its-missing-newline", SETTINGS,
     """    let body = if content.ends_with('\\n') {""",
     """    let body = if true {""",
     "settings/put-content-with-no-trailing-newline"),
    ("clearing-a-model-leaves-it", SETTINGS,
     """                document.shift_remove("model");""",
     """""",
     "settings/clear-the-model"),
    ("a-cleared-json-model-swaps-with-the-last-key", SETTINGS,
     """                document.shift_remove("model");""",
     """                document.remove("model");""",
     "settings/clear-the-model"),
    ("the-toml-root-table-is-the-whole-file", SETTINGS,
     """    let section = section_start(content);""",
     """    let section: Option<usize> = None;""",
     # A file whose *only* `model` lives under a section: with the root table
     # correctly bounded there is nothing to replace and a line is inserted,
     # where treating the whole file as the root rewrites the section's key.
     # The case this seed first named could not tell the two apart, because its
     # root `model` came before the section and was found either way.
     "model/set-a-codex-model"),
    ("a-toml-model-is-inserted-rather-than-replaced", SETTINGS,
     """    pattern.find(root).map(|found| (found.start(), found.end()))""",
     """    let _ = root;
    None""",
     "model/set-a-codex-model"),
    ("a-cleared-toml-model-leaves-its-line-blank", SETTINGS,
     """            let end = if root[span.1..].starts_with('\\n') {
                span.1 + 1
            } else {
                span.1
            };""",
     """            let end = span.1;""",
     "settings/clear-a-codex-model-with-a-section-below"),

    # --- backups --------------------------------------------------------------
    ("a-file-backup-never-gives-up", BACKUP,
     """const FILE_ATTEMPTS: u32 = 10;""",
     """const FILE_ATTEMPTS: u32 = 10_000;""",
     "settings/clear-a-codex-model-with-a-section-below"),
    ("a-write-takes-no-backup", SETTINGS,
     """    let backup = backup_config_file(&path)?;""",
     """    let backup: Option<std::path::PathBuf> = None;""",
     # Not the first write: `.claude/settings.json` does not exist yet then, so
     # there is nothing to back up and both answers are null either way. The
     # first write that finds a file already there is what observes this.
     "model/set-a-model"),

    # --- the routes -----------------------------------------------------------
    ("the-agent-segment-is-decoded", ROUTE,
     """fn agent_segment(uri: &Uri, trailing: bool) -> &str {
    let path = uri.path();""",
     """fn agent_segment(uri: &Uri, trailing: bool) -> &str {
    let path = uri.path();
    let path: &str = Box::leak(
        crate::server::body::percent_decode(path).into_boxed_str(),
    );""",
     "settings/an-encoded-agent-name"),
    ("the-settings-method-is-checked-first", ROUTE,
     """    let Some(agent) = agent_named(agent_segment(&uri, false)) else {
        return error(StatusCode::BAD_REQUEST, "Unknown agent.");
    };
    match method {""",
     """    if !matches!(method, Method::GET | Method::PUT) {
        return error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
    }
    let Some(agent) = agent_named(agent_segment(&uri, false)) else {
        return error(StatusCode::BAD_REQUEST, "Unknown agent.");
    };
    match method {""",
     "settings/a-delete-on-an-unknown-agent"),
    ("the-model-agent-is-checked-first", ROUTE,
     """    if method != Method::POST {
        return error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
    }
    let Some(agent) = agent_named(agent_segment(&uri, true)) else {
        return error(StatusCode::BAD_REQUEST, "Unknown agent.");
    };""",
     """    let Some(agent) = agent_named(agent_segment(&uri, true)) else {
        return error(StatusCode::BAD_REQUEST, "Unknown agent.");
    };
    if method != Method::POST {
        return error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
    }""",
     "model/a-get-on-an-unknown-agent"),
    ("a-bad-settings-write-is-always-a-500", ROUTE,
     """            let status = if message.starts_with("Not valid") {""",
     """            let status = if false {""",
     "settings/put-content-that-is-not-valid"),
    ("a-bad-model-write-is-a-400", ROUTE,
     """        Err(message) => error(StatusCode::INTERNAL_SERVER_ERROR, &message),
    }
}

/// A write's refusal splits on wording""",
     """        Err(message) => error(StatusCode::BAD_REQUEST, &message),
    }
}

/// A write's refusal splits on wording""",
     "settings/set-a-model-on-a-file-that-does-not-parse"),
    ("any-agent-can-be-snapshotted", ROUTE,
     """        .and_then(agent_named)""",
     """        .map(|_| Agent::Claude)""",
     "snapshot/an-unknown-agent"),

    # --- the staged-change schema ---------------------------------------------
    ("a-batch-may-be-empty", ROUTE,
     """    if items.is_empty() || items.len() > MAX_CHANGES {""",
     """    if items.len() > MAX_CHANGES {""",
     "preview/an-empty-array"),
    ("a-batch-has-no-ceiling", ROUTE,
     """const MAX_CHANGES: usize = 50;""",
     """const MAX_CHANGES: usize = 5_000;""",
     "preview/fifty-one-changes"),
    ("a-null-optional-field-is-absent", ROUTE,
     """            Some(Value::Null) => None,""",
     """            Some(Value::Null) => Some(None),""",
     "preview/a-source-scope-that-is-null"),
    ("a-blank-name-is-accepted", ROUTE,
     """    if name.is_empty() {
        return None;
    }""",
     """""",
     "preview/a-blank-name"),
    ("a-missing-source-scope-is-project", ROUTE,
     """        None => Scope::User,""",
     """        None => Scope::Project,""",
     "preview/no-source-scope"),

    # --- what a preview says --------------------------------------------------
    ("a-batch-is-valid-whatever-its-items-say", CHANGES,
     """        valid: items.iter().all(|item| item.ok),""",
     """        valid: true,""",
     "preview/copy-an-mcp-that-does-not-exist"),
    ("an-untouched-agent-is-still-reported", CHANGES,
     """            .filter(|diff| !diff.add.is_empty() || !diff.remove.is_empty())""",
     """            .filter(|_| true)""",
     "preview/copy-an-mcp-between-agents"),
    ("a-copy-also-counts-as-a-removal", CHANGES,
     """        if change.action != Action::Copy {""",
     """        if true {""",
     "preview/copy-an-mcp-between-agents"),
    ("a-summary-names-the-agent-by-its-id", CHANGES,
     """        let from = format!(
            "{} ({})",
            self.source_agent.display_name(),
            self.source_scope.id()
        );""",
     """        let from = format!("{} ({})", self.source_agent.id(), self.source_scope.id());""",
     "preview/copy-an-mcp-between-agents"),
    ("an-overwrite-goes-unwarned", CHANGES,
     """                    warnings.push(format!(
                        "{} already has an MCP named \\"{}\\"; it will be overwritten.",
                        target_agent.display_name(),
                        change.name
                    ));""",
     """""",
     "preview/an-mcp-that-already-exists-on-the-target"),
    ("codex-keeps-a-remote-servers-detail", CHANGES,
     """                && drops_detail(source, change.source_scope, &change.name)""",
     """                && false""",
     "preview/copy-a-remote-mcp"),
    ("a-plugins-contents-are-not-counted", CHANGES,
     """        if let Some(contents) = plugin_contents(plugin) {""",
     """        if let Some(contents) = None::<String> {""",
     "preview/remove-a-managed-plugin"),
    ("a-plugin-with-no-install-path-is-removable", CHANGES,
     """        && plugin.install_path.is_some()""",
     """        && true""",
     "preview/remove-a-plugin-with-no-install-path"),
    ("a-remove-may-name-a-target-agent", CHANGES,
     """    } else if change.target_agent.is_some() {
        return fail(warnings, "A remove cannot have a target agent.".to_string());
    }""",
     """    }""",
     "preview/remove-an-mcp-with-a-target-agent-anyway"),
    ("a-skill-may-go-to-antigravitys-project-scope", CHANGES,
     """        if change.category == Category::Skill
            && target_scope == Scope::Project
            && target_agent == Agent::Antigravity
        {""",
     """        if false {""",
     "preview/move-a-skill-to-project-scope"),

    # --- what an apply does ---------------------------------------------------
    ("a-failed-batch-still-applies-what-it-can", CHANGES,
     """    if !preview.valid {""",
     """    if false {""",
     "apply/a-good-change-after-a-bad-one"),
    ("a-copy-backs-up-what-it-replaces", CHANGES,
     """    let mut backups: Vec<String> = Vec::new();""",
     """    let mut backups: Vec<String> = Vec::new();
    if target.is_dir() {
        backups.push(text(backup::directory(&target, name)?));
    }""",
     "apply/copy-the-same-skill-again"),
    ("a-move-keeps-no-copy-of-its-source", CHANGES,
     """    if remove_source {
        backups.push(text(backup::directory(&source, name)?));
    }""",
     """""",
     "apply/move-a-skill"),
    ("a-move-leaves-its-source-behind", CHANGES,
     """    if remove_source {
        std::fs::remove_dir_all(&source)
            .map_err(|error| format!("Failed to remove {}: {error}", source.display()))?;
    }""",
     """""",
     "apply/the-live-picture-after-the-skill-move"),
    ("a-removed-skill-is-not-backed-up", CHANGES,
     """    let taken = backup::directory(&directory, name)?;""",
     """    let taken = std::path::PathBuf::new();""",
     "apply/remove-a-skill"),
]

def main():
    seeds, complaint = select(SEEDS, sys.argv[1:])
    if complaint:
        print(complaint)
        return 2
    return run_sweep(ROOT, seeds, GATE_SCRIPT, workers=WORKERS)


# **Guarded on purpose.** Importing this file to reuse SEEDS -- to validate the
# anchors, say -- must not start a sweep.
if __name__ == "__main__":
    sys.exit(main())
