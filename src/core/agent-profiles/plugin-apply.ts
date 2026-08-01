import { cp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type {
  AgentLiveConfig,
  AgentMcpEntry,
  AgentName,
  RemoteMcpEntry,
} from "../agent-env/index.js";
import { writeManagedPlugin } from "../agent-env/managed-plugins.js";
import {
  addMcp,
  atomicWrite,
  backupFile,
  installSkillFromDirectory,
  type WriteOutcome,
} from "../agent-env-writers.js";
import type { ProfilePlugin } from "./types.js";
import { pluginBundleDigest } from "./plugin-bundle.js";
import { readManagedPlugins } from "../agent-env/managed-plugins.js";
import { removePlugin } from "../agent-env-plugin-uninstall.js";

export interface PluginApplyPlan {
  status: "add" | "identical" | "conflict";
  strategy: "native" | "managed";
  warnings: string[];
}

export async function previewPluginApply(
  plugin: ProfilePlugin,
  targetAgent: AgentName,
  live: AgentLiveConfig,
): Promise<PluginApplyPlan> {
  const existing = live.skills.find(
    (entry) =>
      entry.kind === "plugin" &&
      entry.name === plugin.name &&
      (entry.source ?? "") === (plugin.source ?? ""),
  );
  const strategy =
    !plugin.managed &&
    plugin.sourceAgent === targetAgent &&
    (targetAgent === "claude" || targetAgent === "codex")
      ? "native"
      : "managed";
  const warnings: string[] = [];
  if (strategy === "managed") {
    warnings.push(
      `Plugin "${plugin.name}" will be installed as portable assets rather than a native ${targetAgent} plugin.`,
    );
  }
  if (targetAgent === "antigravity" && (plugin.pluginAgents?.length ?? 0) > 0) {
    warnings.push("Antigravity does not support bundled subagents; those files will be skipped.");
  }
  if (targetAgent === "antigravity" && (plugin.pluginCommands?.length ?? 0) > 0) {
    warnings.push("Plugin commands will be installed as user skills on Antigravity.");
  }
  const managedConflicts =
    strategy === "managed" ? findManagedAssetConflicts(plugin, live) : [];
  if (managedConflicts.length > 0) {
    warnings.push(
      `Portable plugin assets conflict with existing user items: ${managedConflicts.join(", ")}.`,
    );
  }
  const identical =
    existing?.installPath && plugin.digest
      ? await pluginBundleDigest(existing.installPath).then(
          (digest) => digest === plugin.digest,
          () => false,
        )
      : false;
  return {
    status: identical
      ? "identical"
      : existing || managedConflicts.length > 0
        ? "conflict"
        : "add",
    strategy,
    warnings,
  };
}

function findManagedAssetConflicts(
  plugin: ProfilePlugin,
  live: AgentLiveConfig,
): string[] {
  const skillNames = new Set([
    ...(plugin.pluginSkills ?? []),
    ...(plugin.pluginCommands ?? []),
  ]);
  const mcpNames = new Set(plugin.pluginMcps ?? []);
  const conflicts = new Set<string>();

  for (const skill of live.skills) {
    if (skill.kind === "plugin") {
      for (const name of [...(skill.pluginSkills ?? []), ...(skill.pluginCommands ?? [])]) {
        if (skillNames.has(name)) conflicts.add(`skill "${name}"`);
      }
      for (const name of skill.pluginMcps ?? []) {
        if (mcpNames.has(name)) conflicts.add(`MCP "${name}"`);
      }
      continue;
    }
    if (skill.scope === "user" && skillNames.has(skill.name)) {
      conflicts.add(`skill "${skill.name}"`);
    }
  }

  for (const name of mcpNames) {
    if (live.mcpServers[name] || live.remoteMcpServers[name]) {
      conflicts.add(`MCP "${name}"`);
    }
  }
  return Array.from(conflicts).sort((left, right) => left.localeCompare(right));
}

export async function applyPluginBundle(options: {
  cwd: string;
  homeDir?: string;
  plugin: ProfilePlugin;
  sourceDir: string;
  targetAgent: AgentName;
}): Promise<WriteOutcome> {
  if (
    !options.plugin.managed &&
    options.plugin.sourceAgent === options.targetAgent &&
    options.targetAgent === "claude"
  ) {
    return restoreClaudePlugin(options);
  }
  if (
    !options.plugin.managed &&
    options.plugin.sourceAgent === options.targetAgent &&
    options.targetAgent === "codex"
  ) {
    return restoreCodexPlugin(options);
  }
  return installManagedPlugin(options);
}

async function restoreClaudePlugin(options: {
  homeDir?: string;
  plugin: ProfilePlugin;
  sourceDir: string;
}): Promise<WriteOutcome> {
  const home = options.homeDir ?? homedir();
  const registryPath = path.join(home, ".claude", "plugins", "installed_plugins.json");
  let registry: { version?: number; plugins?: Record<string, unknown> } = {
    version: 2,
    plugins: {},
  };
  let registryBackup: string | null = null;
  try {
    const source = await readFile(registryPath, "utf8");
    const parsed = JSON.parse(source) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      ("plugins" in parsed &&
        ((parsed as { plugins?: unknown }).plugins === null ||
          typeof (parsed as { plugins?: unknown }).plugins !== "object" ||
          Array.isArray((parsed as { plugins?: unknown }).plugins)))
    ) {
      throw new Error("unexpected registry shape");
    }
    registry = parsed as typeof registry;
    registryBackup = await backupFile(registryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Claude plugin registry is invalid: ${registryPath}`);
    }
  }

  const marketplace = safeSegment(options.plugin.source ?? "local");
  const version = safeSegment(options.plugin.version ?? "profile");
  const destination = path.join(
    home,
    ".claude",
    "plugins",
    "cache",
    marketplace,
    safeSegment(options.plugin.name),
    version,
  );
  const directoryBackup = await replaceDirectory(options.sourceDir, destination, home);

  const backups: string[] = [];
  if (directoryBackup) backups.push(directoryBackup);
  if (registryBackup) backups.push(registryBackup);
  const now = new Date().toISOString();
  registry.plugins = {
    ...(registry.plugins ?? {}),
    [`${options.plugin.name}@${marketplace}`]: [
      {
        scope: "user",
        installPath: destination,
        version,
        installedAt: now,
        lastUpdated: now,
      },
    ],
  };
  await mkdir(path.dirname(registryPath), { recursive: true });
  await atomicWrite(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  return { backups };
}

async function restoreCodexPlugin(options: {
  homeDir?: string;
  plugin: ProfilePlugin;
  sourceDir: string;
}): Promise<WriteOutcome> {
  const home = options.homeDir ?? homedir();
  const marketplace = safeSegment(options.plugin.source ?? "local");
  const version = safeSegment(options.plugin.version ?? "profile");
  const destination = path.join(
    home,
    ".codex",
    "plugins",
    "cache",
    marketplace,
    safeSegment(options.plugin.name),
    version,
  );
  const directoryBackup = await replaceDirectory(options.sourceDir, destination, home);

  const configPath = path.join(home, ".codex", "config.toml");
  const backups: string[] = [];
  if (directoryBackup) backups.push(directoryBackup);
  let config = "";
  try {
    config = await readFile(configPath, "utf8");
    const backup = await backupFile(configPath);
    if (backup) backups.push(backup);
  } catch {
    // Fresh config.
  }
  const pluginKey = `${options.plugin.name}@${marketplace}`;
  const section = `[plugins.${JSON.stringify(pluginKey)}]\nenabled = true`;
  const next = upsertTomlSection(config, `[plugins.${JSON.stringify(pluginKey)}]`, section);
  await mkdir(path.dirname(configPath), { recursive: true });
  await atomicWrite(configPath, `${next.trimEnd()}\n`);
  return { backups };
}

async function installManagedPlugin(options: {
  cwd: string;
  homeDir?: string;
  plugin: ProfilePlugin;
  sourceDir: string;
  targetAgent: AgentName;
}): Promise<WriteOutcome> {
  const backups: string[] = [];
  const home = options.homeDir ?? homedir();
  const previous = (await readManagedPlugins({
    agent: options.targetAgent,
    homeDir: options.homeDir,
  })).find(
    (entry) =>
      entry.name === options.plugin.name &&
      (entry.source ?? "") === (options.plugin.source ?? ""),
  );
  if (previous) {
    const outcome = await removePlugin({
      cwd: options.cwd,
      homeDir: options.homeDir,
      agent: options.targetAgent,
      plugin: previous,
    });
    backups.push(...outcome.backups);
  }
  const managedSourceDir = path.join(
    home,
    ".config",
    "nomoreide",
    "managed-plugin-bundles",
    options.targetAgent,
    options.plugin.bundleKey,
  );
  const bundleBackup = await replaceDirectory(options.sourceDir, managedSourceDir, home);
  if (bundleBackup) backups.push(bundleBackup);
  const installedSkills: string[] = [];
  const installedMcps: string[] = [];
  const installedAgents: string[] = [];
  const installedCommands: string[] = [];

  for (const skillName of await directoryNames(path.join(managedSourceDir, "skills"))) {
    const outcome = await installSkillFromDirectory({
      cwd: options.cwd,
      homeDir: options.homeDir,
      sourceDir: path.join(managedSourceDir, "skills", skillName),
      target: { agent: options.targetAgent, skillName, scope: "user" },
    });
    backups.push(...outcome.backups);
    installedSkills.push(skillName);
  }

  for (const commandName of await markdownNames(path.join(options.sourceDir, "commands"))) {
    const tempDir = path.join(
      options.homeDir ?? homedir(),
      ".config",
      "nomoreide",
      "profile-command-staging",
      options.plugin.bundleKey,
      commandName,
    );
    await rm(tempDir, { recursive: true, force: true });
    await mkdir(tempDir, { recursive: true });
    await cp(path.join(managedSourceDir, "commands", `${commandName}.md`), path.join(tempDir, "SKILL.md"));
    const outcome = await installSkillFromDirectory({
      cwd: options.cwd,
      homeDir: options.homeDir,
      sourceDir: tempDir,
      target: { agent: options.targetAgent, skillName: commandName, scope: "user" },
    });
    backups.push(...outcome.backups);
    installedCommands.push(commandName);
  }

  for (const [key, mcp] of Object.entries(await readPluginMcps(managedSourceDir))) {
    const outcome = await addMcp({
      cwd: options.cwd,
      homeDir: options.homeDir,
      agent: options.targetAgent,
      key,
      scope: "user",
      ...mcp,
    });
    backups.push(...outcome.backups);
    installedMcps.push(key);
  }

  if (options.targetAgent !== "antigravity") {
    const expectedExtension = options.targetAgent === "claude" ? ".md" : ".toml";
    const targetRoot = path.join(
      options.homeDir ?? homedir(),
      `.${options.targetAgent}`,
      "agents",
    );
    for (const file of await fileNames(path.join(managedSourceDir, "agents"))) {
      if (path.extname(file) !== expectedExtension) continue;
      const target = path.join(targetRoot, path.basename(file));
      await mkdir(path.dirname(target), { recursive: true });
      const backup = await backupFile(target);
      if (backup) backups.push(backup);
      await atomicWrite(target, await readFile(path.join(managedSourceDir, "agents", file), "utf8"));
      installedAgents.push(path.basename(file, expectedExtension));
    }
  }

  const registryPath = path.join(
    options.homeDir ?? homedir(),
    ".config",
    "nomoreide",
    "managed-plugins.json",
  );
  const registryBackup = await backupFile(registryPath);
  if (registryBackup) backups.push(registryBackup);
  await writeManagedPlugin({
    agent: options.targetAgent,
    homeDir: options.homeDir,
    plugin: {
      name: options.plugin.name,
      source: options.plugin.source,
      kind: "plugin",
      scope: "user",
      managed: true,
      installPath: managedSourceDir,
      pluginSkills: installedSkills,
      pluginMcps: installedMcps,
      pluginAgents: installedAgents,
      pluginCommands: installedCommands,
    },
  });
  return { backups };
}

async function readPluginMcps(
  sourceDir: string,
): Promise<Record<string, { entry?: AgentMcpEntry; remoteEntry?: RemoteMcpEntry }>> {
  try {
    const parsed = JSON.parse(await readFile(path.join(sourceDir, ".mcp.json"), "utf8")) as {
      mcpServers?: Record<string, unknown>;
    } & Record<string, unknown>;
    const source =
      parsed.mcpServers && typeof parsed.mcpServers === "object"
        ? parsed.mcpServers
        : parsed;
    const result: Record<string, { entry?: AgentMcpEntry; remoteEntry?: RemoteMcpEntry }> = {};
    for (const [key, value] of Object.entries(source)) {
      if (typeof value !== "object" || value === null) continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.command === "string") {
        result[key] = {
          entry: {
            command: entry.command,
            ...(Array.isArray(entry.args) ? { args: entry.args.map(String) } : {}),
            ...(entry.env && typeof entry.env === "object"
              ? { env: stringRecord(entry.env) }
              : {}),
          },
        };
      } else if (typeof entry.url === "string") {
        result[key] = {
          remoteEntry: {
            transport:
              entry.type === "sse" || entry.transport === "sse" ? "sse" : "http",
            url: entry.url,
            ...(entry.headers && typeof entry.headers === "object"
              ? { headers: stringRecord(entry.headers) }
              : {}),
            ...(entry.env && typeof entry.env === "object"
              ? { env: stringRecord(entry.env) }
              : {}),
          },
        };
      }
    }
    return result;
  } catch {
    return {};
  }
}

function stringRecord(value: object): Record<string, string> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]));
}

async function replaceDirectory(
  source: string,
  destination: string,
  homeDir: string,
): Promise<string | null> {
  await mkdir(path.dirname(destination), { recursive: true });
  const staging = `${destination}.tmp.${process.pid}.${Date.now()}`;
  await rm(staging, { recursive: true, force: true });
  await cp(source, staging, { recursive: true });
  let backup: string | null = null;
  try {
    await readdir(destination);
    backup = path.join(
      homeDir,
      ".config",
      "nomoreide",
      "agent-env-backups",
      `plugin-${path.basename(destination)}-${Date.now()}`,
    );
    await mkdir(path.dirname(backup), { recursive: true });
    await cp(destination, backup, { recursive: true });
  } catch {
    // Fresh destination.
  }
  await rm(destination, { recursive: true, force: true });
  await rename(staging, destination);
  return backup;
}

function safeSegment(value: string): string {
  const safe = path.basename(value).replace(/[^A-Za-z0-9._-]+/g, "-");
  return safe || "unknown";
}

function upsertTomlSection(content: string, header: string, section: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let skipping = false;
  let inserted = false;
  for (const line of lines) {
    if (line.trim() === header) {
      if (!inserted) result.push(section);
      inserted = true;
      skipping = true;
      continue;
    }
    if (skipping && /^\s*\[/.test(line)) skipping = false;
    if (!skipping) result.push(line);
  }
  if (!inserted) result.push("", section);
  return result.join("\n").trim();
}

async function directoryNames(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function fileNames(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function markdownNames(root: string): Promise<string[]> {
  return (await fileNames(root))
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.basename(name, ".md"));
}
