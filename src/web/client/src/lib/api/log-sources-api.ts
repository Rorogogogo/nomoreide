/**
 * Log-sources API surface — the single contract both backends implement. See
 * {@link ../git-api} for the shared-interface seam rationale.
 */
import type { LogEntry } from "./services.js";

export type LogSourceKind = "file" | "ssh" | "command";
export type LogDriver = "journald" | "docker";

export interface LogSource {
  name: string;
  kind: LogSourceKind;
  path?: string;
  host?: string;
  command?: string;
  cwd?: string;
  driver?: LogDriver;
  unit?: string;
  container?: string;
}

export interface LogQuery {
  since?: string;
  until?: string;
  grep?: string;
  level?: "warn" | "error";
  lines?: number;
  cursor?: string;
  /** journald cursor to page older than — returns the `lines` entries before it. */
  before?: string;
}

export interface LogSourcesApi {
  listLogSources(): Promise<LogSource[]>;
  addLogSource(input: LogSource): Promise<LogSource[]>;
  deleteLogSource(name: string): Promise<void>;
  /** Log streaming for external sources is not implemented in desktop mode. */
  getLogSourceLogs(name: string, query?: LogQuery): Promise<LogEntry[]>;
}
