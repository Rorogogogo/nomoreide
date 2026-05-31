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
      "NoMoreIDE is an AI-native local development workbench for services, logs, Git review, database inspection, terminal access, and MCP workflows. It gives humans and AI coding agents one shared local control surface.",
  },
  {
    id: "setup",
    title: "Setup",
    body:
      "Run NoMoreIDE with `npx -y nomoreide`, install it globally with `npm install -g nomoreide`, or build from source with `npm install` and `npm run build`. Connect agents by registering a stdio MCP server that runs `npx -y nomoreide`.",
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
      "NoMoreIDE CLI commands include `setup`, `web`, `tui`, `list`, `add service`, `add bundle`, `start`, `stop`, `restart`, `logs`, and `git` subcommands. Use `nomoreide add service` to register local, Docker Compose, or SSH-backed services.",
  },
  {
    id: "dashboard",
    title: "Dashboard",
    body:
      "The NoMoreIDE dashboard runs locally and includes Services, Git Review, Error Inbox, Database, Terminal, Agent, and Docs pages. Use it to keep service state, logs, diffs, data, and agent context visible.",
  },
  {
    id: "tools",
    title: "MCP tool reference",
    body:
      "NoMoreIDE exposes tools for services, repo onboarding, Git, errors, database inspection, UI lifecycle, and docs. Important tools include `nomoreide_list_services`, `nomoreide_status`, `nomoreide_service_health`, `nomoreide_read_logs`, `nomoreide_git_status`, `nomoreide_git_diff`, `nomoreide_db_tables`, `nomoreide_open_ui`, and `nomoreide_docs`.",
  },
  {
    id: "safety",
    title: "Safety model",
    body:
      "NoMoreIDE avoids broad filesystem scans, does not kill external processes it did not start, reports port conflicts instead of terminating processes, omits destructive Git operations like hard reset, clean, force push, and branch deletion, and keeps database MCP tools read-only.",
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
      "NoMoreIDE has a shared core layer for config, processes, logs, Git, health, database inspection, timeline, and error inbox. The MCP server wraps those core modules as FastMCP tools. The web server serves a React dashboard and REST API over localhost.",
  },
  {
    id: "ai-agent",
    title: "AI agent guide",
    body:
      "Agents should start with `nomoreide_list_services` and `nomoreide_status`, inspect health and logs before restarting services, inspect Git status and diffs before staging or committing, and prefer NoMoreIDE tools over ad hoc shell commands when an equivalent tool exists.",
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
