export interface DockerStatus {
  available: boolean;
  canStart: boolean;
  installUrl?: string;
  version?: string;
  error?: string;
}

export interface DockerContainerSummary {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  createdAt?: string;
  project?: string;
  service?: string;
}

export type DockerContainerAction = "start" | "stop" | "restart";

export interface DockerContainerStats {
  id: string;
  cpuPercent: number | null;
  memoryPercent: number | null;
  memoryUsage: string;
  netIo: string;
  blockIo: string;
}

export interface DockerImageSummary {
  id: string;
  repository: string;
  tag: string;
  size: string;
  createdSince: string;
  dangling: boolean;
}

export interface DockerVolumeSummary {
  name: string;
  driver: string;
  mountpoint: string;
  scope: string;
}

export interface DockerNetworkSummary {
  id: string;
  name: string;
  driver: string;
  scope: string;
}

export interface DockerEnvVar {
  key: string;
  value: string;
  secret: boolean;
}

export interface DockerMountInfo {
  type: string;
  source: string;
  destination: string;
  readOnly: boolean;
}

export interface DockerPortBinding {
  containerPort: string;
  hostPort: string;
}

export interface DockerContainerDetail {
  id: string;
  name: string;
  image: string;
  command: string;
  created: string;
  state: string;
  startedAt: string;
  restartCount: number;
  env: DockerEnvVar[];
  mounts: DockerMountInfo[];
  ports: DockerPortBinding[];
  networks: string[];
  labels: Record<string, string>;
}

export type DockerFileType = "directory" | "file" | "symlink" | "other";

export interface DockerFileEntry {
  name: string;
  path: string;
  type: DockerFileType;
  size: number;
  modifiedAt: number | null;
}

export interface DockerDirectoryListing {
  containerId: string;
  path: string;
  entries: DockerFileEntry[];
}

export interface DockerFileContent {
  containerId: string;
  path: string;
  content: string;
  size: number;
  binary: boolean;
  truncated: boolean;
}

export interface DockerApi {
  getDockerStatus(): Promise<DockerStatus>;
  startDocker(): Promise<void>;
  getDockerContainers(): Promise<DockerContainerSummary[]>;
  getDockerStats(): Promise<DockerContainerStats[]>;
  getDockerImages(): Promise<DockerImageSummary[]>;
  getDockerVolumes(): Promise<DockerVolumeSummary[]>;
  getDockerNetworks(): Promise<DockerNetworkSummary[]>;
  getDockerContainerDetail(id: string): Promise<DockerContainerDetail>;
  runDockerContainerAction(id: string, action: DockerContainerAction): Promise<void>;
  getDockerContainerLogs(id: string, tail?: number): Promise<string>;
  getDockerContainerDirectory(
    id: string,
    path?: string,
    includeHidden?: boolean,
  ): Promise<DockerDirectoryListing>;
  getDockerContainerFile(id: string, path: string): Promise<DockerFileContent>;
}
