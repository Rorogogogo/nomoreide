//! Deduped error and stack-trace incidents detected across managed service logs.
//!
//! The inbox watches the log store and turns repeated noise into a short list
//! of distinct things that are wrong. It belongs to whatever process owns the
//! services — which is the daemon — because an inbox in a process that never
//! sees a log line has nothing in it.

mod detect;

pub use detect::{continues_a_stack, level_of, signature_of, title_of, Frame, Level};

use crate::git_manager::GitManager;
use crate::log_store::LogStore;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};

/// How many distinct incidents are kept. Past this the oldest is dropped: the
/// inbox is a view of what is going wrong now, not a record of everything that
/// ever did — that is what the log files are.
const MAX_INCIDENTS: usize = 100;
/// Lines of context captured with an incident, ending at the line that raised
/// it.
const EXCERPT_WINDOW: usize = 12;
/// Stack frames appended to that context as they arrive. A deeper stack than
/// this is not more informative, and the excerpt is meant to be readable.
const MAX_APPENDED_FRAMES: usize = 12;
/// How much of the service's log a prompt carries beyond the excerpt.
const PROMPT_LOG_LINES: usize = 40;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Incident {
    pub id: u64,
    pub service: String,
    pub level: String,
    pub signature: String,
    /// The first occurrence's wording. Later ones may differ in the details the
    /// signature normalized away; the first is what the incident is named.
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    pub first_seen: DateTime<Utc>,
    pub last_seen: DateTime<Utc>,
    pub count: u64,
    pub log_excerpt: Vec<String>,
}

/// An incident and everything an agent needs to act on it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncidentPrompt {
    pub incident: Incident,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    pub prompt: String,
}

struct Inner {
    incidents: VecDeque<Incident>,
    next_id: u64,
    /// How many frames have been appended to the newest incident of a service,
    /// so a deep stack cannot crowd out the message that opened it.
    appended: HashMap<String, usize>,
    /// The last few lines of each service, kept here rather than read back from
    /// the log store.
    ///
    /// The store calls its listeners while holding its own write lock, so a
    /// listener that read from it would deadlock the thread delivering the
    /// line. Keeping the window here also makes an excerpt a function of what
    /// this inbox saw, which is what it claims to describe.
    windows: HashMap<String, VecDeque<String>>,
}

#[derive(Clone)]
pub struct ErrorInbox {
    inner: Arc<Mutex<Inner>>,
    logs: LogStore,
}

impl ErrorInbox {
    pub fn new(logs: LogStore) -> Self {
        ErrorInbox {
            inner: Arc::new(Mutex::new(Inner {
                incidents: VecDeque::new(),
                next_id: 1,
                appended: HashMap::new(),
                windows: HashMap::new(),
            })),
            logs,
        }
    }

    /// Start watching the log store this inbox was built over.
    ///
    /// Separate from `new` because a subscription outlives the value that made
    /// it: the store holds the closure, so subscribing inside a constructor
    /// would let a temporary inbox keep feeding one nothing reads.
    pub fn watch(&self) {
        let inbox = self.clone();
        self.logs.subscribe(move |entry| {
            inbox.observe(&entry.service, &entry.text, entry.timestamp);
        });
    }

    /// Take one log line into account.
    ///
    /// Called from the log store's own listener, so it must not read the store
    /// back — everything it needs about the lines before this one is already in
    /// the window kept here.
    pub fn observe(&self, service: &str, text: &str, at: DateTime<Utc>) {
        let mut inner = self.inner.lock().unwrap();
        let window = inner.windows.entry(service.to_string()).or_default();
        window.push_back(text.to_string());
        while window.len() > EXCERPT_WINDOW {
            window.pop_front();
        }
        match detect::level_of(text) {
            Some(level) => record(&mut inner, service, text, level, at),
            // Not an incident of its own, but a stack frame belongs to
            // whichever incident is already open for this service.
            None => attach_continuation(&mut inner, service, text, at),
        }
    }

    /// The most recently active incidents first, at most `limit` of them.
    pub fn list(&self, limit: usize) -> Vec<Incident> {
        let inner = self.inner.lock().unwrap();
        let mut incidents: Vec<Incident> = inner.incidents.iter().cloned().collect();
        // Newest activity first, and ties broken by id so two incidents that
        // arrived within the same millisecond still order deterministically.
        incidents.sort_by(|left, right| {
            right
                .last_seen
                .cmp(&left.last_seen)
                .then(right.id.cmp(&left.id))
        });
        incidents.truncate(limit);
        incidents
    }

    /// Assemble the debugging prompt for one incident, or nothing when no such
    /// incident is held.
    pub async fn build_prompt(&self, id: u64) -> Option<IncidentPrompt> {
        let incident = self.get(id)?;
        let logs = self.recent_lines(&incident.service, PROMPT_LOG_LINES);
        let diff = match &incident.file {
            Some(file) => working_diff(file).await,
            None => None,
        };
        let prompt = render_prompt(&incident, diff.as_deref(), &logs);
        Some(IncidentPrompt {
            file: incident.file.clone(),
            incident,
            prompt,
        })
    }

    fn get(&self, id: u64) -> Option<Incident> {
        let inner = self.inner.lock().unwrap();
        inner
            .incidents
            .iter()
            .find(|incident| incident.id == id)
            .cloned()
    }

    /// Read from the log store, which is safe here: a prompt is assembled from
    /// a request handler, never from the store's own listener.
    fn recent_lines(&self, service: &str, limit: usize) -> Vec<String> {
        self.logs
            .read(service, limit)
            .into_iter()
            .map(|entry| entry.text)
            .collect()
    }
}

fn record(inner: &mut Inner, service: &str, text: &str, level: Level, at: DateTime<Utc>) {
    let title = detect::title_of(text);
    let signature = detect::signature_of(service, text);
    let excerpt: Vec<String> = inner
        .windows
        .get(service)
        .map(|window| window.iter().cloned().collect())
        .unwrap_or_default();
    let frame = detect::last_frame(&excerpt);

    // A new message ends whatever stack was being appended to the last one.
    inner.appended.insert(service.to_string(), 0);
    if let Some(existing) = inner
        .incidents
        .iter_mut()
        .find(|incident| incident.signature == signature)
    {
        existing.count += 1;
        existing.last_seen = at;
        existing.log_excerpt = excerpt;
        if existing.file.is_none() {
            if let Some(frame) = frame {
                existing.file = Some(frame.file);
                existing.line = Some(frame.line);
            }
        }
        return;
    }

    let id = inner.next_id;
    inner.next_id += 1;
    inner.incidents.push_back(Incident {
        id,
        service: service.to_string(),
        level: level.as_str().to_string(),
        signature,
        title,
        file: frame.as_ref().map(|frame| frame.file.clone()),
        line: frame.map(|frame| frame.line),
        first_seen: at,
        last_seen: at,
        count: 1,
        log_excerpt: excerpt,
    });
    while inner.incidents.len() > MAX_INCIDENTS {
        inner.incidents.pop_front();
    }
}

/// A stack frame that followed an incident joins it, and points it at a file if
/// nothing had yet. It never overwrites one: the first frame after the message
/// is the innermost, which is where the fault is.
///
/// A continuation joins the excerpt whether or not it resolves to a file — a
/// stack printed with holes in it is harder to read than one with frames this
/// cannot place.
fn attach_continuation(inner: &mut Inner, service: &str, text: &str, at: DateTime<Utc>) {
    if !detect::continues_a_stack(text) {
        return;
    }
    let frame = detect::frame_in(text);
    let appended = inner.appended.get(service).copied().unwrap_or(0);
    if appended >= MAX_APPENDED_FRAMES {
        return;
    }
    let Some(incident) = inner
        .incidents
        .iter_mut()
        .filter(|incident| incident.service == service)
        .next_back()
    else {
        return;
    };
    incident.log_excerpt.push(text.to_string());
    incident.last_seen = at;
    if incident.file.is_none() {
        if let Some(frame) = frame {
            incident.file = Some(frame.file);
            incident.line = Some(frame.line);
        }
    }
    inner.appended.insert(service.to_string(), appended + 1);
}

/// The uncommitted changes to one file, when it is in a repository and has any.
/// A file outside a repository, or one git has nothing to say about, adds no
/// section rather than an empty one.
async fn working_diff(file: &str) -> Option<String> {
    let directory = Path::new(file).parent()?.to_str()?.to_string();
    let diff = GitManager::diff(&directory, Some(file)).await.ok()?;
    let diff = diff.trim_end();
    (!diff.is_empty()).then(|| diff.to_string())
}

fn render_prompt(incident: &Incident, diff: Option<&str>, logs: &[String]) -> String {
    let mut prompt = format!(
        "I hit an error in my **{}** service. Help me fix it.\n\n## Error\n```\n{}\n```\n",
        incident.service,
        incident.log_excerpt.join("\n")
    );
    if let Some(file) = &incident.file {
        let line = incident
            .line
            .map(|line| format!(" (line {line})"))
            .unwrap_or_default();
        prompt.push_str(&format!("\nAffected file: `{file}`{line}\n"));
    }
    if let Some(diff) = diff {
        prompt.push_str(&format!(
            "\n## Current diff of the affected file\n```diff\n{diff}\n```\n"
        ));
    }
    // No trailing newline: the prompt ends at its last fence, because it is
    // pasted into a conversation rather than written to a file.
    prompt.push_str(&format!(
        "\n## Last {} log lines from {}\n```\n{}\n```",
        logs.len(),
        incident.service,
        logs.join("\n")
    ));
    prompt
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inbox() -> ErrorInbox {
        ErrorInbox::new(LogStore::new(
            std::env::temp_dir().join("nomoreide-inbox-tests"),
        ))
    }

    fn at(second: u32) -> DateTime<Utc> {
        DateTime::from_timestamp(1_700_000_000 + i64::from(second), 0).expect("valid instant")
    }

    #[test]
    fn one_fault_repeated_is_one_incident() {
        let inbox = inbox();
        inbox.observe("api", "Error: id 1 failed", at(0));
        inbox.observe("api", "Error: id 2 failed", at(1));
        inbox.observe("api", "Error: id 3 failed", at(2));
        let listed = inbox.list(50);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].count, 3);
        // Named by the first occurrence, not the latest.
        assert_eq!(listed[0].title, "Error: id 1 failed");
    }

    #[test]
    fn the_same_message_from_two_services_is_two_incidents() {
        let inbox = inbox();
        inbox.observe("api", "Error: shared", at(0));
        inbox.observe("web", "Error: shared", at(1));
        assert_eq!(inbox.list(50).len(), 2);
    }

    #[test]
    fn a_frame_after_the_message_points_it_at_a_file_and_the_first_one_wins() {
        let inbox = inbox();
        inbox.observe("api", "Error: deep", at(0));
        inbox.observe("api", "    at inner (/tmp/app.js:3:1)", at(1));
        inbox.observe("api", "    at outer (/tmp/app.js:9:1)", at(2));
        let listed = inbox.list(50);
        assert_eq!(listed[0].file.as_deref(), Some("/tmp/app.js"));
        assert_eq!(listed[0].line, Some(3));
        assert_eq!(listed[0].log_excerpt.len(), 3);
    }

    #[test]
    fn a_frame_already_in_the_window_points_a_later_incident_at_a_file() {
        let inbox = inbox();
        inbox.observe("api", "Error: first", at(0));
        inbox.observe("api", "    at h (/tmp/app.js:4:1)", at(1));
        inbox.observe("api", "Error: second", at(2));
        let second = inbox
            .list(50)
            .into_iter()
            .find(|incident| incident.title == "Error: second")
            .expect("the second incident");
        assert_eq!(second.line, Some(4));
    }

    #[test]
    fn a_deep_stack_cannot_crowd_out_the_message_that_opened_it() {
        let inbox = inbox();
        inbox.observe("api", "Error: very deep", at(0));
        for depth in 0..30 {
            inbox.observe(
                "api",
                &format!("    at f{depth} (/tmp/app.js:{}:1)", depth + 1),
                at(1),
            );
        }
        assert_eq!(inbox.list(50)[0].log_excerpt.len(), 1 + MAX_APPENDED_FRAMES);
    }

    #[test]
    fn the_context_window_ends_at_the_line_that_raised_it() {
        let inbox = inbox();
        for index in 0..20 {
            inbox.observe("api", &format!("noise {index}"), at(0));
        }
        inbox.observe("api", "Error: at the end", at(1));
        let excerpt = &inbox.list(50)[0].log_excerpt;
        assert_eq!(excerpt.len(), EXCERPT_WINDOW);
        assert_eq!(
            excerpt.last().map(String::as_str),
            Some("Error: at the end")
        );
    }

    #[test]
    fn the_oldest_incident_is_dropped_once_the_cap_is_reached() {
        let inbox = inbox();
        for index in 0..MAX_INCIDENTS + 5 {
            inbox.observe("api", &format!("Error: shape {index}x"), at(index as u32));
        }
        let listed = inbox.list(200);
        assert_eq!(listed.len(), MAX_INCIDENTS);
        assert!(listed.iter().all(|incident| incident.id > 5));
    }

    #[test]
    fn the_listing_is_ordered_by_most_recent_activity() {
        let inbox = inbox();
        inbox.observe("api", "Error: older", at(0));
        inbox.observe("api", "Error: newer", at(1));
        inbox.observe("api", "Error: older", at(2));
        let listed = inbox.list(50);
        assert_eq!(listed[0].title, "Error: older");
        assert_eq!(listed[1].title, "Error: newer");
    }

    #[test]
    fn a_prompt_without_a_file_carries_neither_the_file_nor_a_diff() {
        let incident = Incident {
            id: 1,
            service: "api".into(),
            level: "error".into(),
            signature: "api error: bare".into(),
            title: "Error: bare".into(),
            file: None,
            line: None,
            first_seen: at(0),
            last_seen: at(0),
            count: 1,
            log_excerpt: vec!["Error: bare".into()],
        };
        let prompt = render_prompt(&incident, None, &["Error: bare".to_string()]);
        assert!(!prompt.contains("Affected file"));
        assert!(!prompt.contains("```diff"));
        assert!(prompt.contains("## Last 1 log lines from api"));
        assert!(prompt.ends_with("```"), "a prompt ends at its last fence");
    }
}
