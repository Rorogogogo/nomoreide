//! The compiled dashboard: the SPA shell and the files under `/assets/`.
//!
//! Rust counterpart of `src/web/static-assets.ts` and `src/web/routes/
//! shell-routes.ts`. Nothing here is an API — it is the one part of the daemon
//! a browser reaches without a credential, because a document load cannot
//! carry an `Authorization` header.
//!
//! Asset *roots* are tried in order and the first that holds the file wins, the
//! way the reference walks its own candidate list. That is what lets one binary
//! serve a repo checkout, a packaged install, and a test fixture without
//! knowing which it is in.

use std::path::{Component, Path, PathBuf};

/// Points the daemon at a `dist/web/client` it could not have guessed —
/// a packaged layout, or a test that builds its own.
pub(crate) const WEB_ROOT_ENV: &str = "NOMOREIDE_WEB_ROOT";

/// Paths that serve the SPA shell; client-side routing handles the rest.
///
/// Must stay in sync with `shellPaths` in `src/web/routes/shell-routes.ts`,
/// which is itself kept in sync with the client's `PAGE_PATHS`. A page the
/// client routes to but this set omits works when navigated to in-app and 404s
/// on direct load or refresh.
const SHELL_PATHS: &[&str] = &[
    "/",
    "/services",
    "/activity",
    "/servers",
    "/docker",
    "/git",
    "/github",
    "/workflows",
    "/agent",
    "/agent-env",
    "/context",
    "/extensions",
    "/errors",
    "/database",
    "/settings",
];

/// Prefixes that also serve the shell, for pages whose last segment is *data*
/// rather than a route known in advance. `/extensions/<id>` is the only one:
/// which plugins exist comes from the registry.
const SHELL_PREFIXES: &[&str] = &["/extensions/"];

/// Collapse `.` and `..` segments the way a URL parser does, before anything
/// looks at the path.
///
/// **This is what the reference gets for free.** `src/web/server.ts` builds a
/// WHATWG `URL` from the request line, and that parser normalizes dot segments
/// during parsing — by the time any route sees `url.pathname`, a request for
/// `/assets/../index.html` has already become `/index.html`. axum hands over
/// the path exactly as it arrived, so without this the two runtimes disagree
/// about what was even asked for: the reference 404s that request while a
/// literal read would find the file and serve it.
///
/// The `%2e` spellings are collapsed too, because the URL spec counts them as
/// dot segments. No client sends them — `fetch` normalizes them away before
/// the request leaves — but a hand-written request can, and the reference
/// would still normalize it.
pub(crate) fn normalize_request_path(path: &str) -> String {
    let mut segments: Vec<&str> = Vec::new();
    // Whether the path, as normalized so far, ends at a slash. A dot segment
    // leaves one behind — the URL parser turns `/a/..` into `/` — and so does
    // an empty segment, which is what a trailing slash splits into. Getting
    // this wrong silently turns `/extensions/` into `/extensions`, which is a
    // page, and the difference between a 404 and the dashboard.
    let mut trailing_slash = false;
    for segment in path.split('/') {
        match dot_segment(segment) {
            Some(Dots::One) => trailing_slash = true,
            Some(Dots::Two) => {
                segments.pop();
                trailing_slash = true;
            }
            None => {
                if segment.is_empty() {
                    trailing_slash = true;
                    continue;
                }
                segments.push(segment);
                trailing_slash = false;
            }
        }
    }
    let mut normalized = String::from("/");
    normalized.push_str(&segments.join("/"));
    if trailing_slash && !normalized.ends_with('/') {
        normalized.push('/');
    }
    normalized
}

enum Dots {
    One,
    Two,
}

/// A single- or double-dot segment, in any of the spellings the URL spec
/// treats as one.
fn dot_segment(segment: &str) -> Option<Dots> {
    match segment.to_ascii_lowercase().as_str() {
        "." | "%2e" => Some(Dots::One),
        ".." | "%2e." | ".%2e" | "%2e%2e" => Some(Dots::Two),
        _ => None,
    }
}

/// Whether a path should serve the SPA shell.
pub(crate) fn serves_shell(pathname: &str) -> bool {
    if SHELL_PATHS.contains(&pathname) {
        return true;
    }
    SHELL_PREFIXES.iter().any(|prefix| {
        // A bare prefix with nothing after it is not a page: `/extensions`
        // already is one, and `/extensions/` should not quietly render as the
        // same thing.
        pathname.starts_with(prefix) && pathname.len() > prefix.len()
    })
}

/// The shell HTML, from the first candidate that exists.
pub(crate) fn read_shell() -> Result<String, String> {
    for root in asset_roots() {
        if let Ok(html) = std::fs::read_to_string(root.join("index.html")) {
            return Ok(html);
        }
    }
    // The source index, so `cargo run` in a checkout that has never been built
    // still renders something rather than a bare error.
    for root in repo_candidates() {
        if let Ok(html) = std::fs::read_to_string(root.join("apps/dashboard/index.html")) {
            return Ok(html);
        }
    }
    Err("React web app shell was not found. Run npm run build.".to_string())
}

/// One asset's bytes and content type, or `None` when no root holds it.
pub(crate) fn read_asset(request_path: &str) -> Option<(Vec<u8>, &'static str)> {
    let relative = request_path.trim_start_matches('/');
    for root in asset_roots() {
        let Some(path) = resolve_inside(&root, relative) else {
            // Climbing out of this root is not an error worth reporting: the
            // next root gets the same request, exactly as the reference's loop
            // `continue`s rather than returning.
            continue;
        };
        if let Ok(bytes) = std::fs::read(&path) {
            return Some((bytes, content_type_for(&path)));
        }
    }
    None
}

/// Join `relative` under `root`, refusing anything that lands outside it.
///
/// **Defense in depth, not the front line.** Every request path is normalized
/// before it gets here, so no `..` survives to reach this function over HTTP —
/// a seeded sweep that removed this check entirely could not make the shell
/// parity gate fail. The unit tests below are its coverage, and it stays
/// because the normalizer is not the only caller this could ever have.
///
/// **Not the reference's check, on purpose.** `src/web/static-assets.ts` tested
/// `assetPath.startsWith(root)`, a *string* prefix, so a request for
/// `/assets/../../client-evil/x` resolved to the sibling directory
/// `…/web/client-evil/x` and passed — the prefix matched without a separator
/// after it. This compares whole path components instead, and the TypeScript
/// was fixed the same way in the same change; a directory escape is not a
/// divergence worth preserving for parity.
fn resolve_inside(root: &Path, relative: &str) -> Option<PathBuf> {
    let mut resolved = root.to_path_buf();
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(part) => resolved.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                // Popping past the root is what an escape looks like before it
                // has anywhere to go.
                if !resolved.pop() || !resolved.starts_with(root) {
                    return None;
                }
            }
            // An absolute or prefixed component would replace the root outright.
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    resolved.starts_with(root).then_some(resolved)
}

/// Where the built client may live, most specific first.
fn asset_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(configured) = std::env::var_os(WEB_ROOT_ENV) {
        roots.push(PathBuf::from(configured));
    }
    for candidate in repo_candidates() {
        roots.push(candidate.join("dist/web/client"));
    }
    if let Some(directory) = executable_directory() {
        // A packaged layout, where the client sits beside the binary rather
        // than under a repository's `dist/`.
        roots.push(directory.join("web/client"));
    }
    roots
}

/// Directories that may be a repository root, walking up from the executable:
/// `target/debug/nomoreide` is two levels down from one.
fn repo_candidates() -> Vec<PathBuf> {
    let Some(directory) = executable_directory() else {
        return Vec::new();
    };
    let mut candidates = Vec::new();
    let mut current = Some(directory.as_path());
    for _ in 0..4 {
        let Some(path) = current else { break };
        candidates.push(path.to_path_buf());
        current = path.parent();
    }
    candidates
}

fn executable_directory() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()?
        .parent()
        .map(Path::to_path_buf)
}

/// The reference's own switch, extension for extension. Notably `.ttf` is not
/// in it — the bundled Nerd Font ships as `application/octet-stream`, and
/// browsers load it from `@font-face` regardless, so "fixing" the type here
/// would be a divergence that buys nothing.
fn content_type_for(path: &Path) -> &'static str {
    match path.extension().and_then(|value| value.to_str()) {
        Some("css") => "text/css; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_path_normalizes_to_itself() {
        assert_eq!(normalize_request_path("/assets/app.js"), "/assets/app.js");
        assert_eq!(normalize_request_path("/"), "/");
    }

    #[test]
    fn dot_segments_collapse_the_way_a_url_parser_collapses_them() {
        assert_eq!(
            normalize_request_path("/assets/../index.html"),
            "/index.html"
        );
        assert_eq!(normalize_request_path("/assets/./app.js"), "/assets/app.js");
        assert_eq!(
            normalize_request_path("/assets/../../../package.json"),
            "/package.json"
        );
        assert_eq!(
            normalize_request_path("/assets/../../client-evil/secret.js"),
            "/client-evil/secret.js"
        );
    }

    #[test]
    fn climbing_past_the_root_stops_at_it() {
        assert_eq!(normalize_request_path("/../../etc/passwd"), "/etc/passwd");
        assert_eq!(normalize_request_path("/.."), "/");
    }

    /// The URL spec counts these spellings as dot segments, so the reference's
    /// parser collapses them before any route is consulted.
    #[test]
    fn percent_encoded_dots_are_dot_segments() {
        assert_eq!(
            normalize_request_path("/assets/%2e%2e/package.json"),
            "/package.json"
        );
        assert_eq!(
            normalize_request_path("/assets/%2E./package.json"),
            "/package.json"
        );
        assert_eq!(
            normalize_request_path("/assets/%2e/app.js"),
            "/assets/app.js"
        );
    }

    #[test]
    fn a_trailing_slash_survives() {
        assert_eq!(normalize_request_path("/assets/"), "/assets/");
        assert_eq!(normalize_request_path("/extensions/"), "/extensions/");
    }

    #[test]
    fn known_pages_serve_the_shell() {
        assert!(serves_shell("/"));
        assert!(serves_shell("/services"));
        assert!(serves_shell("/agent-env"));
    }

    #[test]
    fn unknown_paths_do_not_serve_the_shell() {
        assert!(!serves_shell("/nope"));
        assert!(!serves_shell("/api/status"));
        assert!(!serves_shell("/services/extra"));
    }

    #[test]
    fn an_extension_id_serves_the_shell_but_the_bare_prefix_does_not() {
        assert!(serves_shell("/extensions/some-plugin"));
        assert!(
            !serves_shell("/extensions/"),
            "a trailing slash names no plugin"
        );
        // The bare page is in the exact set rather than the prefix.
        assert!(serves_shell("/extensions"));
    }

    #[test]
    fn a_path_inside_the_root_resolves() {
        let root = Path::new("/srv/client");
        assert_eq!(
            resolve_inside(root, "assets/app.js"),
            Some(PathBuf::from("/srv/client/assets/app.js"))
        );
    }

    #[test]
    fn dot_segments_that_stay_inside_are_allowed() {
        let root = Path::new("/srv/client");
        assert_eq!(
            resolve_inside(root, "assets/../assets/./app.js"),
            Some(PathBuf::from("/srv/client/assets/app.js"))
        );
    }

    #[test]
    fn climbing_out_of_the_root_is_refused() {
        let root = Path::new("/srv/client");
        assert_eq!(resolve_inside(root, "../secret"), None);
        assert_eq!(resolve_inside(root, "assets/../../secret"), None);
    }

    /// The escape the reference's string-prefix check let through: a sibling
    /// directory whose name merely *starts with* the root's.
    #[test]
    fn a_sibling_whose_name_extends_the_root_is_refused() {
        let root = Path::new("/srv/client");
        assert_eq!(resolve_inside(root, "../client-evil/secret"), None);
        assert_eq!(
            resolve_inside(root, "assets/../../client-evil/secret"),
            None
        );
    }

    #[test]
    fn an_absolute_request_cannot_replace_the_root() {
        let root = Path::new("/srv/client");
        assert_eq!(resolve_inside(root, "/etc/passwd"), None);
    }

    #[test]
    fn content_types_match_the_reference_switch() {
        assert_eq!(
            content_type_for(Path::new("a.css")),
            "text/css; charset=utf-8"
        );
        assert_eq!(
            content_type_for(Path::new("a.js")),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(content_type_for(Path::new("a.svg")), "image/svg+xml");
        assert_eq!(content_type_for(Path::new("a.png")), "image/png");
        assert_eq!(content_type_for(Path::new("a.woff2")), "font/woff2");
        // Deliberately unlisted upstream, so deliberately unlisted here.
        assert_eq!(
            content_type_for(Path::new("a.ttf")),
            "application/octet-stream"
        );
        assert_eq!(content_type_for(Path::new("a")), "application/octet-stream");
    }
}
