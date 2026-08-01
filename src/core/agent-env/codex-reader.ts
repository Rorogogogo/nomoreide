import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { mergeManagedPluginsIntoSkills, readManagedPlugins } from "./managed-plugins.js";
import { readCodexPlugins } from "./plugin-reader.js";
import {
  filterPluginOwnedMcps,
  readBrainctlProjectMcps,
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
 * Codex CLI stores MCP servers as `[mcp_servers.*]` TOML sections in
 * `~/.codex/config.toml`. Skills follow the Agent Skills standard:
 * `~/.agents/skills/` for personal skills (legacy `~/.codex/skills/` is still
 * read) and `<repo>/.agents/skills/` for project skills. The TOML subset
 * parser is deliberate — the config format only uses flat sections with
 * string/array values, and a dependency-free parse mirrors what brainctl
 * shipped and tested.
 */
export async function readCodexConfig(options: AgentEnvReadOptions): Promise<AgentLiveConfig> {
  const homeDir = options.homeDir ?? homedir();
  const configPath = path.join(homeDir, ".codex", "config.toml");
  const projectMaps = await readBrainctlProjectMcps(options.cwd, "codex");
  const skills = await readCodexSkills(homeDir, options.cwd);

  try {
    const source = await readFile(configPath, "utf8");
    const { mcpServers, remoteMcpServers } = parseCodexToml(source);
    const filtered = filterPluginOwnedMcps(
      { mcpServers, remoteMcpServers, ...projectMaps },
      skills,
    );
    return { agent: "codex", configPath, exists: true, ...filtered, skills };
  } catch {
    return {
      agent: "codex",
      configPath,
      exists: false,
      mcpServers: {},
      remoteMcpServers: {},
      ...projectMaps,
      skills,
    };
  }
}

async function readCodexSkills(homeDir: string, cwd: string): Promise<AgentSkillEntry[]> {
  const nativePlugins = await readCodexPlugins({
    configTomlPath: path.join(homeDir, ".codex", "config.toml"),
    pluginsCacheDir: path.join(homeDir, ".codex", "plugins", "cache"),
  });
  const managedPlugins = await readManagedPlugins({ agent: "codex", homeDir });

  // Personal skills: the Agent Skills standard dir wins over the legacy dir
  // when the same name exists in both.
  const localSkills = dedupeSkillsByName([
    ...(await readSkillDirsSafe(path.join(homeDir, ".agents", "skills"))),
    ...(await readSkillDirsSafe(path.join(homeDir, ".codex", "skills"))),
  ]);
  const projectSkills = await readProjectSkills(cwd, path.join(".agents", "skills"));

  const allPlugins = dedupePluginsByIdentity([...managedPlugins, ...nativePlugins]);
  return [...mergeManagedPluginsIntoSkills(localSkills, allPlugins), ...projectSkills];
}

async function readSkillDirsSafe(skillsDir: string): Promise<AgentSkillEntry[]> {
  try {
    return await readSkillDirs(skillsDir);
  } catch {
    return [];
  }
}

function dedupeSkillsByName(skills: AgentSkillEntry[]): AgentSkillEntry[] {
  const seen = new Map<string, AgentSkillEntry>();
  for (const skill of skills) {
    if (!seen.has(skill.name)) seen.set(skill.name, skill);
  }
  return Array.from(seen.values());
}

function dedupePluginsByIdentity(plugins: AgentSkillEntry[]): AgentSkillEntry[] {
  const seen = new Map<string, AgentSkillEntry>();
  for (const plugin of plugins) {
    const identity = `${plugin.name}\0${plugin.source ?? ""}`;
    if (!seen.has(identity)) seen.set(identity, plugin);
  }
  return Array.from(seen.values());
}

function parseCodexToml(source: string): {
  mcpServers: Record<string, AgentMcpEntry>;
  remoteMcpServers: Record<string, RemoteMcpEntry>;
} {
  const mcpServers: Record<string, AgentMcpEntry> = {};
  const remoteMcpServers: Record<string, RemoteMcpEntry> = {};

  let currentServer: string | null = null;
  let inEnv = false;
  let currentEntry: AgentMcpEntry = { command: "" };
  let currentEnv: Record<string, string> = {};
  let currentUrl: string | null = null;

  const flush = () => {
    if (!currentServer) return;
    if (currentUrl) {
      remoteMcpServers[currentServer] = { transport: "http", url: currentUrl };
    } else {
      if (Object.keys(currentEnv).length > 0) currentEntry.env = currentEnv;
      mcpServers[currentServer] = currentEntry;
    }
  };

  for (const line of source.split("\n")) {
    const trimmed = line.trim();

    if (/^\[mcp_servers\.([^.]+)\.env\]$/.test(trimmed)) {
      inEnv = true;
      continue;
    }

    const serverMatch = trimmed.match(/^\[mcp_servers\.([^\].]+)\]$/);
    if (serverMatch) {
      flush();
      currentServer = serverMatch[1];
      currentEntry = { command: "" };
      currentEnv = {};
      currentUrl = null;
      inEnv = false;
      continue;
    }

    if (/^\[/.test(trimmed) && !/^\[mcp_servers/.test(trimmed)) {
      flush();
      currentServer = null;
      currentEntry = { command: "" };
      currentEnv = {};
      currentUrl = null;
      inEnv = false;
      continue;
    }

    const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
    if (!kvMatch || !currentServer) continue;

    const [, key, rawValue] = kvMatch;
    if (inEnv) {
      currentEnv[key] = parseTomlValue(rawValue);
    } else if (key === "url") {
      currentUrl = parseTomlValue(rawValue);
    } else if (key === "command") {
      currentEntry.command = parseTomlValue(rawValue);
    } else if (key === "args") {
      currentEntry.args = parseTomlArray(rawValue);
    }
  }

  flush();
  return { mcpServers, remoteMcpServers };
}

function parseTomlValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

function parseTomlArray(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const result: string[] = [];
  for (const part of trimmed.slice(1, -1).split(",")) {
    const value = parseTomlValue(part.trim());
    if (value.length > 0) result.push(value);
  }
  return result;
}
