use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::time::sleep;

use super::process_manager::service_path;

const SEARCH_URL: &str = "https://skills.sh/api/search";
const SKILLS_CLI_VERSION: &str = "1.5.20";
const SEARCH_LIMIT: usize = 6;
const MAX_SEARCH_BYTES: usize = 256 * 1024;
const MAX_SKILL_PROMPT_BYTES: usize = 256 * 1024;
const MAX_COMBINED_PROMPT_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OneTimeSkillSelection {
    pub name: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSkillResult {
    id: String,
    name: String,
    source: String,
    use_source: String,
    installs: u64,
    url: String,
}

#[derive(Deserialize)]
struct SearchPayload {
    skills: Vec<SearchEntry>,
}

#[derive(Deserialize)]
struct SearchEntry {
    id: String,
    name: String,
    source: String,
    installs: Option<f64>,
}

fn valid_segment(value: &str, max: usize, allow_colon: bool) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.chars().enumerate().all(|(index, character)| {
            character.is_ascii_alphanumeric()
                || (index > 0
                    && (character == '.'
                        || character == '_'
                        || character == '-'
                        || (allow_colon && character == ':')))
        })
}

fn valid_repository(value: &str) -> bool {
    let mut parts = value.split('/');
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(owner), Some(repo), None)
            if valid_segment(owner, 100, false) && valid_segment(repo, 100, false)
    )
}

fn selector_for<'a>(id: &'a str, source: &str) -> Option<&'a str> {
    let selector = id.strip_prefix(&format!("{source}/"))?;
    valid_segment(selector, 200, true).then_some(selector)
}

fn normalize_search(payload: SearchPayload) -> Vec<RemoteSkillResult> {
    payload
        .skills
        .into_iter()
        .filter_map(|entry| {
            if !valid_repository(&entry.source) {
                return None;
            }
            let selector = selector_for(&entry.id, &entry.source)?.to_string();
            Some(RemoteSkillResult {
                url: format!("https://skills.sh/{}", entry.id),
                use_source: format!("{}@{selector}", entry.source),
                installs: entry.installs.unwrap_or(0.0).max(0.0) as u64,
                id: entry.id,
                name: entry.name.chars().take(200).collect(),
                source: entry.source,
            })
        })
        .take(SEARCH_LIMIT)
        .collect()
}

pub async fn search_remote_skills(raw_query: &str) -> Result<Vec<RemoteSkillResult>, String> {
    let query = raw_query.trim();
    if !(2..=100).contains(&query.len()) {
        return Err("Skill search must be 2–100 characters.".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| error.to_string())?;
    let mut response = client
        .get(SEARCH_URL)
        .query(&[("q", query), ("limit", &SEARCH_LIMIT.to_string())])
        .send()
        .await
        .map_err(|error| format!("Could not search skills.sh: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "skills.sh search failed with HTTP {}.",
            response.status().as_u16()
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Could not read skills.sh response: {error}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_SEARCH_BYTES {
            return Err("skills.sh returned too much search data.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let payload: SearchPayload = serde_json::from_slice(&bytes)
        .map_err(|_| "skills.sh returned an invalid search result.".to_string())?;
    Ok(normalize_search(payload))
}

fn validate_selection(selection: &OneTimeSkillSelection) -> Result<(), String> {
    let (repository, selector) = selection
        .source
        .rsplit_once('@')
        .ok_or_else(|| "The selected skill source is invalid.".to_string())?;
    if !valid_repository(repository)
        || !valid_segment(selector, 200, true)
        || selection.name.trim().is_empty()
        || selection.name.len() > 200
    {
        return Err("The selected skill source is invalid.".into());
    }
    Ok(())
}

async fn read_limited<R>(mut reader: R, maximum: usize) -> Result<Vec<u8>, ()>
where
    R: AsyncRead + Unpin,
{
    let mut collected = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader.read(&mut buffer).await.map_err(|_| ())?;
        if read == 0 {
            return Ok(collected);
        }
        if collected.len().saturating_add(read) > maximum {
            return Err(());
        }
        collected.extend_from_slice(&buffer[..read]);
    }
}

pub async fn resolve_one_time_skill(selection: &OneTimeSkillSelection) -> Result<String, String> {
    validate_selection(selection)?;
    let executable = if cfg!(windows) { "npx.cmd" } else { "npx" };
    let mut command = Command::new(executable);
    command
        .args([
            "--yes",
            &format!("skills@{SKILLS_CLI_VERSION}"),
            "use",
            &selection.source,
        ])
        .env("PATH", service_path())
        .env("CI", "1")
        .env("NO_COLOR", "1")
        .env("npm_config_yes", "true")
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "Node.js and npm are required to use a temporary skill.".to_string()
        } else {
            format!("The temporary skill could not be loaded: {error}")
        }
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "The temporary skill could not be loaded.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "The temporary skill could not be loaded.".to_string())?;
    let mut stdout_task = tokio::spawn(read_limited(stdout, MAX_SKILL_PROMPT_BYTES));
    let mut stderr_task = tokio::spawn(read_limited(stderr, MAX_SKILL_PROMPT_BYTES));
    let mut deadline = Box::pin(sleep(Duration::from_secs(60)));
    let mut stdout_bytes = None;
    let mut stderr_bytes = None;
    let status = loop {
        tokio::select! {
            result = &mut stdout_task, if stdout_bytes.is_none() => {
                match result {
                    Ok(Ok(bytes)) => stdout_bytes = Some(bytes),
                    _ => {
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                        stderr_task.abort();
                        return Err("The temporary skill output is too large or invalid.".into());
                    }
                }
            }
            result = &mut stderr_task, if stderr_bytes.is_none() => {
                match result {
                    Ok(Ok(bytes)) => stderr_bytes = Some(bytes),
                    _ => {
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                        stdout_task.abort();
                        return Err("The temporary skill output is too large or invalid.".into());
                    }
                }
            }
            status = child.wait() => {
                break status.map_err(|error| format!("The temporary skill could not be loaded: {error}"))?;
            }
            _ = &mut deadline => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                stdout_task.abort();
                stderr_task.abort();
                return Err("Loading the temporary skill timed out.".into());
            }
        }
    };
    let stdout = match stdout_bytes {
        Some(bytes) => bytes,
        None => stdout_task
            .await
            .map_err(|_| "The temporary skill returned invalid output.".to_string())?
            .map_err(|_| "The temporary skill output is too large or invalid.".to_string())?,
    };
    let stderr = match stderr_bytes {
        Some(bytes) => bytes,
        None => stderr_task
            .await
            .map_err(|_| "The temporary skill returned invalid output.".to_string())?
            .map_err(|_| "The temporary skill output is too large or invalid.".to_string())?,
    };
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "The temporary skill could not be loaded.".into()
        } else {
            detail
        });
    }
    let prompt = String::from_utf8(stdout)
        .map_err(|_| "The temporary skill returned invalid text.".to_string())?;
    if prompt.trim().is_empty() {
        return Err("The skills CLI returned an empty skill.".into());
    }
    Ok(prompt)
}

pub fn compose_one_time_skill_prompt(
    skill_prompt: &str,
    user_prompt: &str,
) -> Result<String, String> {
    let combined = format!(
        "{}\n\nUser's request:\n{user_prompt}",
        skill_prompt.trim_end()
    );
    if combined.len() > MAX_COMBINED_PROMPT_BYTES {
        return Err("The temporary skill and task are too large to send together.".into());
    }
    Ok(combined)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_public_search_results() {
        let results = normalize_search(SearchPayload {
            skills: vec![SearchEntry {
                id: "vercel-labs/skills/find-skills".into(),
                name: "find-skills".into(),
                source: "vercel-labs/skills".into(),
                installs: Some(42.0),
            }],
        });
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].use_source, "vercel-labs/skills@find-skills");
    }

    #[test]
    fn validates_and_composes_a_temporary_skill() {
        let selection = OneTimeSkillSelection {
            name: "find-skills".into(),
            source: "vercel-labs/skills@find-skills".into(),
        };
        assert!(validate_selection(&selection).is_ok());
        assert_eq!(
            compose_one_time_skill_prompt("Skill instructions\n", "Find one").unwrap(),
            "Skill instructions\n\nUser's request:\nFind one"
        );
    }

    #[test]
    fn rejects_option_like_or_non_repository_sources() {
        for source in ["--help", "repo@skill", "owner/repo@--help"] {
            let selection = OneTimeSkillSelection {
                name: "bad".into(),
                source: source.into(),
            };
            assert!(validate_selection(&selection).is_err());
        }
    }
}
