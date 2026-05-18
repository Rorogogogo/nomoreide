export interface ServiceDefinition {
  name: string;
  command: string;
  cwd: string;
  port?: number;
  description?: string;
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

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(body?.error || response.statusText);
  }
  return body as T;
}
