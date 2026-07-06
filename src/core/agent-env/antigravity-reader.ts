import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { mergeManagedPluginsIntoSkills, readManagedPlugins } from "./managed-plugins.js";
import {
  filterPluginOwnedMcps,
  parseEnvObject,
  readBrainctlProjectMcps,
  readSkillDirs,
} from "./shared.js";
import type {
  AgentEnvReadOptions,
  AgentLiveConfig,
  AgentMcpEntry,
  AgentSkillEntry,
  RemoteMcpEntry,
} from "./types.js";

/**
 * Antigravity (Gemini's agent CLI) has shipped its MCP config under several
 * paths across releases; the first candidate that exists wins. Remote servers
 * use `httpUrl` (http) or `url` (sse). Skills live in `~/.gemini/skills/`.
 */
export async function readAntigravityConfig(
  options: AgentEnvReadOptions,
): Promise<AgentLiveConfig> {
  const homeDir = options.homeDir ?? homedir();
  const candidates = [
    path.join(homeDir, ".gemini", "antigravity-cli", "mcp_config.json"),
    path.join(homeDir, ".gemini", "config", "mcp_config.json"),
    path.join(homeDir, ".gemini", "antigravity", "mcp_config.json"),
    path.join(homeDir, ".gemini", "antigravity-ide", "mcp_config.json"),
  ];
  let configPath = candidates[0];
  const projectMaps = await readBrainctlProjectMcps(options.cwd, "antigravity");

  let rawServers: Record<string, Record<string, unknown>> = {};
  let exists = false;
  for (const candidatePath of candidates) {
    try {
      const source = await readFile(candidatePath, "utf8");
      configPath = candidatePath;
      exists = true;
      // An empty placeholder file is a live (empty) config, not a missing one.
      if (source.trim().length > 0) {
        const data = JSON.parse(source) as Record<string, unknown>;
        rawServers = (data.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
      }
      break;
    } catch {
      // try the next known Antigravity config location
    }
  }

  const mcpServers: Record<string, AgentMcpEntry> = {};
  const remoteMcpServers: Record<string, RemoteMcpEntry> = {};
  for (const [name, entry] of Object.entries(rawServers)) {
    const remoteEntry = toRemoteEntry(entry);
    if (remoteEntry) {
      remoteMcpServers[name] = remoteEntry;
      continue;
    }
    mcpServers[name] = {
      command: String(entry.command ?? ""),
      args: Array.isArray(entry.args) ? entry.args.map(String) : undefined,
      env: parseEnvObject(entry.env),
    };
  }

  const skills = await readAntigravitySkills(homeDir);
  const filtered = filterPluginOwnedMcps(
    { mcpServers, remoteMcpServers, ...projectMaps },
    skills,
  );
  return { agent: "antigravity", configPath, exists, ...filtered, skills };
}

function toRemoteEntry(entry: Record<string, unknown>): RemoteMcpEntry | null {
  if (typeof entry.httpUrl === "string" && entry.httpUrl.trim().length > 0) {
    return {
      transport: "http",
      url: entry.httpUrl,
      headers: parseEnvObject(entry.headers),
      env: parseEnvObject(entry.env),
    };
  }
  if (typeof entry.url === "string" && entry.url.trim().length > 0) {
    return {
      transport: "sse",
      url: entry.url,
      headers: parseEnvObject(entry.headers),
      env: parseEnvObject(entry.env),
    };
  }
  return null;
}

async function readAntigravitySkills(homeDir: string): Promise<AgentSkillEntry[]> {
  const managedPlugins = await readManagedPlugins({ agent: "antigravity", homeDir });
  try {
    const localSkills = await readSkillDirs(path.join(homeDir, ".gemini", "skills"));
    return mergeManagedPluginsIntoSkills(localSkills, managedPlugins);
  } catch {
    return managedPlugins;
  }
}
