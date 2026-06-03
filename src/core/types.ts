import type { ProcessTreeSummary } from "./process-tree.js";
import type { PortBindingStatus } from "./port-utils.js";
import type { Workflow } from "./workflows.js";

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

export type DatabaseEngine = "postgres" | "mysql" | "sqlite";

/**
 * A read-only database connection for DB Peek. For `postgres`/`mysql`, `url` is
 * the connection string (stored like a secret, masked in API responses). For
 * `sqlite`, `url` is an absolute path to the `.db` file.
 */
export interface DatabaseConnection {
  name: string;
  engine: DatabaseEngine;
  url: string;
}

export type LogSourceKind = "file" | "ssh" | "command";

/**
 * Structured log backend. When set, the source builds its own query (time
 * range, text filter, level) instead of a fixed `tail`, pushing the work down
 * to the host. Runs over ssh when `host` is set, otherwise locally.
 */
export type LogDriver = "journald" | "docker";

/**
 * A named, on-demand log reader (e.g. "UAT", "PROD") that is *not* tied to a
 * managed process. `file` tails a local path, `ssh` tails a path on a remote
 * host via the local ssh binary + ~/.ssh/config, and `command` runs an
 * arbitrary command (journalctl, kubectl logs, …) and treats its output as log.
 *
 * Setting `driver` upgrades the source to a query backend: `journald` filters
 * server-side via journalctl flags, `docker` via `docker logs` windowing.
 */
export interface LogSourceDefinition {
  name: string;
  kind: LogSourceKind;
  /** Absolute path for `file`; remote path for `ssh`. */
  path?: string;
  /** SSH host/alias for `ssh`, and for any `driver` source run remotely. */
  host?: string;
  /** Command line for `command`. */
  command?: string;
  /** Optional working directory for `command`. */
  cwd?: string;
  /** Query backend. When set, `since`/`until`/`grep`/`level` are honored. */
  driver?: LogDriver;
  /** systemd unit for `driver: "journald"`. */
  unit?: string;
  /** container name/id for `driver: "docker"`. */
  container?: string;
}

/**
 * Read-time query for a log source. Honored fully by `journald` (server-side
 * journalctl flags) and partially by `docker` (time window server-side, text +
 * level filtered client-side); for plain file/ssh/command sources `grep`/`level`
 * are applied client-side and `since`/`until`/`cursor` are ignored.
 */
export interface LogQuery {
  /** Start of time window, e.g. "today", "1 hour ago", "2026-05-24 00:00". */
  since?: string;
  /** End of time window. */
  until?: string;
  /** Case-insensitive text/regex filter. */
  grep?: string;
  /** Minimum severity to include. */
  level?: "warn" | "error";
  /** Max lines (tail). */
  lines?: number;
  /** journald cursor to page *newer* than (`--after-cursor`). */
  cursor?: string;
  /** journald cursor to page *older* than — returns the `lines` entries before it. */
  before?: string;
}

export interface GitHubToken {
  host: string;
  token: string;
}

export interface NoMoreIdeConfig {
  version: 1;
  services: ServiceDefinition[];
  bundles: BundleDefinition[];
  gitRepositories: GitRepositoryDefinition[];
  selectedGitRepository?: string;
  databases: DatabaseConnection[];
  logSources: LogSourceDefinition[];
  githubTokens: GitHubToken[];
  /** User-saved git/GitHub workflows (forks/edits of the built-in templates). */
  workflows: Workflow[];
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
  /** journald `__CURSOR` for sources that support it; enables "load older" paging. */
  cursor?: string;
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
