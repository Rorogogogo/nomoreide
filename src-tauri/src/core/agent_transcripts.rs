use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

const MAX_HEAD_LINES: usize = 500;
const MAX_CODEX_SCAN: usize = 400;
const MAX_TITLE: usize = 200;
pub const DEFAULT_TRANSCRIPT_LIMIT: usize = 100;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTranscript {
    pub id: String,
    pub provider: String,
    pub cwd: String,
    pub title: String,
    pub started_at: String,
    pub updated_at: String,
}

fn path_key(value: &str) -> String {
    let mut key = String::new();
    let mut separated = true;
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            key.push(character.to_ascii_lowercase());
            separated = false;
        } else if !separated && !key.is_empty() {
            key.push('-');
            separated = true;
        }
    }
    if key.ends_with('-') {
        key.pop();
    }
    key
}

fn title(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('<')
        || trimmed.starts_with("# AGENTS.md instructions for ")
    {
        return None;
    }
    let collapsed = trimmed.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= MAX_TITLE {
        return Some(collapsed);
    }
    let shortened = collapsed.chars().take(MAX_TITLE - 1).collect::<String>();
    Some(format!("{}…", shortened.trim_end()))
}

fn content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect(),
        _ => String::new(),
    }
}

fn modified_at(path: &Path) -> Option<String> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some(DateTime::<Utc>::from(modified).to_rfc3339())
}

fn json_lines(path: &Path) -> impl Iterator<Item = Value> {
    File::open(path)
        .ok()
        .into_iter()
        .flat_map(|file| BufReader::new(file).lines().take(MAX_HEAD_LINES))
        .filter_map(Result::ok)
        .filter_map(|line| serde_json::from_str(&line).ok())
}

fn read_claude(path: &Path, fallback_id: &str) -> Option<AgentTranscript> {
    let mut id = None;
    let mut cwd = None;
    let mut first_prompt = None;
    let mut started_at = None;
    for entry in json_lines(path) {
        if id.is_none() {
            id = entry
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        if cwd.is_none() {
            cwd = entry.get("cwd").and_then(Value::as_str).map(str::to_owned);
        }
        if started_at.is_none() {
            started_at = entry
                .get("timestamp")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        if first_prompt.is_none()
            && entry.get("type").and_then(Value::as_str) == Some("user")
            && entry.get("isSidechain").and_then(Value::as_bool) != Some(true)
        {
            first_prompt = entry
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(|content| title(&content_text(content)));
        }
        if cwd.is_some() && first_prompt.is_some() {
            break;
        }
    }
    let updated_at = modified_at(path)?;
    Some(AgentTranscript {
        id: id.unwrap_or_else(|| fallback_id.to_string()),
        provider: "claude".to_string(),
        cwd: cwd?,
        title: first_prompt?,
        started_at: started_at.unwrap_or_else(|| updated_at.clone()),
        updated_at,
    })
}

/// Codex writes each subagent thread to its own rollout file whose
/// `session_meta` repeats the *parent's* `session_id`. Listing those would show
/// one conversation once per subagent it spawned, all sharing a single id — and
/// resuming any of them just reopens the parent. Claude's reader skips its
/// sidechain turns for the same reason.
fn is_codex_subagent_thread(payload: &Value) -> bool {
    payload.get("thread_source").and_then(Value::as_str) == Some("subagent")
        || payload
            .get("forked_from_id")
            .and_then(Value::as_str)
            .is_some()
        || payload
            .get("parent_thread_id")
            .and_then(Value::as_str)
            .is_some()
}

fn read_codex(path: &Path, expected_cwd: Option<&str>) -> Option<AgentTranscript> {
    let mut id = None;
    let mut cwd = None;
    let mut first_prompt = None;
    let mut started_at = None;
    for entry in json_lines(path) {
        let Some(payload) = entry.get("payload") else {
            continue;
        };
        if entry.get("type").and_then(Value::as_str) == Some("session_meta") {
            if is_codex_subagent_thread(payload) {
                return None;
            }
            id = payload
                .get("session_id")
                .or_else(|| payload.get("id"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            cwd = payload
                .get("cwd")
                .and_then(Value::as_str)
                .map(str::to_owned);
            started_at = payload
                .get("timestamp")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if expected_cwd.is_some() && cwd.as_deref() != expected_cwd {
                return None;
            }
        } else if first_prompt.is_none()
            && payload.get("type").and_then(Value::as_str) == Some("message")
            && payload.get("role").and_then(Value::as_str) == Some("user")
        {
            first_prompt = payload
                .get("content")
                .and_then(|content| title(&content_text(content)));
        }
        if id.is_some() && first_prompt.is_some() {
            break;
        }
    }
    let updated_at = modified_at(path)?;
    Some(AgentTranscript {
        id: id?,
        provider: "codex".to_string(),
        cwd: cwd.filter(|value| expected_cwd.is_none_or(|expected| value == expected))?,
        title: first_prompt?,
        started_at: started_at.unwrap_or_else(|| updated_at.clone()),
        updated_at,
    })
}

/// The session id is what `resume` takes, so two rows carrying the same one are
/// the same conversation however many files it was written to. Only the most
/// recently written copy is kept — a duplicate id is not just a repeated row,
/// it collides in any list keyed by it. Expects newest-first input.
fn dedupe_by_session(transcripts: &mut Vec<AgentTranscript>) {
    let mut seen = HashSet::new();
    transcripts.retain(|transcript| seen.insert(transcript.id.clone()));
}

fn directory_names(path: &Path) -> Vec<String> {
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect()
}

fn codex_files(codex_home: &Path) -> Vec<PathBuf> {
    let root = codex_home.join("sessions");
    let mut files = Vec::new();
    let mut years = directory_names(&root);
    years.sort_by(|a, b| b.cmp(a));
    for year in years {
        let year_path = root.join(year);
        let mut months = directory_names(&year_path);
        months.sort_by(|a, b| b.cmp(a));
        for month in months {
            let month_path = year_path.join(month);
            let mut days = directory_names(&month_path);
            days.sort_by(|a, b| b.cmp(a));
            for day in days {
                let day_path = month_path.join(day);
                let mut names = directory_names(&day_path);
                names.sort_by(|a, b| b.cmp(a));
                files.extend(
                    names
                        .into_iter()
                        .filter(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
                        .map(|name| day_path.join(name)),
                );
                if files.len() >= MAX_CODEX_SCAN {
                    files.truncate(MAX_CODEX_SCAN);
                    return files;
                }
            }
        }
    }
    files
}

pub fn list_agent_transcripts(
    home: &Path,
    codex_home: &Path,
    repo_path: Option<&str>,
    limit_per_provider: usize,
) -> Vec<AgentTranscript> {
    let mut claude = Vec::new();
    let claude_root = home.join(".claude").join("projects");
    let expected_key = repo_path.map(path_key);
    for directory in directory_names(&claude_root).into_iter().filter(|name| {
        expected_key
            .as_ref()
            .is_none_or(|expected| path_key(name) == *expected)
    }) {
        let path = claude_root.join(directory);
        for name in directory_names(&path)
            .into_iter()
            .filter(|name| name.ends_with(".jsonl"))
        {
            if let Some(transcript) =
                read_claude(&path.join(&name), name.trim_end_matches(".jsonl"))
            {
                if repo_path.is_none_or(|expected| transcript.cwd == expected) {
                    claude.push(transcript);
                }
            }
        }
    }
    let mut codex = codex_files(codex_home)
        .iter()
        .filter_map(|path| read_codex(path, repo_path))
        .collect::<Vec<_>>();
    claude.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    codex.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    dedupe_by_session(&mut claude);
    dedupe_by_session(&mut codex);
    claude.truncate(limit_per_provider);
    codex.truncate(limit_per_provider);
    let mut transcripts = claude;
    transcripts.extend(codex);
    transcripts.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    transcripts
}

#[cfg(test)]
mod tests {
    use super::list_agent_transcripts;
    use std::fs;

    #[test]
    fn lists_claude_and_codex_sessions_for_the_requested_repository() {
        let home = std::env::temp_dir().join(format!(
            "nomoreide-agent-transcripts-{}",
            uuid::Uuid::new_v4()
        ));
        let repo = "/tmp/work/repo";
        let claude_dir = home.join(".claude/projects/-tmp-work-repo");
        let codex_dir = home.join(".codex/sessions/2026/07/25");
        fs::create_dir_all(&claude_dir).unwrap();
        fs::create_dir_all(&codex_dir).unwrap();
        fs::write(
            claude_dir.join("dce2b69c-0fb4-4bd3-b456-b2bef4230c81.jsonl"),
            concat!(
                "{\"type\":\"mode\",\"sessionId\":\"dce2b69c-0fb4-4bd3-b456-b2bef4230c81\"}\n",
                "{\"type\":\"user\",\"cwd\":\"/tmp/work/repo\",\"timestamp\":\"2026-07-25T01:00:00Z\",",
                "\"message\":{\"content\":\"Resume the dock\"}}\n"
            ),
        )
        .unwrap();
        fs::write(
            codex_dir.join(
                "rollout-2026-07-25T02-00-00-019f7c82-cb32-73d3-9ffd-7425ddb8dbb4.jsonl",
            ),
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"session_id\":\"019f7c82-cb32-73d3-9ffd-7425ddb8dbb4\",",
                "\"cwd\":\"/tmp/work/repo\",\"timestamp\":\"2026-07-25T02:00:00Z\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",",
                "\"content\":[{\"type\":\"input_text\",\"text\":\"Finish conversation history\"}]}}\n"
            ),
        )
        .unwrap();

        let transcripts = list_agent_transcripts(&home, &home.join(".codex"), Some(repo), 30);

        assert_eq!(transcripts.len(), 2);
        assert!(transcripts
            .iter()
            .any(|row| { row.provider == "claude" && row.title == "Resume the dock" }));
        assert!(transcripts
            .iter()
            .any(|row| { row.provider == "codex" && row.title == "Finish conversation history" }));
        assert_eq!(
            list_agent_transcripts(&home, &home.join(".codex"), Some(repo), 1).len(),
            2,
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn drops_codex_subagent_threads_that_repeat_their_parents_session_id() {
        let home = std::env::temp_dir().join(format!(
            "nomoreide-agent-subagents-{}",
            uuid::Uuid::new_v4()
        ));
        let repo = "/tmp/work/repo";
        let codex_dir = home.join(".codex/sessions/2026/07/25");
        fs::create_dir_all(&codex_dir).unwrap();
        fs::write(
            codex_dir.join("rollout-2026-07-25T02-00-00-parent.jsonl"),
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"session_id\":\"parent\",\"id\":\"parent\",",
                "\"thread_source\":\"user\",\"cwd\":\"/tmp/work/repo\",\"timestamp\":\"2026-07-25T02:00:00Z\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",",
                "\"content\":[{\"type\":\"input_text\",\"text\":\"the real task\"}]}}\n"
            ),
        )
        .unwrap();
        // A subagent thread: its own file and id, but the parent's session_id.
        fs::write(
            codex_dir.join("rollout-2026-07-25T02-05-00-child.jsonl"),
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"session_id\":\"parent\",\"id\":\"child\",",
                "\"forked_from_id\":\"parent\",\"parent_thread_id\":\"parent\",\"thread_source\":\"subagent\",",
                "\"cwd\":\"/tmp/work/repo\",\"timestamp\":\"2026-07-25T02:05:00Z\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",",
                "\"content\":[{\"type\":\"input_text\",\"text\":\"subagent instruction\"}]}}\n"
            ),
        )
        .unwrap();

        let transcripts = list_agent_transcripts(&home, &home.join(".codex"), Some(repo), 30);

        assert_eq!(transcripts.len(), 1);
        assert_eq!(transcripts[0].id, "parent");
        assert_eq!(transcripts[0].title, "the real task");
        fs::remove_dir_all(home).unwrap();
    }
}
