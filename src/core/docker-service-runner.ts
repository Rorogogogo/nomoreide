import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DockerComposeTarget {
  cwd: string;
  composeFile?: string;
  composeService: string;
}

export interface DockerComposeCommands {
  start: [string, string[]];
  stop: [string, string[]];
  status: [string, string[]];
  logs: [string, string[]];
}

export function createDockerComposeCommands(
  target: DockerComposeTarget,
  logTail = 120,
): DockerComposeCommands {
  validateTarget(target);
  const fileArgs = target.composeFile ? ["-f", target.composeFile] : [];
  return {
    start: ["docker", ["compose", ...fileArgs, "up", "-d", target.composeService]],
    stop: ["docker", ["compose", ...fileArgs, "stop", target.composeService]],
    status: [
      "docker",
      ["compose", ...fileArgs, "ps", "--format", "json", target.composeService],
    ],
    logs: [
      "docker",
      [
        "compose",
        ...fileArgs,
        "logs",
        "--tail",
        String(logTail),
        target.composeService,
      ],
    ],
  };
}

export interface DockerContainerInfo {
  containerId?: string;
  state?: string;
}

export async function startDockerService(
  target: DockerComposeTarget,
): Promise<DockerContainerInfo> {
  const commands = createDockerComposeCommands(target);
  await execFileAsync(commands.start[0], commands.start[1], { cwd: target.cwd });
  return readDockerServiceStatus(target);
}

export async function stopDockerService(target: DockerComposeTarget): Promise<void> {
  const commands = createDockerComposeCommands(target);
  await execFileAsync(commands.stop[0], commands.stop[1], { cwd: target.cwd });
}

export async function readDockerServiceStatus(
  target: DockerComposeTarget,
): Promise<DockerContainerInfo> {
  const commands = createDockerComposeCommands(target);
  try {
    const { stdout } = await execFileAsync(commands.status[0], commands.status[1], {
      cwd: target.cwd,
    });
    return parseDockerPsOutput(stdout);
  } catch {
    return {};
  }
}

export async function readDockerServiceLogs(
  target: DockerComposeTarget,
  tail = 120,
): Promise<string> {
  const commands = createDockerComposeCommands(target, tail);
  const { stdout } = await execFileAsync(commands.logs[0], commands.logs[1], {
    cwd: target.cwd,
  });
  return stdout;
}

export function parseDockerPsOutput(stdout: string): DockerContainerInfo {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { ID?: string; State?: string };
      if (parsed.ID) {
        return { containerId: parsed.ID, state: parsed.State };
      }
    } catch {
      // ignore non-json line
    }
  }
  return {};
}

function validateTarget(target: DockerComposeTarget): void {
  if (!target.cwd.trim()) throw new Error("Docker compose cwd is required.");
  if (!target.composeService.trim()) {
    throw new Error("Docker compose service name is required.");
  }
}
