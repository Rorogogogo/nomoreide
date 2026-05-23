import { postFormForJson, requestJson } from "./client.js";
import type { GitBranch, GitFileStatus } from "./git.js";

export type ServiceKind = "local" | "docker-compose" | "ssh";

export interface ServiceDefinition {
  name: string;
  kind?: ServiceKind;
  command?: string;
  cwd?: string;
  port?: number;
  description?: string;
  test?: string;
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

export async function browseServiceConfig(
  name: string,
  path?: string,
): Promise<ConfigBrowseResult> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return requestJson<ConfigBrowseResult>(
    `/api/services/${encodeURIComponent(name)}/config-browse${query}`,
  );
}

export async function getServiceConfigFiles(name: string): Promise<{
  cwd: string;
  files: ConfigFileInfo[];
}> {
  const response = await requestJson<{ ok: true; cwd: string; files: ConfigFileInfo[] }>(
    `/api/services/${encodeURIComponent(name)}/config-files`,
  );
  return { cwd: response.cwd, files: response.files };
}

export async function getServiceConfigFile(
  name: string,
  path: string,
): Promise<ConfigFileResponse> {
  return requestJson<ConfigFileResponse>(
    `/api/services/${encodeURIComponent(name)}/config-file?path=${encodeURIComponent(path)}`,
  );
}

export async function putServiceConfigFileEnv(
  name: string,
  path: string,
  entries: { key: string; value: string }[],
): Promise<ConfigFileEnvResponse> {
  return requestJson<ConfigFileEnvResponse>(
    `/api/services/${encodeURIComponent(name)}/config-file?path=${encodeURIComponent(path)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries }),
    },
  );
}

export async function putServiceConfigFileText(
  name: string,
  path: string,
  content: string,
): Promise<ConfigFileTextResponse> {
  return requestJson<ConfigFileTextResponse>(
    `/api/services/${encodeURIComponent(name)}/config-file?path=${encodeURIComponent(path)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
}

export async function testServiceCommand(
  values: Record<string, string | number | undefined>,
): Promise<ServiceTestResult> {
  return postFormForJson<ServiceTestResult>("/api/services/test", values);
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

/** Start a test run for a service. Returns `ok:false` (409) if one is already active. */
export async function runServiceTests(
  name: string,
  pattern?: string,
): Promise<{ ok: boolean; run?: TestRun; error?: string }> {
  return postFormForJson(
    `/api/services/${encodeURIComponent(name)}/test`,
    pattern ? { pattern } : {},
  );
}
