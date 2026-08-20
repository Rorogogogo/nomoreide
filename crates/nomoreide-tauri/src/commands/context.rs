use serde::Deserialize;
use serde_json::{json, Value};
use tauri::State;

use crate::AppState;
use nomoreide_core::agent_transcripts::{list_agent_transcripts, DEFAULT_TRANSCRIPT_LIMIT};
use nomoreide_core::context_library::{
    ContextAttachment, ContextItem, ContextLibrary, ContextNote, ContextPreview, ContextRef,
    ContextSnapshot, CreateContextNote, UpdateContextNote,
};

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextQuery {
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    project_path: Option<String>,
    #[serde(default)]
    kinds: Option<Vec<String>>,
}

async fn snapshot(
    state: &State<'_, AppState>,
    query: &ContextQuery,
) -> Result<ContextSnapshot, String> {
    let library = ContextLibrary::default();
    let pinned = library.pinned()?;
    let pinned_keys: std::collections::HashSet<_> = pinned.iter().map(ref_key).collect();
    let config = state
        .config_store
        .load()
        .await
        .map_err(|error| error.to_string())?;
    let notes = library.notes()?;
    let note_projects: std::collections::HashMap<_, _> = notes
        .iter()
        .map(|note| (note.item.context_ref.id.clone(), note.project_paths.clone()))
        .collect();
    let mut items = all_context_items(&config, &notes).await?;
    for item in &mut items {
        item.pinned = pinned_keys.contains(&ref_key(&item.context_ref));
    }
    let q = query
        .q
        .as_ref()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());
    items.retain(|item| {
        query
            .kinds
            .as_ref()
            .map_or(true, |kinds| kinds.contains(&item.kind))
            && query.project_path.as_ref().map_or(true, |path| {
                item.project_path.as_ref() == Some(path)
                    || (item.kind == "note"
                        && note_projects
                            .get(&item.context_ref.id)
                            .is_some_and(|projects| projects.contains(path)))
            })
            && q.as_ref().map_or(true, |q| {
                item.title.to_lowercase().contains(q)
                    || item
                        .excerpt
                        .as_ref()
                        .is_some_and(|value| value.to_lowercase().contains(q))
            })
    });
    items.sort_by(|left, right| left.title.to_lowercase().cmp(&right.title.to_lowercase()));
    Ok(ContextSnapshot {
        vault_path: library.vault_path(),
        items,
        pinned,
        diagnostics: Vec::new(),
        truncated: notes.len() >= 2_000,
    })
}

pub(crate) async fn all_context_items(
    config: &nomoreide_core::config::Config,
    notes: &[ContextNote],
) -> Result<Vec<ContextItem>, String> {
    let mut items: Vec<ContextItem> = notes.iter().map(|note| note.item.clone()).collect();
    items.extend(config.git_repositories.iter().map(|repo| {
        ContextItem {
            context_ref: ContextRef {
                kind: "project".into(),
                id: repo.path.clone(),
            },
            title: repo.name.clone(),
            kind: "project".into(),
            excerpt: Some(
                repo.active_worktree_path
                    .clone()
                    .unwrap_or_else(|| repo.path.clone()),
            ),
            project_path: Some(repo.path.clone()),
            path: Some(repo.path.clone()),
            updated_at: None,
            tags: Vec::new(),
            aliases: Vec::new(),
            pinned: false,
            editable: false,
        }
    }));
    items.extend(config.services.iter().map(|service| {
        let cwd = service.cwd.clone().unwrap_or_default();
        let project_path = config
            .git_repositories
            .iter()
            .find(|repo| cwd.starts_with(&repo.path))
            .map(|repo| repo.path.clone());
        ContextItem {
            context_ref: ContextRef {
                kind: "service".into(),
                id: format!(
                    "{}:{}",
                    project_path.clone().unwrap_or_else(|| "workspace".into()),
                    service.name
                ),
            },
            title: service.name.clone(),
            kind: "service".into(),
            excerpt: Some(format!(
                "{} · {}",
                service.effective_kind(),
                service.command.clone().unwrap_or_else(|| cwd.clone())
            )),
            project_path,
            path: Some(cwd),
            updated_at: None,
            tags: Vec::new(),
            aliases: Vec::new(),
            pinned: false,
            editable: false,
        }
    }));
    let home = dirs::home_dir().ok_or_else(|| "Home directory is unavailable".to_string())?;
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    let transcripts = tauri::async_runtime::spawn_blocking(move || {
        list_agent_transcripts(&home, &codex_home, None, DEFAULT_TRANSCRIPT_LIMIT)
    })
    .await
    .map_err(|error| error.to_string())?;
    items.extend(transcripts.into_iter().map(|session| ContextItem {
        context_ref: ContextRef {
            kind: "session".into(),
            id: format!("{}:{}", session.provider, session.id),
        },
        title: session.title,
        kind: "session".into(),
        excerpt: Some(session.cwd.clone()),
        project_path: Some(session.cwd),
        path: None,
        updated_at: Some(session.updated_at),
        tags: vec![session.provider],
        aliases: Vec::new(),
        pinned: false,
        editable: false,
    }));
    Ok(items)
}

#[tauri::command]
pub async fn list_context(
    state: State<'_, AppState>,
    query: Option<ContextQuery>,
) -> Result<ContextSnapshot, String> {
    snapshot(&state, &query.unwrap_or_default()).await
}

#[tauri::command]
pub async fn get_context_note(id: String) -> Result<ContextNote, String> {
    ContextLibrary::default().get_note(&id)
}

#[tauri::command]
pub async fn create_context_note(input: CreateContextNote) -> Result<ContextNote, String> {
    ContextLibrary::default().create_note(input)
}

#[tauri::command]
pub async fn update_context_note(
    id: String,
    input: UpdateContextNote,
) -> Result<ContextNote, String> {
    ContextLibrary::default().update_note(&id, input)
}

#[tauri::command]
pub async fn delete_context_note(id: String, revision: String) -> Result<(), String> {
    ContextLibrary::default().delete_note(&id, &revision)
}

#[tauri::command]
pub async fn set_context_pins(refs: Vec<ContextRef>) -> Result<Vec<ContextRef>, String> {
    ContextLibrary::default().set_pinned(refs)
}

#[tauri::command]
pub async fn preview_context(
    state: State<'_, AppState>,
    attachment: ContextAttachment,
    project_path: Option<String>,
) -> Result<ContextPreview, String> {
    let snapshot = snapshot(&state, &ContextQuery::default()).await?;
    let mut preview = ContextLibrary::default().preview(&attachment, &snapshot.items)?;
    if let Some(project_path) = project_path {
        for item in &preview.resolved {
            if item.kind != "note"
                && item
                    .project_path
                    .as_deref()
                    .is_some_and(|path| path != project_path)
            {
                preview
                    .warnings
                    .push(format!("{} belongs to another project.", item.title));
            }
        }
    }
    Ok(preview)
}

#[tauri::command]
pub async fn get_context_graph(
    state: State<'_, AppState>,
    query: Option<ContextQuery>,
) -> Result<Value, String> {
    let snapshot = snapshot(&state, &query.unwrap_or_default()).await?;
    let library = ContextLibrary::default();
    let notes = library.notes()?;
    let nodes: Vec<_> = snapshot.items.iter().take(250).map(|item| json!({
        "ref": item.context_ref, "title": item.title, "kind": item.kind, "pinned": item.pinned
    })).collect();
    let visible: std::collections::HashSet<_> = snapshot
        .items
        .iter()
        .take(250)
        .map(|item| ref_key(&item.context_ref))
        .collect();
    let mut edges = Vec::new();
    for note in notes {
        if !visible.contains(&ref_key(&note.item.context_ref)) {
            continue;
        }
        for path in note.project_paths {
            let target = ContextRef {
                kind: "project".into(),
                id: path,
            };
            if visible.contains(&ref_key(&target)) {
                edges.push(
                    json!({ "from": note.item.context_ref, "to": target, "type": "belongs-to" }),
                );
            }
        }
        for link in note.links {
            if let Some(target) = snapshot.items.iter().find(|item| {
                item.title.eq_ignore_ascii_case(&link.target)
                    || item
                        .aliases
                        .iter()
                        .any(|alias| alias.eq_ignore_ascii_case(&link.target))
            }) {
                if visible.contains(&ref_key(&target.context_ref)) {
                    edges.push(json!({ "from": note.item.context_ref, "to": target.context_ref, "type": "wiki" }));
                }
            }
        }
    }
    let config = state
        .config_store
        .load()
        .await
        .map_err(|error| error.to_string())?;
    for service in &config.services {
        let Some(source) = snapshot.items.iter().find(|item| {
            item.kind == "service" && item.context_ref.id.ends_with(&format!(":{}", service.name))
        }) else {
            continue;
        };
        for dependency in service.depends_on.as_deref().unwrap_or_default() {
            if let Some(target) = snapshot.items.iter().find(|item| {
                item.kind == "service" && item.context_ref.id.ends_with(&format!(":{dependency}"))
            }) {
                edges.push(json!({ "from": source.context_ref, "to": target.context_ref, "type": "depends-on" }));
            }
        }
    }
    Ok(json!({ "nodes": nodes, "edges": edges, "truncated": snapshot.items.len() > 250 }))
}

fn ref_key(context_ref: &ContextRef) -> String {
    format!("{}:{}", context_ref.kind, context_ref.id)
}
