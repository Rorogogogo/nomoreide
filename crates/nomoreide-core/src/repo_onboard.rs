//! Cloning a repository from a URL, and the URL parsing that names it.
//!
//! This lives outside `git_manager` on purpose: that module is read-safe and
//! never reaches the network. A clone is additive — it only ever writes a
//! directory that did not exist — so it is guarded here instead of by widening
//! the read-safe surface.

use anyhow::{bail, Result};
use base64::Engine;
use serde::Serialize;
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

/// True when `path` resolves inside `root`. The containment guard the onboard
/// endpoints put in front of every path a browser hands them, so a clone path
/// can only ever name something the wizard itself cloned.
///
/// **The escape check is a string test on the relative path**, not a structural
/// one, which is worth mirroring rather than tightening: a directory whose own
/// name begins with `..` — `<root>/..hidden` is a perfectly ordinary one — makes
/// the relative path start with `..` and is refused even though it is inside.
/// A guard that lets *fewer* paths through than the reference is still a
/// divergence, and this one is the reference's.
///
/// The root itself is refused too: the relative path is empty, and an empty
/// path is not a repository anyone onboarded.
pub fn is_inside_repos_dir(path: &str, root: &Path) -> bool {
    let resolved = node_resolve(path);
    let relative = node_relative(&node_resolve(&root.to_string_lossy()), &resolved);
    if relative.is_empty() {
        return false;
    }
    !relative.starts_with("..") && !resolved.contains('\0')
}

/// `path.resolve` for one POSIX path: made absolute against the process
/// directory, then `.` dropped and `..` popped **textually**. No symlink is
/// followed and the filesystem is not consulted, which is what makes the guard
/// above decidable for a path that is not there.
fn node_resolve(path: &str) -> String {
    let mut segments: Vec<&str> = Vec::new();
    let joined = if path.starts_with('/') {
        path.to_string()
    } else {
        format!(
            "{}/{path}",
            std::env::current_dir().unwrap_or_default().display()
        )
    };
    for segment in joined.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            other => segments.push(other),
        }
    }
    format!("/{}", segments.join("/"))
}

/// `path.relative` for two already-resolved POSIX paths: the segments they do
/// not share, prefixed by one `..` per segment left over on the `from` side.
fn node_relative(from: &str, to: &str) -> String {
    let from: Vec<&str> = from.split('/').filter(|s| !s.is_empty()).collect();
    let to: Vec<&str> = to.split('/').filter(|s| !s.is_empty()).collect();
    let shared = from
        .iter()
        .zip(to.iter())
        .take_while(|(left, right)| left == right)
        .count();
    let mut parts: Vec<&str> = vec![".."; from.len() - shared];
    parts.extend_from_slice(&to[shared..]);
    parts.join("/")
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

    // The heuristics below are covered end to end by the parity gate. These
    // pin the pieces a fixture cannot reach — a URL a compose file could hold
    // but that no throwaway tree would produce, and the boundaries where one
    // reading of a number turns into another.

    #[test]
    fn a_port_flag_beats_a_bare_colon() {
        assert_eq!(
            sniff_port("node server.js --host 0.0.0.0:31000"),
            Some(31000)
        );
        assert_eq!(
            sniff_port("vite --port 5173 --host 0.0.0.0:31000"),
            Some(5173)
        );
    }

    #[test]
    fn a_flag_takes_the_leading_digits_but_a_colon_needs_the_number_to_end() {
        // `--port 123456` is read as far as a port can go; `:123456` is not a
        // port at all, because a longer number is a different number.
        assert_eq!(sniff_port("x --port 123456"), Some(12345));
        assert_eq!(sniff_port("x http://h:123456/p"), None);
        assert_eq!(sniff_port("x --port 1"), None);
    }

    #[test]
    fn a_number_outside_the_port_range_is_not_reported() {
        assert_eq!(sniff_port("serve --port 99999"), None);
        assert_eq!(sniff_port("serve --port 65535"), Some(65535));
    }

    #[test]
    fn only_a_standalone_port_word_counts() {
        assert_eq!(sniff_port("PORT=8080 node server.js"), Some(8080));
        assert_eq!(sniff_port("run port:9090"), Some(9090));
        assert_eq!(sniff_port("this supports 8080 clients"), None);
    }

    #[test]
    fn an_env_name_is_what_a_shell_would_accept() {
        let keys = parse_env_keys(
            "# c\nPLAIN=1\n  SPACED = 2\nexport EXPORTED=3\nDOT.KEY=5\nDASH-KEY=6\n1LEADING=7\nNO_VALUE\n=NOKEY\nDUP=a\nDUP=b\n",
        );
        assert_eq!(keys, ["PLAIN", "SPACED", "EXPORTED", "DUP", "DUP"]);
    }

    #[test]
    fn a_credential_is_encoded_the_way_javascript_encodes_it() {
        assert_eq!(encode_component("a b"), "a%20b");
        assert_eq!(encode_component("p@ss:word/x"), "p%40ss%3Aword%2Fx");
        // The characters `encodeURIComponent` leaves alone, which are not the
        // same set the URL standard leaves alone.
        assert_eq!(encode_component("-_.!~*'()"), "-_.!~*'()");
    }

    #[test]
    fn a_port_mapping_is_read_from_its_host_side() {
        assert_eq!(split_port("5544:5432"), (Some(5544), Some(5432)));
        assert_eq!(split_port("127.0.0.1:5544:5432"), (Some(5544), Some(5432)));
        assert_eq!(split_port("7777"), (Some(7777), Some(7777)));
        // A range publishes several ports and names none of them.
        assert_eq!(split_port("6000-6002:5432"), (None, Some(5432)));
        assert_eq!(split_port("5403:5432/tcp"), (Some(5403), None));
    }

    #[test]
    fn the_engines_port_wins_over_the_first_one_published() {
        let ports = ["8080:80".to_string(), "5544:5432".to_string()];
        assert_eq!(published_host_port(&ports, 5432), Some(5544));
        // Nothing publishes 5432, so the first mapping is the best guess.
        assert_eq!(
            published_host_port(&["4000:9999".to_string()], 5432),
            Some(4000)
        );
        assert_eq!(published_host_port(&[], 5432), None);
    }

    #[test]
    fn an_image_naming_both_engines_is_read_as_postgres() {
        assert_eq!(
            detect_db_engine("mysql-postgres:1"),
            Some(DbEngine::Postgres)
        );
        assert_eq!(
            detect_db_engine("bitnami/postgresql:16"),
            Some(DbEngine::Postgres)
        );
        assert_eq!(detect_db_engine("mariadb:11"), Some(DbEngine::Mysql));
        // Close enough to read as a database, but not one this proposes.
        assert_eq!(detect_db_engine("maria:11"), None);
        assert_eq!(detect_db_engine("cockroachdb/cockroach"), None);
        assert_eq!(detect_db_engine("redis:7"), None);
    }

    #[test]
    fn a_readme_heading_has_to_be_shallow_and_say_something_about_running() {
        assert!(is_run_heading("## Getting Started"));
        assert!(is_run_heading("### quick start"));
        assert!(!is_run_heading("#### Getting Started"));
        assert!(!is_run_heading("##Getting Started"));
        assert!(!is_run_heading("## Licence"));
    }
}

// ---------------------------------------------------------------------------
// Scanning a clone into a profile
// ---------------------------------------------------------------------------

/// A JSON object that keeps the order it was built in.
///
/// `scripts` and a compose service's `environment` are quoted back to an agent
/// as the file wrote them, and a map that sorted its keys would quietly
/// reorder someone's manifest.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Ordered<V>(Vec<(String, V)>);

impl<V> Ordered<V> {
    fn get(&self, key: &str) -> Option<&V> {
        self.0.entry_for(key)
    }

    fn push(&mut self, key: impl Into<String>, value: V) {
        self.0.push((key.into(), value));
    }
}

/// Lookup helper kept off `Ordered` itself so the borrow stays on the vector.
trait EntryFor<V> {
    fn entry_for(&self, key: &str) -> Option<&V>;
}

impl<V> EntryFor<V> for Vec<(String, V)> {
    fn entry_for(&self, key: &str) -> Option<&V> {
        self.iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }
}

impl<V: Serialize> Serialize for Ordered<V> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, value) in &self.0 {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

/// What a top-level read of a clone says about how to run it.
///
/// The repository root only — no recursion. A profile is a set of signals for
/// an agent to interpret, so being quick and shallow matters more than being
/// exhaustive.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoProfile {
    pub name: String,
    pub clone_path: String,
    pub languages: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node: Option<NodeSignal>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub python: Option<PythonSignal>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docker: Option<DockerSignal>,
    /// Variable *names* from an example env file. The values are dropped on
    /// purpose: an example file is exactly where a real secret ends up by
    /// accident, and a name is all a proposal needs.
    pub env_keys: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub readme_excerpt: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PackageManager {
    Npm,
    Yarn,
    Pnpm,
    Bun,
}

impl PackageManager {
    fn as_str(self) -> &'static str {
        match self {
            Self::Npm => "npm",
            Self::Yarn => "yarn",
            Self::Pnpm => "pnpm",
            Self::Bun => "bun",
        }
    }

    /// How this manager is asked to run a named script. `npm` and `bun` need
    /// the `run`; `yarn` and `pnpm` take the script name directly.
    fn run(self, script: &str) -> String {
        match self {
            Self::Npm => format!("npm run {script}"),
            Self::Yarn => format!("yarn {script}"),
            Self::Pnpm => format!("pnpm {script}"),
            Self::Bun => format!("bun run {script}"),
        }
    }

    fn install(self) -> String {
        format!("{} install", self.as_str())
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeSignal {
    pub package_manager: PackageManager,
    /// Passed through as the manifest wrote them, values included: a `scripts`
    /// entry that is not a string is reported rather than dropped, and simply
    /// does not count as a script that can be run.
    pub scripts: Ordered<serde_json::Value>,
    pub has_dev_script: bool,
    pub has_start_script: bool,
}

impl NodeSignal {
    fn script(&self, name: &str) -> Option<&str> {
        self.scripts.get(name).and_then(serde_json::Value::as_str)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PythonFramework {
    Django,
    Fastapi,
    Flask,
    Unknown,
}

impl PythonFramework {
    fn as_str(self) -> &'static str {
        match self {
            Self::Django => "django",
            Self::Fastapi => "fastapi",
            Self::Flask => "flask",
            Self::Unknown => "unknown",
        }
    }

    /// The command that starts this framework's development server, and the
    /// port it listens on unless told otherwise.
    fn command(self) -> &'static str {
        match self {
            Self::Django => "python manage.py runserver",
            Self::Fastapi => "uvicorn main:app --reload",
            Self::Flask => "flask run",
            Self::Unknown => "python main.py",
        }
    }

    fn default_port(self) -> Option<u32> {
        match self {
            Self::Django | Self::Fastapi => Some(8000),
            Self::Flask => Some(5000),
            Self::Unknown => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PythonSignal {
    pub has_requirements: bool,
    pub has_pyproject: bool,
    pub has_manage_py: bool,
    pub framework: PythonFramework,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComposeServiceDetail {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    pub ports: Vec<String>,
    pub environment: Ordered<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DockerSignal {
    pub has_dockerfile: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compose_file: Option<String>,
    pub compose_services: Vec<String>,
    pub services: Vec<ComposeServiceDetail>,
}

/// The compose file names that are looked for, in the order they win.
const COMPOSE_FILES: &[&str] = &[
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
];

/// The example env files that are read, in the order they win. The first one
/// with anything in it is used; an empty file falls through to the next.
const ENV_FILES: &[&str] = &[".env.example", ".env.sample", ".env.template"];

const README_FILES: &[&str] = &["README.md", "readme.md", "README.MD", "README"];

/// Read-only scan of a cloned repository into a structured profile.
pub async fn scan_repo(clone_path: &str) -> Result<RepoProfile> {
    let mut entries = match tokio::fs::read_dir(clone_path).await {
        Ok(entries) => entries,
        Err(_) => bail!("Cannot scan repository at {clone_path}."),
    };
    let mut files: Vec<String> = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        files.push(entry.file_name().to_string_lossy().into_owned());
    }
    let has = |name: &str| files.iter().any(|file| file == name);

    let node = scan_node(clone_path, &has).await;
    let python = scan_python(clone_path, &has).await;
    let docker = scan_docker(clone_path, &has).await;

    let mut env_keys = Vec::new();
    for candidate in ENV_FILES {
        if !has(candidate) {
            continue;
        }
        if let Some(raw) = read_if_present(clone_path, candidate).await {
            if !raw.is_empty() {
                env_keys = parse_env_keys(&raw);
                break;
            }
        }
    }

    let mut readme_excerpt = None;
    if let Some(name) = README_FILES.iter().find(|file| has(file)) {
        if let Some(raw) = read_if_present(clone_path, name).await {
            if !raw.is_empty() {
                readme_excerpt = Some(readme_excerpt_of(&raw));
            }
        }
    }

    let mut languages = Vec::new();
    if node.is_some() {
        languages.push("node".to_string());
    }
    if python.is_some() {
        languages.push("python".to_string());
    }
    if docker.is_some() {
        languages.push("docker".to_string());
    }

    let leaf = clone_path
        .split(['\\', '/'])
        .filter(|segment| !segment.is_empty())
        .next_back()
        .unwrap_or("service");
    Ok(RepoProfile {
        name: sanitize_name(leaf),
        clone_path: clone_path.to_string(),
        languages,
        node,
        python,
        docker,
        env_keys,
        readme_excerpt,
    })
}

async fn read_if_present(root: &str, name: &str) -> Option<String> {
    tokio::fs::read_to_string(Path::new(root).join(name))
        .await
        .ok()
}

async fn scan_node(root: &str, has: &impl Fn(&str) -> bool) -> Option<NodeSignal> {
    if !has("package.json") {
        return None;
    }
    // A manifest that will not parse still says "this is a Node project"; it
    // just cannot say how to run it.
    let scripts = read_if_present(root, "package.json")
        .await
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|manifest| manifest.get("scripts").cloned())
        .and_then(|scripts| scripts.as_object().cloned())
        .map(|scripts| {
            let mut ordered = Ordered::default();
            for (key, value) in scripts {
                ordered.push(key, value);
            }
            ordered
        })
        .unwrap_or_default();

    let is_script = |name: &str| {
        scripts
            .get(name)
            .and_then(serde_json::Value::as_str)
            .is_some()
    };
    Some(NodeSignal {
        package_manager: detect_package_manager(has),
        has_dev_script: is_script("dev"),
        has_start_script: is_script("start"),
        scripts,
    })
}

/// Which manager a lockfile names. Checked in a fixed order, so a repository
/// carrying more than one lockfile gets a stable answer rather than whichever
/// the filesystem listed first.
fn detect_package_manager(has: &impl Fn(&str) -> bool) -> PackageManager {
    if has("pnpm-lock.yaml") {
        PackageManager::Pnpm
    } else if has("yarn.lock") {
        PackageManager::Yarn
    } else if has("bun.lockb") {
        PackageManager::Bun
    } else {
        PackageManager::Npm
    }
}

async fn scan_python(root: &str, has: &impl Fn(&str) -> bool) -> Option<PythonSignal> {
    let has_requirements = has("requirements.txt");
    let has_pyproject = has("pyproject.toml");
    let has_manage_py = has("manage.py");
    if !has_requirements && !has_pyproject && !has_manage_py {
        return None;
    }
    let mut declared = String::new();
    for name in ["requirements.txt", "pyproject.toml"] {
        if let Some(raw) = read_if_present(root, name).await {
            declared.push_str(&raw.to_lowercase());
        }
    }
    // `manage.py` is Django's own entry point, so it settles the question
    // before any dependency list is consulted.
    let framework = if has_manage_py {
        PythonFramework::Django
    } else if declared.contains("fastapi") {
        PythonFramework::Fastapi
    } else if declared.contains("flask") {
        PythonFramework::Flask
    } else if declared.contains("django") {
        PythonFramework::Django
    } else {
        PythonFramework::Unknown
    };
    Some(PythonSignal {
        has_requirements,
        has_pyproject,
        has_manage_py,
        framework,
    })
}

async fn scan_docker(root: &str, has: &impl Fn(&str) -> bool) -> Option<DockerSignal> {
    let compose_file = COMPOSE_FILES.iter().find(|file| has(file));
    let has_dockerfile = has("Dockerfile");
    if compose_file.is_none() && !has_dockerfile {
        return None;
    }
    let mut services = Vec::new();
    if let Some(name) = compose_file {
        if let Some(raw) = read_if_present(root, name).await {
            if !raw.is_empty() {
                services = parse_compose_service_details(&raw);
            }
        }
    }
    Some(DockerSignal {
        has_dockerfile,
        compose_file: compose_file.map(|file| (*file).to_string()),
        compose_services: services
            .iter()
            .map(|service| service.name.clone())
            .collect(),
        services,
    })
}

/// Top-level compose services, with the details the proposals use.
///
/// A compose file that will not parse yields no services rather than an error:
/// the rest of the profile is still worth reporting, and an agent reading it
/// can see the file was named but described nothing.
pub fn parse_compose_service_details(raw: &str) -> Vec<ComposeServiceDetail> {
    let Ok(document) = serde_yaml::from_str::<serde_yaml::Value>(raw) else {
        return Vec::new();
    };
    let Some(services) = document.get("services") else {
        return Vec::new();
    };
    // A `services:` that is a list rather than a mapping is malformed compose,
    // but it parses, and the reference names those entries by their index —
    // so an agent sees "0" and "1" rather than nothing at all.
    let entries: Vec<(String, &serde_yaml::Value)> = match services {
        serde_yaml::Value::Mapping(mapping) => mapping
            .iter()
            .filter_map(|(key, value)| key.as_str().map(|key| (key.to_string(), value)))
            .collect(),
        serde_yaml::Value::Sequence(sequence) => sequence
            .iter()
            .enumerate()
            .map(|(index, value)| (index.to_string(), value))
            .collect(),
        _ => return Vec::new(),
    };

    entries
        .into_iter()
        .map(|(name, value)| ComposeServiceDetail {
            name,
            image: value
                .get("image")
                .and_then(serde_yaml::Value::as_str)
                .map(str::to_string),
            ports: normalize_compose_ports(value.get("ports")),
            environment: normalize_compose_environment(value.get("environment")),
        })
        .collect()
}

/// Compose's several spellings of a port, flattened to `host:container` text.
fn normalize_compose_ports(ports: Option<&serde_yaml::Value>) -> Vec<String> {
    let Some(serde_yaml::Value::Sequence(entries)) = ports else {
        // A bare string here is not a list of ports, and compose would reject
        // it too.
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| match entry {
            serde_yaml::Value::String(text) => Some(text.clone()),
            serde_yaml::Value::Number(number) => Some(number.to_string()),
            // The long form: `{ target: 5432, published: 5402 }`.
            serde_yaml::Value::Mapping(_) => {
                let published = entry.get("published").map(scalar_text)?;
                let target = entry.get("target").map(scalar_text)?;
                Some(format!("{published}:{target}"))
            }
            _ => None,
        })
        .collect()
}

/// Compose's two spellings of an environment: a mapping, or `KEY=VALUE` lines.
fn normalize_compose_environment(environment: Option<&serde_yaml::Value>) -> Ordered<String> {
    let mut result = Ordered::default();
    match environment {
        Some(serde_yaml::Value::Mapping(mapping)) => {
            for (key, value) in mapping {
                if let Some(key) = key.as_str() {
                    result.push(key, scalar_text(value));
                }
            }
        }
        Some(serde_yaml::Value::Sequence(entries)) => {
            for entry in entries {
                let Some(text) = entry.as_str() else { continue };
                let Some((key, value)) = text.split_once('=') else {
                    continue;
                };
                if key.is_empty() {
                    continue;
                }
                result.push(key, value.to_string());
            }
        }
        _ => {}
    }
    result
}

/// A YAML scalar as the text an environment variable would carry. A null is
/// the empty string, the way an unset value reads to a container.
fn scalar_text(value: &serde_yaml::Value) -> String {
    match value {
        serde_yaml::Value::String(text) => text.clone(),
        serde_yaml::Value::Bool(flag) => flag.to_string(),
        serde_yaml::Value::Number(number) => number.to_string(),
        _ => String::new(),
    }
}

/// Variable *names* from an example env file.
///
/// Only what would parse as a shell-style assignment counts, and only names a
/// shell would accept: a leading digit, a dot, or a dash means the line is not
/// an assignment this can report. Duplicates are kept as written — an example
/// file that sets the same key twice is telling the reader something.
fn parse_env_keys(raw: &str) -> Vec<String> {
    let mut keys = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let candidate = trimmed
            .strip_prefix("export ")
            .unwrap_or(trimmed)
            .trim_start();
        let Some((name, _)) = candidate.split_once('=') else {
            continue;
        };
        let name = name.trim_end();
        if is_env_name(name) {
            keys.push(name.to_string());
        }
    }
    keys
}

fn is_env_name(name: &str) -> bool {
    let mut characters = name.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

/// The heading a README excerpt prefers to start at — the section that tells a
/// reader how to run the thing.
const README_HEADINGS: &[&str] = &[
    "getting started",
    "usage",
    "quickstart",
    "quick start",
    "running",
    "setup",
    "develop",
    "install",
];

const README_LINES_FROM_HEADING: usize = 40;
const README_LINES_FROM_TOP: usize = 30;
const README_MAX_CHARS: usize = 2000;

/// The part of a README worth showing an agent: the run instructions if the
/// file has a heading that looks like them, otherwise the top of the file.
fn readme_excerpt_of(raw: &str) -> String {
    let lines: Vec<&str> = raw
        .split('\n')
        .map(|line| line.trim_end_matches('\r'))
        .collect();
    let start = lines.iter().position(|line| is_run_heading(line));
    let slice = match start {
        Some(start) => &lines[start..lines.len().min(start + README_LINES_FROM_HEADING)],
        None => &lines[..lines.len().min(README_LINES_FROM_TOP)],
    };
    // Cut by character, not by byte: a README is prose and often not ASCII.
    slice
        .join("\n")
        .chars()
        .take(README_MAX_CHARS)
        .collect::<String>()
        .trim()
        .to_string()
}

/// A markdown heading of at most three levels whose text mentions running the
/// project. Four hashes is too deep to be the section a reader wants.
fn is_run_heading(line: &str) -> bool {
    let hashes = line
        .chars()
        .take_while(|character| *character == '#')
        .count();
    if !(1..=3).contains(&hashes) {
        return false;
    }
    let rest = &line[hashes..];
    if !rest.starts_with([' ', '\t']) {
        return false;
    }
    let lowered = rest.to_lowercase();
    README_HEADINGS
        .iter()
        .any(|heading| lowered.contains(heading))
}

// ---------------------------------------------------------------------------
// Heuristic proposals
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProposalKind {
    Local,
    DockerCompose,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProposedService {
    pub name: String,
    pub kind: ProposalKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compose_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compose_service: Option<String>,
    /// A one-shot step to run before the first start. Not persisted with the
    /// service: installing is something you do once, not every time it starts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_command: Option<String>,
    pub confidence: Confidence,
    pub reason: String,
}

/// How a service might be started, best guess first.
///
/// Every non-compose proposal is named after the repository, so a repository
/// that is both a Node project and a compose project produces one name twice —
/// and the later duplicate is dropped. That is why a compose file effectively
/// hides the `package.json` proposal: they are two answers to the same
/// question and only one can carry the repository's own name.
pub fn propose_services(profile: &RepoProfile) -> Vec<ProposedService> {
    let mut proposals: Vec<ProposedService> = Vec::new();

    if let Some(docker) = &profile.docker {
        for (index, service) in docker.services.iter().enumerate() {
            proposals.push(ProposedService {
                // The first service is taken to be the application itself and
                // gets the repository's name; the rest are its dependencies.
                name: if index == 0 {
                    profile.name.clone()
                } else {
                    format!("{}-{}", profile.name, service.name)
                },
                kind: ProposalKind::DockerCompose,
                command: None,
                cwd: profile.clone_path.clone(),
                port: first_host_port(&service.ports),
                compose_file: docker.compose_file.clone(),
                compose_service: Some(service.name.clone()),
                install_command: None,
                confidence: if index == 0 {
                    Confidence::High
                } else {
                    Confidence::Low
                },
                reason: format!("docker-compose service \"{}\"", service.name),
            });
        }
    }

    if let Some(node) = &profile.node {
        // `dev` is what a developer runs; `start` is usually production and is
        // only the answer when there is no `dev`.
        let script = node
            .script("dev")
            .map(|command| ("dev", command, Confidence::High))
            .or_else(|| {
                node.script("start")
                    .map(|command| ("start", command, Confidence::Medium))
            });
        if let Some((name, command, confidence)) = script {
            let manager = node.package_manager;
            proposals.push(ProposedService {
                name: profile.name.clone(),
                kind: ProposalKind::Local,
                command: Some(manager.run(name)),
                cwd: profile.clone_path.clone(),
                port: sniff_port(command),
                compose_file: None,
                compose_service: None,
                install_command: Some(manager.install()),
                confidence,
                reason: format!("package.json \"{name}\" script ({})", manager.as_str()),
            });
        }
    }

    if let Some(python) = &profile.python {
        proposals.push(ProposedService {
            name: profile.name.clone(),
            kind: ProposalKind::Local,
            command: Some(python.framework.command().to_string()),
            cwd: profile.clone_path.clone(),
            port: python.framework.default_port(),
            compose_file: None,
            compose_service: None,
            install_command: if python.has_requirements {
                Some("pip install -r requirements.txt".to_string())
            } else if python.has_pyproject {
                Some("pip install .".to_string())
            } else {
                None
            },
            confidence: if python.framework == PythonFramework::Unknown {
                Confidence::Low
            } else {
                Confidence::Medium
            },
            reason: format!("python {} project", python.framework.as_str()),
        });
    }

    // Already best-first by construction, so nothing is sorted here: a
    // compose file's own application is the only `high` a compose repository
    // produces, `dev` outranks `start`, and no Python guess ever beats a Node
    // one. Sorting by confidence could not reorder any of it.
    dedupe_by_name(proposals, |proposal| proposal.name.clone())
}

fn dedupe_by_name<T>(items: Vec<T>, name: impl Fn(&T) -> String) -> Vec<T> {
    let mut seen: Vec<String> = Vec::new();
    let mut result = Vec::new();
    for item in items {
        let key = name(&item);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        result.push(item);
    }
    result
}

/// The port a start command appears to bind, read out of the command text.
///
/// Ordered from the most explicit spelling to the least, because the last
/// pattern — a bare `:port` — would otherwise claim the port out of a URL that
/// only happens to appear in the command.
fn sniff_port(text: &str) -> Option<u32> {
    flag_port(text, "--port")
        .or_else(|| flag_port(text, "-p"))
        .or_else(|| word_port(text))
        .or_else(|| colon_port(text))
        // A number that reads like a port but cannot be one is not reported at
        // all. Half-guessing a port is worse than leaving it for the agent.
        .filter(|port| (1..=65535).contains(port))
}

/// `--port 5173`, `--port=5173`, `-p 4000`, `-p=4000`.
fn flag_port(text: &str, flag: &str) -> Option<u32> {
    let mut from = 0;
    while let Some(index) = text[from..].find(flag) {
        let at = from + index + flag.len();
        let rest = &text[at..];
        if rest.starts_with(' ') || rest.starts_with('=') {
            if let Some(port) = leading_digits(&rest[1..]) {
                return Some(port);
            }
        }
        from = at;
    }
    None
}

/// `PORT=8080`, `port 9090`, or `port:9090`, in either case — but only where
/// the word stands on its own, so `supports 8080` is not a port.
fn word_port(text: &str) -> Option<u32> {
    const WORD: &str = "port";
    let lowered = text.to_lowercase();
    let mut from = 0;
    while let Some(index) = lowered[from..].find(WORD) {
        let at = from + index;
        let preceded_by_word_character = text[..at]
            .chars()
            .next_back()
            .is_some_and(|character| character.is_alphanumeric() || character == '_');
        let rest = &text[at + WORD.len()..];
        if !preceded_by_word_character
            && (rest.starts_with(' ') || rest.starts_with('=') || rest.starts_with(':'))
        {
            if let Some(port) = leading_digits(&rest[1..]) {
                return Some(port);
            }
        }
        from = at + WORD.len();
    }
    None
}

/// A `:port` on the end of a host. Four digits at least — `1.2.3.4:80` is far
/// more likely a typo than a port — and the number has to end there, so a
/// longer run of digits is left alone rather than read as its first five.
fn colon_port(text: &str) -> Option<u32> {
    let mut from = 0;
    while let Some(index) = text[from..].find(':') {
        let at = from + index + 1;
        let digits: String = text[at..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        if (4..=5).contains(&digits.len()) {
            if let Ok(port) = digits.parse() {
                return Some(port);
            }
        }
        from = at;
    }
    None
}

/// The number a flag's value starts with: at least two digits, and at most the
/// first five of a longer run. Where `colon_port` refuses an over-long number,
/// these spellings are explicit enough that the leading digits are meant.
fn leading_digits(text: &str) -> Option<u32> {
    let digits: String = text
        .chars()
        .take_while(char::is_ascii_digit)
        .take(5)
        .collect();
    if digits.len() < 2 {
        return None;
    }
    digits.parse().ok()
}

// ---------------------------------------------------------------------------
// Database proposals
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DbEngine {
    Postgres,
    Mysql,
}

impl DbEngine {
    fn as_str(self) -> &'static str {
        match self {
            Self::Postgres => "postgres",
            Self::Mysql => "mysql",
        }
    }

    /// The port the official image listens on inside the container.
    fn container_port(self) -> u32 {
        match self {
            Self::Postgres => 5432,
            Self::Mysql => 3306,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProposedDatabase {
    pub name: String,
    pub engine: DbEngine,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compose_service: Option<String>,
    pub confidence: Confidence,
    pub reason: String,
}

/// Image name fragments that give an engine away. Matched as substrings of the
/// lowercased image, which is why `postgresql`, `crunchy-postgres`, and
/// `supabase/postgres` all land on the same answer without being listed.
///
/// Postgres is tested first: an image naming both engines is far more likely a
/// Postgres tool that mentions MySQL than the other way round.
const POSTGRES_IMAGES: &[&str] = &["postgres", "postgis", "pgvector", "timescale"];
const MYSQL_IMAGES: &[&str] = &["mysql", "mariadb", "percona"];

/// Databases a compose file appears to stand up, each with a URL that is ready
/// to connect with.
///
/// Every proposal is named `<repo>-db`, so a compose file running two databases
/// yields one proposal: the first. Naming them apart is a change to make on
/// both sides of the port, not here.
pub fn propose_databases(profile: &RepoProfile) -> Vec<ProposedDatabase> {
    let Some(docker) = &profile.docker else {
        return Vec::new();
    };
    let proposals: Vec<ProposedDatabase> = docker
        .services
        .iter()
        .filter_map(|service| {
            let image = service.image.as_deref()?;
            let engine = detect_db_engine(image)?;
            let port = published_host_port(&service.ports, engine.container_port())
                .unwrap_or_else(|| engine.container_port());
            let credentials = db_credentials(engine, &service.environment);
            Some(ProposedDatabase {
                name: format!("{}-db", profile.name),
                engine,
                url: db_url(engine, &credentials, port),
                compose_service: Some(service.name.clone()),
                // A URL with no database in it will connect and then land the
                // caller nowhere in particular, so it is worth less than one
                // that names where to go. MySQL creates no database unless the
                // compose file asks for one, which is why an unconfigured
                // MySQL service is the usual way to see this.
                confidence: if credentials.database.is_empty() {
                    Confidence::Medium
                } else {
                    Confidence::High
                },
                reason: format!(
                    "{} database from compose service \"{}\" ({image})",
                    engine.as_str(),
                    service.name
                ),
            })
        })
        .collect();
    dedupe_by_name(proposals, |proposal| proposal.name.clone())
}

fn detect_db_engine(image: &str) -> Option<DbEngine> {
    let lowered = image.to_lowercase();
    if POSTGRES_IMAGES.iter().any(|token| lowered.contains(token)) {
        Some(DbEngine::Postgres)
    } else if MYSQL_IMAGES.iter().any(|token| lowered.contains(token)) {
        Some(DbEngine::Mysql)
    } else {
        None
    }
}

/// Where the engine is reachable from the host: the mapping that publishes its
/// own port if there is one, else whatever the first mapping publishes, else
/// nothing — and the caller falls back to the container's port.
fn published_host_port(ports: &[String], container_port: u32) -> Option<u32> {
    let matching = ports.iter().find_map(|entry| {
        let (host, container) = split_port(entry);
        (container == Some(container_port))
            .then_some(host)
            .flatten()
    });
    matching.or_else(|| first_host_port(ports))
}

/// The host side of the first mapping.
fn first_host_port(ports: &[String]) -> Option<u32> {
    ports.first().and_then(|entry| split_port(entry).0)
}

/// A compose port mapping split into what the host publishes and what the
/// container listens on.
///
/// Compose writes these several ways — `5432`, `5544:5432`, `127.0.0.1:5544:5432`,
/// `5403:5432/tcp` — and the host side is always the second-to-last field, or
/// the only one. A field that is not a plain number (a `6000-6002` range) is
/// no answer rather than a wrong one.
fn split_port(entry: &str) -> (Option<u32>, Option<u32>) {
    let fields: Vec<&str> = entry.split(':').collect();
    let host = if fields.len() >= 2 {
        fields[fields.len() - 2]
    } else {
        fields[0]
    };
    let container = fields[fields.len() - 1];
    (host.parse().ok(), container.parse().ok())
}

/// Whatever credentials the compose service hands its container — which is
/// exactly what a developer would otherwise read out of the file themselves.
struct DbCredentials {
    user: String,
    password: Option<String>,
    database: String,
}

fn db_credentials(engine: DbEngine, environment: &Ordered<String>) -> DbCredentials {
    let value = |key: &str| environment.get(key).map(String::as_str);
    match engine {
        DbEngine::Postgres => DbCredentials {
            user: value("POSTGRES_USER").unwrap_or("postgres").to_string(),
            password: value("POSTGRES_PASSWORD").map(str::to_string),
            // Postgres creates a database named after the user when it is not
            // told otherwise, and defaults that user to `postgres`.
            database: value("POSTGRES_DB")
                .or_else(|| value("POSTGRES_USER"))
                .unwrap_or("postgres")
                .to_string(),
        },
        DbEngine::Mysql => DbCredentials {
            user: value("MYSQL_USER").unwrap_or("root").to_string(),
            // The user's own password if the file sets one, else the root
            // password, which is the only one a bare MySQL service defines.
            password: value("MYSQL_PASSWORD")
                .or_else(|| value("MYSQL_ROOT_PASSWORD"))
                .map(str::to_string),
            // MySQL creates no database unless asked, so there may be none to
            // name — and a URL that names none is still one you can connect
            // with, it just arrives nowhere in particular.
            database: value("MYSQL_DATABASE").unwrap_or_default().to_string(),
        },
    }
}

/// A connection URL ready to hand to a driver.
fn db_url(engine: DbEngine, credentials: &DbCredentials, port: u32) -> String {
    let credential = match credentials
        .password
        .as_deref()
        .filter(|password| !password.is_empty())
    {
        Some(password) => format!(
            "{}:{}",
            encode_component(&credentials.user),
            encode_component(password)
        ),
        None => encode_component(&credentials.user),
    };
    // The database is not encoded, matching the reference. A compose file that
    // names a database with a `/` in it has a bigger problem than this URL.
    format!(
        "{}://{credential}@127.0.0.1:{port}/{}",
        engine.as_str(),
        credentials.database
    )
}

/// Percent-encoding as `encodeURIComponent` does it — a credential goes into
/// the authority of a URL, where an unescaped `@` or `:` ends the field early.
/// The unreserved set is deliberately JavaScript's, not the URL standard's, so
/// both runtimes produce the same string.
fn encode_component(value: &str) -> String {
    const KEPT: &str = "-_.!~*'()";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        let character = byte as char;
        if character.is_ascii_alphanumeric() || KEPT.contains(character) {
            encoded.push(character);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/// One line of a running install, and which pipe it came out of.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub struct InstallLine {
    pub stream: &'static str,
    pub text: String,
}

/// Run a one-shot install command in `cwd`, sending each line as it arrives.
///
/// Stateless: the caller owns delivery, because the only caller is an SSE route
/// and what it does with a line is framing, not process management.
///
/// Returns the exit code, or `None` when there was no code to have — the child
/// was killed by a signal, or never started at all. Both are reported the same
/// way to the browser, which is the reference's `exitCode: null`.
///
/// **The two pipes are forwarded as they arrive**, not one after the other.
/// An install that interleaves progress on stdout with warnings on stderr reads
/// in the order it happened, which is the only order that makes sense of it.
pub async fn run_install(
    cwd: &str,
    command: &str,
    lines: tokio::sync::mpsc::Sender<InstallLine>,
) -> Option<i32> {
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, BufReader};

    let mut child = match tokio::process::Command::new(SHELL)
        .arg("-c")
        .arg(command)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            // A cwd that is not there fails the *spawn*, and the reference
            // reports it as a line on stderr rather than as a stream error —
            // so the browser sees a failed install, not a broken connection.
            let _ = lines
                .send(InstallLine {
                    stream: "stderr",
                    text: node_spawn_error(&error),
                })
                .await;
            return None;
        }
    };

    async fn pump<R>(stream: &'static str, reader: R, lines: tokio::sync::mpsc::Sender<InstallLine>)
    where
        R: tokio::io::AsyncRead + Unpin,
    {
        let mut reader = BufReader::new(reader).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            // A line that is only whitespace is not output. Blank lines are
            // most of what a noisy installer prints.
            if line.trim().is_empty() {
                continue;
            }
            if lines
                .send(InstallLine {
                    stream,
                    text: line.trim_end_matches('\r').to_string(),
                })
                .await
                .is_err()
            {
                return;
            }
        }
    }

    let out = child.stdout.take().map(|reader| {
        let lines = lines.clone();
        tokio::spawn(async move { pump("stdout", reader, lines).await })
    });
    let err = child.stderr.take().map(|reader| {
        let lines = lines.clone();
        tokio::spawn(async move { pump("stderr", reader, lines).await })
    });

    let status = child.wait().await.ok();
    // Both pipes are drained before the exit code goes out, so a trailing line
    // never arrives after the `done` that says the run finished.
    if let Some(task) = out {
        let _ = task.await;
    }
    if let Some(task) = err {
        let _ = task.await;
    }
    status.and_then(|status| status.code())
}

/// The shell an install command runs under.
///
/// Named explicitly because it appears in the failure message, which is
/// compared against the reference's — Node spells a spawn failure
/// `spawn <file> <CODE>`.
const SHELL: &str = "/bin/sh";

/// A spawn failure worded the way Node words it.
fn node_spawn_error(error: &std::io::Error) -> String {
    let code = match error.raw_os_error() {
        Some(2) => "ENOENT",
        Some(13) => "EACCES",
        Some(20) => "ENOTDIR",
        Some(12) => "ENOMEM",
        _ => return error.to_string(),
    };
    format!("spawn {SHELL} {code}")
}

#[cfg(test)]
mod install_tests {
    use super::*;

    async fn collect(cwd: &str, command: &str) -> (Vec<InstallLine>, Option<i32>) {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let run = tokio::spawn({
            let cwd = cwd.to_string();
            let command = command.to_string();
            async move { run_install(&cwd, &command, tx).await }
        });
        let mut lines = Vec::new();
        while let Some(line) = rx.recv().await {
            lines.push(line);
        }
        (lines, run.await.unwrap())
    }

    #[tokio::test]
    async fn a_last_line_without_a_newline_is_still_a_line() {
        let (lines, code) = collect("/", "printf 'no-newline'").await;
        assert_eq!(
            lines,
            vec![InstallLine {
                stream: "stdout",
                text: "no-newline".into()
            }]
        );
        assert_eq!(code, Some(0));
    }

    #[tokio::test]
    async fn blank_lines_are_not_output() {
        let (lines, code) = collect("/", "printf '\\n\\n   \\n'").await;
        assert!(lines.is_empty());
        assert_eq!(code, Some(0));
    }

    #[tokio::test]
    async fn a_cwd_that_is_not_there_reads_the_way_node_reads_it() {
        let (lines, code) = collect("/definitely/not/here", "echo hi").await;
        assert_eq!(
            lines,
            vec![InstallLine {
                stream: "stderr",
                text: "spawn /bin/sh ENOENT".into()
            }]
        );
        assert_eq!(code, None);
    }

    #[tokio::test]
    async fn an_exit_code_survives() {
        let (_, code) = collect("/", "exit 7").await;
        assert_eq!(code, Some(7));
    }
}
