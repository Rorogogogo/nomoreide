import { requestJson } from "./client.js";
import type {
  DockerApi,
  DockerContainerAction,
  DockerContainerDetail,
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
};
