//! Reading one agent's configured MCP servers out of its own config file.
//!
//! The three formats agree on very little, so the differences are the point of
//! this module: what makes a server remote, what transport it is reported as,
//! whether its headers survive, whether the agent has project scope at all,
//! and what an unparseable file counts as. Each rule is attached to the
//! [`Reader`] it belongs to rather than applied everywhere.

use super::skills;
use super::{Agent, AgentConfigView, OrderedMap, Reader, RemoteServer, StdioServer};
use serde::Deserialize;
use serde_json::Value;
use std::path::Path;

/// One entry as its config file spells it, before the shape rules apply.
/// Everything is optional because every field is something a user may leave
/// out, and an entry missing all of them is still reported.
#[derive(Debug, Default, Deserialize)]
struct RawServer {
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<OrderedMap<Value>>,
    url: Option<String>,
    /// Antigravity's spelling for a streamable-HTTP server. The other two
    /// readers do not know the key, so an entry using it is not remote to
    /// them at all.
    #[serde(rename = "httpUrl")]
    http_url: Option<String>,
    #[serde(rename = "type")]
    declared_transport: Option<String>,
    /// How the project-scope store spells the same idea.
    transport: Option<String>,
    headers: Option<OrderedMap<Value>>,
}

#[derive(Debug, Default, Deserialize)]
struct JsonConfig {
    #[serde(rename = "mcpServers")]
    mcp_servers: Option<OrderedMap<RawServer>>,
    /// Claude's per-project overrides, keyed by the project's own path.
    projects: Option<OrderedMap<JsonProject>>,
}

#[derive(Debug, Default, Deserialize)]
struct JsonProject {
    #[serde(rename = "mcpServers")]
    mcp_servers: Option<OrderedMap<RawServer>>,
}

#[derive(Debug, Default, Deserialize)]
struct TomlConfig {
    /// Codex spells the same idea in snake case.
    mcp_servers: Option<OrderedMap<RawServer>>,
}

impl Reader {
    /// The URL a remote server is reached at and the transport it is reported
    /// as, or `None` when this entry is not remote to this reader.
    ///
    /// Which key holds the URL is itself per-reader. Claude and Codex know
    /// only `url`; Antigravity also knows `httpUrl`, and prefers it — an
    /// entry carrying both is reached over HTTP at the `httpUrl`.
    fn remote_of(self, raw: &RawServer) -> Option<(&'static str, String)> {
        let url = |value: &Option<String>| value.clone().filter(|url| !url.is_empty());
        match self {
            Self::ClaudeJson => url(&raw.url).map(|url| {
                // The one reader that asks the entry what it is. Anything
                // other than an explicit `sse` is reported as HTTP.
                let transport = if raw.declared_transport.as_deref() == Some("sse") {
                    "sse"
                } else {
                    "http"
                };
                (transport, url)
            }),
            // Codex reads a declared type and then ignores it.
            Self::CodexToml => url(&raw.url).map(|url| ("http", url)),
            Self::ProjectStore => url(&raw.url).map(|url| {
                let transport = if raw.transport.as_deref() == Some("sse") {
                    "sse"
                } else {
                    "http"
                };
                (transport, url)
            }),
            Self::AntigravityJson => url(&raw.http_url)
                .map(|url| ("http", url))
                .or_else(|| url(&raw.url).map(|url| ("sse", url))),
        }
    }

    /// Codex's config has nowhere to put them, so they are not reported.
    fn keeps_headers(self) -> bool {
        !matches!(self, Self::CodexToml)
    }

    /// Only Claude records anything per project *in its own config*. The
    /// other two have their project servers read out of the store instead.
    fn has_project_scope(self) -> bool {
        matches!(self, Self::ClaudeJson)
    }
}

pub(super) fn read(agent: Agent, home: &Path, cwd: &Path) -> AgentConfigView {
    let reader = agent.reader();
    let path = agent.config_path(home);
    let text = std::fs::read_to_string(&path).ok();
    let present = text.is_some();

    let (user_entries, project_entries, parsed) = match (&text, reader) {
        (None, _) => (OrderedMap::new(), OrderedMap::new(), false),
        (Some(text), Reader::CodexToml) => {
            let config: TomlConfig = toml::from_str(text).unwrap_or_default();
            (
                config.mcp_servers.unwrap_or_default(),
                OrderedMap::new(),
                true,
            )
        }
        (Some(text), _) => {
            // Two passes rather than one: whether the file is JSON at all and
            // whether it is JSON of the shape wanted are separate answers, and
            // Claude reports them differently. A `[]` is valid JSON that holds
            // no servers; `{ not json` is not valid JSON at all.
            let valid = serde_json::from_str::<serde::de::IgnoredAny>(text).is_ok();
            let config: JsonConfig = serde_json::from_str(text).unwrap_or_default();
            let project = config
                .projects
                .filter(|_| reader.has_project_scope())
                .and_then(|projects| {
                    // An exact key match, and deliberately not a walk upwards:
                    // Claude keys these by the directory it was started in, so
                    // a subdirectory of a project is not that project.
                    projects
                        .into_iter()
                        .find(|(key, _)| Path::new(key) == cwd)
                        .and_then(|(_, entry)| entry.mcp_servers)
                })
                .unwrap_or_default();
            (config.mcp_servers.unwrap_or_default(), project, valid)
        }
    };

    // Codex and Antigravity report a file they could not parse as present;
    // only Claude treats a file it cannot parse as no config at all.
    let exists = match reader {
        Reader::ClaudeJson => present && parsed,
        _ => present,
    };

    let (mcp_servers, remote_mcp_servers) = split(user_entries, reader);
    // An agent with no project scope of its own still has whatever was
    // recorded for it in the project, and reports it here — otherwise adding
    // a project-scoped server to Codex would leave no trace a listing shows.
    let (project_mcp_servers, project_remote_mcp_servers) = if reader.has_project_scope() {
        split(project_entries, reader)
    } else {
        split(
            super::store::project_entries(cwd, agent),
            Reader::ProjectStore,
        )
    };
    AgentConfigView {
        agent: agent.id(),
        config_path: path.to_string_lossy().into_owned(),
        exists,
        mcp_servers,
        remote_mcp_servers,
        project_mcp_servers,
        project_remote_mcp_servers,
        skills: skills::discover(agent, home, cwd),
    }
}

/// Sort entries into the stdio ones and the remote ones, in file order.
///
/// A command wins over a URL: an entry carrying both is something to run, not
/// something to connect to. An entry carrying neither — or carrying only empty
/// strings — is still reported, as a stdio server with no command, so that a
/// mistyped entry stays visible instead of disappearing from the listing.
fn split(
    entries: OrderedMap<RawServer>,
    reader: Reader,
) -> (OrderedMap<StdioServer>, OrderedMap<RemoteServer>) {
    let mut stdio = OrderedMap::new();
    let mut remote = OrderedMap::new();
    for (key, raw) in entries {
        let command = raw.command.clone().unwrap_or_default();
        if command.is_empty() {
            if let Some((transport, url)) = reader.remote_of(&raw) {
                remote.insert(
                    key,
                    RemoteServer {
                        transport,
                        url,
                        headers: raw.headers.filter(|_| reader.keeps_headers()),
                    },
                );
                continue;
            }
        }
        stdio.insert(
            key,
            StdioServer {
                command,
                args: raw.args,
                env: raw.env,
            },
        );
    }
    (stdio, remote)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries(source: &str) -> OrderedMap<RawServer> {
        serde_json::from_str(source).unwrap()
    }

    #[test]
    fn a_command_wins_over_a_url_and_an_empty_one_is_still_reported() {
        let (stdio, remote) = split(
            entries(
                r#"{
                    "both": {"command": "node", "url": "https://example.test"},
                    "neither": {},
                    "blank": {"command": "", "url": ""},
                    "remote": {"url": "https://example.test"}
                }"#,
            ),
            Reader::ClaudeJson,
        );
        assert_eq!(
            stdio.iter().map(|(key, _)| key).collect::<Vec<_>>(),
            ["both", "neither", "blank"]
        );
        assert_eq!(stdio.get("neither").unwrap().command, "");
        assert_eq!(remote.len(), 1);
        assert!(remote.get("remote").is_some());
    }

    #[test]
    fn each_reader_reports_a_remote_transport_its_own_way() {
        let source = r#"{"one": {"url": "https://example.test", "type": "sse"}}"#;
        let sse = |reader| {
            split(entries(source), reader)
                .1
                .get("one")
                .unwrap()
                .transport
        };
        assert_eq!(sse(Reader::ClaudeJson), "sse");
        // Both of these read the declared type and then ignore it.
        assert_eq!(sse(Reader::CodexToml), "http");
        assert_eq!(sse(Reader::AntigravityJson), "sse");

        let http = r#"{"one": {"url": "https://example.test", "type": "http"}}"#;
        let transport = |reader| split(entries(http), reader).1.get("one").unwrap().transport;
        assert_eq!(transport(Reader::ClaudeJson), "http");
        assert_eq!(transport(Reader::AntigravityJson), "sse");
    }

    #[test]
    fn only_antigravity_knows_what_an_http_url_is() {
        let source = r#"{"one": {"httpUrl": "https://h.test", "url": "https://s.test"}}"#;
        let remote = |reader| split(entries(source), reader).1;

        let antigravity = remote(Reader::AntigravityJson);
        let one = antigravity.get("one").unwrap();
        // `httpUrl` wins, and brings its own transport with it.
        assert_eq!(
            (one.transport, one.url.as_str()),
            ("http", "https://h.test")
        );

        // To the other two the key means nothing, so `url` still decides.
        assert_eq!(
            remote(Reader::ClaudeJson).get("one").unwrap().url,
            "https://s.test"
        );
        assert_eq!(
            remote(Reader::CodexToml).get("one").unwrap().url,
            "https://s.test"
        );
    }

    #[test]
    fn an_http_url_alone_is_not_remote_to_claude_or_codex() {
        let source = r#"{"one": {"httpUrl": "https://h.test"}}"#;
        for reader in [Reader::ClaudeJson, Reader::CodexToml] {
            let (stdio, remote) = split(entries(source), reader);
            assert!(remote.is_empty());
            assert_eq!(stdio.get("one").unwrap().command, "");
        }
    }

    #[test]
    fn only_codex_drops_the_headers_it_was_given() {
        let source = r#"{"one": {"url": "https://example.test", "headers": {"X": "y"}}}"#;
        let headers = |reader| {
            split(entries(source), reader)
                .1
                .get("one")
                .unwrap()
                .headers
                .is_some()
        };
        assert!(headers(Reader::ClaudeJson));
        assert!(headers(Reader::AntigravityJson));
        assert!(!headers(Reader::CodexToml));
    }

    #[test]
    fn entries_keep_the_order_the_file_wrote_them_in() {
        let (stdio, _) = split(
            entries(r#"{"zulu": {"command": "a"}, "alpha": {"command": "b"}}"#),
            Reader::ClaudeJson,
        );
        assert_eq!(
            stdio.iter().map(|(key, _)| key).collect::<Vec<_>>(),
            ["zulu", "alpha"]
        );
    }
}
