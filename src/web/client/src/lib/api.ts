export type ServiceKind = "local" | "docker-compose" | "ssh";

export interface ServiceDefinition {
  name: string;
  kind?: ServiceKind;
  command?: string;
  cwd?: string;
  port?: number;
  description?: string;
  composeFile?: string;
  composeService?: string;
  host?: string;
}

export interface BundleDefinition {
  name: string;
  services: string[];
}

export interface GitRepositoryDefinition {
  name: string;
  path: string;
}

export interface ServiceStatus {
  name: string;
  state: "stopped" | "starting" | "running" | "exited";
  pid?: number;
  url?: string;
  startedAt?: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  processTree?: ProcessTreeSummary;
  kind?: ServiceKind;
  containerId?: string;
  host?: string;
  inspector?: InspectorStatus;
}

export interface InspectorStatus {
  enabled: boolean;
  port?: number;
  upstreamPort?: number;
}

export interface ProcessTreeSummary {
  rootPid: number;
  processCount: number;
  cpuPercent: number;
  rssMb: number;
  processes: ProcessRow[];
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  cpuPercent: number;
  rssMb: number;
  command: string;
}

export interface PortOverview {
  port: number;
  available: boolean;
  hosts: HostPortStatus[];
  state: "available" | "managed" | "occupied";
  services: string[];
  urls: string[];
}

export interface HostPortStatus {
  host: string;
  available: boolean;
  errorCode?: string;
}

export interface LogEntry {
  service: string;
  stream: "stdout" | "stderr";
  text: string;
  timestamp: string;
}

export interface ServiceHealth {
  service: string;
  status: "unknown" | "healthy" | "warning" | "unhealthy";
  summary: string;
  checkedAt: string;
  checks: HealthCheckResult[];
  processTree?: ProcessTreeSummary;
  ports: PortOverview[];
  lastErrorLog?: LogEntry;
  agentContext: string;
}

export interface HealthCheckResult {
  name: string;
  ok: boolean;
  summary: string;
  latencyMs?: number;
}

export interface TimelineEvent {
  id: string;
  timestamp: string;
  kind:
    | "service.lifecycle"
    | "service.log"
    | "service.health"
    | "service.port"
    | "service.http"
    | "mcp.tool"
    | "git.change"
    | "user.action";
  service?: string;
  severity: "info" | "warning" | "error";
  title: string;
  detail?: string;
  data?: Record<string, unknown>;
}

export interface ServiceTestResult {
  ok: boolean;
  message: string;
  exitCode?: number | null;
  signal?: string | null;
  stdout: string[];
  stderr: string[];
}

export interface GitFileStatus {
  path: string;
  index: string;
  workingTree: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream?: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
}

export interface DirectoryListing {
  ok: true;
  path: string;
  parent: string;
  entries: DirectoryEntry[];
}

export interface DashboardData {
  ok: true;
  cwd: string;
  config: {
    services: ServiceDefinition[];
    bundles: BundleDefinition[];
    gitRepositories: GitRepositoryDefinition[];
    selectedGitRepository?: string;
  };
  runtime: {
    services: Record<string, ServiceStatus>;
  };
  ports: PortOverview[];
  health: Record<string, ServiceHealth>;
  timeline: TimelineEvent[];
  logs: LogEntry[];
  git: {
    cwd: string;
    selectedRepository: GitRepositoryDefinition | null;
    status:
      | {
          branch: string;
          files: GitFileStatus[];
        }
      | null;
    branches: GitBranch[];
    error?: string;
  };
}

export async function getDashboard(): Promise<DashboardData> {
  return requestJson<DashboardData>("/api/dashboard");
}

export interface AgentMemoryFile {
  path: string;
  name: string;
  size: number;
  preview: string;
}

export interface AgentSkill {
  name: string;
  scope: "user" | "project" | "plugin";
  path: string;
  description?: string;
}

export interface AgentMcpServer {
  name: string;
  scope: "user" | "project";
  command?: string;
  type?: string;
  url?: string;
}

export interface AgentProjectEntry {
  path: string;
  current: boolean;
  lastSessionFirstPrompt?: string;
  lastSessionModified?: string;
  mcpServerCount: number;
}

export interface AgentInfo {
  detected: {
    name: "claude-code" | "codex" | "gemini" | "unknown";
    label: string;
    signals: string[];
    parentProcess?: string;
  };
  project: {
    cwd: string;
    claudeMdPath?: string;
    claudeMdPreview?: string;
    memoryDir?: string;
    memoryFiles: AgentMemoryFile[];
  };
  skills: AgentSkill[];
  mcpServers: AgentMcpServer[];
  projects: AgentProjectEntry[];
}

export async function getAgentInfo(): Promise<AgentInfo> {
  const response = await requestJson<{ ok: true; agent: AgentInfo }>("/api/agent");
  return response.agent;
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
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow;
}

export interface UsageInfo {
  claude?: ClaudeUsage;
  codex?: CodexUsage;
}

export async function getAgentUsage(): Promise<UsageInfo> {
  const response = await requestJson<{ ok: true; usage: UsageInfo }>("/api/agent/usage");
  return response.usage;
}

export async function getGitDiff(path: string): Promise<string> {
  const response = await fetch(`/api/git/diff?file=${encodeURIComponent(path)}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error || "Unable to load diff");
  }
  return response.text();
}

export async function getDirectories(path: string): Promise<DirectoryListing> {
  return requestJson<DirectoryListing>(
    `/api/fs/directories?path=${encodeURIComponent(path)}`,
  );
}

export async function getServiceLogs(name: string): Promise<LogEntry[]> {
  const response = await requestJson<{ ok: true; logs: LogEntry[] }>(
    `/api/services/${encodeURIComponent(name)}/logs`,
  );
  return response.logs;
}

export async function postForm(
  url: string,
  values: Record<string, string | number | undefined>,
): Promise<void> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && String(value).trim()) {
      body.set(key, String(value));
    }
  }

  await requestJson(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

export async function testServiceCommand(
  values: Record<string, string | number | undefined>,
): Promise<ServiceTestResult> {
  return postFormForJson<ServiceTestResult>("/api/services/test", values);
}

async function postFormForJson<T>(
  url: string,
  values: Record<string, string | number | undefined>,
): Promise<T> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && String(value).trim()) {
      body.set(key, String(value));
    }
  }

  return requestJson<T>(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

export interface PortConflictDetail {
  code: "PORT_IN_USE";
  port: number;
  holder: { pid: number; pgid?: number; command: string } | null;
}

export class PortConflictResponseError extends Error {
  readonly conflict: PortConflictDetail;
  constructor(message: string, conflict: PortConflictDetail) {
    super(message);
    this.name = "PortConflictResponseError";
    this.conflict = conflict;
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    if (response.status === 409 && body?.conflict?.code === "PORT_IN_USE") {
      throw new PortConflictResponseError(
        body?.error || "Port already in use",
        body.conflict as PortConflictDetail,
      );
    }
    throw new Error(body?.error || response.statusText);
  }
  return body as T;
}
