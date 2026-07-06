import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_NAMES,
  type AgentAvailability,
  type AgentDoctorCheck,
  type AgentDoctorResult,
  type AgentLiveConfig,
  type AgentName,
} from "./types.js";

const AGENT_COMMANDS: Record<AgentName, string> = {
  claude: "claude",
  codex: "codex",
  antigravity: "antigravity",
};

/** PATH lookup without shelling out to `which` (works on win32 via PATHEXT). */
export async function findExecutable(command: string): Promise<string | null> {
  if (command.includes(path.sep)) {
    return (await isExecutable(command)) ? command : null;
  }

  const pathEntries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry.length > 0);
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter((entry) => entry.length > 0)
      : [""];

  for (const pathEntry of pathEntries) {
    for (const extension of extensions) {
      const candidate =
        process.platform === "win32" &&
        extension.length > 0 &&
        !command.toLowerCase().endsWith(extension.toLowerCase())
          ? path.join(pathEntry, `${command}${extension}`)
          : path.join(pathEntry, command);

      if (await isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function getAgentAvailability(): Promise<AgentAvailability[]> {
  return Promise.all(
    AGENT_NAMES.map(async (agent) => {
      const command = AGENT_COMMANDS[agent];
      const resolvedPath = await findExecutable(command);
      return {
        agent,
        command,
        available: resolvedPath !== null,
        resolvedPath: resolvedPath ?? undefined,
      };
    }),
  );
}

/** Availability + config-file presence, summarized as pass/warn checks. */
export function buildDoctorResult(
  availability: AgentAvailability[],
  configs: AgentLiveConfig[],
): AgentDoctorResult {
  const checks: AgentDoctorCheck[] = [];

  for (const agent of availability) {
    checks.push({
      label: "Agent CLI",
      status: agent.available ? "ok" : "warn",
      message: agent.available
        ? `${agent.agent} is available (${agent.resolvedPath})`
        : `${agent.agent} is not available on PATH`,
    });
  }

  for (const config of configs) {
    checks.push({
      label: "Config file",
      status: config.exists ? "ok" : "warn",
      message: config.exists
        ? `${config.agent} config found at ${config.configPath}`
        : `${config.agent} has no config at ${config.configPath}`,
    });
  }

  return { checks, hasIssues: checks.some((check) => check.status !== "ok") };
}
