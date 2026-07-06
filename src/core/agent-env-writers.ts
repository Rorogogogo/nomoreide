/**
 * Agent Environments low-level writers — the ONLY code that mutates coding
 * agents' config files. Ported from brainctl's agent-config-service (ROR-61).
 * Kept separate from the read-safe `core/agent-env/` module, mirroring the
 * GitManager/GitActions and DbPeek/DbWrite splits; callers go through the
 * staged preview → apply flow in `agent-env-actions.ts`.
 *
 * Every mutation backs up the touched file to a timestamped sibling
 * (`<file>.bak.<ts>`) and writes atomically (temp file + rename). Skill
 * directory removals are backed up under
 * `<home>/.config/nomoreide/agent-env-backups/` first.
 */
import { constants } from "node:fs";
import { copyFile, cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  readAntigravityConfig,
  readCodexConfig,
  type AgentMcpEntry,
  type AgentName,
  type RemoteMcpEntry,
} from "./agent-env/index.js";

export type AgentEnvScope = "user" | "project";

export interface WriterOptions {
  cwd: string;
  /** Injectable for tmpdir tests, like the readers. */
  homeDir?: string;
}

/** Paths of `.bak.*` copies created before the mutation (empty for fresh files). */
export interface WriteOutcome {
  backups: string[];
}

export function formatTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function backupFile(filePath: string): Promise<string | null> {
  const base = `${filePath}.bak.${formatTimestamp()}`;
  // COPYFILE_EXCL + suffix loop: two writes within the same second (e.g. the
  // add+remove halves of a move) must not overwrite each other's backup.
  for (let attempt = 0; attempt < 10; attempt++) {
    const backupPath = attempt === 0 ? base : `${base}-${attempt}`;
    try {
      await copyFile(filePath, backupPath, constants.COPYFILE_EXCL);
      return backupPath;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") continue;
      return null; // source file does not exist yet — nothing to back up
    }
  }
  return null;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp.${Date.now()}`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, filePath);
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await atomicWrite(filePath, JSON.stringify(data, null, 2) + "\n");
}

/* ---- MCP servers ---- */

export interface McpMutationOptions extends WriterOptions {
  agent: AgentName;
  key: string;
  scope: AgentEnvScope;
}

export interface AddMcpOptions extends McpMutationOptions {
  entry?: AgentMcpEntry;
  remoteEntry?: RemoteMcpEntry;
}

export async function addMcp(options: AddMcpOptions): Promise<WriteOutcome> {
  const { agent, key, entry, remoteEntry, scope } = options;
  if (!entry && !remoteEntry) {
    throw new Error(`MCP "${key}" has neither a command nor a URL; nothing to add.`);
  }

  if (agent === "claude") {
    return mutateClaudeConfig(options, scope, (servers) => {
      servers[key] = remoteEntry ? toClaudeRemoteEntry(remoteEntry) : toClaudeEntry(entry!);
    });
  }
  if (scope === "project") {
    // Codex and Antigravity have no native per-project config; brainctl's
    // `.brainctl/project-mcps.json` convention is kept for compatibility.
    return mutateBrainctlProjectMcps(options, agent, (servers) => {
      servers[key] = remoteEntry
        ? { transport: remoteEntry.transport, url: remoteEntry.url }
        : {
            command: entry!.command,
            ...(entry!.args ? { args: entry!.args } : {}),
            ...(entry!.env ? { env: entry!.env } : {}),
          };
    });
  }
  if (agent === "codex") {
    return mutateCodexConfig(options, (state) => {
      delete state.mcpServers[key];
      delete state.remoteMcpServers[key];
      if (remoteEntry) state.remoteMcpServers[key] = remoteEntry;
      else state.mcpServers[key] = entry!;
    });
  }
  return mutateAntigravityConfig(options, (servers) => {
    servers[key] = remoteEntry ? toAntigravityRemoteEntry(remoteEntry) : toAntigravityEntry(entry!);
  });
}

export async function removeMcp(options: McpMutationOptions): Promise<WriteOutcome> {
  const { agent, key, scope } = options;

  if (agent === "claude") {
    return mutateClaudeConfig(options, scope, (servers) => {
      delete servers[key];
    });
  }
  if (scope === "project") {
    return mutateBrainctlProjectMcps(options, agent, (servers) => {
      delete servers[key];
    });
  }
  if (agent === "codex") {
    return mutateCodexConfig(options, (state) => {
      delete state.mcpServers[key];
      delete state.remoteMcpServers[key];
    });
  }
  return mutateAntigravityConfig(options, (servers) => {
    delete servers[key];
  });
}

/* ---- Claude: ~/.claude.json with top-level and projects[cwd] mcpServers ---- */

async function mutateClaudeConfig(
  options: WriterOptions,
  scope: AgentEnvScope,
  mutate: (servers: Record<string, unknown>) => void,
): Promise<WriteOutcome> {
  const homeDir = options.homeDir ?? homedir();
  const configPath = path.join(homeDir, ".claude.json");
  const backups: string[] = [];
  let existing: Record<string, unknown> = {};

  try {
    existing = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    const backup = await backupFile(configPath);
    if (backup) backups.push(backup);
  } catch {
    // fresh config
  }

  if (scope === "user") {
    const servers = (existing.mcpServers ?? {}) as Record<string, unknown>;
    mutate(servers);
    existing.mcpServers = servers;
  } else {
    const projects = (existing.projects ?? {}) as Record<string, Record<string, unknown>>;
    const projectConfig = (projects[options.cwd] ?? {}) as Record<string, unknown>;
    const servers = (projectConfig.mcpServers ?? {}) as Record<string, unknown>;
    mutate(servers);
    projectConfig.mcpServers = servers;
    projects[options.cwd] = projectConfig;
    existing.projects = projects;
  }

  await atomicWriteJson(configPath, existing);
  return { backups };
}

function toClaudeEntry(entry: AgentMcpEntry): Record<string, unknown> {
  return {
    type: "stdio",
    command: entry.command,
    args: entry.args ?? [],
    ...(entry.env ? { env: entry.env } : {}),
  };
}

function toClaudeRemoteEntry(entry: RemoteMcpEntry): Record<string, unknown> {
  return {
    type: entry.transport === "sse" ? "sse" : "http",
    url: entry.url,
    ...(entry.headers ? { headers: entry.headers } : {}),
  };
}

/* ---- Codex: [mcp_servers.*] TOML sections in ~/.codex/config.toml ---- */

async function mutateCodexConfig(
  options: WriterOptions,
  mutate: (state: {
    mcpServers: Record<string, AgentMcpEntry>;
    remoteMcpServers: Record<string, RemoteMcpEntry>;
  }) => void,
): Promise<WriteOutcome> {
  const homeDir = options.homeDir ?? homedir();
  const configPath = path.join(homeDir, ".codex", "config.toml");
  const backups: string[] = [];
  let existingContent = "";

  try {
    existingContent = await readFile(configPath, "utf8");
    const backup = await backupFile(configPath);
    if (backup) backups.push(backup);
  } catch {
    // fresh config
  }

  const current = await readCodexConfig({ cwd: options.cwd, homeDir });
  const state = {
    mcpServers: { ...current.mcpServers },
    remoteMcpServers: { ...current.remoteMcpServers },
  };
  mutate(state);

  // Rebuild the file: everything that isn't an mcp_servers section, then ours.
  const nonMcp = stripCodexMcpSections(existingContent).trim();
  const mcpToml = buildCodexMcpToml(state);
  const final = [nonMcp, mcpToml].filter((part) => part.length > 0).join("\n\n");

  await mkdir(path.dirname(configPath), { recursive: true });
  await atomicWrite(configPath, final + "\n");
  return { backups };
}

function stripCodexMcpSections(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let inMcp = false;

  for (const line of lines) {
    if (/^\[mcp_servers[\].]/.test(line)) {
      inMcp = true;
      continue;
    }
    if (inMcp && /^\[/.test(line) && !/^\[mcp_servers[\].]/.test(line)) {
      inMcp = false;
    }
    if (!inMcp) result.push(line);
  }

  return result.join("\n");
}

function buildCodexMcpToml(state: {
  mcpServers: Record<string, AgentMcpEntry>;
  remoteMcpServers: Record<string, RemoteMcpEntry>;
}): string {
  const lines: string[] = [];

  for (const [name, entry] of Object.entries(state.mcpServers)) {
    lines.push(`[mcp_servers.${name}]`);
    lines.push(`command = ${tomlStr(entry.command)}`);
    if (entry.args && entry.args.length > 0) {
      lines.push(`args = [${entry.args.map(tomlStr).join(", ")}]`);
    }
    if (entry.env && Object.keys(entry.env).length > 0) {
      lines.push("");
      lines.push(`[mcp_servers.${name}.env]`);
      for (const [key, value] of Object.entries(entry.env)) {
        lines.push(`${key} = ${tomlStr(value)}`);
      }
    }
    lines.push("");
  }

  // Codex TOML only carries a URL for remote servers; transport/headers are
  // Claude/Antigravity concepts and are dropped (preview warns about this).
  for (const [name, entry] of Object.entries(state.remoteMcpServers)) {
    lines.push(`[mcp_servers.${name}]`);
    lines.push(`url = ${tomlStr(entry.url)}`);
    lines.push("");
  }

  return lines.join("\n").trim();
}

function tomlStr(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/* ---- Antigravity: JSON mcpServers at the live candidate path ---- */

async function mutateAntigravityConfig(
  options: WriterOptions,
  mutate: (servers: Record<string, unknown>) => void,
): Promise<WriteOutcome> {
  const homeDir = options.homeDir ?? homedir();
  // Antigravity has shipped several config locations; write to whichever one
  // is live (the reader resolves it), falling back to the current default.
  const live = await readAntigravityConfig({ cwd: options.cwd, homeDir });
  const configPath = live.configPath;
  const backups: string[] = [];

  let existing: Record<string, unknown> = {};
  try {
    const source = await readFile(configPath, "utf8");
    if (source.trim().length > 0) {
      existing = JSON.parse(source) as Record<string, unknown>;
    }
    const backup = await backupFile(configPath);
    if (backup) backups.push(backup);
  } catch {
    // fresh config
  }

  const servers = (existing.mcpServers ?? {}) as Record<string, unknown>;
  mutate(servers);
  existing.mcpServers = servers;

  await mkdir(path.dirname(configPath), { recursive: true });
  await atomicWriteJson(configPath, existing);
  return { backups };
}

function toAntigravityEntry(entry: AgentMcpEntry): Record<string, unknown> {
  return {
    command: entry.command,
    args: entry.args ?? [],
    ...(entry.env ? { env: entry.env } : {}),
  };
}

function toAntigravityRemoteEntry(entry: RemoteMcpEntry): Record<string, unknown> {
  return {
    ...(entry.transport === "http" ? { httpUrl: entry.url } : { url: entry.url }),
    ...(entry.headers ? { headers: entry.headers } : {}),
    ...(entry.env ? { env: entry.env } : {}),
  };
}

/* ---- brainctl-compat project MCPs: <cwd>/.brainctl/project-mcps.json ---- */

async function mutateBrainctlProjectMcps(
  options: WriterOptions,
  agent: "codex" | "antigravity",
  mutate: (servers: Record<string, unknown>) => void,
): Promise<WriteOutcome> {
  const filePath = path.join(options.cwd, ".brainctl", "project-mcps.json");
  const backups: string[] = [];

  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    const backup = await backupFile(filePath);
    if (backup) backups.push(backup);
  } catch {
    // fresh file
  }

  const agentData = (data[agent] ?? {}) as Record<string, unknown>;
  const servers = (agentData.mcpServers ?? {}) as Record<string, unknown>;
  mutate(servers);
  agentData.mcpServers = servers;
  data[agent] = agentData;

  await mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteJson(filePath, data);
  return { backups };
}

/* ---- Skills: SKILL.md directories ---- */

export interface SkillLocation {
  agent: AgentName;
  skillName: string;
  scope: AgentEnvScope;
}

/**
 * Resolve the directory holding a skill's SKILL.md. Project scope is
 * Claude-only — Codex and Antigravity have no project-skills concept.
 */
export function getSkillDir(location: SkillLocation, cwd: string, homeDir?: string): string {
  const { agent, scope } = location;
  const safeName = path.basename(location.skillName);
  if (scope === "project") {
    if (agent !== "claude") {
      throw new Error(
        `Project-scoped skills are not supported for ${agent}; only Claude reads .claude/skills/ from the workspace.`,
      );
    }
    return path.join(cwd, ".claude", "skills", safeName);
  }
  const home = homeDir ?? homedir();
  const agentDir = { claude: ".claude", codex: ".codex", antigravity: ".gemini" }[agent];
  return path.join(home, agentDir, "skills", safeName);
}

export interface CopySkillOptions extends WriterOptions {
  source: SkillLocation;
  target: SkillLocation;
}

export async function copySkill(options: CopySkillOptions): Promise<WriteOutcome> {
  const sourceDir = getSkillDir(options.source, options.cwd, options.homeDir);
  const targetDir = getSkillDir(options.target, options.cwd, options.homeDir);
  try {
    await stat(sourceDir);
  } catch {
    throw new Error(
      `Skill "${options.source.skillName}" not found for ${options.source.agent} at ${sourceDir}.`,
    );
  }
  await mkdir(path.dirname(targetDir), { recursive: true });
  await rm(targetDir, { recursive: true, force: true });
  await cp(sourceDir, targetDir, { recursive: true });
  return { backups: [] };
}

export interface RemoveSkillOptions extends WriterOptions {
  location: SkillLocation;
}

export async function removeSkill(options: RemoveSkillOptions): Promise<WriteOutcome> {
  const skillDir = getSkillDir(options.location, options.cwd, options.homeDir);
  const backup = await backupSkillDir(options, skillDir);
  await rm(skillDir, { recursive: true, force: true });
  return { backups: backup ? [backup] : [] };
}

export async function moveSkill(options: CopySkillOptions): Promise<WriteOutcome> {
  const sourceDir = getSkillDir(options.source, options.cwd, options.homeDir);
  const targetDir = getSkillDir(options.target, options.cwd, options.homeDir);

  try {
    await stat(sourceDir);
  } catch {
    // Idempotent: source already gone but destination present → done.
    try {
      await stat(targetDir);
      return { backups: [] };
    } catch {
      throw new Error(
        `Skill "${options.source.skillName}" not found for ${options.source.agent} at ${sourceDir}.`,
      );
    }
  }

  await mkdir(path.dirname(targetDir), { recursive: true });
  await rm(targetDir, { recursive: true, force: true });
  await cp(sourceDir, targetDir, { recursive: true });
  const backup = await backupSkillDir(options, sourceDir);
  await rm(sourceDir, { recursive: true, force: true });
  return { backups: backup ? [backup] : [] };
}

/**
 * Copy a skill dir that is about to be deleted into the central backup area.
 * Deliberately NOT a sibling `.bak.*` directory — the readers would list that
 * as a new skill.
 */
async function backupSkillDir(options: WriterOptions, skillDir: string): Promise<string | null> {
  try {
    await stat(skillDir);
  } catch {
    return null;
  }
  const homeDir = options.homeDir ?? homedir();
  const backupDir = path.join(
    homeDir,
    ".config",
    "nomoreide",
    "agent-env-backups",
    `${path.basename(skillDir)}.${formatTimestamp()}`,
  );
  await mkdir(path.dirname(backupDir), { recursive: true });
  await cp(skillDir, backupDir, { recursive: true });
  return backupDir;
}

/* ---- Snapshot: back up an agent's config file before bulk operations ---- */

export async function snapshotAgentConfig(
  options: WriterOptions & { agent: AgentName },
): Promise<WriteOutcome> {
  const homeDir = options.homeDir ?? homedir();
  const configPath =
    options.agent === "claude"
      ? path.join(homeDir, ".claude.json")
      : options.agent === "codex"
        ? path.join(homeDir, ".codex", "config.toml")
        : (await readAntigravityConfig({ cwd: options.cwd, homeDir })).configPath;

  const backup = await backupFile(configPath);
  return { backups: backup ? [backup] : [] };
}
