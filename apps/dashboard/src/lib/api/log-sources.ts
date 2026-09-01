/** Log-sources API entry point shared by browser and desktop. */
import type { LogSourcesApi } from "./log-sources-api.js";
import { httpLogSourcesApi } from "./log-sources-http.js";

const api: LogSourcesApi = httpLogSourcesApi;

export const { listLogSources, addLogSource, deleteLogSource, getLogSourceLogs } = api;

export type {
  LogSourcesApi,
  LogSourceKind,
  LogDriver,
  LogSource,
  LogQuery,
} from "./log-sources-api.js";
