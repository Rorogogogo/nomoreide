import { postFormForJson, requestJson } from "./client.js";
import type { LogEntry } from "./services.js";
import {
  isTauri,
  tauri_listLogSources,
  tauri_registerLogSource,
  tauri_removeLogSource,
} from "./tauri-bridge.js";

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

export async function listLogSources(): Promise<LogSource[]> {
  if (isTauri()) {
    const sources = await tauri_listLogSources();
    return (sources ?? []) as LogSource[];
  }
  const res = await requestJson<{ ok: true; sources: LogSource[] }>("/api/log-sources");
  return res.sources;
}

export async function addLogSource(input: LogSource): Promise<LogSource[]> {
  if (isTauri()) {
    await tauri_registerLogSource(input as unknown as Record<string, unknown>);
    return listLogSources();
  }
  const res = await postFormForJson<{ ok: true; sources: LogSource[] }>(
    "/api/log-sources",
    input as unknown as Record<string, string | number | undefined>,
  );
  return res.sources;
}

export async function deleteLogSource(name: string): Promise<void> {
  if (isTauri()) {
    await tauri_removeLogSource(name);
    return;
  }
  await requestJson(`/api/log-sources/${encodeURIComponent(name)}`, { method: "DELETE" });
}

/** Log streaming for external sources is not implemented in desktop mode; returns empty. */
export async function getLogSourceLogs(
  name: string,
  query: LogQuery = {},
): Promise<LogEntry[]> {
  if (isTauri()) return [];
  const params = new URLSearchParams();
  params.set("lines", String(query.lines ?? 500));
  if (query.since) params.set("since", query.since);
  if (query.until) params.set("until", query.until);
  if (query.grep) params.set("grep", query.grep);
  if (query.level) params.set("level", query.level);
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.before) params.set("before", query.before);

  const res = await requestJson<{ ok: true; logs: LogEntry[] }>(
    `/api/log-sources/${encodeURIComponent(name)}/logs?${params.toString()}`,
  );
  return res.logs;
}
