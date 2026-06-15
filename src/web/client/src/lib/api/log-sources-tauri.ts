/** Rust-core implementation of {@link LogSourcesApi}, over Tauri `invoke()` (desktop). */
import {
  tauri_listLogSources,
  tauri_registerLogSource,
  tauri_removeLogSource,
} from "./tauri-bridge.js";
import type { LogSource, LogSourcesApi } from "./log-sources-api.js";

async function listLogSources(): Promise<LogSource[]> {
  const sources = await tauri_listLogSources();
  return (sources ?? []) as LogSource[];
}

export const tauriLogSourcesApi: LogSourcesApi = {
  listLogSources,
  async addLogSource(input) {
    await tauri_registerLogSource(input as unknown as Record<string, unknown>);
    return listLogSources();
  },
  async deleteLogSource(name) {
    await tauri_removeLogSource(name);
  },
  // External log streaming has no Rust backend yet.
  getLogSourceLogs: async () => [],
};
