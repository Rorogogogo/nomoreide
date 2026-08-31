//! The documentation table `nomoreide_docs` reads from.
//!
//! Prose, not behaviour: every entry below is the text the reference reported
//! for that topic, transcribed from its answers rather than from its source.
//! The one thing that is not a literal is the version in the overview — the
//! reference used to carry a hardcoded one that had drifted four releases
//! behind the package it described, so both runtimes now interpolate their
//! own.

use crate::tools::render;
use serde::Serialize;

/// One documentation topic: the id an agent passes, and what it gets back.
struct Topic {
    id: &'static str,
    title: &'static str,
    body: &'static str,
}

/// The order matters — it is the order the index lists topics in, and the
/// order the argument contract spells the enum it rejects against.
const TOPICS: [Topic; 12] = [
    Topic {
        id: "overview",
        title: "Overview",
        body: "NoMoreIDE v{version} is an AI-native local development workbench for services, activity, Docker, Git and worktrees, GitHub, Vercel, databases, workflows, terminals, and agent environments. It gives humans and AI coding agents one shared local control surface through MCP, CLI, TUI, web, and macOS desktop interfaces.",
    },
    Topic {
        id: "setup",
        title: "Setup",
        body: "Recommended NoMoreIDE agent setup is `npx -y nomoreide setup codex`, `npx -y nomoreide setup claude`, or `npx -y nomoreide setup gemini`; this installs both the local MCP connection and the bundled nomoreide-debug skill. Start a new agent session and verify with `/mcp`. You can also run with `npx -y nomoreide`, install globally with `npm install -g nomoreide`, download the macOS desktop app from GitHub Releases, or build from source.",
    },
    Topic {
        id: "mcp",
        title: "MCP setup",
        body: "NoMoreIDE MCP setup uses a local stdio server. Claude Code: `claude mcp add --transport stdio nomoreide -- npx -y nomoreide`. Codex CLI: `codex mcp add nomoreide -- npx -y nomoreide`. Gemini: add an MCP server named `nomoreide` with command `npx` and args `[\"-y\", \"nomoreide\"]`. Verify inside the agent with `/mcp`.",
    },
    Topic {
        id: "cli",
        title: "CLI reference",
        body: "NoMoreIDE CLI commands include `setup`, `web`, `tui`, `daemon`, `list`, `add service`, `add bundle`, `start`, `stop`, `restart`, `logs`, `git`, `db`, `agents`, and `profile`. Use `nomoreide add service` for local, Docker Compose, or SSH services; `nomoreide agents` to inspect coding-agent configuration; and `nomoreide profile` to snapshot, preview, apply, export, import, publish, or install portable agent setups.",
    },
    Topic {
        id: "dashboard",
        title: "Dashboard",
        body: "The NoMoreIDE web and macOS dashboards include all-project Overview, Services, Activity, Docker, Error Inbox, Terminal, Git Review, GitHub, Vercel, Workflows, Database, Agent Console, Agent Environments, and searchable Settings surfaces. They keep runtime state, logs, diffs, deployments, data, workflows, and agent context visible.",
    },
    Topic {
        id: "tools",
        title: "MCP tool reference",
        body: "NoMoreIDE exposes domain tools for services, repo onboarding, Git and worktrees, snapshots, GitHub, Vercel, errors, database catalog inspection, documentation, UI lifecycle, agent environments, portable profiles, and the hosted profile registry. Fetch `https://www.nomoreide.com/llms-full.txt` for the complete tool-name reference.",
    },
    Topic {
        id: "vercel",
        title: "Vercel",
        body: "Use NoMoreIDE's `nomoreide_deploy_list_projects`, `nomoreide_deploy_list_deployments`, `nomoreide_deploy_get_deployment`, and `nomoreide_deploy_logs` tools to inspect linked deploy-provider projects and diagnose builds. Each takes a `provider` id (default `vercel`). MCP access is read-only; redeploy, cancel, promote, and rollback remain explicit human actions in the dashboard.",
    },
    Topic {
        id: "agent-environments",
        title: "Agent environments and profiles",
        body: "NoMoreIDE can inspect Claude Code, Codex, and Antigravity MCP servers, skills, and plugins; run configuration diagnostics; safely move items between agents and scopes; and package setups as profiles. Preview profile applications before writing. Agent configuration writes create backups, and exported or published profiles redact credentials.",
    },
    Topic {
        id: "safety",
        title: "Safety model",
        body: "NoMoreIDE avoids broad filesystem scans, does not kill external processes it did not start, reports port conflicts instead of terminating processes, omits destructive Git operations like hard reset, clean, force push, and branch deletion, and keeps database MCP tools read-only. Vercel MCP tools are read-only too: agents can inspect deployments and build logs, but redeploy, cancel, promote, and rollback are reachable only from the dashboard. Agent environment writes create backups, and exported or published profiles redact credential values.",
    },
    Topic {
        id: "troubleshooting",
        title: "Troubleshooting",
        body: "For NoMoreIDE troubleshooting, if MCP tools do not appear, re-run setup, restart the agent, verify with `/mcp`, and check that `npx -y nomoreide` works. For service failures, check `nomoreide_service_health`, `nomoreide_read_logs`, and `nomoreide_timeline`. For dashboard port conflicts, use a custom port.",
    },
    Topic {
        id: "architecture",
        title: "Architecture",
        body: "NoMoreIDE has a shared core and daemon for config, processes, logs, activity, Git/worktrees/snapshots, GitHub, Vercel, databases, workflows, agent environments, profiles, and diagnostics. FastMCP exposes narrow domain tools; the local server exposes a React dashboard and REST API; Tauri provides the standalone macOS shell.",
    },
    Topic {
        id: "ai-agent",
        title: "AI agent guide",
        body: "Agents should start with `nomoreide_list_services` and `nomoreide_status`, inspect health and logs before restarting services, inspect Git status and diffs before staging or committing, use read-only database and Vercel MCP tools, preview agent profile changes before applying, and prefer the narrowest matching NoMoreIDE tool over ad hoc shell access.",
    },
];

/// Where the full documentation lives. Every answer carries these, so an
/// agent that needs more than a paragraph knows where to fetch it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Links {
    human_docs: &'static str,
    llms_index: &'static str,
    full_ai_docs: &'static str,
    ai_agent_guide: &'static str,
    github: &'static str,
    npm: &'static str,
}

const LINKS: Links = Links {
    human_docs: "https://www.nomoreide.com/docs",
    llms_index: "https://www.nomoreide.com/llms.txt",
    full_ai_docs: "https://www.nomoreide.com/llms-full.txt",
    ai_agent_guide: "https://www.nomoreide.com/docs/ai-guide.md",
    github: "https://github.com/Rorogogogo/nomoreide",
    npm: "https://www.npmjs.com/package/nomoreide",
};

/// The ids `nomoreide_docs` accepts, in the order its rejection spells them.
pub(crate) const TOPIC_IDS: [&str; TOPICS.len()] = topic_ids();

const fn topic_ids() -> [&'static str; TOPICS.len()] {
    let mut ids = [""; TOPICS.len()];
    let mut index = 0;
    while index < TOPICS.len() {
        ids[index] = TOPICS[index].id;
        index += 1;
    }
    ids
}

/// The `{ id, title }` pairs every answer carries, so an agent that asked for
/// one topic can see what else there is without asking again.
#[derive(Serialize)]
struct TopicRef {
    id: &'static str,
    title: &'static str,
}

#[derive(Serialize)]
struct Answer {
    topic: &'static str,
    title: &'static str,
    body: String,
    topics: Vec<TopicRef>,
    links: Links,
}

/// What an agent gets for one topic, or — with no topic — the index.
///
/// An unknown topic never reaches here: the argument contract rejects it
/// before the tool runs, the way the reference's enum does.
pub(crate) fn docs(topic: Option<&str>) -> Result<String, String> {
    let entry = match topic {
        None => Answer {
            topic: "index",
            title: "NoMoreIDE documentation index",
            body: interpolate(INDEX_BODY),
            topics: listing(),
            links: LINKS,
        },
        Some(requested) => {
            let found = TOPICS
                .iter()
                .find(|entry| entry.id == requested)
                .ok_or_else(|| format!("Unknown documentation topic \"{requested}\"."))?;
            Answer {
                topic: found.id,
                title: found.title,
                body: interpolate(found.body),
                topics: listing(),
                links: LINKS,
            }
        }
    };
    render(&entry)
}

const INDEX_BODY: &str = "NoMoreIDE is an AI-native local development workbench. Pass a topic to `nomoreide_docs` for focused docs, or fetch the canonical docs links included in this response.";

fn listing() -> Vec<TopicRef> {
    TOPICS
        .iter()
        .map(|entry| TopicRef {
            id: entry.id,
            title: entry.title,
        })
        .collect()
}

/// The only substitution these bodies take. Keeping it a placeholder rather
/// than a literal is what stopped the overview from drifting behind the
/// package it describes.
fn interpolate(body: &str) -> String {
    body.replace("{version}", env!("CARGO_PKG_VERSION"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_overview_reports_the_version_this_binary_was_built_as() {
        let payload = docs(Some("overview")).expect("overview renders");
        assert!(payload.contains(&format!("NoMoreIDE v{}", env!("CARGO_PKG_VERSION"))));
        assert!(!payload.contains("{version}"));
    }

    #[test]
    fn every_topic_id_is_listed_by_every_answer() {
        for id in TOPIC_IDS {
            let payload = docs(Some(id)).expect("topic renders");
            for listed in TOPIC_IDS {
                assert!(
                    payload.contains(&format!("\"id\": \"{listed}\"")),
                    "{id} omits {listed}"
                );
            }
        }
    }
}
