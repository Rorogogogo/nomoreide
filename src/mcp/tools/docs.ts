import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { stringify, type ToolContext } from "./context.js";

export const DOC_TOOL_NAMES = ["nomoreide_docs"] as const;

const docsLinks = {
  humanDocs: "https://www.nomoreide.com/docs",
  llmsIndex: "https://www.nomoreide.com/llms.txt",
  fullAiDocs: "https://www.nomoreide.com/llms-full.txt",
  aiAgentGuide: "https://www.nomoreide.com/docs/ai-guide.md",
  github: "https://github.com/Rorogogogo/nomoreide",
  npm: "https://www.npmjs.com/package/nomoreide",
} as const;

const docsTopicSchema = z.enum([
  "overview",
  "setup",
  "mcp",
  "cli",
  "dashboard",
  "tools",
  "vercel",
  "agent-environments",
  "safety",
  "troubleshooting",
  "architecture",
  "ai-agent",
]);

export type NoMoreIdeDocsTopic = z.infer<typeof docsTopicSchema>;

interface DocsTopicEntry {
  id: NoMoreIdeDocsTopic;
  title: string;
  body: string;
}

export interface NoMoreIdeDocsResponse {
  topic: NoMoreIdeDocsTopic | "index";
  title: string;
  body: string;
  topics: Array<{ id: NoMoreIdeDocsTopic; title: string }>;
  links: typeof docsLinks;
}

const topicEntries: DocsTopicEntry[] = [
  {
    id: "overview",
    title: "Overview",
    body:
      "NoMoreIDE v0.1.99 is an AI-native local development workbench for services, activity, Docker, Git and worktrees, GitHub, Vercel, databases, workflows, terminals, and agent environments. It gives humans and AI coding agents one shared local control surface through MCP, CLI, TUI, web, and macOS desktop interfaces.",
  },
  {
    id: "setup",
    title: "Setup",
    body:
      "Recommended NoMoreIDE agent setup is `npx -y nomoreide setup codex`, `npx -y nomoreide setup claude`, or `npx -y nomoreide setup gemini`; this installs both the local MCP connection and the bundled nomoreide-debug skill. Start a new agent session and verify with `/mcp`. You can also run with `npx -y nomoreide`, install globally with `npm install -g nomoreide`, download the macOS desktop app from GitHub Releases, or build from source.",
  },
  {
    id: "mcp",
    title: "MCP setup",
    body:
      "NoMoreIDE MCP setup uses a local stdio server. Claude Code: `claude mcp add --transport stdio nomoreide -- npx -y nomoreide`. Codex CLI: `codex mcp add nomoreide -- npx -y nomoreide`. Gemini: add an MCP server named `nomoreide` with command `npx` and args `[\"-y\", \"nomoreide\"]`. Verify inside the agent with `/mcp`.",
  },
  {
    id: "cli",
    title: "CLI reference",
    body:
      "NoMoreIDE CLI commands include `setup`, `web`, `tui`, `daemon`, `list`, `add service`, `add bundle`, `start`, `stop`, `restart`, `logs`, `git`, `db`, `agents`, and `profile`. Use `nomoreide add service` for local, Docker Compose, or SSH services; `nomoreide agents` to inspect coding-agent configuration; and `nomoreide profile` to snapshot, preview, apply, export, import, publish, or install portable agent setups.",
  },
  {
    id: "dashboard",
    title: "Dashboard",
    body:
      "The NoMoreIDE web and macOS dashboards include all-project Overview, Services, Activity, Docker, Error Inbox, Terminal, Git Review, GitHub, Vercel, Workflows, Database, Agent Console, Agent Environments, and searchable Settings surfaces. They keep runtime state, logs, diffs, deployments, data, workflows, and agent context visible.",
  },
  {
    id: "tools",
    title: "MCP tool reference",
    body:
      "NoMoreIDE exposes domain tools for services, repo onboarding, Git and worktrees, snapshots, GitHub, Vercel, errors, database catalog inspection, documentation, UI lifecycle, agent environments, portable profiles, and the hosted profile registry. Fetch `https://www.nomoreide.com/llms-full.txt` for the complete tool-name reference.",
  },
  {
    id: "vercel",
    title: "Vercel",
    body:
      "Use NoMoreIDE's `nomoreide_vercel_list_projects`, `nomoreide_vercel_list_deployments`, `nomoreide_vercel_get_deployment`, and `nomoreide_vercel_deployment_logs` tools to inspect linked Vercel projects and diagnose builds. MCP access is read-only; redeploy, cancel, promote, and rollback remain explicit human actions in the dashboard.",
  },
  {
    id: "agent-environments",
    title: "Agent environments and profiles",
    body:
      "NoMoreIDE can inspect Claude Code, Codex, and Antigravity MCP servers, skills, and plugins; run configuration diagnostics; safely move items between agents and scopes; and package setups as profiles. Preview profile applications before writing. Agent configuration writes create backups, and exported or published profiles redact credentials.",
  },
  {
    id: "safety",
    title: "Safety model",
    body:
      "NoMoreIDE avoids broad filesystem scans, does not kill external processes it did not start, reports port conflicts instead of terminating processes, omits destructive Git operations like hard reset, clean, force push, and branch deletion, and keeps database MCP tools read-only. Vercel MCP tools are read-only too: agents can inspect deployments and build logs, but redeploy, cancel, promote, and rollback are reachable only from the dashboard. Agent environment writes create backups, and exported or published profiles redact credential values.",
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    body:
      "For NoMoreIDE troubleshooting, if MCP tools do not appear, re-run setup, restart the agent, verify with `/mcp`, and check that `npx -y nomoreide` works. For service failures, check `nomoreide_service_health`, `nomoreide_read_logs`, and `nomoreide_timeline`. For dashboard port conflicts, use a custom port.",
  },
  {
    id: "architecture",
    title: "Architecture",
    body:
      "NoMoreIDE has a shared core and daemon for config, processes, logs, activity, Git/worktrees/snapshots, GitHub, Vercel, databases, workflows, agent environments, profiles, and diagnostics. FastMCP exposes narrow domain tools; the local server exposes a React dashboard and REST API; Tauri provides the standalone macOS shell.",
  },
  {
    id: "ai-agent",
    title: "AI agent guide",
    body:
      "Agents should start with `nomoreide_list_services` and `nomoreide_status`, inspect health and logs before restarting services, inspect Git status and diffs before staging or committing, use read-only database and Vercel MCP tools, preview agent profile changes before applying, and prefer the narrowest matching NoMoreIDE tool over ad hoc shell access.",
  },
];

const topicMap = new Map(topicEntries.map((entry) => [entry.id, entry]));

export function buildNoMoreIdeDocs({
  topic,
}: {
  topic?: NoMoreIdeDocsTopic;
}): NoMoreIdeDocsResponse {
  const topics = topicEntries.map((entry) => ({
    id: entry.id,
    title: entry.title,
  }));

  if (!topic) {
    return {
      topic: "index",
      title: "NoMoreIDE documentation index",
      body:
        "NoMoreIDE is an AI-native local development workbench. Pass a topic to `nomoreide_docs` for focused docs, or fetch the canonical docs links included in this response.",
      topics,
      links: docsLinks,
    };
  }

  const entry = topicMap.get(topic);
  if (!entry) {
    throw new Error(`Unknown NoMoreIDE docs topic: ${topic}`);
  }

  return {
    topic: entry.id,
    title: entry.title,
    body: entry.body,
    topics,
    links: docsLinks,
  };
}

export function registerDocTools(server: FastMCP, _ctx: ToolContext): void {
  server.addTool({
    name: "nomoreide_docs",
    description:
      "Return NoMoreIDE documentation for a topic, or a docs index with canonical links. Use this when you need to understand how NoMoreIDE works, which MCP tools exist, how setup works, or where to fetch the full docs.",
    parameters: z.object({
      topic: docsTopicSchema.optional().describe(
        "Optional docs topic. Omit for the topic index and canonical docs links.",
      ),
    }),
    execute: async ({ topic }) => stringify(buildNoMoreIdeDocs({ topic })),
  });
}
