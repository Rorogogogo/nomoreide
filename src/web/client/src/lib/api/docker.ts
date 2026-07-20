import { isTauri } from "./tauri-bridge.js";
import type { DockerApi } from "./docker-api.js";
import { httpDockerApi } from "./docker-http.js";
import { tauriDockerApi } from "./docker-tauri.js";

const api: DockerApi = isTauri() ? tauriDockerApi : httpDockerApi;

export const {
  getDockerStatus,
  getDockerContainers,
  runDockerContainerAction,
  getDockerContainerLogs,
} = api;

export type {
  DockerApi,
  DockerContainerAction,
  DockerContainerSummary,
  DockerStatus,
} from "./docker-api.js";
