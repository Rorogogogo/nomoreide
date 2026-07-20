export interface DockerStatus {
  available: boolean;
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

export interface DockerApi {
  getDockerStatus(): Promise<DockerStatus>;
  getDockerContainers(): Promise<DockerContainerSummary[]>;
  runDockerContainerAction(id: string, action: DockerContainerAction): Promise<void>;
  getDockerContainerLogs(id: string, tail?: number): Promise<string>;
}
