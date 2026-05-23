import type { ProcessTreeSummary } from "./process-tree.js";
import type { PortBindingStatus } from "./port-utils.js";

export type ServiceKind = "local" | "docker-compose" | "ssh";

export interface ServiceDefinition {
  name: string;
  kind?: ServiceKind;
  port?: number;
  description?: string;
  /** Test Runner command; defaults to `npm test` when absent. */
  test?: string;
  // local + ssh
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  // docker-compose
  composeFile?: string;
  composeService?: string;
  // ssh
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

export interface NoMoreIdeConfig {
  version: 1;
  services: ServiceDefinition[];
  bundles: BundleDefinition[];
  gitRepositories: GitRepositoryDefinition[];
  selectedGitRepository?: string;
}

export type ServiceState = "stopped" | "starting" | "running" | "exited";

export interface ServiceStatus {
  name: string;
  state: ServiceState;
  pid?: number;
  url?: string;
  startedAt?: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
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

export type LogStream = "stdout" | "stderr";

export interface LogEntry {
  service: string;
  stream: LogStream;
  text: string;
  timestamp: string;
}

export type ServiceHealthStatus =
  | "unknown"
  | "healthy"
  | "warning"
  | "unhealthy";

export interface HealthCheckResult {
  name: string;
  ok: boolean;
  summary: string;
  latencyMs?: number;
}

export interface ServiceHealth {
  service: string;
  status: ServiceHealthStatus;
  summary: string;
  checkedAt: string;
  checks: HealthCheckResult[];
  processTree?: ProcessTreeSummary;
  ports: PortBindingStatus[];
  lastErrorLog?: LogEntry;
  agentContext: string;
}

export type TimelineEventKind =
  | "service.lifecycle"
  | "service.log"
  | "service.health"
  | "service.port"
  | "service.http"
  | "mcp.tool"
  | "git.change"
  | "user.action";

export interface TimelineEvent {
  id: string;
  timestamp: string;
  kind: TimelineEventKind;
  service?: string;
  severity: "info" | "warning" | "error";
  title: string;
  detail?: string;
  data?: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  message: string;
}
