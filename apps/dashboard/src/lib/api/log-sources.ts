/**
 * Log-sources API entry point. Picks the backend implementation once at module
 * load (`isTauri()` → Rust core, else Node HTTP) and re-exports its methods as
 * the named functions the rest of the app already imports — never a per-function
 * `if (isTauri())` branch.
 */
import { isTauri } from "./tauri-bridge.js";
import type { LogSourcesApi } from "./log-sources-api.js";
import { httpLogSourcesApi } from "./log-sources-http.js";
import { tauriLogSourcesApi } from "./log-sources-tauri.js";

const api: LogSourcesApi = isTauri() ? tauriLogSourcesApi : httpLogSourcesApi;

export const { listLogSources, addLogSource, deleteLogSource, getLogSourceLogs } = api;

export type {
  LogSourcesApi,
  LogSourceKind,
  LogDriver,
  LogSource,
  LogQuery,
} from "./log-sources-api.js";
