/**
 * `docker inspect` for a single container, flattened to what the detail panel
 * actually renders. Raw inspect output is a deeply nested ~200-key document;
 * shipping it wholesale to the client would be both noisy and a needless
 * disclosure surface, so this picks fields deliberately.
 */
import { execDocker, validateContainerId } from "./docker.js";

export interface DockerEnvVar {
  key: string;
  value: string;
  /** True when the value was masked because the key looks credential-shaped. */
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

/**
 * Env values are masked when the key looks like a credential. This is a local
 * dashboard, but the same daemon port is what MCP agents talk to — a container
 * password shouldn't land in an agent transcript just because someone opened a
 * detail panel.
 */
const SECRET_KEY_PATTERN = /(pass|secret|token|key|credential|auth)/i;

export async function inspectDockerContainer(id: string): Promise<DockerContainerDetail> {
  validateContainerId(id);
  const stdout = await execDocker(["inspect", id]);
  const parsed = JSON.parse(stdout) as unknown;
  const raw = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!raw || typeof raw !== "object") {
    throw new Error(`No inspect output for container "${id}"`);
  }
  return mapInspectDocument(raw as Record<string, unknown>);
}

export function mapInspectDocument(raw: Record<string, unknown>): DockerContainerDetail {
  const config = asRecord(raw.Config);
  const state = asRecord(raw.State);
  const hostConfig = asRecord(raw.NetworkSettings);

  return {
    id: asString(raw.Id),
    // Docker prefixes container names with a slash; nobody wants to read that.
    name: asString(raw.Name).replace(/^\//, ""),
    image: asString(config.Image),
    command: [asString(config.Entrypoint), ...asStringArray(config.Cmd)]
      .filter(Boolean)
      .join(" "),
    created: asString(raw.Created),
    state: asString(state.Status),
    startedAt: asString(state.StartedAt),
    restartCount: typeof raw.RestartCount === "number" ? raw.RestartCount : 0,
    env: parseEnvList(asStringArray(config.Env)),
    mounts: parseMounts(raw.Mounts),
    ports: parsePortBindings(hostConfig.Ports),
    networks: Object.keys(asRecord(hostConfig.Networks)),
    labels: parseLabels(config.Labels),
  };
}

export function parseEnvList(entries: string[]): DockerEnvVar[] {
  return entries.map((entry) => {
    const separator = entry.indexOf("=");
    const key = separator === -1 ? entry : entry.slice(0, separator);
    const value = separator === -1 ? "" : entry.slice(separator + 1);
    const secret = SECRET_KEY_PATTERN.test(key) && value.length > 0;
    return { key, value: secret ? "••••••••" : value, secret };
  });
}

function parseMounts(raw: unknown): DockerMountInfo[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((mount) => ({
    type: asString(mount.Type),
    // Named volumes report Name; bind mounts report Source.
    source: asString(mount.Name) || asString(mount.Source),
    destination: asString(mount.Destination),
    readOnly: mount.RW === false,
  }));
}

/** NetworkSettings.Ports maps "5432/tcp" to a list of host bindings, or null. */
function parsePortBindings(raw: unknown): DockerPortBinding[] {
  if (!isRecord(raw)) return [];
  const bindings: DockerPortBinding[] = [];
  for (const [containerPort, hostList] of Object.entries(raw)) {
    if (!Array.isArray(hostList) || hostList.length === 0) {
      bindings.push({ containerPort, hostPort: "" });
      continue;
    }
    for (const host of hostList.filter(isRecord)) {
      const ip = asString(host.HostIp);
      const port = asString(host.HostPort);
      bindings.push({ containerPort, hostPort: ip ? `${ip}:${port}` : port });
    }
  }
  return bindings;
}

function parseLabels(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {};
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") labels[key] = value;
  }
  return labels;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
