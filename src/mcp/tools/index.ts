import type { FastMCP } from "fastmcp";
import type { AgentSessionTracker } from "../../core/agent-sessions.js";
import type { ToolCallStore } from "../../core/tool-call-store.js";
import { wrapServerForRecording, type ToolContext } from "./context.js";
import { AGENT_TOOL_NAMES, registerAgentTools } from "./agent.js";
import { AGENT_ENV_TOOL_NAMES, registerAgentEnvTools } from "./agent-env.js";
import { DATABASE_TOOL_NAMES, registerDatabaseTools } from "./database.js";
import { DOC_TOOL_NAMES, registerDocTools } from "./docs.js";
import { ERROR_TOOL_NAMES, registerErrorTools } from "./errors.js";
import { GIT_TOOL_NAMES, registerGitTools } from "./git.js";
import { GITHUB_TOOL_NAMES, registerGithubTools } from "./github.js";
import { ONBOARD_TOOL_NAMES, registerOnboardTools } from "./onboard.js";
import { registerServiceTools, SERVICE_TOOL_NAMES } from "./services.js";
import { registerSnapshotTools, SNAPSHOT_TOOL_NAMES } from "./snapshots.js";

/**
 * Every tool name NoMoreIDE exposes, in registration order. Each domain owns
 * its own slice; this aggregates them — mirroring the web route registry.
 *
 * To add a tool: add it to its domain's `registerXTools` and name list, or add
 * a new domain module and register it below. This aggregator never grows a
 * per-tool branch.
 */
export const NOMOREIDE_TOOL_NAMES = [
  ...SERVICE_TOOL_NAMES,
  ...ONBOARD_TOOL_NAMES,
  ...GIT_TOOL_NAMES,
  ...SNAPSHOT_TOOL_NAMES,
  ...GITHUB_TOOL_NAMES,
  ...ERROR_TOOL_NAMES,
  ...DATABASE_TOOL_NAMES,
  ...DOC_TOOL_NAMES,
  ...AGENT_TOOL_NAMES,
  ...AGENT_ENV_TOOL_NAMES,
] as const;

interface RegisterNoMoreIdeToolsOptions extends ToolContext {
  server: FastMCP;
  toolCallStore?: ToolCallStore;
  agentSessions?: AgentSessionTracker;
}

export function registerNoMoreIdeTools(
  options: RegisterNoMoreIdeToolsOptions,
): void {
  const { server: rawServer, toolCallStore, agentSessions, ...ctx } = options;
  const server = toolCallStore
    ? wrapServerForRecording(rawServer, toolCallStore, agentSessions)
    : rawServer;

  registerServiceTools(server, ctx);
  registerOnboardTools(server, ctx);
  registerGitTools(server, ctx);
  registerSnapshotTools(server, ctx);
  registerGithubTools(server, ctx);
  registerErrorTools(server, ctx);
  registerDatabaseTools(server, ctx);
  registerDocTools(server, ctx);
  registerAgentTools(server, ctx);
  registerAgentEnvTools(server, ctx);
}

export type { ToolContext } from "./context.js";
