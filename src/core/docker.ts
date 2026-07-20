/**
 * Read-mostly Docker introspection: lists whatever containers are running on
 * the host (registered as a nomoreide service or not) and offers basic
 * lifecycle actions. Mirrors `docker-service-runner.ts`'s approach (shell out
 * via `execFile`, no shell interpolation) but is not tied to a specific
 * compose target — this is "what's on my machine", not "run this service".
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DockerStatus {
  available: boolean;
  version?: string;
  error?: string;
}

/** Whether the `docker` CLI/daemon is reachable at all, for the page's empty state. */
export async function getDockerStatus(): Promise<DockerStatus> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "version",
      "--format",
      "{{.Server.Version}}",
    ]);
    return { available: true, version: stdout.trim() };
  } catch (error) {
    return { available: false, error: errorMessage(error) };
  }
}

export interface DockerContainerSummary {
  id: string;
  name: string;
  image: string;
  /** Raw `docker ps` state: running, exited, paused, created, restarting, dead. */
  state: string;
  /** Human status string, e.g. "Up 2 hours" or "Exited (0) 3 days ago". */
  status: string;
  ports: string;
  createdAt?: string;
  /** From `com.docker.compose.project` / `.service` labels, when present. */
  project?: string;
  service?: string;
}

export async function listDockerContainers(): Promise<DockerContainerSummary[]> {
  const { stdout } = await execFileAsync("docker", ["ps", "-a", "--format", "{{json .}}"]);
  return parseDockerPsLines(stdout);
}

export function parseDockerPsLines(stdout: string): DockerContainerSummary[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseDockerPsLine)
    .filter((container): container is DockerContainerSummary => container !== null);
}

function parseDockerPsLine(line: string): DockerContainerSummary | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const id = typeof raw.ID === "string" ? raw.ID : undefined;
  if (!id) return null;
  const labels = parseDockerLabels(typeof raw.Labels === "string" ? raw.Labels : "");
  return {
    id,
    name: typeof raw.Names === "string" && raw.Names ? raw.Names : id,
    image: typeof raw.Image === "string" ? raw.Image : "",
    state: typeof raw.State === "string" && raw.State ? raw.State : "unknown",
    status: typeof raw.Status === "string" ? raw.Status : "",
    ports: typeof raw.Ports === "string" ? raw.Ports : "",
    createdAt: typeof raw.CreatedAt === "string" ? raw.CreatedAt : undefined,
    project: labels["com.docker.compose.project"],
    service: labels["com.docker.compose.service"],
  };
}

/** `docker ps`'s Labels field is a flat `key=value,key=value` string. */
function parseDockerLabels(raw: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    const key = pair.slice(0, separator).trim();
    if (key) labels[key] = pair.slice(separator + 1).trim();
  }
  return labels;
}

export type DockerContainerAction = "start" | "stop" | "restart";

export async function performDockerContainerAction(
  id: string,
  action: DockerContainerAction,
): Promise<void> {
  validateContainerId(id);
  await execFileAsync("docker", [action, id]);
}

export async function readDockerContainerLogs(id: string, tail = 200): Promise<string> {
  validateContainerId(id);
  const clampedTail = Math.min(Math.max(Math.trunc(tail) || 200, 1), 2000);
  const { stdout, stderr } = await execFileAsync("docker", [
    "logs",
    "--tail",
    String(clampedTail),
    "--timestamps",
    id,
  ]);
  return mergeTimestampedLogLines(stdout, stderr);
}

/**
 * `docker logs` writes container stdout/stderr as two separate streams, so
 * `execFile` hands them back unordered relative to each other. `--timestamps`
 * prefixes every line with an RFC3339 time, so a lexicographic sort of the
 * combined lines reconstructs chronological order.
 */
export function mergeTimestampedLogLines(stdout: string, stderr: string): string {
  const lines = [...splitNonEmptyLines(stdout), ...splitNonEmptyLines(stderr)];
  lines.sort((a, b) => a.localeCompare(b));
  return lines.join("\n");
}

function splitNonEmptyLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.length > 0);
}

/** Docker container IDs/names are alphanumeric plus `_.-`; reject anything else. */
function validateContainerId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) {
    throw new Error(`Invalid container id: "${id}"`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
