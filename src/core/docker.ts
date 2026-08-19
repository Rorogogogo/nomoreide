/**
 * Read-mostly Docker introspection: lists whatever containers are running on
 * the host (registered as a nomoreide service or not) and offers basic
 * lifecycle actions. Mirrors `docker-service-runner.ts`'s approach (shell out
 * via `execFile`, no shell interpolation) but is not tied to a specific
 * compose target — this is "what's on my machine", not "run this service".
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  assertReadOnlyPath,
  FILE_PREVIEW_BYTES,
  FILE_READ_TIMEOUT_MS,
  parseReadOnlyDirectory,
  parseReadOnlyFile,
  READ_DIRECTORY_SCRIPT,
  READ_FILE_SCRIPT,
  type ReadOnlyDirectoryListing,
  type ReadOnlyFileContent,
} from "./read-only-files.js";

const execFileAsync = promisify(execFile);

/**
 * Single entry point for every `docker` invocation in this feature. Sibling
 * modules (stats/resources/inspect) go through here so argument handling and
 * the no-shell-interpolation guarantee stay in one place.
 */
export async function execDocker(args: string[]): Promise<string> {
  // Docker can emit a lot on `inspect`/`logs`; the default 1MB buffer truncates.
  const { stdout } = await execFileAsync("docker", args, { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/**
 * Most `docker ... --format "{{json .}}"` commands emit one JSON object per
 * line. Parse leniently: a single malformed line shouldn't blank the view.
 */
export function parseDockerJsonLines<T>(
  stdout: string,
  map: (raw: Record<string, unknown>) => T | null,
): T[] {
  const rows: T[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const mapped = map(raw);
    if (mapped !== null) rows.push(mapped);
  }
  return rows;
}

/** Read a string field off a `docker ... --format "{{json .}}"` row. */
export function readString(raw: Record<string, unknown>, key: string): string {
  return typeof raw[key] === "string" ? (raw[key] as string) : "";
}

export interface DockerStatus {
  available: boolean;
  canStart: boolean;
  installUrl?: string;
  version?: string;
  error?: string;
}

/** Whether the `docker` CLI/daemon is reachable at all, for the page's empty state. */
export async function getDockerStatus(): Promise<DockerStatus> {
  const canStart = await isDockerDesktopInstalled();
  const installUrl = canStart ? undefined : dockerDesktopInstallUrl();
  try {
    const { stdout } = await execFileAsync("docker", [
      "version",
      "--format",
      "{{.Server.Version}}",
    ]);
    return { available: true, canStart, installUrl, version: stdout.trim() };
  } catch (error) {
    return { available: false, canStart, installUrl, error: errorMessage(error) };
  }
}

/** A fixed, platform-owned launch command—never derived from request input. */
export function dockerDesktopStartCommand(
  platform = process.platform,
): { file: string; args: string[] } | null {
  if (platform === "darwin") return { file: "open", args: ["-a", "Docker"] };
  return null;
}

export function dockerDesktopLookupCommand(
  platform = process.platform,
): { file: string; args: string[] } | null {
  if (platform === "darwin") return { file: "open", args: ["-Ra", "Docker"] };
  return null;
}

export function dockerDesktopInstallUrl(platform = process.platform): string | undefined {
  return platform === "darwin"
    ? "https://docs.docker.com/desktop/setup/install/mac-install/"
    : undefined;
}

export async function isDockerDesktopInstalled(platform = process.platform): Promise<boolean> {
  const command = dockerDesktopLookupCommand(platform);
  if (!command) return false;
  try {
    await execFileAsync(command.file, command.args, { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export async function startDockerDesktop(): Promise<void> {
  if (!(await isDockerDesktopInstalled())) {
    throw new Error("Docker Desktop is not installed.");
  }
  const command = dockerDesktopStartCommand();
  if (!command) {
    throw new Error("Starting Docker automatically is currently supported on macOS only.");
  }
  await execFileAsync(command.file, command.args, { timeout: 10_000 });
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

export interface DockerDirectoryListing extends ReadOnlyDirectoryListing {
  containerId: string;
}

export interface DockerFileContent extends ReadOnlyFileContent {
  containerId: string;
}

/** Lazy, read-only listing rooted at the container's configured working directory. */
export async function readDockerContainerDirectory(
  id: string,
  path = ".",
  includeHidden = false,
): Promise<DockerDirectoryListing> {
  const { stdout } = await execFileAsync(
    "docker",
    dockerReadDirectoryArgs(id, path),
    {
      encoding: "buffer",
      timeout: FILE_READ_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return { containerId: id, ...parseReadOnlyDirectory(stdout, includeHidden) };
}

export async function readDockerContainerFile(
  id: string,
  path: string,
): Promise<DockerFileContent> {
  const { stdout } = await execFileAsync(
    "docker",
    dockerReadFileArgs(id, path),
    {
      encoding: "buffer",
      timeout: FILE_READ_TIMEOUT_MS,
      maxBuffer: FILE_PREVIEW_BYTES + 64 * 1024,
    },
  );
  return { containerId: id, ...parseReadOnlyFile(path, stdout) };
}

/** Exact argv boundary used by the read-only explorer; paths never become shell source. */
export function dockerReadDirectoryArgs(id: string, path: string): string[] {
  validateContainerId(id);
  assertReadOnlyPath(path);
  return ["exec", id, "sh", "-c", READ_DIRECTORY_SCRIPT, "nomoreide", path];
}

export function dockerReadFileArgs(id: string, path: string): string[] {
  validateContainerId(id);
  assertReadOnlyPath(path, true);
  return ["exec", id, "sh", "-c", READ_FILE_SCRIPT, "nomoreide", path];
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
export function validateContainerId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) {
    throw new Error(`Invalid container id: "${id}"`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
