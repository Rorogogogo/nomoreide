import type { ProcessTreeSummary } from "./process-tree.js";

export interface ServiceDefinition {
  name: string;
  command: string;
  cwd: string;
  port?: number;
  env?: Record<string, string>;
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
}

export type LogStream = "stdout" | "stderr";

export interface LogEntry {
  service: string;
  stream: LogStream;
  text: string;
  timestamp: string;
}

export interface ToolResult {
  ok: boolean;
  message: string;
}
