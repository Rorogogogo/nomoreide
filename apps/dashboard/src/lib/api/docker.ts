import type { DockerApi } from "./docker-api.js";
import { httpDockerApi } from "./docker-http.js";

const api: DockerApi = httpDockerApi;

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
