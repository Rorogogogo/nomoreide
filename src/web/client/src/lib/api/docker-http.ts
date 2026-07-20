import { requestJson } from "./client.js";
import type {
  DockerApi,
  DockerContainerAction,
  DockerContainerSummary,
  DockerStatus,
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
