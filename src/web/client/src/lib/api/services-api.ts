/**
 * Services API surface — the single contract both backends implement.
 *
 * Most config-file / metrics / test endpoints are Node-server only; the desktop
 * (Tauri) impl inherits those from the HTTP impl and overrides just the
 * Rust-backed lifecycle methods. See {@link ../git-api} for the seam rationale.
 */
import type { GitBranch, GitFileStatus } from "./git.js";
import type { LogQuery } from "./log-sources.js";

export type ServiceKind = "local" | "docker-compose" | "ssh";

export interface ServiceDefinition {
  name: string;
  kind?: ServiceKind;
  command?: string;
  cwd?: string;
  port?: number;
  description?: string;
  test?: string;
  dependsOn?: string[];
  /**
   * Project this service is pinned to, overriding the inference from `cwd`.
   * Absent means infer; see `features/services/project-scope`.
   */
  projectPath?: string;
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
  activeWorktreePath?: string;
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
  /** journald cursor (source targets only); used for "load older" paging. */
  cursor?: string;
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

export interface DirectoryEntry {
  name: string;
  path: string;
  isDir: boolean;
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
          upstream?: string;
          ahead: number;
          behind: number;
          files: GitFileStatus[];
        }
      | null;
    branches: GitBranch[];
    error?: string;
  };
}

export interface ServiceLogsResult {
  logs: LogEntry[];
  /** True when the service can re-query its host (ssh journald/docker). */
  queryable: boolean;
}

export type ConfigFileFormat = "env" | "json" | "yaml";

export interface ConfigFileInfo {
  path: string;
  relativePath: string;
  format: ConfigFileFormat;
}

export interface ServiceEnvEntry {
  key: string;
  value: string;
  secret: boolean;
}

export interface ConfigFileEnvResponse {
  ok: true;
  exists: boolean;
  format: "env";
  path: string;
  relativePath: string;
  entries: ServiceEnvEntry[];
}

export interface ConfigFileTextResponse {
  ok: true;
  exists: boolean;
  format: "json" | "yaml";
  path: string;
  relativePath: string;
  content: string;
}

export type ConfigFileResponse = ConfigFileEnvResponse | ConfigFileTextResponse;

export interface ConfigBrowseEntry {
  name: string;
  relativePath: string;
  kind: "directory" | "file";
  format?: ConfigFileFormat;
  supported: boolean;
}

export interface ConfigBrowseResult {
  ok: true;
  cwd: string;
  currentPath: string;
  relativePath: string;
  isRoot: boolean;
  entries: ConfigBrowseEntry[];
}

export interface MetricSample {
  t: number;
  cpu: number;
  rss: number;
}

/** One slice of the same window `samples` covers, counted by severity. */
export interface LogVolumeBucket {
  t: number;
  info: number;
  warning: number;
  error: number;
}

export interface MetricsSeries {
  service: string;
  startedAt?: string;
  sampleIntervalMs: number;
  samples: MetricSample[];
  /**
   * Log lines bucketed over `samples`' range — the strip under the CPU and
   * memory panes. Optional because it is the newer half of this response: a
   * client talking to a daemon that predates it, and the website's mock before
   * it grew a handler, both answer without one.
   */
  logVolume?: LogVolumeBucket[];
}

export type TestRunStatus = "running" | "passed" | "failed" | "error";

export interface TestRun {
  id: number;
  service: string;
  command: string;
  pattern?: string;
  status: TestRunStatus;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  failingCount: number;
}

export interface TestRunEvent {
  type: "output" | "status";
  run: TestRun;
  line?: { stream: "stdout" | "stderr"; text: string };
}

export interface StaleConfigFile {
  relativePath: string;
  path: string;
  format: ConfigFileFormat;
  modifiedAt: string;
}

export interface RuntimeEnvStatus {
  running: boolean;
  startedAt?: string;
  /** Config files modified after the service started (most-recent first). */
  staleFiles: StaleConfigFile[];
  /** True when a running process is using an out-of-date configuration. */
  stale: boolean;
}

export interface ServiceGraphNode {
  name: string;
  /** Declared deps that resolve to a registered service. */
  dependsOn: string[];
  /** Declared deps with no matching service (rendered as a warning). */
  missing: string[];
}

export interface ServiceGraph {
  nodes: ServiceGraphNode[];
  edges: Array<{ from: string; to: string }>;
  /** Topological start order (deps first); empty when a cycle blocks sorting. */
  order: string[];
  /** Distinct cycles detected in the graph (empty when acyclic). */
  cycles: string[][];
}

export interface ServicesApi {
  getDashboard(): Promise<DashboardData>;
  /** Structural service dependency graph (nodes/edges/order/cycles). */
  getServiceGraph(): Promise<ServiceGraph>;
  startService(name: string): Promise<void>;
  stopService(name: string): Promise<void>;
  restartService(name: string): Promise<void>;
  startBundle(name: string): Promise<void>;
  stopBundle(name: string): Promise<void>;
  /** Unregister a service. Rejects (409) if it is still running. */
  deleteService(name: string): Promise<void>;
  /**
   * Pin a service to a project, or pass `undefined` to clear the pin back to
   * inference from `cwd`. Patches only the assignment, leaving the rest of the
   * definition untouched.
   */
  setServiceProject(name: string, projectPath: string | undefined): Promise<void>;
  /** Persist a bundle's full membership (create or replace in place). */
  registerBundle(bundle: BundleDefinition): Promise<void>;
  getServiceLogs(name: string, query?: LogQuery): Promise<ServiceLogsResult>;
  getDirectories(path: string, opts?: { files?: boolean }): Promise<DirectoryListing>;
  browseServiceConfig(name: string, path?: string): Promise<ConfigBrowseResult>;
  getServiceConfigFiles(name: string): Promise<{ cwd: string; files: ConfigFileInfo[] }>;
  getServiceConfigFile(name: string, path: string): Promise<ConfigFileResponse>;
  putServiceConfigFileEnv(
    name: string,
    path: string,
    entries: { key: string; value: string }[],
  ): Promise<ConfigFileEnvResponse>;
  putServiceConfigFileText(
    name: string,
    path: string,
    content: string,
  ): Promise<ConfigFileTextResponse>;
  /**
   * Whether a running service's config files were edited after it started, so
   * the live process is using stale values (a reload is needed to apply them).
   */
  getServiceEnvRuntime(name: string): Promise<RuntimeEnvStatus>;
  getServiceMetrics(name: string): Promise<MetricsSeries>;
  testServiceCommand(
    values: Record<string, string | number | undefined>,
  ): Promise<ServiceTestResult>;
  /** Start a test run for a service. Returns `ok:false` (409) if one is already active. */
  runServiceTests(
    name: string,
    pattern?: string,
  ): Promise<{ ok: boolean; run?: TestRun; error?: string }>;
}
