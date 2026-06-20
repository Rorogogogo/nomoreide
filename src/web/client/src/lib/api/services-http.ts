/** Node HTTP-server implementation of {@link ServicesApi} (the web/MCP backend). */
import { postForm, postFormForJson, requestJson } from "./client.js";
import type {
  ConfigBrowseResult,
  ConfigFileEnvResponse,
  ConfigFileInfo,
  ConfigFileResponse,
  ConfigFileTextResponse,
  DashboardData,
  DirectoryListing,
  LogEntry,
  MetricsSeries,
  ServiceGraph,
  ServiceTestResult,
  ServicesApi,
} from "./services-api.js";

export const httpServicesApi: ServicesApi = {
  getDashboard() {
    return requestJson<DashboardData>("/api/dashboard");
  },

  async getServiceGraph() {
    const response = await requestJson<{ ok: true; graph: ServiceGraph }>(
      "/api/services/graph",
    );
    return response.graph;
  },

  async startService(name) {
    await requestJson(`/api/services/${encodeURIComponent(name)}/start`, { method: "POST" });
  },

  async stopService(name) {
    await requestJson(`/api/services/${encodeURIComponent(name)}/stop`, { method: "POST" });
  },

  async restartService(name) {
    await requestJson(`/api/services/${encodeURIComponent(name)}/restart`, { method: "POST" });
  },

  async startBundle(name) {
    await requestJson(`/api/bundles/${encodeURIComponent(name)}/start`, { method: "POST" });
  },

  async stopBundle(name) {
    await requestJson(`/api/bundles/${encodeURIComponent(name)}/stop`, { method: "POST" });
  },

  async deleteService(name) {
    await requestJson(`/api/services/${encodeURIComponent(name)}`, { method: "DELETE" });
  },

  async registerBundle(bundle) {
    await postForm("/api/bundles", {
      name: bundle.name,
      originalName: bundle.name,
      services: bundle.services.join(","),
    });
  },

  async getServiceLogs(name, query = {}) {
    const params = new URLSearchParams();
    params.set("lines", String(query.lines ?? 500));
    if (query.since) params.set("since", query.since);
    if (query.until) params.set("until", query.until);
    if (query.grep) params.set("grep", query.grep);
    if (query.level) params.set("level", query.level);
    if (query.cursor) params.set("cursor", query.cursor);
    if (query.before) params.set("before", query.before);

    const response = await requestJson<{ ok: true; logs: LogEntry[]; queryable?: boolean }>(
      `/api/services/${encodeURIComponent(name)}/logs?${params.toString()}`,
    );
    return { logs: response.logs, queryable: Boolean(response.queryable) };
  },

  getDirectories(path, { files = false }: { files?: boolean } = {}) {
    const params = new URLSearchParams({ path });
    if (files) params.set("files", "1");
    return requestJson<DirectoryListing>(`/api/fs/directories?${params.toString()}`);
  },

  browseServiceConfig(name, path) {
    const query = path ? `?path=${encodeURIComponent(path)}` : "";
    return requestJson<ConfigBrowseResult>(
      `/api/services/${encodeURIComponent(name)}/config-browse${query}`,
    );
  },

  async getServiceConfigFiles(name) {
    const response = await requestJson<{ ok: true; cwd: string; files: ConfigFileInfo[] }>(
      `/api/services/${encodeURIComponent(name)}/config-files`,
    );
    return { cwd: response.cwd, files: response.files };
  },

  getServiceConfigFile(name, path) {
    return requestJson<ConfigFileResponse>(
      `/api/services/${encodeURIComponent(name)}/config-file?path=${encodeURIComponent(path)}`,
    );
  },

  putServiceConfigFileEnv(name, path, entries) {
    return requestJson<ConfigFileEnvResponse>(
      `/api/services/${encodeURIComponent(name)}/config-file?path=${encodeURIComponent(path)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entries }),
      },
    );
  },

  putServiceConfigFileText(name, path, content) {
    return requestJson<ConfigFileTextResponse>(
      `/api/services/${encodeURIComponent(name)}/config-file?path=${encodeURIComponent(path)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      },
    );
  },

  async getServiceMetrics(name) {
    const response = await requestJson<{ ok: true; metrics: MetricsSeries }>(
      `/api/services/${encodeURIComponent(name)}/metrics`,
    );
    return response.metrics;
  },

  testServiceCommand(values) {
    return postFormForJson<ServiceTestResult>("/api/services/test", values);
  },

  runServiceTests(name, pattern) {
    return postFormForJson(
      `/api/services/${encodeURIComponent(name)}/test`,
      pattern ? { pattern } : {},
    );
  },
};
