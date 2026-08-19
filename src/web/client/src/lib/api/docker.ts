import { isTauri } from "./tauri-bridge.js";
import type { DockerApi } from "./docker-api.js";
import { httpDockerApi } from "./docker-http.js";
import { tauriDockerApi } from "./docker-tauri.js";

const api: DockerApi = isTauri() ? tauriDockerApi : httpDockerApi;

export const {
  getDockerStatus,
  startDocker,
  getDockerContainers,
  getDockerStats,
  getDockerImages,
  getDockerVolumes,
  getDockerNetworks,
  getDockerContainerDetail,
  runDockerContainerAction,
  getDockerContainerLogs,
  getDockerContainerDirectory,
  getDockerContainerFile,
} = api;

export type {
  DockerApi,
  DockerContainerAction,
  DockerContainerDetail,
  DockerContainerStats,
  DockerContainerSummary,
  DockerDirectoryListing,
  DockerEnvVar,
  DockerFileContent,
  DockerFileEntry,
  DockerFileType,
  DockerImageSummary,
  DockerMountInfo,
  DockerNetworkSummary,
  DockerPortBinding,
  DockerStatus,
  DockerVolumeSummary,
} from "./docker-api.js";
