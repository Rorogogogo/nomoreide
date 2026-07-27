import { createHash } from "node:crypto";
import { readdir, readFile, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  addGeminiMcp,
  addCodexMcpPreservingConfig,
  addMcp,
  getSkillDir,
  installSkillFromDirectory,
  removeSkill,
} from "../agent-env-writers.js";
import {
  readAllAgentConfigs,
  type AgentMcpEntry,
  type AgentName,
} from "../agent-env/index.js";
import { loadBundledDebugProfile } from "./builtin.js";
import type { ProfileLocalMcp } from "./types.js";

export type DebugSetupAgent = "claude" | "codex" | "gemini";
export type DebugSetupStatus = "added" | "identical" | "replaced";

export interface DebugSetupResult {
  agent: DebugSetupAgent;
  mcp: DebugSetupStatus;
  skill: DebugSetupStatus;
  backups: string[];
}

export class DebugSetupConflictError extends Error {
  constructor(readonly items: string[]) {
    super(
      `NoMoreIDE setup conflicts with existing ${items.join(" and ")}. ` +
        "Re-run with --force to replace them; backups will be created.",
    );
    this.name = "DebugSetupConflictError";
  }
}

type ExistingMcp = AgentMcpEntry | "incompatible" | undefined;

export async function installBundledDebugSetup(options: {
  agent: DebugSetupAgent;
  cwd: string;
  homeDir?: string;
  force?: boolean;
}): Promise<DebugSetupResult> {
  const bundled = await loadBundledDebugProfile();
  const desired = bundled.profile.mcps.nomoreide;
  if (!desired || desired.kind !== "local") {
    throw new Error('Bundled profile must define a local "nomoreide" MCP server.');
  }

  const homeDir = options.homeDir ?? homedir();
  const skillAgent = skillAgentFor(options.agent);
  const sourceSkillDir = path.join(bundled.skillsDir, "nomoreide-debug");
  const targetSkillDir = getSkillDir(
    { agent: skillAgent, skillName: "nomoreide-debug", scope: "user" },
    options.cwd,
    homeDir,
  );
  const legacyCodexSkillDir =
    options.agent === "codex"
      ? path.join(homeDir, ".codex", "skills", "nomoreide-debug")
      : undefined;
  const [existingMcp, sourceDigest, targetDigest, legacyCodexDigest] = await Promise.all([
    readExistingMcp(options.agent, options.cwd, homeDir),
    directoryDigest(sourceSkillDir),
    directoryDigest(targetSkillDir),
    legacyCodexSkillDir ? directoryDigest(legacyCodexSkillDir) : Promise.resolve(null),
  ]);
  if (!sourceDigest) {
    throw new Error('Bundled skill "nomoreide-debug" is missing.');
  }

  const mcp = classifyMcp(existingMcp, desired);
  const visibleSkillDigest = targetDigest ?? legacyCodexDigest;
  const skill =
    visibleSkillDigest === null
      ? "added"
      : visibleSkillDigest === sourceDigest
        ? "identical"
        : "replaced";
  const conflicts = [
    ...(mcp === "replaced" ? ['MCP server "nomoreide"'] : []),
    ...(skill === "replaced" ? ['skill "nomoreide-debug"'] : []),
  ];
  if (conflicts.length > 0 && !options.force) {
    throw new DebugSetupConflictError(conflicts);
  }

  const backups: string[] = [];
  if (mcp !== "identical") {
    const entry = toAgentMcpEntry(desired);
    const outcome =
      options.agent === "gemini"
        ? await addGeminiMcp({
            cwd: options.cwd,
            homeDir,
            key: "nomoreide",
            entry,
          })
        : options.agent === "codex"
          ? await addCodexMcpPreservingConfig({
              cwd: options.cwd,
              homeDir,
              key: "nomoreide",
              entry,
            })
        : await addMcp({
            cwd: options.cwd,
            homeDir,
            agent: options.agent,
            key: "nomoreide",
            scope: "user",
            entry,
          });
    backups.push(...outcome.backups);
  }

  if (skill !== "identical") {
    if (options.agent === "codex" && visibleSkillDigest !== null) {
      const outcome = await removeSkill({
        cwd: options.cwd,
        homeDir,
        location: { agent: "codex", skillName: "nomoreide-debug", scope: "user" },
      });
      backups.push(...outcome.backups);
    }
    const outcome = await installSkillFromDirectory({
      cwd: options.cwd,
      homeDir,
      sourceDir: sourceSkillDir,
      target: { agent: skillAgent, skillName: "nomoreide-debug", scope: "user" },
    });
    backups.push(...outcome.backups);
  }

  return { agent: options.agent, mcp, skill, backups };
}

function skillAgentFor(agent: DebugSetupAgent): AgentName {
  return agent === "gemini" ? "antigravity" : agent;
}

async function readExistingMcp(
  agent: DebugSetupAgent,
  cwd: string,
  homeDir: string,
): Promise<ExistingMcp> {
  if (agent === "codex") {
    return await readExistingCodexMcp(homeDir);
  }
  if (agent === "claude") {
    const configs = await readAllAgentConfigs({ cwd, homeDir });
    const config = configs.find((candidate) => candidate.agent === agent);
    return config?.mcpServers.nomoreide ??
      (config?.remoteMcpServers.nomoreide ? "incompatible" : undefined);
  }

  const settingsPath = path.join(homeDir, ".gemini", "settings.json");
  let source: string;
  try {
    source = await readFile(settingsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const settings = JSON.parse(source) as { mcpServers?: Record<string, unknown> };
    const value = settings.mcpServers?.nomoreide;
    if (value === undefined) return undefined;
    return parseLocalMcpEntry(value) ?? "incompatible";
  } catch {
    throw new Error(`Gemini CLI settings contain invalid JSON: ${settingsPath}`);
  }
}

async function readExistingCodexMcp(homeDir: string): Promise<ExistingMcp> {
  const configPath = path.join(homeDir, ".codex", "config.toml");
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(source) as Record<string, unknown>;
  } catch {
    throw new Error(`Codex configuration contains invalid TOML: ${configPath}`);
  }
  const servers = parsed.mcp_servers;
  if (!servers || typeof servers !== "object") return undefined;
  const value = (servers as Record<string, unknown>).nomoreide;
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") return "incompatible";
  const raw = value as Record<string, unknown>;
  if (raw.enabled === false || typeof raw.url === "string") return "incompatible";
  return parseLocalMcpEntry(raw) ?? "incompatible";
}

function parseLocalMcpEntry(value: unknown): AgentMcpEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as { command?: unknown; args?: unknown; env?: unknown };
  if (typeof entry.command !== "string") return undefined;
  return {
    command: entry.command,
    ...(Array.isArray(entry.args) && entry.args.every((item) => typeof item === "string")
      ? { args: entry.args as string[] }
      : {}),
    ...(entry.env && typeof entry.env === "object"
      ? { env: entry.env as Record<string, string> }
      : {}),
  };
}

function classifyMcp(
  existing: ExistingMcp,
  desired: ProfileLocalMcp,
): DebugSetupStatus {
  if (!existing) return "added";
  if (existing === "incompatible") return "replaced";
  return JSON.stringify(normalizeMcp(existing)) ===
    JSON.stringify(normalizeMcp(toAgentMcpEntry(desired)))
    ? "identical"
    : "replaced";
}

function toAgentMcpEntry(profile: ProfileLocalMcp): AgentMcpEntry {
  return {
    command: profile.command,
    ...(profile.args ? { args: profile.args } : {}),
    ...(profile.env ? { env: profile.env } : {}),
  };
}

function normalizeMcp(entry: AgentMcpEntry): AgentMcpEntry {
  return {
    command: entry.command,
    args: entry.args ?? [],
    ...(entry.env && Object.keys(entry.env).length > 0 ? { env: entry.env } : {}),
  };
}

async function directoryDigest(root: string): Promise<string | null> {
  const hash = createHash("sha256");
  try {
    await appendDirectory(hash, root, "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return hash.digest("hex");
}

async function appendDirectory(
  hash: ReturnType<typeof createHash>,
  root: string,
  relative: string,
): Promise<void> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const entryRelative = path.join(relative, entry.name);
    hash.update(entryRelative);
    if (entry.isDirectory()) {
      hash.update("directory");
      await appendDirectory(hash, root, entryRelative);
    } else if (entry.isSymbolicLink()) {
      hash.update("symlink");
      hash.update(await readlink(path.join(root, entryRelative)));
    } else {
      hash.update("file");
      hash.update(await readFile(path.join(root, entryRelative)));
    }
  }
}
