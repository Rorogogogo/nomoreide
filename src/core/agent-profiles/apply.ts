/**
 * Apply a profile to an agent — the write-gated half of Agent Profiles.
 * Mirrors the ROR-61 staged-writes gate: `previewProfileApply` classifies
 * every item (add / identical / conflict) and surfaces warnings, then
 * `applyProfile` snapshots the agent's config, writes through the
 * write-guarded agent-env-writers layer, and reports every backup created.
 */
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { addMcp, getSkillDir, snapshotAgentConfig } from "../agent-env-writers.js";
import {
  readAllAgentConfigs,
  type AgentLiveConfig,
  type AgentName,
} from "../agent-env/index.js";
import { findUnresolvedCredentialKeys } from "./credentials.js";
import { getProfile, profileSkillsDir, pathExists, type ProfileStoreOptions } from "./store.js";
import type { Profile, ProfileMcp } from "./types.js";

export type ProfileItemStatus = "add" | "identical" | "conflict";

export interface ProfileApplyItem {
  category: "mcp" | "skill";
  name: string;
  status: ProfileItemStatus;
  warnings: string[];
}

export interface ProfileApplyPreview {
  profile: string;
  agent: AgentName;
  items: ProfileApplyItem[];
  /** `${credentials.*}` keys still unresolved in the profile — applied as-is. */
  unresolvedCredentials: string[];
}

export interface ProfileApplyOptions extends ProfileStoreOptions {
  cwd: string;
  name: string;
  agent: AgentName;
  /** Item names (per category) to leave untouched — typically conflicts the user kept. */
  skip?: { mcps?: string[]; skills?: string[] };
}

export async function previewProfileApply(
  options: Omit<ProfileApplyOptions, "skip">,
): Promise<ProfileApplyPreview> {
  const [profile, live] = await Promise.all([
    getProfile(options.name, options),
    readLiveConfig(options),
  ]);

  const items: ProfileApplyItem[] = [];

  for (const [key, mcp] of Object.entries(profile.mcps)) {
    const existing = findLiveMcp(live, key);
    const warnings: string[] = [];
    if (
      options.agent === "codex" &&
      mcp.kind === "remote" &&
      (mcp.headers || mcp.transport === "sse")
    ) {
      warnings.push(
        "Codex config only stores a URL for remote MCPs; transport and headers will be dropped.",
      );
    }
    items.push({
      category: "mcp",
      name: key,
      status: existing === undefined ? "add" : sameMcp(existing, mcp) ? "identical" : "conflict",
      warnings,
    });
  }

  const liveSkillNames = new Set(
    live.skills.filter((skill) => skill.scope === "user").map((skill) => skill.name),
  );
  for (const skill of profile.skills) {
    items.push({
      category: "skill",
      name: skill.name,
      // Skill contents aren't diffed — an existing dir with the same name is a conflict.
      status: liveSkillNames.has(skill.name) ? "conflict" : "add",
      warnings: [],
    });
  }

  return {
    profile: profile.name,
    agent: options.agent,
    items,
    unresolvedCredentials: findUnresolvedCredentialKeys(profile.mcps),
  };
}

export interface ProfileApplyResult {
  profile: string;
  agent: AgentName;
  mcpsApplied: string[];
  skillsApplied: string[];
  skipped: string[];
  backups: string[];
}

export async function applyProfile(options: ProfileApplyOptions): Promise<ProfileApplyResult> {
  const profile = await getProfile(options.name, options);
  const base = { cwd: options.cwd, homeDir: options.homeDir };
  const skipMcps = new Set(options.skip?.mcps ?? []);
  const skipSkills = new Set(options.skip?.skills ?? []);
  const backups: string[] = [];
  const skipped: string[] = [];

  // One snapshot of the agent's config file before the batch (plus the
  // per-write .bak.* copies the writers create anyway).
  const snapshot = await snapshotAgentConfig({ ...base, agent: options.agent });
  backups.push(...snapshot.backups);

  const mcpsApplied: string[] = [];
  for (const [key, mcp] of Object.entries(profile.mcps)) {
    if (skipMcps.has(key)) {
      skipped.push(`mcp "${key}"`);
      continue;
    }
    const outcome = await addMcp({
      ...base,
      agent: options.agent,
      key,
      scope: "user",
      entry:
        mcp.kind === "local"
          ? { command: mcp.command, args: mcp.args, env: mcp.env }
          : undefined,
      remoteEntry:
        mcp.kind === "remote"
          ? { transport: mcp.transport, url: mcp.url, headers: mcp.headers, env: mcp.env }
          : undefined,
    });
    backups.push(...outcome.backups);
    mcpsApplied.push(key);
  }

  const skillsApplied: string[] = [];
  for (const skill of profile.skills) {
    if (skipSkills.has(skill.name)) {
      skipped.push(`skill "${skill.name}"`);
      continue;
    }
    const sourceDir = path.join(
      profileSkillsDir(options.name, options),
      path.basename(skill.name),
    );
    if (!(await pathExists(sourceDir))) {
      skipped.push(`skill "${skill.name}" (missing from profile bundle)`);
      continue;
    }
    await installProfileSkill(sourceDir, skill.name, options);
    skillsApplied.push(skill.name);
  }

  return {
    profile: profile.name,
    agent: options.agent,
    mcpsApplied,
    skillsApplied,
    skipped,
    backups,
  };
}

/** Copy a bundled skill dir into the agent's user skills dir (idempotent overwrite). */
async function installProfileSkill(
  sourceDir: string,
  skillName: string,
  options: ProfileApplyOptions,
): Promise<void> {
  const targetDir = getSkillDir(
    { agent: options.agent, skillName, scope: "user" },
    options.cwd,
    options.homeDir,
  );
  await mkdir(path.dirname(targetDir), { recursive: true });
  await rm(targetDir, { recursive: true, force: true });
  await cp(sourceDir, targetDir, { recursive: true });
}

async function readLiveConfig(options: {
  cwd: string;
  homeDir?: string;
  agent: AgentName;
}): Promise<AgentLiveConfig> {
  const configs = await readAllAgentConfigs({ cwd: options.cwd, homeDir: options.homeDir });
  const config = configs.find((candidate) => candidate.agent === options.agent);
  if (!config) throw new Error(`Unknown agent "${options.agent}".`);
  return config;
}

function findLiveMcp(config: AgentLiveConfig, key: string): ProfileMcp | undefined {
  const local = config.mcpServers[key];
  if (local) return { kind: "local", command: local.command, args: local.args, env: local.env };
  const remote = config.remoteMcpServers[key];
  if (remote) {
    return {
      kind: "remote",
      transport: remote.transport,
      url: remote.url,
      headers: remote.headers,
      env: remote.env,
    };
  }
  return undefined;
}

function sameMcp(left: ProfileMcp, right: ProfileMcp): boolean {
  return JSON.stringify(normalizeMcp(left)) === JSON.stringify(normalizeMcp(right));
}

function normalizeMcp(mcp: ProfileMcp): Record<string, unknown> {
  if (mcp.kind === "local") {
    return {
      kind: "local",
      command: mcp.command,
      args: mcp.args ?? [],
      env: sortedEntries(mcp.env),
    };
  }
  return {
    kind: "remote",
    transport: mcp.transport,
    url: mcp.url,
    headers: sortedEntries(mcp.headers),
    env: sortedEntries(mcp.env),
  };
}

function sortedEntries(map: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(map ?? {}).sort(([a], [b]) => a.localeCompare(b));
}
