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
import { parse as parseToml } from "smol-toml";
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

export async function backupFile(filePath: string): Promise<string | null> {
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

export async function atomicWrite(filePath: string, content: string): Promise<void> {
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

/** Add a local MCP server to Gemini CLI's `~/.gemini/settings.json`. */
export async function addGeminiMcp(
  options: WriterOptions & { key: string; entry: AgentMcpEntry },
): Promise<WriteOutcome> {
  const homeDir = options.homeDir ?? homedir();
  const configPath = path.join(homeDir, ".gemini", "settings.json");
  const backups: string[] = [];
  let existing: Record<string, unknown> = {};
  let source: string | undefined;

  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (source !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw new Error(`Gemini CLI settings contain invalid JSON: ${configPath}`);
    }
    if (!isRecord(parsed)) {
      throw new Error(`Gemini CLI settings must contain a JSON object: ${configPath}`);
    }
    existing = parsed;
    if (existing.mcpServers !== undefined && !isRecord(existing.mcpServers)) {
      throw new Error(`Gemini CLI mcpServers must contain a JSON object: ${configPath}`);
    }
    const backup = await backupFile(configPath);
    if (backup) backups.push(backup);
  }

  const servers = (existing.mcpServers ?? {}) as Record<string, unknown>;
  servers[options.key] = {
    command: options.entry.command,
    args: options.entry.args ?? [],
    ...(options.entry.env ? { env: options.entry.env } : {}),
  };
  existing.mcpServers = servers;

  await mkdir(path.dirname(configPath), { recursive: true });
  await atomicWriteJson(configPath, existing);
  return { backups };
}

/** Add one local Codex MCP table without rebuilding unrelated MCP sections. */
export async function addCodexMcpPreservingConfig(
  options: WriterOptions & { key: string; entry: AgentMcpEntry },
): Promise<WriteOutcome> {
  const homeDir = options.homeDir ?? homedir();
  const configPath = path.join(homeDir, ".codex", "config.toml");
  const backups: string[] = [];
  let existingContent = "";

  try {
    existingContent = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const section = buildCodexLocalMcpSection(options.key, options.entry);
  if (existingContent.trim()) {
    let parsed: Record<string, unknown>;
    try {
      parsed = parseToml(existingContent) as Record<string, unknown>;
    } catch {
      throw new Error(`Codex configuration contains invalid TOML: ${configPath}`);
    }
    const servers = isRecord(parsed.mcp_servers) ? parsed.mcp_servers : undefined;
    existingContent = replaceCodexMcpSection(
      existingContent,
      options.key,
      section,
      servers ? options.key in servers : false,
    );
    try {
      parseToml(existingContent);
    } catch {
      throw new Error(`Codex MCP "${options.key}" could not be replaced safely in ${configPath}`);
    }
    const backup = await backupFile(configPath);
    if (backup) backups.push(backup);
  } else {
    existingContent = section;
  }

  await mkdir(path.dirname(configPath), { recursive: true });
  await atomicWrite(configPath, `${existingContent.trimEnd()}\n`);
  return { backups };
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
  let source: string | undefined;

  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (source !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw new Error(`Claude configuration contains invalid JSON: ${configPath}`);
    }
    if (!isRecord(parsed)) {
      throw new Error(`Claude configuration must contain a JSON object: ${configPath}`);
    }
    existing = parsed;
    if (scope === "user" && existing.mcpServers !== undefined && !isRecord(existing.mcpServers)) {
      throw new Error(`Claude mcpServers must contain a JSON object: ${configPath}`);
    }
    const backup = await backupFile(configPath);
    if (backup) backups.push(backup);
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

function buildCodexLocalMcpSection(name: string, entry: AgentMcpEntry): string {
  const lines = [
    `[mcp_servers.${name}]`,
    `command = ${tomlStr(entry.command)}`,
  ];
  if (entry.args && entry.args.length > 0) {
    lines.push(`args = [${entry.args.map(tomlStr).join(", ")}]`);
  }
  if (entry.env && Object.keys(entry.env).length > 0) {
    lines.push("", `[mcp_servers.${name}.env]`);
    for (const [key, value] of Object.entries(entry.env)) {
      lines.push(`${key} = ${tomlStr(value)}`);
    }
  }
  return lines.join("\n");
}

function replaceCodexMcpSection(
  content: string,
  name: string,
  section: string,
  hasExistingTarget = false,
): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const key = `(?:${escaped}|"${escaped}"|'${escaped}')`;
  const targetTable = new RegExp(
    `^\\s*\\[mcp_servers\\.${key}(?:\\.[^\\]]+)?\\]\\s*(?:#.*)?$`,
  );
  const dottedAssignment = new RegExp(`^\\s*mcp_servers\\.${key}\\s*=`);
  const rootAssignment = new RegExp(`^\\s*${key}\\s*=`);
  const lines = content.split("\n");
  const result: string[] = [];
  let skipping = false;
  let inserted = false;
  let appendSection = false;
  let inRootMcpTable = false;
  let atTopLevel = true;

  for (const line of lines) {
    if (/^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(line)) {
      if (targetTable.test(line)) {
        if (!inserted) {
          result.push(section);
          inserted = true;
        }
        skipping = true;
        continue;
      }
      skipping = false;
      inRootMcpTable = /^\s*\[mcp_servers\]\s*(?:#.*)?$/.test(line);
      atTopLevel = false;
    }
    if (
      !skipping &&
      ((atTopLevel && dottedAssignment.test(line)) ||
        (inRootMcpTable && rootAssignment.test(line)))
    ) {
      inserted = true;
      appendSection = true;
      continue;
    }
    if (!skipping) result.push(line);
  }

  if (appendSection) {
    const prefix = result.join("\n").trimEnd();
    return prefix ? `${prefix}\n\n${section}` : section;
  }
  if (!inserted) {
    if (hasExistingTarget) {
      throw new Error(`Codex MCP "${name}" uses an unsupported TOML layout.`);
    }
    const prefix = result.join("\n").trimEnd();
    return prefix ? `${prefix}\n\n${section}` : section;
  }
  return result.join("\n");
}

function tomlStr(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
 * Resolve the directory a skill's SKILL.md is written to. Claude reads
 * `.claude/skills/`, Codex the Agent Skills standard `.agents/skills/` (user
 * and project); Antigravity has no project-skills concept. New Codex skills
 * always land in `~/.agents/skills/` — the legacy `~/.codex/skills/` dir is
 * only consulted when resolving an existing skill (see
 * `resolveExistingSkillDirs`).
 */
export function getSkillDir(location: SkillLocation, cwd: string, homeDir?: string): string {
  const { agent, scope } = location;
  const safeName = path.basename(location.skillName);
  if (scope === "project") {
    if (agent === "antigravity") {
      throw new Error(
        "Project-scoped skills are not supported for antigravity; Claude reads .claude/skills/ and Codex reads .agents/skills/ from the workspace.",
      );
    }
    const subdir = agent === "claude" ? ".claude" : ".agents";
    return path.join(cwd, subdir, "skills", safeName);
  }
  const home = homeDir ?? homedir();
  const agentDir = { claude: ".claude", codex: ".agents", antigravity: ".gemini" }[agent];
  return path.join(home, agentDir, "skills", safeName);
}

/**
 * Every directory the skill currently exists at. For Codex user skills this
 * checks the standard `~/.agents/skills/` dir first, then the legacy
 * `~/.codex/skills/` dir — a remove/move must clear both or the legacy copy
 * resurfaces after the standard one is deleted.
 */
async function resolveExistingSkillDirs(
  location: SkillLocation,
  cwd: string,
  homeDir?: string,
): Promise<string[]> {
  const candidates = [getSkillDir(location, cwd, homeDir)];
  if (location.agent === "codex" && location.scope === "user") {
    const home = homeDir ?? homedir();
    candidates.push(path.join(home, ".codex", "skills", path.basename(location.skillName)));
  }
  const existing: string[] = [];
  for (const dir of candidates) {
    try {
      await stat(dir);
      existing.push(dir);
    } catch {
      // not present at this candidate
    }
  }
  return existing;
}

export interface CopySkillOptions extends WriterOptions {
  source: SkillLocation;
  target: SkillLocation;
}

export interface InstallSkillFromDirectoryOptions extends WriterOptions {
  sourceDir: string;
  target: SkillLocation;
}

/**
 * Install a skill from a packaged directory, preserving any replaced skill in
 * the central backup area and preparing the new copy before removing the old.
 */
export async function installSkillFromDirectory(
  options: InstallSkillFromDirectoryOptions,
): Promise<WriteOutcome> {
  const targetDir = getSkillDir(options.target, options.cwd, options.homeDir);
  const stagingDir = `${targetDir}.tmp.${process.pid}.${Date.now()}`;
  await mkdir(path.dirname(targetDir), { recursive: true });
  await rm(stagingDir, { recursive: true, force: true });
  await cp(options.sourceDir, stagingDir, { recursive: true });

  const backup = await backupSkillDir(options, targetDir);
  try {
    await rm(targetDir, { recursive: true, force: true });
    await rename(stagingDir, targetDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
  return { backups: backup ? [backup] : [] };
}

export async function copySkill(options: CopySkillOptions): Promise<WriteOutcome> {
  const [sourceDir] = await resolveExistingSkillDirs(options.source, options.cwd, options.homeDir);
  const targetDir = getSkillDir(options.target, options.cwd, options.homeDir);
  if (!sourceDir) {
    throw new Error(
      `Skill "${options.source.skillName}" not found for ${options.source.agent} at ${getSkillDir(options.source, options.cwd, options.homeDir)}.`,
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
  const skillDirs = await resolveExistingSkillDirs(options.location, options.cwd, options.homeDir);
  const backups: string[] = [];
  for (const skillDir of skillDirs) {
    const backup = await backupSkillDir(options, skillDir);
    if (backup) backups.push(backup);
    await rm(skillDir, { recursive: true, force: true });
  }
  return { backups };
}

export async function moveSkill(options: CopySkillOptions): Promise<WriteOutcome> {
  const sourceDirs = await resolveExistingSkillDirs(options.source, options.cwd, options.homeDir);
  const targetDir = getSkillDir(options.target, options.cwd, options.homeDir);

  if (sourceDirs.length === 0) {
    // Idempotent: source already gone but destination present → done.
    try {
      await stat(targetDir);
      return { backups: [] };
    } catch {
      throw new Error(
        `Skill "${options.source.skillName}" not found for ${options.source.agent} at ${getSkillDir(options.source, options.cwd, options.homeDir)}.`,
      );
    }
  }

  await mkdir(path.dirname(targetDir), { recursive: true });
  await rm(targetDir, { recursive: true, force: true });
  await cp(sourceDirs[0], targetDir, { recursive: true });
  const backups: string[] = [];
  for (const sourceDir of sourceDirs) {
    if (sourceDir === targetDir) continue;
    const backup = await backupSkillDir(options, sourceDir);
    if (backup) backups.push(backup);
    await rm(sourceDir, { recursive: true, force: true });
  }
  return { backups };
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
  const backupBase = path.join(
    homeDir,
    ".config",
    "nomoreide",
    "agent-env-backups",
    `${path.basename(skillDir)}.${formatTimestamp()}`,
  );
  await mkdir(path.dirname(backupBase), { recursive: true });
  for (let attempt = 0; attempt < 100; attempt++) {
    const backupDir = attempt === 0 ? backupBase : `${backupBase}-${attempt}`;
    try {
      await mkdir(backupDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      await cp(skillDir, backupDir, { recursive: true });
      return backupDir;
    } catch (error) {
      await rm(backupDir, { recursive: true, force: true });
      throw error;
    }
  }
  throw new Error(`Could not allocate a unique backup path for skill "${path.basename(skillDir)}".`);
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
