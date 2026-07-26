import { isTauri } from "./tauri-bridge.js";
import type { DockerApi } from "./docker-api.js";
import { httpDockerApi } from "./docker-http.js";
import { tauriDockerApi } from "./docker-tauri.js";

const api: DockerApi = isTauri() ? tauriDockerApi : httpDockerApi;

export const {
  getDockerStatus,
  getDockerContainers,
  getDockerStats,
  getDockerImages,
  getDockerVolumes,
  getDockerNetworks,
  getDockerContainerDetail,
  runDockerContainerAction,
  getDockerContainerLogs,
} = api;

export type {
  DockerApi,
  DockerContainerAction,
  DockerContainerDetail,
  DockerContainerStats,
  DockerContainerSummary,
  DockerEnvVar,
  DockerImageSummary,
  DockerMountInfo,
  DockerNetworkSummary,
  DockerPortBinding,
  DockerStatus,
  DockerVolumeSummary,
} from "./docker-api.js";
