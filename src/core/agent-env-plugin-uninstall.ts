/**
 * Plugin uninstall writers — the plugin counterpart to the skill/MCP writers
 * in `agent-env-writers.ts`, ported from brainctl's plugin-install-uninstall
 * service. Three removal paths:
 *
 *   - Claude native plugin  → delegate to `claude plugin uninstall` so a live
 *     Claude Code session drops it from memory (direct fs edits get
 *     resurrected by running sessions).
 *   - Codex native plugin   → strip its `[plugins."name@marketplace"]` section
 *     from `~/.codex/config.toml` (backup + atomic write) and delete its
 *     plugins-cache directory.
 *   - brainctl-managed      → delete the skill/command dirs and agent files it
 *     installed, remove its MCP entries, then drop its record from
 *     `~/.brainctl/managed-plugins.json`.
 *
 * Callers go through the staged preview → apply flow in agent-env-actions.
 */
import { spawn } from "node:child_process";
import { readFile, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AgentName, AgentSkillEntry } from "./agent-env/index.js";
import {
  atomicWrite,
  backupFile,
  removeMcp,
  removeSkill,
  type WriteOutcome,
  type WriterOptions,
} from "./agent-env-writers.js";

export type RunClaudeCli = (args: string[]) => Promise<void>;

export interface RemovePluginOptions extends WriterOptions {
  agent: AgentName;
  plugin: AgentSkillEntry;
  /** Injectable for tests; defaults to spawning `claude` from PATH. */
  runClaudeCli?: RunClaudeCli;
}

export function isRemovablePlugin(agent: AgentName, plugin: AgentSkillEntry): boolean {
  if (plugin.kind !== "plugin") return false;
  if (plugin.managed) return true;
  const native = agent === "claude" || agent === "codex";
  return native && !!plugin.installPath && !!plugin.source;
}

export async function removePlugin(options: RemovePluginOptions): Promise<WriteOutcome> {
  const { agent, plugin } = options;
  if (plugin.kind !== "plugin") {
    throw new Error(`"${plugin.name}" is not a plugin entry.`);
  }

  if (plugin.managed) return removeManagedPlugin(options);
  if (agent === "claude") return removeClaudeNativePlugin(options);
  if (agent === "codex") return removeCodexNativePlugin(options);
  throw new Error(`Plugin uninstall is not supported for ${agent}.`);
}

/* ---- Claude: delegate to the claude CLI ---- */

async function removeClaudeNativePlugin(options: RemovePluginOptions): Promise<WriteOutcome> {
  const { plugin } = options;
  const pluginKey = `${plugin.name}@${plugin.source}`;
  const run = options.runClaudeCli ?? defaultRunClaudeCli;
  await run(["plugin", "uninstall", pluginKey, "--scope", "user"]);
  return { backups: [] };
}

function defaultRunClaudeCli(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (chunk) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk) => (output += chunk.toString()));
    child.on("error", (error) => {
      reject(
        new Error(`Failed to invoke \`claude\` CLI: ${error.message}. Is Claude Code on PATH?`),
      );
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else {
        const detail = output.trim();
        reject(new Error(`\`claude ${args.join(" ")}\` exited ${code}${detail ? `: ${detail}` : ""}`));
      }
    });
  });
}

/* ---- Codex: config.toml section + plugins cache directory ---- */

async function removeCodexNativePlugin(options: RemovePluginOptions): Promise<WriteOutcome> {
  const { plugin } = options;
  const homeDir = options.homeDir ?? homedir();
  const cacheRoot = path.join(homeDir, ".codex", "plugins", "cache");
  const resolvedInstall = path.resolve(plugin.installPath ?? "");

  if (!resolvedInstall.startsWith(cacheRoot + path.sep)) {
    throw new Error(
      `Refusing to remove Codex plugin files outside ${cacheRoot}: ${resolvedInstall || "(no install path)"}`,
    );
  }

  const backups: string[] = [];
  const configPath = path.join(homeDir, ".codex", "config.toml");
  try {
    const existing = await readFile(configPath, "utf8");
    const next = stripCodexPluginSection(existing, `${plugin.name}@${plugin.source}`);
    if (next !== existing) {
      const backup = await backupFile(configPath);
      if (backup) backups.push(backup);
      await atomicWrite(configPath, next);
    }
  } catch {
    // no config.toml — cache dir removal below still applies
  }

  // installPath is the version dir; its parent is the plugin's cache root.
  await rm(path.dirname(resolvedInstall), { recursive: true, force: true });
  return { backups };
}

function stripCodexPluginSection(content: string, pluginKey: string): string {
  const target = `[plugins."${pluginKey}"]`;
  const result: string[] = [];
  let inTarget = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === target) {
      inTarget = true;
      continue;
    }
    if (inTarget && /^\[/.test(trimmed)) inTarget = false;
    if (!inTarget) result.push(line);
  }
  return result.join("\n");
}

/* ---- brainctl-managed: installed files + registry record ---- */

async function removeManagedPlugin(options: RemovePluginOptions): Promise<WriteOutcome> {
  const { agent, plugin } = options;
  const base = { cwd: options.cwd, homeDir: options.homeDir };
  const backups: string[] = [];

  // brainctl materialized plugin skills AND commands as skill dirs on agents
  // without a native plugin system.
  for (const skillName of [...(plugin.pluginSkills ?? []), ...(plugin.pluginCommands ?? [])]) {
    const outcome = await removeSkill({
      ...base,
      location: { agent, skillName, scope: "user" },
    });
    backups.push(...outcome.backups);
  }

  for (const key of plugin.pluginMcps ?? []) {
    const outcome = await removeMcp({ ...base, agent, key, scope: "user" });
    backups.push(...outcome.backups);
  }

  for (const agentName of plugin.pluginAgents ?? []) {
    const filePath = subagentFilePath(agent, agentName, options.homeDir);
    if (filePath) await unlink(filePath).catch(() => {});
  }

  await removeNoMoreIdeManagedBundle(agent, plugin.installPath, options.homeDir);
  backups.push(
    ...(await removeManagedRegistryRecords(
      agent,
      plugin.name,
      plugin.source,
      options.homeDir,
    )),
  );
  return { backups };
}

async function removeNoMoreIdeManagedBundle(
  agent: AgentName,
  installPath: string | undefined,
  homeDirOverride?: string,
): Promise<void> {
  if (!installPath) return;
  const home = homeDirOverride ?? homedir();
  const root = path.resolve(
    home,
    ".config",
    "nomoreide",
    "managed-plugin-bundles",
    agent,
  );
  const resolved = path.resolve(installPath);
  if (!resolved.startsWith(`${root}${path.sep}`)) return;
  await rm(resolved, { recursive: true, force: true });
}

function subagentFilePath(agent: AgentName, agentName: string, homeDir?: string): string | null {
  const home = homeDir ?? homedir();
  const safeName = path.basename(agentName);
  if (agent === "claude") return path.join(home, ".claude", "agents", `${safeName}.md`);
  if (agent === "codex") return path.join(home, ".codex", "agents", `${safeName}.toml`);
  return null;
}

async function removeManagedRegistryRecords(
  agent: AgentName,
  pluginName: string,
  pluginSource: string | undefined,
  homeDirOverride?: string,
): Promise<string[]> {
  const homeDir = homeDirOverride ?? homedir();
  const backups: string[] = [];
  for (const registryPath of [
    path.join(homeDir, ".config", "nomoreide", "managed-plugins.json"),
    path.join(homeDir, ".brainctl", "managed-plugins.json"),
  ]) {
    let data: { version: 1; agents?: Partial<Record<AgentName, AgentSkillEntry[]>> };
    try {
      data = JSON.parse(await readFile(registryPath, "utf8"));
    } catch {
      continue;
    }
    const entries = data.agents?.[agent] ?? [];
    const next = entries.filter(
      (entry) =>
        entry.name !== pluginName ||
        (entry.source ?? "") !== (pluginSource ?? ""),
    );
    if (next.length === entries.length) continue;
    const backup = await backupFile(registryPath);
    if (backup) backups.push(backup);
    data.agents = { ...data.agents, [agent]: next };
    await atomicWrite(registryPath, `${JSON.stringify(data, null, 2)}\n`);
  }
  return backups;
}
