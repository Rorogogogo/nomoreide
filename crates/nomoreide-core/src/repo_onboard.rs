//! Cloning a repository from a URL, and the URL parsing that names it.
//!
//! This lives outside `git_manager` on purpose: that module is read-safe and
//! never reaches the network. A clone is additive — it only ever writes a
//! directory that did not exist — so it is guarded here instead of by widening
//! the read-safe surface.

use anyhow::{bail, Result};
use base64::Engine;
use std::path::{Path, PathBuf};
use tokio::process::Command;

/// The schemes a clone URL may use. Anything else is refused by name rather
/// than handed to git, so the caller learns which part of the URL was wrong.
const ALLOWED_SCHEMES: &[&str] = &["http", "https", "ssh", "git", "file"];

/// Schemes whose `//` the URL standard collapses, so `https:///owner/repo`
/// means `https://owner/repo` rather than a URL with no host. `file` is one of
/// them, which is why `file:///path` parses with an empty host.
const SPECIAL_SCHEMES: &[&str] = &["http", "https", "file", "ws", "wss", "ftp"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedRepoUrl {
    /// Sanitised service name derived from the repository path.
    pub name: String,
    /// The URL as given (trimmed), suitable to hand to `git clone`.
    pub normalized_url: String,
    pub owner: Option<String>,
    pub host: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CloneResult {
    pub name: String,
    pub clone_path: String,
    pub url: String,
}

/// Parse https / ssh / scp-style git URLs and derive a safe service name.
pub fn parse_repo_url(input: &str) -> Result<ParsedRepoUrl> {
    let url = input.trim();
    if url.is_empty() {
        bail!("Repository URL is required.");
    }

    let (host, path) = match split_scheme(url) {
        Some((scheme, rest)) => parse_absolute(input, &scheme, rest)?,
        // Not `scheme://…`, so the only remaining shape is git's own
        // `user@host:path`. Anything else is not a URL this can name.
        None => match split_scp_like(url) {
            Some(parts) => parts,
            None => bail!("Unrecognized repository URL: {input}"),
        },
    };

    let segments: Vec<&str> = strip_git_suffix(&path)
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    let Some(repo) = segments.last() else {
        bail!("Repository URL has no path: {input}");
    };
    let owner = if segments.len() >= 2 {
        Some(segments[segments.len() - 2].to_string())
    } else {
        None
    };
    let name = sanitize_name(repo);
    if name.is_empty() {
        bail!("Could not derive a service name from URL: {input}");
    }
    Ok(ParsedRepoUrl {
        name,
        normalized_url: url.to_string(),
        owner,
        host,
    })
}

/// Where onboarded repositories are cloned. Override with `NOMOREIDE_REPOS_DIR`.
pub fn default_repos_dir() -> PathBuf {
    if let Some(override_path) = std::env::var("NOMOREIDE_REPOS_DIR")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return absolute(Path::new(&override_path));
    }
    dirs::home_dir()
        .unwrap_or_default()
        .join(".nomoreide")
        .join("repos")
}

/// Shallow-clone a repository into `dest_root/<name>`. Refuses to overwrite a
/// non-empty destination, and disables interactive credential prompts so a
/// private repository fails fast instead of hanging. When a `github_token` is
/// supplied and the URL is an HTTPS github.com URL, the token authenticates the
/// clone so private GitHub repositories work without SSH keys.
pub async fn clone_repository(
    url: &str,
    dest_root: Option<&Path>,
    github_token: Option<&str>,
) -> Result<CloneResult> {
    let parsed = parse_repo_url(url)?;
    let root = match dest_root {
        Some(root) => root.to_path_buf(),
        None => default_repos_dir(),
    };
    let clone_path = root.join(&parsed.name);
    if is_non_empty_dir(&clone_path).await? {
        bail!(
            "Destination already exists and is not empty: {}. Remove it or pick another repo.",
            clone_path.display()
        );
    }
    tokio::fs::create_dir_all(&root).await?;

    let destination = clone_path.to_string_lossy().into_owned();
    let mut args = github_auth_args(&parsed, github_token);
    args.extend([
        "clone".to_string(),
        "--depth".to_string(),
        "1".to_string(),
        parsed.normalized_url.clone(),
        destination.clone(),
    ]);

    let output = Command::new("git")
        .args(&args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .await
        .map_err(|error| anyhow::anyhow!("{}", spawn_failure(&error)))?;
    if !output.status.success() {
        bail!(
            "{}",
            redact_authorization(&format!(
                "Command failed: git {}\n{}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr)
            ))
        );
    }

    Ok(CloneResult {
        name: parsed.name,
        clone_path: destination,
        url: parsed.normalized_url,
    })
}

/// One-shot git auth header for HTTPS github.com clones, reusing the stored
/// GitHub token. Passed via `git -c` (command-scoped) so it is *not* written
/// into the cloned repository's `.git/config` — the token never lands on disk.
/// No-ops for SSH URLs (which use the host's keys) or any non-github.com host.
fn github_auth_args(parsed: &ParsedRepoUrl, token: Option<&str>) -> Vec<String> {
    let Some(token) = token.filter(|token| !token.is_empty()) else {
        return Vec::new();
    };
    let is_https_github = parsed.normalized_url.len() >= 8
        && parsed.normalized_url[..8].eq_ignore_ascii_case("https://")
        && parsed.host.as_deref() == Some("github.com");
    if !is_https_github {
        return Vec::new();
    }
    let basic = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
    vec![
        "-c".to_string(),
        format!("http.https://github.com/.extraheader=Authorization: Basic {basic}"),
    ]
}

/// Git's failure text names the command that failed, and the command carries
/// the credential header. Blank the encoded value on the way out: an agent
/// reads this message, and a base64 blob is a token to anyone who decodes it.
fn redact_authorization(text: &str) -> String {
    const MARKER: &str = "extraheader=Authorization: Basic ";
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(MARKER) {
        let (before, after) = rest.split_at(start + MARKER.len());
        result.push_str(before);
        result.push_str("***");
        // The value runs to the end of that argument, and the arguments are
        // joined with spaces.
        rest = after.find(' ').map_or("", |space| &after[space..]);
    }
    result.push_str(rest);
    result
}

/// How Node names a spawn that never happened — the errno, not prose. The
/// reference reports a missing `git` this way, so this has to as well.
fn spawn_failure(error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => "spawn git ENOENT".to_string(),
        std::io::ErrorKind::PermissionDenied => "spawn git EACCES".to_string(),
        _ => format!("spawn git failed: {error}"),
    }
}

async fn is_non_empty_dir(path: &Path) -> Result<bool> {
    match tokio::fs::read_dir(path).await {
        Ok(mut entries) => Ok(entries.next_entry().await?.is_some()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

/// `scheme://rest`, with the scheme lowercased. The scheme has to start with a
/// letter, which is what tells a URL from an `scp`-style `host:path`.
fn split_scheme(url: &str) -> Option<(String, &str)> {
    let separator = url.find("://")?;
    let scheme = &url[..separator];
    let mut characters = scheme.chars();
    if !characters.next()?.is_ascii_alphabetic() {
        return None;
    }
    if !characters.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '+' | '.' | '-')) {
        return None;
    }
    Some((scheme.to_ascii_lowercase(), &url[separator + 3..]))
}

/// Host and path of an absolute URL, refusing the schemes a clone cannot use.
///
/// The order matters: a URL that does not parse at all is reported as invalid
/// before its scheme is judged, because naming the scheme of something that is
/// not a URL would be the wrong complaint.
fn parse_absolute(input: &str, scheme: &str, rest: &str) -> Result<(Option<String>, String)> {
    let special = SPECIAL_SCHEMES.contains(&scheme);
    let rest = if special {
        rest.trim_start_matches('/')
    } else {
        rest
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, remainder) = rest.split_at(end);
    if authority.contains(char::is_whitespace) {
        bail!("Invalid repository URL: {input}");
    }
    // Userinfo and port are not part of the host, and the host is compared
    // against a literal, so it is lowercased the way a URL parser does.
    let after_userinfo = authority.rsplit('@').next().unwrap_or_default();
    let host = match after_userinfo.rsplit_once(':') {
        Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) => host,
        _ => after_userinfo,
    }
    .to_ascii_lowercase();
    if matches!(scheme, "http" | "https") && host.is_empty() {
        bail!("Invalid repository URL: {input}");
    }
    if !ALLOWED_SCHEMES.contains(&scheme) {
        bail!("Unsupported repository URL scheme: {scheme}:");
    }
    // A `file:` URL names no machine; `localhost` there is spelled out but
    // means the same nothing, and a URL parser drops it.
    let host = if host.is_empty() || (scheme == "file" && host == "localhost") {
        None
    } else {
        Some(host)
    };
    let path = if remainder.is_empty() && special {
        "/".to_string()
    } else {
        remainder.split(['?', '#']).next().unwrap_or("").to_string()
    };
    Ok((host, path))
}

/// git's own `user@host:path` shorthand, which is not a URL and so is matched
/// rather than parsed.
fn split_scp_like(url: &str) -> Option<(Option<String>, String)> {
    let (before, path) = url.split_once(':')?;
    if path.is_empty() {
        return None;
    }
    let (userinfo, host) = match before.split_once('@') {
        Some((userinfo, host)) => (Some(userinfo), host),
        None => (None, before),
    };
    let name_like = |value: &str| {
        !value.is_empty()
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    };
    if !name_like(host) || userinfo.is_some_and(|user| !name_like(user)) {
        return None;
    }
    Some((Some(host.to_string()), path.to_string()))
}

/// `.git` or `.git/` at the very end, and nowhere else.
fn strip_git_suffix(path: &str) -> &str {
    path.strip_suffix(".git/")
        .or_else(|| path.strip_suffix(".git"))
        .unwrap_or(path)
}

fn sanitize_name(raw: &str) -> String {
    let lowered = raw.trim().to_ascii_lowercase();
    let lowered = lowered.strip_suffix(".git").unwrap_or(&lowered);
    let mut result = String::with_capacity(lowered.len());
    let mut in_run = false;
    for character in lowered.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
            result.push(character);
            in_run = false;
        } else if !in_run {
            // A run of unsafe characters collapses to one dash, the way the
            // reference's `+` quantifier does.
            result.push('-');
            in_run = true;
        }
    }
    result.trim_matches('-').to_string()
}

fn absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(url: &str) -> ParsedRepoUrl {
        parse_repo_url(url).unwrap()
    }

    #[test]
    fn an_https_url_names_the_repository_and_its_owner() {
        let parsed = parse("https://github.com/Owner/Repo.git");
        assert_eq!(parsed.name, "repo");
        assert_eq!(parsed.owner.as_deref(), Some("Owner"));
        assert_eq!(parsed.host.as_deref(), Some("github.com"));
        assert_eq!(parsed.normalized_url, "https://github.com/Owner/Repo.git");
    }

    #[test]
    fn a_scp_style_url_is_matched_rather_than_parsed() {
        let parsed = parse("git@github.com:owner/My Repo.git");
        assert_eq!(parsed.name, "my-repo");
        assert_eq!(parsed.host.as_deref(), Some("github.com"));
    }

    #[test]
    fn userinfo_and_the_default_port_are_not_part_of_the_host() {
        assert_eq!(
            parse("https://user:pw@GitHub.com:443/o/r.git")
                .host
                .as_deref(),
            Some("github.com")
        );
    }

    /// A `file:` URL names no machine, so a token meant for github.com must not
    /// attach itself to one.
    #[test]
    fn a_file_url_has_no_host() {
        assert_eq!(parse("file:///srv/repos/demo.git").name, "demo");
        assert_eq!(parse("file://localhost/srv/demo.git").host, None);
    }

    #[test]
    fn a_trailing_slash_after_dot_git_is_still_the_same_repository() {
        assert_eq!(parse("file:///srv/repos/demo.git/").name, "demo");
    }

    #[test]
    fn each_way_a_url_can_be_unusable_is_refused_by_name() {
        let message = |url: &str| parse_repo_url(url).unwrap_err().to_string();
        assert_eq!(message("   "), "Repository URL is required.");
        assert_eq!(
            message("not a url"),
            "Unrecognized repository URL: not a url"
        );
        assert_eq!(
            message("ftp://example.com/a/b.git"),
            "Unsupported repository URL scheme: ftp:"
        );
        assert_eq!(
            message("https://example.com"),
            "Repository URL has no path: https://example.com"
        );
        assert_eq!(message("https://"), "Invalid repository URL: https://");
    }

    /// The reference collapses a *run* of unsafe characters to one dash and
    /// then trims the ends, so a name is never bracketed by dashes.
    #[test]
    fn an_unsafe_name_collapses_rather_than_growing_a_dash_per_character() {
        assert_eq!(sanitize_name("  ~~My  Repo!! "), "my-repo");
        assert_eq!(sanitize_name("!!!"), "");
    }

    /// The token rides in an argument, and the argument is quoted back in git's
    /// failure text. Whatever else that text says, it must not say the token.
    #[test]
    fn a_failed_clone_does_not_quote_the_credential_back() {
        let parsed = parse("https://github.com/owner/repo.git");
        let args = github_auth_args(&parsed, Some("ghp_secret"));
        let failure = format!(
            "Command failed: git {} clone --depth 1\nfatal: no",
            args.join(" ")
        );
        let redacted = redact_authorization(&failure);
        assert!(!redacted.contains("ghp_secret"));
        assert!(!redacted.contains(
            &base64::engine::general_purpose::STANDARD.encode("x-access-token:ghp_secret")
        ));
        assert!(redacted.contains("extraheader=Authorization: Basic ***"));
        assert!(redacted.ends_with("clone --depth 1\nfatal: no"));
    }

    /// An SSH clone authenticates with a key, so a token has no business being
    /// attached to one — nor to any host but github.com.
    #[test]
    fn the_token_is_attached_only_to_an_https_github_url() {
        assert!(github_auth_args(&parse("git@github.com:o/r.git"), Some("t")).is_empty());
        assert!(github_auth_args(&parse("https://gitlab.com/o/r.git"), Some("t")).is_empty());
        assert!(github_auth_args(&parse("https://github.com/o/r.git"), None).is_empty());
        assert_eq!(
            github_auth_args(&parse("https://github.com/o/r.git"), Some("t")).len(),
            2
        );
    }
}
