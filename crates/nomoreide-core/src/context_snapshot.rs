//! The context library's *listing*, which is more than its notes.
//!
//! A note is written by a person and lives in the vault. Everything else on the
//! page is **derived**: a row per registered repository, per registered service,
//! per open incident, per recorded agent session, and per Markdown file in a
//! repository. None of that is stored anywhere — it is rebuilt from config, the
//! error inbox and the transcript readers on every request, which is why the
//! builder takes them as arguments instead of the library holding them.
//!
//! That split is deliberate and matches `ContextLibrary::preview`, which
//! already takes the item list rather than assembling one: the library owns the
//! vault, and the vault is only ever part of what the page shows.

use crate::agent_transcripts::AgentTranscript;
use crate::config::Config;
use crate::context_library::{ContextItem, ContextLibrary, ContextNote, ContextRef, CONTEXT_KINDS};
use crate::error_inbox::Incident;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::Path;

const MAX_NOTES: usize = 2_000;
const MAX_PROJECT_MARKDOWN_FILES: usize = 2_000;
const MAX_GRAPH_NODES: usize = 250;
const MARKDOWN_EXTENSIONS: &[&str] = &["md", "mdx", "markdown"];
const IGNORED_DIRS: &[&str] = &[
    ".git",
    ".obsidian",
    ".trash",
    ".nomoreide",
    ".next",
    ".turbo",
    ".vercel",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "target",
    "vendor",
];

/// One row of the listing.
///
/// A note is carried **whole** — body, revision, links, project paths and
/// frontmatter included — while a derived row has only the fields every item
/// has. That asymmetry is the reference's and it is load-bearing: the editor
/// opens a note straight out of the listing, so a listing that carried only
/// the common fields would need a second request per note to render the page.
///
/// Untagged, so both serialize as a plain object with no discriminator. A
/// note's extra keys are simply there.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum ContextEntry {
    Note(Box<ContextNote>),
    Derived(Box<ContextItem>),
}

impl ContextEntry {
    pub fn item(&self) -> &ContextItem {
        match self {
            ContextEntry::Note(note) => &note.item,
            ContextEntry::Derived(item) => item,
        }
    }

    fn item_mut(&mut self) -> &mut ContextItem {
        match self {
            ContextEntry::Note(note) => &mut note.item,
            ContextEntry::Derived(item) => item,
        }
    }

    /// The project paths a row *also* belongs to. Only a note has more than
    /// the single `projectPath` every item carries.
    fn project_paths(&self) -> &[String] {
        match self {
            ContextEntry::Note(note) => &note.project_paths,
            ContextEntry::Derived(_) => &[],
        }
    }
}

/// The registered project a recorded path refers to.
///
/// **An exact match is not enough, because checkouts move.** A note records the
/// absolute path of the project it belonged to when it was written, and moving
/// the repository — or cloning it somewhere else — leaves every note pointing
/// at a directory that no longer exists. Matched literally they all fall out of
/// the graph at once, which reads as "these notes belong to nothing" rather
/// than "this path is stale".
///
/// So: the exact path first, and failing that the project whose directory has
/// the same name. **An ambiguous name resolves to nothing** — two checkouts
/// called `api` are a real possibility, and silently attaching a note to
/// whichever came first is a worse answer than leaving it unattached, the same
/// judgement the duplicate-note-id rule makes.
fn resolve_project<'a>(recorded: &str, items: &'a [ContextItem]) -> Option<&'a ContextItem> {
    let is_project = |item: &&ContextItem| item.kind == "project";
    if let Some(exact) = items
        .iter()
        .find(|item| is_project(item) && item.context_ref.id == recorded)
    {
        return Some(exact);
    }
    let name = directory_name(recorded)?;
    let mut matches = items
        .iter()
        .filter(|item| is_project(item) && directory_name(&item.context_ref.id) == Some(name));
    let first = matches.next()?;
    matches.next().is_none().then_some(first)
}

/// The last non-empty segment of a path, with any trailing separator ignored.
fn directory_name(path: &str) -> Option<&str> {
    path.trim_end_matches('/')
        .rsplit('/')
        .find(|segment| !segment.is_empty())
}

/// The listing, which is `ContextSnapshot` with its rows able to be notes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextListing {
    pub vault_path: String,
    pub items: Vec<ContextEntry>,
    pub pinned: Vec<ContextRef>,
    pub diagnostics: Vec<String>,
    pub truncated: bool,
}

impl ContextListing {
    /// The rows as plain items, which is what a preview resolves against.
    pub fn items(&self) -> Vec<ContextItem> {
        self.items
            .iter()
            .map(|entry| entry.item().clone())
            .collect()
    }
}

/// What a caller may narrow the listing to. Every field is optional and they
/// compose: a query, a project, and a set of kinds all apply at once.
#[derive(Debug, Default, Clone)]
pub struct ContextQuery {
    pub q: Option<String>,
    pub project_path: Option<String>,
    /// `None` means every kind. `Some(empty)` means **none** — which is what an
    /// unrecognised `kinds=` value collapses to, and it matches nothing.
    pub kinds: Option<Vec<String>>,
}

impl ContextQuery {
    /// Whether the listing will use agent transcripts at all.
    ///
    /// Public because reading them opens every recent rollout file, and a
    /// caller that knows they are not wanted should not pay for them.
    pub fn includes_session(&self) -> bool {
        self.includes("session")
    }

    fn includes(&self, kind: &str) -> bool {
        self.kinds
            .as_ref()
            .map_or(true, |kinds| kinds.iter().any(|wanted| wanted == kind))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextGraphNode {
    #[serde(rename = "ref")]
    pub context_ref: ContextRef,
    pub title: String,
    pub kind: String,
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextGraphEdge {
    pub from: ContextRef,
    pub to: ContextRef,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextGraph {
    pub nodes: Vec<ContextGraphNode>,
    pub edges: Vec<ContextGraphEdge>,
    pub truncated: bool,
}

/// Everything the page lists, in the order it lists it.
pub fn context_snapshot(
    library: &ContextLibrary,
    config: &Config,
    incidents: &[Incident],
    transcripts: &[AgentTranscript],
    query: &ContextQuery,
) -> Result<ContextListing, String> {
    let (notes, note_diagnostics) = library.notes_and_diagnostics()?;
    let note_count = notes.len();
    let pinned = library.pinned()?;
    let derived = derived_items(config, incidents, transcripts, query);
    let pinned_keys: Vec<String> = pinned.iter().map(ref_key).collect();

    // Each item travels with the project paths it *also* belongs to, which only
    // a note has. A note carries a whole list of them, and the project filter
    // matches against every one — a note filed under three repositories shows
    // up under all three. A derived item has only the single `projectPath` it
    // was built with, so its list is empty and the filter falls through to that.
    let mut items: Vec<ContextEntry> = notes
        .into_iter()
        .map(|note| ContextEntry::Note(Box::new(note)))
        .chain(
            derived
                .items
                .into_iter()
                .map(|item| ContextEntry::Derived(Box::new(item))),
        )
        .map(|mut entry| {
            let pinned = pinned_keys.contains(&ref_key(&entry.item().context_ref));
            entry.item_mut().pinned = pinned;
            entry
        })
        .collect();

    // The note rows were not filtered by kind above — only the derived ones are
    // built conditionally — so the kind filter runs over everything here.
    if query.kinds.is_some() {
        items.retain(|entry| query.includes(&entry.item().kind));
    }
    // A note carries a whole list of project paths and the filter matches any
    // of them, so a note filed under three repositories shows up under all
    // three. A derived row has only the one it was built with.
    if let Some(project) = query.project_path.as_deref() {
        // The same staleness the graph has to cope with: a note filed before the
        // checkout moved records the old absolute path, and matching it
        // literally hides the note from the project it plainly belongs to. The
        // directory name is the fallback here too — without the ambiguity check
        // the graph can make, because a filter that quietly drops a row is the
        // worse failure of the two.
        let wanted_name = directory_name(project);
        items.retain(|entry| {
            entry.item().project_path.as_deref() == Some(project)
                || entry.project_paths().iter().any(|path| {
                    path == project
                        || (wanted_name.is_some() && directory_name(path) == wanted_name)
                })
        });
    }
    if let Some(needle) = query.q.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        let needle = needle.to_lowercase();
        items.retain(|entry| {
            let item = entry.item();
            let haystacks = [
                Some(item.title.as_str()),
                item.excerpt.as_deref(),
                item.path.as_deref(),
            ];
            haystacks
                .into_iter()
                .flatten()
                .chain(item.tags.iter().map(String::as_str))
                .chain(item.aliases.iter().map(String::as_str))
                .any(|value| value.to_lowercase().contains(&needle))
        });
    }
    items.sort_by(|left, right| locale_cmp(&left.item().title, &right.item().title));

    let mut diagnostics = note_diagnostics;
    if note_count >= MAX_NOTES {
        diagnostics.push(format!(
            "Only the first {MAX_NOTES} Markdown notes were indexed."
        ));
    }
    diagnostics.extend(derived.diagnostics);
    Ok(ContextListing {
        vault_path: library.vault_path(),
        items,
        pinned,
        diagnostics,
        truncated: note_count >= MAX_NOTES || derived.truncated,
    })
}

struct Derived {
    items: Vec<ContextItem>,
    diagnostics: Vec<String>,
    truncated: bool,
}

/// A note's `projectPath` filter also matches its `projectPaths` list, which is
/// why the project filter above cannot be the whole story for notes.
fn derived_items(
    config: &Config,
    incidents: &[Incident],
    transcripts: &[AgentTranscript],
    query: &ContextQuery,
) -> Derived {
    let mut items = Vec::new();

    if query.includes("project") {
        for repository in &config.git_repositories {
            items.push(ContextItem {
                context_ref: ContextRef {
                    kind: "project".to_string(),
                    id: repository.path.clone(),
                },
                title: repository.name.clone(),
                kind: "project".to_string(),
                excerpt: Some(match repository.active_worktree_path.as_deref() {
                    Some(worktree) => format!("Active worktree: {worktree}"),
                    None => repository.path.clone(),
                }),
                project_path: Some(repository.path.clone()),
                path: Some(repository.path.clone()),
                updated_at: None,
                tags: Vec::new(),
                aliases: Vec::new(),
                pinned: false,
                editable: false,
            });
        }
    }

    if query.includes("service") {
        for service in &config.services {
            let cwd = service.cwd.clone().unwrap_or_default();
            let project_path = service.project_path.clone().or_else(|| {
                config
                    .git_repositories
                    .iter()
                    .find(|repository| cwd.starts_with(&repository.path))
                    .map(|repository| repository.path.clone())
            });
            items.push(ContextItem {
                context_ref: ContextRef {
                    kind: "service".to_string(),
                    id: format!(
                        "{}:{}",
                        project_path.as_deref().unwrap_or("workspace"),
                        service.name
                    ),
                },
                title: service.name.clone(),
                kind: "service".to_string(),
                excerpt: Some(format!(
                    "{} · {}",
                    service.kind.as_deref().unwrap_or("local"),
                    service.command.clone().unwrap_or(cwd.clone())
                )),
                project_path,
                path: Some(cwd),
                updated_at: None,
                tags: Vec::new(),
                aliases: Vec::new(),
                pinned: false,
                editable: false,
            });
        }
    }

    if query.includes("incident") {
        for incident in incidents {
            items.push(ContextItem {
                context_ref: ContextRef {
                    kind: "incident".to_string(),
                    id: format!("{}:{}", incident.service, incident.signature),
                },
                title: incident.title.clone(),
                kind: "incident".to_string(),
                excerpt: Some(format!(
                    "{} · {} · {} occurrences",
                    incident.level, incident.service, incident.count
                )),
                project_path: None,
                path: incident.file.clone(),
                updated_at: None,
                tags: vec![incident.level.clone()],
                aliases: Vec::new(),
                pinned: false,
                editable: false,
            });
        }
    }

    if query.includes("session") {
        for transcript in transcripts {
            items.push(ContextItem {
                context_ref: ContextRef {
                    kind: "session".to_string(),
                    id: format!("{}:{}", transcript.provider, transcript.id),
                },
                title: if transcript.title.is_empty() {
                    format!("{} session", transcript.provider)
                } else {
                    transcript.title.clone()
                },
                kind: "session".to_string(),
                excerpt: Some(transcript.cwd.clone()),
                project_path: Some(transcript.cwd.clone()),
                path: None,
                updated_at: Some(transcript.updated_at.clone()),
                tags: vec![transcript.provider.clone()],
                aliases: Vec::new(),
                pinned: false,
                editable: false,
            });
        }
    }

    let mut markdown = Vec::new();
    if query.includes("file") {
        for repository in &config.git_repositories {
            let remaining = MAX_PROJECT_MARKDOWN_FILES.saturating_sub(markdown.len());
            if remaining == 0 {
                break;
            }
            let root = Path::new(
                repository
                    .active_worktree_path
                    .as_deref()
                    .unwrap_or(&repository.path),
            );
            for path in markdown_files(root, remaining) {
                let relative = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .into_owned();
                let mut hasher = Sha256::new();
                hasher.update(repository.path.as_bytes());
                hasher.update([0u8]);
                hasher.update(relative.as_bytes());
                markdown.push(ContextItem {
                    context_ref: ContextRef {
                        kind: "file".to_string(),
                        id: format!("{:x}", hasher.finalize())[..32].to_string(),
                    },
                    title: relative,
                    kind: "file".to_string(),
                    excerpt: Some(format!("Markdown · {}", repository.name)),
                    project_path: Some(repository.path.clone()),
                    path: Some(path.to_string_lossy().into_owned()),
                    updated_at: None,
                    tags: vec!["markdown".to_string()],
                    aliases: vec![path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_default()],
                    pinned: false,
                    editable: false,
                });
            }
        }
    }
    let truncated = markdown.len() >= MAX_PROJECT_MARKDOWN_FILES;
    items.extend(markdown);
    Derived {
        items,
        diagnostics: if truncated {
            vec![format!(
                "Only the first {MAX_PROJECT_MARKDOWN_FILES} project Markdown files were indexed."
            )]
        } else {
            Vec::new()
        },
        truncated,
    }
}

/// Every Markdown file under a repository, skipping the directories nobody
/// means and never following a symlink out of the tree.
fn markdown_files(root: &Path, limit: usize) -> Vec<std::path::PathBuf> {
    let mut found = Vec::new();
    walk(root, limit, &mut found);
    found
}

fn walk(directory: &Path, limit: usize, found: &mut Vec<std::path::PathBuf>) {
    if found.len() >= limit {
        return;
    }
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        if found.len() >= limit {
            return;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        if kind.is_dir() {
            if !IGNORED_DIRS.contains(&name.as_str()) {
                walk(&path, limit, found);
            }
        } else if kind.is_file() {
            let extension = path
                .extension()
                .map(|value| value.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if MARKDOWN_EXTENSIONS.contains(&extension.as_str()) {
                found.push(path);
            }
        }
    }
}

/// The graph the page draws: what is visible, and what links it.
pub fn context_graph(
    listing: &ContextListing,
    notes: &[ContextNote],
    config: &Config,
) -> ContextGraph {
    let items = listing.items();
    let mut visible: Vec<&ContextItem> = items.iter().collect();
    visible.sort_by(|left, right| {
        right
            .pinned
            .cmp(&left.pinned)
            .then_with(|| kind_priority(&left.kind).cmp(&kind_priority(&right.kind)))
            .then_with(|| locale_cmp(&left.title, &right.title))
    });
    visible.truncate(MAX_GRAPH_NODES);

    let nodes: Vec<ContextGraphNode> = visible
        .iter()
        .map(|item| ContextGraphNode {
            context_ref: item.context_ref.clone(),
            title: item.title.clone(),
            kind: item.kind.clone(),
            pinned: item.pinned,
        })
        .collect();
    let visible_keys: Vec<String> = nodes
        .iter()
        .map(|node| ref_key(&node.context_ref))
        .collect();
    let is_visible = |reference: &ContextRef| visible_keys.contains(&ref_key(reference));
    let lookup = build_lookup(&items);
    let mut edges = Vec::new();

    let find = |kind: &str, id: &str| {
        items
            .iter()
            .find(|item| item.kind == kind && item.context_ref.id == id)
    };

    for note in notes {
        if !is_visible(&note.item.context_ref) {
            continue;
        }
        for project_path in &note.project_paths {
            if let Some(project) = resolve_project(project_path, &items) {
                if is_visible(&project.context_ref) {
                    edges.push(edge(&note.item, project, "belongs-to"));
                }
            }
        }
        for link in &note.links {
            if let Some(target) = resolve_link(&link.target, &lookup) {
                if is_visible(&target.context_ref) {
                    edges.push(edge(&note.item, target, "wiki"));
                }
            }
        }
    }

    for service in &config.services {
        let Some(item) = items.iter().find(|item| {
            item.kind == "service" && item.context_ref.id.ends_with(&format!(":{}", service.name))
        }) else {
            continue;
        };
        if !is_visible(&item.context_ref) {
            continue;
        }
        let cwd = service.cwd.clone().unwrap_or_default();
        let project_path = service.project_path.clone().or_else(|| {
            config
                .git_repositories
                .iter()
                .find(|repository| cwd.starts_with(&repository.path))
                .map(|repository| repository.path.clone())
        });
        if let Some(project) = project_path
            .as_deref()
            .and_then(|path| find("project", path))
        {
            if is_visible(&project.context_ref) {
                edges.push(edge(item, project, "belongs-to"));
            }
        }
        for dependency in service.depends_on.iter().flatten() {
            let target = items.iter().find(|candidate| {
                candidate.kind == "service"
                    && candidate
                        .context_ref
                        .id
                        .ends_with(&format!(":{dependency}"))
            });
            if let Some(target) = target {
                if is_visible(&target.context_ref) {
                    edges.push(edge(item, target, "depends-on"));
                }
            }
        }
    }

    for file in items.iter().filter(|item| item.kind == "file") {
        if !is_visible(&file.context_ref) {
            continue;
        }
        if let Some(project) = file
            .project_path
            .as_deref()
            .and_then(|path| find("project", path))
        {
            if is_visible(&project.context_ref) {
                edges.push(edge(file, project, "belongs-to"));
            }
        }
    }

    ContextGraph {
        nodes,
        edges,
        truncated: items.len() > MAX_GRAPH_NODES,
    }
}

fn edge(from: &ContextItem, to: &ContextItem, kind: &str) -> ContextGraphEdge {
    ContextGraphEdge {
        from: from.context_ref.clone(),
        to: to.context_ref.clone(),
        kind: kind.to_string(),
    }
}

fn kind_priority(kind: &str) -> usize {
    CONTEXT_KINDS
        .iter()
        .position(|candidate| *candidate == kind)
        .map(|position| match position {
            // note, project, service, file, incident, session → the graph wants
            // project, service, note, incident, session, file.
            0 => 2,
            1 => 0,
            2 => 1,
            3 => 5,
            4 => 3,
            _ => 4,
        })
        .unwrap_or(usize::MAX)
}

/// A wiki link resolves only when it is **unambiguous**: a target that names two
/// items draws no edge at all rather than guessing between them.
fn build_lookup(items: &[ContextItem]) -> HashMap<String, Vec<&ContextItem>> {
    let mut lookup: HashMap<String, Vec<&ContextItem>> = HashMap::new();
    for item in items {
        let keys = [
            item.title.clone(),
            format!("{}:{}", item.kind, item.title),
            ref_key(&item.context_ref),
        ];
        for key in keys.iter().chain(item.aliases.iter()) {
            lookup.entry(key.to_lowercase()).or_default().push(item);
        }
    }
    lookup
}

fn resolve_link<'a>(
    target: &str,
    lookup: &HashMap<String, Vec<&'a ContextItem>>,
) -> Option<&'a ContextItem> {
    match lookup.get(&target.to_lowercase()) {
        Some(matches) if matches.len() == 1 => Some(matches[0]),
        _ => None,
    }
}

fn ref_key(reference: &ContextRef) -> String {
    format!("{}:{}", reference.kind, reference.id)
}

/// `String.prototype.localeCompare`, near enough.
///
/// The listing is ordered with it, and it is **not** byte order: it compares
/// base letters first and only falls back to case when those tie. So `beta
/// lowercase` sorts before `Beta uppercase`, where `str::cmp` would put the
/// capital first because `B` is 66 and `b` is 98. Every title in a typical vault
/// is capitalised, which is exactly why the difference stays invisible until it
/// is not.
fn locale_cmp(left: &str, right: &str) -> Ordering {
    crate::locale::compare(left, right)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(path: &str) -> ContextItem {
        ContextItem {
            context_ref: ContextRef {
                kind: "project".into(),
                id: path.into(),
            },
            title: directory_name(path).unwrap_or(path).into(),
            kind: "project".into(),
            excerpt: None,
            project_path: Some(path.into()),
            path: Some(path.into()),
            updated_at: None,
            tags: Vec::new(),
            aliases: Vec::new(),
            pinned: false,
            editable: false,
        }
    }

    #[test]
    fn an_exact_path_wins_over_any_name_match() {
        let items = vec![
            project("/elsewhere/nomoreide"),
            project("/Users/me/Developer/nomoreide"),
        ];

        let resolved = resolve_project("/Users/me/Developer/nomoreide", &items).unwrap();

        assert_eq!(resolved.context_ref.id, "/Users/me/Developer/nomoreide");
    }

    /// The case that put three notes on the floor: the note records where the
    /// project was when it was written, and the checkout has since moved.
    #[test]
    fn a_moved_checkout_still_resolves_by_directory_name() {
        let items = vec![project("/Users/me/Developer/workspace/nomoreide")];

        let resolved = resolve_project("/Users/me/Downloads/old/nomoreide", &items).unwrap();

        assert_eq!(
            resolved.context_ref.id,
            "/Users/me/Developer/workspace/nomoreide"
        );
    }

    /// Two checkouts called `api` is an ordinary thing to have. Attaching the
    /// note to whichever happens to sort first would be a guess wearing the
    /// clothes of a fact.
    #[test]
    fn an_ambiguous_directory_name_resolves_to_nothing() {
        let items = vec![project("/work/one/api"), project("/work/two/api")];

        assert!(resolve_project("/gone/api", &items).is_none());
    }

    #[test]
    fn a_name_nothing_registers_resolves_to_nothing() {
        let items = vec![project("/work/nomoreide")];

        assert!(resolve_project("/gone/unrelated", &items).is_none());
    }

    #[test]
    fn a_trailing_separator_does_not_change_a_directory_name() {
        assert_eq!(directory_name("/work/nomoreide/"), Some("nomoreide"));
        assert_eq!(directory_name("/work/nomoreide"), Some("nomoreide"));
        assert_eq!(directory_name("/"), None);
        assert_eq!(directory_name(""), None);
    }
}
