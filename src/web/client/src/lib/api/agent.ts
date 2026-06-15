import { requestJson } from "./client.js";
import { isTauri } from "./tauri-bridge.js";

export interface AgentMemoryFile {
  path: string;
  name: string;
  size: number;
  preview: string;
}

export interface AgentSkill {
  name: string;
  scope: "user" | "project" | "plugin" | "system";
  path: string;
  description?: string;
}

export interface AgentMcpServer {
  name: string;
  scope: "user" | "project";
  command?: string;
  args?: string[];
  type?: string;
  url?: string;
}

export interface AgentPlugin {
  name: string;
  marketplace?: string;
  scope: "user" | "project";
  version?: string;
  installPath?: string;
  description?: string;
  skills: string[];
  commands: string[];
  agents: string[];
  mcpServers: string[];
}

export interface AgentHook {
  id: string;
  event: string;
  scope: "user" | "project";
  settingsPath: string;
  matcher?: string;
  type?: string;
  command?: string;
  status: "enabled" | "disabled" | "default";
  trusted?: boolean;
}

export interface AgentProjectEntry {
  path: string;
  current: boolean;
  lastSessionFirstPrompt?: string;
  lastSessionModified?: string;
  mcpServerCount: number;
}

export interface AgentProfile {
  project: {
    cwd: string;
    instructionFilePath?: string;
    instructionFileName?: string;
    instructionFilePreview?: string;
    claudeMdPath?: string;
    claudeMdPreview?: string;
    memoryDir?: string;
    memoryFiles: AgentMemoryFile[];
  };
  skills: AgentSkill[];
  mcpServers: AgentMcpServer[];
  plugins: AgentPlugin[];
  hooks: AgentHook[];
  projects: AgentProjectEntry[];
}

export interface AgentInfo extends AgentProfile {
  detected: {
    name: "claude-code" | "codex" | "gemini" | "unknown";
    label: string;
    signals: string[];
    parentProcess?: string;
  };
  agents: {
    "claude-code": AgentProfile;
    codex: AgentProfile;
  };
}

const _emptyProfile: AgentProfile = {
  project: { cwd: "", memoryFiles: [] },
  skills: [],
  mcpServers: [],
  plugins: [],
  hooks: [],
  projects: [],
};

/** Agent CLI introspection is not available in desktop mode; returns an empty profile. */
export async function getAgentInfo(): Promise<AgentInfo> {
  if (isTauri()) {
    return {
      ..._emptyProfile,
      detected: { name: "unknown", label: "Desktop mode", signals: [] },
      agents: { "claude-code": _emptyProfile, codex: _emptyProfile },
    };
  }
  const response = await requestJson<{ ok: true; agent: AgentInfo }>("/api/agent");
  return response.agent;
}

export type AgentName = "claude-code" | "codex";

/** Live auth/connection state of an MCP server, as reported by the agent's CLI. */
export type McpAuthState =
  | "connected"
  | "needs-auth"
  | "no-auth"
  | "failed"
  | "unknown";

export interface McpAuthStatus {
  name: string;
  state: McpAuthState;
}

export async function getMcpAuthStatuses(agent: AgentName): Promise<McpAuthStatus[]> {
  const response = await requestJson<{ ok: true; statuses: McpAuthStatus[] }>(
    `/api/agent/mcp-status?agent=${encodeURIComponent(agent)}`,
  );
  return response.statuses;
}

export interface ToolCallRecord {
  id: number;
  tool: string;
  startedAt: string;
  durationMs: number;
  status: "ok" | "error";
  args?: string;
  error?: string;
}

export async function getRecentToolCalls(limit = 100): Promise<ToolCallRecord[]> {
  const response = await requestJson<{ ok: true; records: ToolCallRecord[] }>(
    `/api/agent/tool-calls?limit=${limit}`,
  );
  return response.records;
}

export interface ClaudeModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
}

export interface ClaudeRateLimitWindow {
  usedPercent: number;
  resetsAtUnix: number;
}

export interface ClaudeUsage {
  cwd: string;
  sessionId?: string;
  costUSD: number;
  durationMs: number;
  apiDurationMs: number;
  linesAdded: number;
  linesRemoved: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  webSearchRequests: number;
  models: ClaudeModelUsage[];
  fiveHour?: ClaudeRateLimitWindow;
  weekly?: ClaudeRateLimitWindow;
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  resetsAtUnix: number;
  windowMinutes?: number;
}

export interface CodexUsage {
  timestamp?: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  lastInputTokens: number;
  lastCachedInputTokens: number;
  lastOutputTokens: number;
  lastReasoningOutputTokens: number;
  lastTotalTokens: number;
  contextWindow?: number;
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow;
}

export interface UsageInfo {
  claude?: ClaudeUsage;
  codex?: CodexUsage;
}

export async function getAgentUsage(): Promise<UsageInfo> {
  if (isTauri()) return {};
  const response = await requestJson<{ ok: true; usage: UsageInfo }>("/api/agent/usage");
  return response.usage;
}

export interface ClaudeAgentSettings {
  coAuthorWithClaude: boolean;
}

export async function getClaudeAgentSettings(): Promise<ClaudeAgentSettings> {
  const response = await requestJson<{ ok: true; settings: ClaudeAgentSettings }>(
    "/api/agent/claude-settings",
  );
  return response.settings;
}

export async function updateClaudeAgentSettings(
  settings: Partial<ClaudeAgentSettings>,
): Promise<ClaudeAgentSettings> {
  const response = await requestJson<{ ok: true; settings: ClaudeAgentSettings }>(
    "/api/agent/claude-settings",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    },
  );
  return response.settings;
}
