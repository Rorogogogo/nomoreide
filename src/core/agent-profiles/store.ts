/**
 * Profile storage: `<home>/.config/nomoreide/agent-profiles/<name>/` holding a
 * Zod-validated `profile.json` plus bundled skill directories under `skills/`.
 * Writes here only touch nomoreide's own config area — applying a profile to
 * an agent goes through `apply.ts` (which uses the write-guarded
 * agent-env-writers layer).
 */
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  readAllAgentConfigs,
  type AgentMcpEntry,
  type AgentName,
  type RemoteMcpEntry,
} from "../agent-env/index.js";
import {
  PROFILE_NAME_PATTERN,
  profileSchema,
  type Profile,
  type ProfileMcp,
  type ProfileSummary,
} from "./types.js";

export interface ProfileStoreOptions {
  /** Injectable for tmpdir tests, like the agent-env readers. */
  homeDir?: string;
}

export function profilesRoot(options: ProfileStoreOptions = {}): string {
  const home = options.homeDir ?? homedir();
  return path.join(home, ".config", "nomoreide", "agent-profiles");
}

export function profileDir(name: string, options: ProfileStoreOptions = {}): string {
  return path.join(profilesRoot(options), path.basename(name));
}

function profileFile(name: string, options: ProfileStoreOptions = {}): string {
  return path.join(profileDir(name, options), "profile.json");
}

export function profileSkillsDir(name: string, options: ProfileStoreOptions = {}): string {
  return path.join(profileDir(name, options), "skills");
}

export function assertValidProfileName(name: string): string {
  const trimmed = name.trim();
  if (!PROFILE_NAME_PATTERN.test(trimmed)) {
    throw new Error(
      `Invalid profile name "${trimmed}". Use letters, numbers, ".", "_", or "-".`,
    );
  }
  return trimmed;
}

export async function listProfiles(
  options: ProfileStoreOptions = {},
): Promise<ProfileSummary[]> {
  const root = profilesRoot(options);
  const summaries: Array<ProfileSummary & { mtimeMs: number }> = [];

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return []; // no profiles yet
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const filePath = profileFile(entry.name, options);
      const info = await stat(filePath);
      const profile = await getProfile(entry.name, options);
      summaries.push({
        name: profile.name,
        description: profile.description,
        mcpCount: Object.keys(profile.mcps).length,
        skillCount: profile.skills.length,
        updatedAt: info.mtime.toISOString(),
        mtimeMs: info.mtimeMs,
      });
    } catch {
      // not a profile folder (or corrupt) — skip it
    }
  }

  return summaries
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name))
    .map(({ mtimeMs: _mtimeMs, ...summary }) => summary);
}

export async function getProfile(
  name: string,
  options: ProfileStoreOptions = {},
): Promise<Profile> {
  const filePath = profileFile(name, options);
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch {
    throw new Error(`Profile "${name}" not found.`);
  }

  const parsed = profileSchema.safeParse(JSON.parse(source));
  if (!parsed.success) {
    throw new Error(`Profile "${name}" has an invalid profile.json.`);
  }
  return parsed.data;
}

export async function createProfile(
  input: { name: string; description?: string },
  options: ProfileStoreOptions = {},
): Promise<Profile> {
  const name = assertValidProfileName(input.name);
  if (await pathExists(profileFile(name, options))) {
    throw new Error(`Profile "${name}" already exists.`);
  }

  const profile: Profile = {
    name,
    ...(input.description ? { description: input.description } : {}),
    mcps: {},
    skills: [],
  };
  await writeProfile(profile, options);
  return profile;
}

export async function updateProfile(
  name: string,
  patch: Partial<Pick<Profile, "description" | "mcps" | "skills">>,
  options: ProfileStoreOptions = {},
): Promise<Profile> {
  const existing = await getProfile(name, options);
  const next = profileSchema.parse({ ...existing, ...patch, name: existing.name });

  // Drop bundled skill dirs that are no longer referenced.
  if (patch.skills) {
    const kept = new Set(next.skills.map((skill) => skill.name));
    for (const skill of existing.skills) {
      if (!kept.has(skill.name)) {
        await rm(path.join(profileSkillsDir(name, options), path.basename(skill.name)), {
          recursive: true,
          force: true,
        });
      }
    }
  }

  await writeProfile(next, options);
  return next;
}

export async function deleteProfile(
  name: string,
  options: ProfileStoreOptions = {},
): Promise<void> {
  if (!(await pathExists(profileFile(name, options)))) {
    throw new Error(`Profile "${name}" not found.`);
  }
  await rm(profileDir(name, options), { recursive: true, force: true });
}

export async function writeProfile(
  profile: Profile,
  options: ProfileStoreOptions = {},
): Promise<void> {
  const folder = profileDir(profile.name, options);
  await mkdir(folder, { recursive: true });
  const filePath = profileFile(profile.name, options);
  const tmpPath = `${filePath}.tmp.${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(profile, null, 2) + "\n", "utf8");
  await rename(tmpPath, filePath);
}

/**
 * Capture an agent's live config (MCPs + local skills) into a new profile.
 * Raw credential values are kept — the profile lives in the user's own config
 * dir; redaction happens at export time.
 */
export async function snapshotProfileFromAgent(
  input: { agent: AgentName; name: string; description?: string; cwd: string },
  options: ProfileStoreOptions = {},
): Promise<Profile> {
  const name = assertValidProfileName(input.name);
  if (await pathExists(profileFile(name, options))) {
    throw new Error(`Profile "${name}" already exists.`);
  }

  const configs = await readAllAgentConfigs({ cwd: input.cwd, homeDir: options.homeDir });
  const config = configs.find((candidate) => candidate.agent === input.agent);
  if (!config?.exists && (config?.skills.length ?? 0) === 0) {
    throw new Error(`Agent "${input.agent}" has no live config to snapshot.`);
  }

  const mcps: Record<string, ProfileMcp> = {};
  for (const [key, entry] of Object.entries(config!.mcpServers)) {
    mcps[key] = toLocalProfileMcp(entry);
  }
  for (const [key, entry] of Object.entries(config!.remoteMcpServers)) {
    mcps[key] = toRemoteProfileMcp(entry);
  }

  const profile: Profile = {
    name,
    ...(input.description ? { description: input.description } : {}),
    mcps,
    skills: [],
  };

  // Bundle plain user-scope skills. Plugins are managed installs (excluded,
  // same rule as ROR-61 staged writes); project skills belong to their repo.
  for (const skill of config!.skills) {
    if (skill.kind === "plugin" || skill.scope !== "user" || !skill.installPath) continue;
    try {
      const target = path.join(profileSkillsDir(name, options), path.basename(skill.name));
      await mkdir(path.dirname(target), { recursive: true });
      await cp(skill.installPath, target, { recursive: true });
      profile.skills.push({ name: skill.name });
    } catch {
      // unreadable skill dir — skip it rather than failing the snapshot
    }
  }

  await writeProfile(profile, options);
  return profile;
}

export function toLocalProfileMcp(entry: AgentMcpEntry): ProfileMcp {
  return {
    kind: "local",
    command: entry.command,
    ...(entry.args ? { args: entry.args } : {}),
    ...(entry.env ? { env: entry.env } : {}),
  };
}

export function toRemoteProfileMcp(entry: RemoteMcpEntry): ProfileMcp {
  return {
    kind: "remote",
    transport: entry.transport,
    url: entry.url,
    ...(entry.headers ? { headers: entry.headers } : {}),
    ...(entry.env ? { env: entry.env } : {}),
  };
}

/** Copy one bundled skill dir between profiles (no-op if the source has no files). */
export async function copySkillBetweenProfiles(
  from: string,
  to: string,
  skillName: string,
  options: ProfileStoreOptions = {},
): Promise<void> {
  const sourceDir = path.join(profileSkillsDir(from, options), path.basename(skillName));
  if (!(await pathExists(sourceDir))) return;
  const targetDir = path.join(profileSkillsDir(to, options), path.basename(skillName));
  await mkdir(path.dirname(targetDir), { recursive: true });
  await rm(targetDir, { recursive: true, force: true });
  await cp(sourceDir, targetDir, { recursive: true });
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
