//! The "share my bug" document for one error-inbox incident.
//!
//! The Rust half of `src/core/repro-bundle.ts`. It gathers the incident, the
//! affected file's diff, the recent log, the service's run state and its `.env`
//! into one markdown document a person pastes into a chat — and, on request,
//! writes a copy under `.nomoreide/repros/`.
//!
//! **The document is the contract.** Every heading, every fence and every
//! masked cell is content someone reads, so this renders the reference's
//! wording exactly rather than an equivalent of it.
//!
//! Masking is by key name, not by value: `API_KEY` is hidden, and a
//! `DATABASE_URL` holding a password is not. That is the reference's rule and
//! this reproduces it — see [`crate::env_file::looks_secret`].

use crate::env_file;
use crate::error_inbox::IncidentContext;
use crate::process_manager::ServiceStatus;
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// What a masked value is replaced with: six bullets, not the value's own
/// length, so the document does not leak how long a secret is.
const MASK: &str = "\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReproBundle {
    pub incident_id: u64,
    pub markdown: String,
    /// Where the copy went, when one was asked for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_path: Option<String>,
}

struct MaskedEntry {
    key: String,
    value: String,
    masked: bool,
}

/// Render the bundle for an incident's context, saving a copy under
/// `repro_dir` when asked.
///
/// A save that fails is an error, unlike almost everything else here: the
/// caller asked for the document to be on disk, and answering with a path that
/// nothing is at would be a lie.
pub async fn build(
    context: &IncidentContext,
    status: Option<&ServiceStatus>,
    repro_dir: &Path,
    save: bool,
) -> std::io::Result<ReproBundle> {
    let env = masked_env(&context.service_cwd).await;
    let markdown = render(context, status, &env);
    let mut saved_path = None;
    if save {
        let path = saved_bundle_path(repro_dir, context.incident.id);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&path, &markdown).await?;
        saved_path = Some(path.to_string_lossy().into_owned());
    }
    Ok(ReproBundle {
        incident_id: context.incident.id,
        markdown,
        saved_path,
    })
}

/// `<iso-instant>-incident-<id>.md`, with the instant's colons and dot turned
/// into dashes so the name is a filename on every filesystem.
fn saved_bundle_path(repro_dir: &Path, id: u64) -> PathBuf {
    let stamp = iso(Utc::now()).replace([':', '.'], "-");
    repro_dir.join(format!("{stamp}-incident-{id}.md"))
}

/// The service's `.env`, secrets replaced. A service with no `.env` has no
/// entries, which the document reports rather than omitting.
async fn masked_env(service_cwd: &str) -> Vec<MaskedEntry> {
    let Ok(Some(lines)) = env_file::read(Path::new(service_cwd).join(".env")).await else {
        return Vec::new();
    };
    env_file::entries(&lines)
        .into_iter()
        .map(|entry| {
            let masked = env_file::looks_secret(&entry.key);
            MaskedEntry {
                key: entry.key,
                value: if masked {
                    MASK.to_string()
                } else {
                    entry.value
                },
                masked,
            }
        })
        .collect()
}

fn render(
    context: &IncidentContext,
    status: Option<&ServiceStatus>,
    env: &[MaskedEntry],
) -> String {
    let incident = &context.incident;
    let mut parts: Vec<String> = Vec::new();

    parts.push(format!("# Bug report: {}", incident.title));
    parts.push(String::new());
    parts.push(format!(
        "**Service:** `{}` · **Level:** {} · seen ×{} · first {} · last {}",
        context.service,
        incident.level,
        incident.count,
        iso(incident.first_seen),
        iso(incident.last_seen),
    ));

    parts.push(String::new());
    parts.push("## Error".to_string());
    parts.push("```".to_string());
    parts.extend(incident.log_excerpt.iter().cloned());
    parts.push("```".to_string());

    if let Some(file) = &context.file {
        // A line number of zero is no line number: the reference tests the
        // value for truth, and prints nothing for a falsy one.
        let line = incident
            .line
            .filter(|line| *line != 0)
            .map(|line| format!(" (line {line})"))
            .unwrap_or_default();
        parts.push(String::new());
        parts.push(format!("**Affected file:** `{file}`{line}"));
    }
    if !context.diff.trim().is_empty() {
        parts.push(String::new());
        parts.push("## Diff of the affected file".to_string());
        parts.push("```diff".to_string());
        parts.push(context.diff.trim_end().to_string());
        parts.push("```".to_string());
    }
    if !context.recent_logs.is_empty() {
        parts.push(String::new());
        parts.push(format!("## Last {} log lines", context.recent_logs.len()));
        parts.push("```".to_string());
        parts.extend(context.recent_logs.iter().cloned());
        parts.push("```".to_string());
    }

    parts.push(String::new());
    parts.push("## Service state".to_string());
    parts.extend(render_service_state(&context.service, status));

    parts.push(String::new());
    parts.push("## Environment (`.env`, secrets masked)".to_string());
    parts.push(String::new());
    if env.is_empty() {
        parts.push("_No `.env` file found for this service._".to_string());
    } else {
        parts.push("| Key | Value |".to_string());
        parts.push("| --- | --- |".to_string());
        for entry in env {
            let value = if entry.masked {
                entry.value.clone()
            } else {
                format!("`{}`", entry.value)
            };
            parts.push(format!("| `{}` | {} |", entry.key, value));
        }
    }

    // No trailing newline: the document ends at its last row, and the saved
    // copy is the same bytes as the returned one.
    parts.join("\n")
}

/// What the process manager knows about the service, as bullets.
///
/// A service the manager has never launched has no run state at all, which is
/// said plainly rather than rendered as a row of blanks. Every other field is
/// printed only when it has something in it, so a stopped service does not
/// claim a URL it no longer serves.
fn render_service_state(service: &str, status: Option<&ServiceStatus>) -> Vec<String> {
    let Some(status) = status else {
        return vec![format!(
            "- **{service}** is not currently managed (no run state)."
        )];
    };
    let mut lines = vec![format!("- **State:** {}", status.state.as_str())];
    if !status.kind.is_empty() {
        lines.push(format!("- **Kind:** {}", status.kind));
    }
    if let Some(pid) = status.pid.filter(|pid| *pid != 0) {
        lines.push(format!("- **PID:** {pid}"));
    }
    if let Some(url) = status.url.as_deref().filter(|url| !url.is_empty()) {
        lines.push(format!("- **URL:** {url}"));
    }
    if let Some(started) = status.started_at {
        lines.push(format!("- **Started:** {}", iso(started)));
    }
    if let Some(exited) = status.exited_at {
        lines.push(format!("- **Exited:** {}", iso(exited)));
    }
    // Zero is an exit code, and the one that means it worked — so this tests
    // for presence, not for truth.
    if let Some(code) = status.exit_code {
        lines.push(format!("- **Exit code:** {code}"));
    }
    lines
}

/// The one instant spelling every payload in the daemon uses.
fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}
