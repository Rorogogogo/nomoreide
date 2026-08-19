import { requestJson } from "./client.js";
import type {
  DockerApi,
  DockerContainerAction,
  DockerContainerDetail,
  DockerDirectoryListing,
  DockerFileContent,
  DockerContainerStats,
  DockerContainerSummary,
  DockerImageSummary,
  DockerNetworkSummary,
  DockerStatus,
  DockerVolumeSummary,
} from "./docker-api.js";

export const httpDockerApi: DockerApi = {
  async getDockerStatus() {
    const response = await requestJson<{ ok: true; status: DockerStatus }>("/api/docker/status");
    return response.status;
  },

  async startDocker() {
    await requestJson("/api/docker/start", { method: "POST" });
  },

  async getDockerContainers() {
    const response = await requestJson<{ ok: true; containers: DockerContainerSummary[] }>(
      "/api/docker/containers",
    );
    return response.containers;
  },

  async getDockerStats() {
    const response = await requestJson<{ ok: true; stats: DockerContainerStats[] }>(
      "/api/docker/stats",
    );
    return response.stats;
  },

  async getDockerImages() {
    const response = await requestJson<{ ok: true; images: DockerImageSummary[] }>(
      "/api/docker/images",
    );
    return response.images;
  },

  async getDockerVolumes() {
    const response = await requestJson<{ ok: true; volumes: DockerVolumeSummary[] }>(
      "/api/docker/volumes",
    );
    return response.volumes;
  },

  async getDockerNetworks() {
    const response = await requestJson<{ ok: true; networks: DockerNetworkSummary[] }>(
      "/api/docker/networks",
    );
    return response.networks;
  },

  async getDockerContainerDetail(id: string) {
    const response = await requestJson<{ ok: true; detail: DockerContainerDetail }>(
      `/api/docker/containers/${encodeURIComponent(id)}/inspect`,
    );
    return response.detail;
  },

  async runDockerContainerAction(id: string, action: DockerContainerAction) {
    await requestJson(`/api/docker/containers/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
    });
  },

  async getDockerContainerLogs(id: string, tail?: number) {
    const query = tail ? `?tail=${tail}` : "";
    const response = await requestJson<{ ok: true; logs: string }>(
      `/api/docker/containers/${encodeURIComponent(id)}/logs${query}`,
    );
    return response.logs;
  },

  async getDockerContainerDirectory(id: string, path = ".", includeHidden = false) {
    const search = new URLSearchParams({ path });
    if (includeHidden) search.set("hidden", "1");
    const response = await requestJson<{ ok: true; directory: DockerDirectoryListing }>(
      `/api/docker/containers/${encodeURIComponent(id)}/files?${search}`,
    );
    return response.directory;
  },

  async getDockerContainerFile(id: string, path: string) {
    const search = new URLSearchParams({ path });
    const response = await requestJson<{ ok: true; file: DockerFileContent }>(
      `/api/docker/containers/${encodeURIComponent(id)}/file?${search}`,
    );
    return response.file;
  },
};
