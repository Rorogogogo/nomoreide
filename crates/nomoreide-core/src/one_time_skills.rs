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

/// A search failure, with the code the HTTP surface reports beside it.
///
/// `search_remote_skills` keeps returning a bare message so its other callers
/// are unchanged; the daemon needs the code because it decides the status —
/// a query this rejected is the caller's fault, a timeout is the upstream's.
#[derive(Debug, Clone)]
pub struct SkillSearchFailure {
    pub code: &'static str,
    pub message: String,
}

impl SkillSearchFailure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub async fn search_remote_skills(raw_query: &str) -> Result<Vec<RemoteSkillResult>, String> {
    search_remote_skills_detailed(raw_query)
        .await
        .map_err(|failure| failure.message)
}

pub async fn search_remote_skills_detailed(
    raw_query: &str,
) -> Result<Vec<RemoteSkillResult>, SkillSearchFailure> {
    let query = raw_query.trim();
    // UTF-16 code units, because the reference counts a JavaScript string's
    // `length` — a single wide character is one unit and three bytes, and
    // counting bytes would let it through to the network.
    if !(2..=100).contains(&query.encode_utf16().count()) {
        return Err(SkillSearchFailure::new(
            "invalid_query",
            "Skill search must be 2–100 characters.",
        ));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| SkillSearchFailure::new("invalid_response", error.to_string()))?;
    let mut response = client
        .get(SEARCH_URL)
        .query(&[("q", query), ("limit", &SEARCH_LIMIT.to_string())])
        .send()
        .await
        .map_err(|error| {
            // reqwest folds its own deadline into the transport error, so a
            // timeout is recognised here rather than raised separately.
            let code = if error.is_timeout() {
                "timeout"
            } else {
                "invalid_response"
            };
            let message = if error.is_timeout() {
                "Skill search timed out.".to_string()
            } else {
                format!("Could not search skills.sh: {error}")
            };
            SkillSearchFailure::new(code, message)
        })?;
    if !response.status().is_success() {
        return Err(SkillSearchFailure::new(
            "invalid_response",
            format!(
                "skills.sh search failed with HTTP {}.",
                response.status().as_u16()
            ),
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        SkillSearchFailure::new(
            "invalid_response",
            format!("Could not read skills.sh response: {error}"),
        )
    })? {
        if bytes.len().saturating_add(chunk.len()) > MAX_SEARCH_BYTES {
            return Err(SkillSearchFailure::new(
                "invalid_response",
                "skills.sh returned too much search data.",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let payload: SearchPayload = serde_json::from_slice(&bytes).map_err(|_| {
        SkillSearchFailure::new(
            "invalid_response",
            "skills.sh returned an invalid search result.",
        )
    })?;
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
        || selection.name.encode_utf16().count() > 200
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

    fn selection(name: &str, source: &str) -> OneTimeSkillSelection {
        OneTimeSkillSelection {
            name: name.to_string(),
            source: source.to_string(),
        }
    }

    /// Unit-tested rather than gated, because the parity gate cannot reach it.
    ///
    /// `@` belongs to neither the repository charset nor the selector charset,
    /// so a source carrying two of them is refused whichever end it splits at,
    /// and both refusals read identically over HTTP. The only input that would
    /// tell the two splits apart is one where a split *succeeds* — which
    /// reaches a subprocess, and a gate must not do that. So the direction is
    /// fixed here instead.
    #[test]
    fn the_source_splits_at_its_last_separator() {
        assert!(validate_selection(&selection("x", "owner@inner/repo@s")).is_err());
        assert!(validate_selection(&selection("x", "owner/repo@some-skill")).is_ok());
        // A selector may hold a colon, so the split must not stop at one.
        assert!(validate_selection(&selection("x", "owner/repo@group:skill")).is_ok());
    }

    /// Also unreachable through HTTP: the route's schema caps a name at two
    /// hundred UTF-16 units before the validator sees it, so this limit only
    /// guards the desktop app's own call into the same function.
    #[test]
    fn a_name_is_measured_in_utf16_units_not_bytes() {
        // A hundred wide characters: three hundred bytes, one hundred units.
        let wide = "\u{4e2d}".repeat(100);
        assert!(validate_selection(&selection(&wide, "owner/repo@s")).is_ok());
        assert!(validate_selection(&selection(&"\u{4e2d}".repeat(201), "owner/repo@s")).is_err());
        assert!(validate_selection(&selection(&"n".repeat(200), "owner/repo@s")).is_ok());
        assert!(validate_selection(&selection(&"n".repeat(201), "owner/repo@s")).is_err());
        assert!(validate_selection(&selection("   ", "owner/repo@s")).is_err());
    }

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
