import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentSkillEntry } from "./types.js";

interface InstalledPluginRecord {
  installPath?: string;
}

interface InstalledPluginsFile {
  plugins?: Record<string, InstalledPluginRecord[]>;
}

/** Marketplace plugins from Claude's `~/.claude/plugins/installed_plugins.json`. */
export async function readInstalledPlugins(
  installedPluginsPath: string,
): Promise<AgentSkillEntry[]> {
  const source = await readFile(installedPluginsPath, "utf8");
  const data = JSON.parse(source) as InstalledPluginsFile;
  const results: AgentSkillEntry[] = [];

  for (const [key, records] of Object.entries(data.plugins ?? {})) {
    const [name, pluginSource] = key.split("@");
    const installPath = records[0]?.installPath;
    const pluginSkills = installPath ? await readPluginSkills(installPath) : [];
    const pluginMcps = installPath ? await readPluginMcpKeys(installPath) : [];
    const pluginAgents = installPath ? await readPluginAgentNames(installPath) : [];
    const pluginCommands = installPath ? await readPluginCommandNames(installPath) : [];

    results.push({
      name,
      source: pluginSource,
      kind: "plugin",
      scope: "user",
      installPath,
      pluginSkills,
      ...(pluginMcps.length > 0 ? { pluginMcps } : {}),
      ...(pluginAgents.length > 0 ? { pluginAgents } : {}),
      ...(pluginCommands.length > 0 ? { pluginCommands } : {}),
    });
  }

  return results;
}

/** Enabled Codex plugins declared in config.toml and materialized in the plugins cache. */
export async function readCodexPlugins(options: {
  configTomlPath: string;
  pluginsCacheDir: string;
}): Promise<AgentSkillEntry[]> {
  let tomlSource: string;
  try {
    tomlSource = await readFile(options.configTomlPath, "utf8");
  } catch {
    return [];
  }

  const entries: AgentSkillEntry[] = [];
  for (const { name, marketplace, enabled } of parseCodexPluginDeclarations(tomlSource)) {
    if (!enabled) continue;
    const installPath = await resolveCodexPluginInstallPath({
      pluginsCacheDir: options.pluginsCacheDir,
      marketplace,
      name,
    });
    if (!installPath) continue;

    const pluginSkills = await readPluginSkills(installPath);
    const pluginMcps = await readPluginMcpKeys(installPath);
    const pluginAgents = await readPluginAgentNames(installPath);
    const pluginCommands = await readPluginCommandNames(installPath);
    entries.push({
      name,
      source: marketplace,
      kind: "plugin",
      scope: "user",
      installPath,
      pluginSkills,
      ...(pluginMcps.length > 0 ? { pluginMcps } : {}),
      ...(pluginAgents.length > 0 ? { pluginAgents } : {}),
      ...(pluginCommands.length > 0 ? { pluginCommands } : {}),
    });
  }

  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

function parseCodexPluginDeclarations(
  source: string,
): Array<{ name: string; marketplace: string; enabled: boolean }> {
  const results: Array<{ name: string; marketplace: string; enabled: boolean }> = [];
  const lines = source.split("\n");

  let current: { name: string; marketplace: string; enabled: boolean } | null = null;
  const flush = () => {
    if (current) {
      results.push(current);
      current = null;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const sectionMatch = trimmed.match(/^\[plugins\."([^"@]+)@([^"]+)"\]$/);
    if (sectionMatch) {
      flush();
      current = { name: sectionMatch[1], marketplace: sectionMatch[2], enabled: false };
      continue;
    }

    if (/^\[/.test(trimmed)) {
      flush();
      continue;
    }

    if (!current) continue;
    const kv = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
    if (kv && kv[1] === "enabled") {
      current.enabled = kv[2].trim() === "true";
    }
  }

  flush();
  return results;
}

async function resolveCodexPluginInstallPath(options: {
  pluginsCacheDir: string;
  marketplace: string;
  name: string;
}): Promise<string | null> {
  const pluginRoot = path.join(options.pluginsCacheDir, options.marketplace, options.name);
  let versionDirs: string[];
  try {
    const entries = await readdir(pluginRoot, { withFileTypes: true });
    versionDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return null;
  }

  if (versionDirs.length === 0) return null;
  if (versionDirs.length === 1) return path.join(pluginRoot, versionDirs[0]);

  const stats = await Promise.all(
    versionDirs.map(async (dir) => {
      try {
        const info = await stat(path.join(pluginRoot, dir));
        return { dir, mtime: info.mtimeMs };
      } catch {
        return { dir, mtime: 0 };
      }
    }),
  );
  stats.sort((left, right) => right.mtime - left.mtime);
  return path.join(pluginRoot, stats[0].dir);
}

async function readPluginSkills(installPath: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(installPath, "skills"), { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith(".") && entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

async function readPluginAgentNames(installPath: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(installPath, "agents"), { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".toml")),
      )
      .map((entry) => entry.name.replace(/\.(md|toml)$/, ""))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

async function readPluginCommandNames(installPath: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(installPath, "commands"), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.replace(/\.md$/, ""))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

export async function readPluginMcpKeys(installPath: string): Promise<string[]> {
  try {
    const source = await readFile(path.join(installPath, ".mcp.json"), "utf8");
    const parsed = JSON.parse(source) as Record<string, unknown>;
    const servers =
      parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)
        ? (parsed.mcpServers as Record<string, unknown>)
        : parsed;
    return Object.keys(servers).sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}
