/**
 * Agent API contract shared by the browser and embedded desktop daemon clients.
 */

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

export interface ToolCallRecord {
  id: number;
  tool: string;
  startedAt: string;
  durationMs: number;
  status: "ok" | "error";
  args?: string;
  error?: string;
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

export type UsageSource = "claude" | "codex";

export interface UsageHistoryEntry {
  at: string;
  source: UsageSource;
  sessionId?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number;
  models?: string[];
}

export interface UsageDayBucket {
  date: string;
  costUSD: number;
  runs: number;
  totalTokens: number;
}

export interface UsageHistorySummary {
  runs: number;
  totalCostUSD: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  firstAt?: string;
  lastAt?: string;
  byDay: UsageDayBucket[];
  codexTotalTokens: number;
}

export interface UsageHistoryResult {
  entries: UsageHistoryEntry[];
  summary: UsageHistorySummary;
}

export interface ClaudeAgentSettings {
  coAuthorWithClaude: boolean;
}

export interface AgentApi {
  /** Agent CLI introspection; returns an empty profile in desktop mode. */
  getAgentInfo(): Promise<AgentInfo>;
  getMcpAuthStatuses(agent: AgentName): Promise<McpAuthStatus[]>;
  getRecentToolCalls(limit?: number): Promise<ToolCallRecord[]>;
  /** Agent token/cost usage; returns empty in desktop mode. */
  getAgentUsage(): Promise<UsageInfo>;
  /** Persisted token/cost history with an aggregate summary (cost/run over time). */
  getAgentUsageHistory(since?: string): Promise<UsageHistoryResult>;
  getClaudeAgentSettings(): Promise<ClaudeAgentSettings>;
  updateClaudeAgentSettings(
    settings: Partial<ClaudeAgentSettings>,
  ): Promise<ClaudeAgentSettings>;
}
