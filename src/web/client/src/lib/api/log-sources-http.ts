/** Node HTTP-server implementation of {@link LogSourcesApi} (the web/MCP backend). */
import { postFormForJson, requestJson } from "./client.js";
import type { LogEntry } from "./services.js";
import type { LogSource, LogSourcesApi } from "./log-sources-api.js";

export const httpLogSourcesApi: LogSourcesApi = {
  async listLogSources() {
    const res = await requestJson<{ ok: true; sources: LogSource[] }>("/api/log-sources");
    return res.sources;
  },

  async addLogSource(input) {
    const res = await postFormForJson<{ ok: true; sources: LogSource[] }>(
      "/api/log-sources",
      input as unknown as Record<string, string | number | undefined>,
    );
    return res.sources;
  },

  async deleteLogSource(name) {
    await requestJson(`/api/log-sources/${encodeURIComponent(name)}`, { method: "DELETE" });
  },

  async getLogSourceLogs(name, query = {}) {
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
  },
};
