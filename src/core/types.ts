import type { ProcessTreeSummary } from "./process-tree.js";
import type { PortBindingStatus } from "./port-utils.js";
import type { Workflow } from "./workflows.js";
import type { WorkflowTrigger } from "./workflow-triggers.js";

export type ServiceKind = "local" | "docker-compose" | "ssh";

/**
 * A reusable remote machine reached through the user's OpenSSH configuration.
 * NoMoreIDE stores only presentation metadata; credentials remain owned by
 * ~/.ssh/config and ssh-agent.
 */
export interface SshServerDefinition {
  /** Host alias passed to `ssh`, normally an explicit Host in ~/.ssh/config. */
  host: string;
  /** Optional human-friendly label; falls back to `host`. */
  name?: string;
  /** Free-form environment label such as Development, UAT, or Production. */
  environment?: string;
}

export interface ServiceDefinition {
  name: string;
  kind?: ServiceKind;
  port?: number;
  description?: string;
  /** Test Runner command; defaults to `npm test` when absent. */
  test?: string;
  /**
   * Names of services that must be started (and healthy) before this one, used
   * to order `startBundle`. Self/unknown references are ignored at start time.
   */
  dependsOn?: string[];
  /**
   * Root path of the project this service belongs to. Overrides the default
   * inference from `cwd`; set it when `cwd` cannot identify the project, as
   * for remote services whose cwd lives on another machine.
   */
  projectPath?: string;
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
  /** Primary worktree used to identify and configure this logical project. */
  path: string;
  /** Worktree currently used by Git, agents, shells, and GitHub workflows. */
  activeWorktreePath?: string;
  /** GitHub identity used for API operations in this logical repository. */
  githubCredential?: GitHubCredentialSelection;
  /**
   * Deploy-provider project this repository ships, keyed by provider id
   * (`vercel`, `cloudflare`, …), when the user pinned one. A missing entry
   * means "infer it" — from the provider's link file (Vercel:
   * `.vercel/project.json`), else the git remote.
   */
  providerProjects?: Record<string, string>;
}

export type GitHubCredentialSelection =
  | { source: "gh"; host: string; login: string }
  | { source: "stored"; host: string };

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
  /**
   * When true the user has explicitly unlocked write access for this
   * connection's SQL console. Default/absent = read-only (locked).
   */
  writeUnlocked?: boolean;
  /**
   * Directory that ties this connection to a project (a repo root, or the
   * cwd of the service whose .env it was detected in). Absent = shared /
   * unclassified — such connections stay visible in every project scope.
   */
  projectPath?: string;
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
  /** Account the token belongs to, captured at connect time (optional legacy). */
  login?: string;
  avatarUrl?: string;
}

/**
 * Commit author/committer for a GitHub account. Cached so the commit path can
 * stamp an identity without an API round trip per commit.
 */
export interface GitHubIdentity {
  host: string;
  login: string;
  name: string;
  email: string;
}

/**
 * How an external provider integration authenticates, keyed by provider id in
 * {@link NoMoreIdeConfig.connections}.
 *
 * The three sources are the same everywhere: `cli` holds no secret — the token
 * is re-read from the vendor CLI's own auth file each time, so `vercel logout`
 * (or `wrangler logout`) revokes NoMoreIDE's access too. `stored` carries a
 * pasted token. `oauth` is the browser sign-in, whose access token expires and
 * is renewed from `refreshToken` (see `vercel-oauth.ts`).
 */
export interface ProviderConnection {
  source: "cli" | "stored" | "oauth";
  /** The pasted token (`stored`) or the current access token (`oauth`). Masked out of every API response. */
  token?: string;
  /** `oauth` only: renews `token`, and is itself rotated on every use. Masked like `token`. */
  refreshToken?: string;
  /** `oauth` only: epoch ms at which `token` expires. */
  expiresAt?: number;
  /** `oauth` only: the registered client the tokens belong to, needed to refresh them. */
  clientId?: string;
  /**
   * Account scope within the provider — a Vercel team, a Cloudflare account.
   * Absent means the provider's own default (for Vercel, the personal account).
   */
  scopeId?: string;
  scopeSlug?: string;
  /** Cached account identity, captured at connect time. */
  username?: string;
}

export interface ProjectPreferences {
  logs: {
    showTimestamps: boolean;
    wrapLines: boolean;
  };
  database: {
    confirmWrites: boolean;
    resultLimit: number;
  };
}

export interface NoMoreIdeConfig {
  version: 1;
  services: ServiceDefinition[];
  bundles: BundleDefinition[];
  gitRepositories: GitRepositoryDefinition[];
  selectedGitRepository?: string;
  /**
   * Ordered repo names pinned to the multi-repo board. Undefined means the
   * board shows every registered repo; an empty array means explicitly cleared.
   */
  gitBoardRepositories?: string[];
  databases: DatabaseConnection[];
  logSources: LogSourceDefinition[];
  sshServers: SshServerDefinition[];
  githubTokens: GitHubToken[];
  /** Resolved commit identities, keyed by host + login. */
  githubIdentities: GitHubIdentity[];
  /**
   * How each external provider authenticates, keyed by provider id (`vercel`,
   * `cloudflare`, …). A missing entry means that provider is not connected.
   */
  connections: Record<string, ProviderConnection>;
  /** User-saved git/GitHub workflows (forks/edits of the built-in templates). */
  workflows: Workflow[];
  /** Event→workflow bindings that auto-fire workflows (IDEAS #16). */
  workflowTriggers: WorkflowTrigger[];
  /**
   * Which CLI the in-dock agent chat drives. Undefined = never chosen → fall
   * back to startup-agent detection.
   */
  chatProvider?: "claude" | "codex";
  /**
   * Model each agent CLI is pinned to. A missing entry means "let the CLI
   * pick" — there is no model name that safely stands in for a provider's own
   * default, so the absence is the signal.
   */
  chatModels?: Partial<Record<"claude" | "codex", string>>;
  preferences?: ProjectPreferences;
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
