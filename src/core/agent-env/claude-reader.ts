import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { readInstalledPlugins } from "./plugin-reader.js";
import {
  filterPluginOwnedMcps,
  parseEnvObject,
  readProjectSkills,
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
 * Claude Code keeps everything in `~/.claude.json`: top-level `mcpServers`
 * (user scope) and `projects[cwd].mcpServers` (project scope). Skills come
 * from marketplace plugins, `~/.claude/skills/`, and `<repo>/.claude/skills/`.
 */
export async function readClaudeConfig(options: AgentEnvReadOptions): Promise<AgentLiveConfig> {
  const homeDir = options.homeDir ?? homedir();
  const configPath = path.join(homeDir, ".claude.json");
  const skills = [
    ...(await readClaudeUserSkills(homeDir)),
    ...(await readProjectSkills(options.cwd)),
  ];

  try {
    const source = await readFile(configPath, "utf8");
    const data = JSON.parse(source) as Record<string, unknown>;

    const userServers = (data.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
    const projects = (data.projects ?? {}) as Record<string, Record<string, unknown>>;
    const projectConfig = (projects[options.cwd] ?? {}) as Record<string, unknown>;
    const projectServers = (projectConfig.mcpServers ?? {}) as Record<
      string,
      Record<string, unknown>
    >;

    const user = splitClaudeServers(userServers);
    const project = splitClaudeServers(projectServers);
    const filtered = filterPluginOwnedMcps(
      {
        mcpServers: user.local,
        remoteMcpServers: user.remote,
        projectMcpServers: project.local,
        projectRemoteMcpServers: project.remote,
      },
      skills,
    );
    return { agent: "claude", configPath, exists: true, ...filtered, skills };
  } catch {
    return {
      agent: "claude",
      configPath,
      exists: false,
      mcpServers: {},
      remoteMcpServers: {},
      projectMcpServers: {},
      projectRemoteMcpServers: {},
      skills,
    };
  }
}

function splitClaudeServers(servers: Record<string, Record<string, unknown>>): {
  local: Record<string, AgentMcpEntry>;
  remote: Record<string, RemoteMcpEntry>;
} {
  const local: Record<string, AgentMcpEntry> = {};
  const remote: Record<string, RemoteMcpEntry> = {};
  for (const [name, entry] of Object.entries(servers)) {
    if (isClaudeRemoteEntry(entry)) {
      remote[name] = {
        transport: entry.type === "sse" ? "sse" : "http",
        url: String(entry.url ?? ""),
        headers: parseEnvObject(entry.headers),
        env: parseEnvObject(entry.env),
      };
    } else {
      local[name] = {
        command: String(entry.command ?? ""),
        args: Array.isArray(entry.args) ? entry.args.map(String) : undefined,
        env: parseEnvObject(entry.env),
      };
    }
  }
  return { local, remote };
}

function isClaudeRemoteEntry(entry: Record<string, unknown>): boolean {
  if (typeof entry.url !== "string" || entry.url.trim().length === 0) {
    return false;
  }
  return entry.type === "http" || entry.type === "sse" || !("command" in entry);
}

async function readClaudeUserSkills(homeDir: string): Promise<AgentSkillEntry[]> {
  const results: AgentSkillEntry[] = [];

  try {
    const pluginsPath = path.join(homeDir, ".claude", "plugins", "installed_plugins.json");
    results.push(...(await readInstalledPlugins(pluginsPath)));
  } catch {
    // no plugins file
  }

  try {
    results.push(...(await readSkillDirs(path.join(homeDir, ".claude", "skills"))));
  } catch {
    // no skills dir
  }

  return results;
}
