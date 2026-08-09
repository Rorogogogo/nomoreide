/**
 * Profile storage: `<home>/.config/nomoreide/agent-profiles/<name>/` holding a
 * Zod-validated `profile.json` plus bundled skill directories under `skills/`.
 * Writes here only touch nomoreide's own config area — applying a profile to
 * an agent goes through `apply.ts` (which uses the write-guarded
 * agent-env-writers layer).
 */
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
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
  type ProfilePlugin,
  type ProfileSummary,
} from "./types.js";
import { pluginBundleDigest } from "./plugin-bundle.js";

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

export function profilePluginsDir(name: string, options: ProfileStoreOptions = {}): string {
  return path.join(profileDir(name, options), "plugins");
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

  let entries: import("node:fs").Dirent[];
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
        sourceAgent: profile.sourceAgent,
        mcpCount: Object.keys(profile.mcps).length,
        skillCount: profile.skills.length,
        pluginCount: profile.plugins.length,
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
    plugins: [],
  };
  await writeProfile(profile, options);
  return profile;
}

export async function updateProfile(
  name: string,
  patch: Partial<Pick<Profile, "description" | "mcps" | "skills" | "plugins">>,
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
  if (patch.plugins) {
    const kept = new Set(next.plugins.map((plugin) => plugin.bundleKey));
    for (const plugin of existing.plugins) {
      if (!kept.has(plugin.bundleKey)) {
        await rm(path.join(profilePluginsDir(name, options), plugin.bundleKey), {
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
  await writeFile(tmpPath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
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
  if (!config) throw new Error(`Unknown agent "${input.agent}".`);

  const mcps: Record<string, ProfileMcp> = {};
  for (const [key, entry] of Object.entries(config.mcpServers)) {
    mcps[key] = toLocalProfileMcp(entry);
  }
  for (const [key, entry] of Object.entries(config.remoteMcpServers)) {
    mcps[key] = toRemoteProfileMcp(entry);
  }

  const profile: Profile = {
    name,
    ...(input.description ? { description: input.description } : {}),
    sourceAgent: input.agent,
    mcps,
    skills: [],
    plugins: [],
  };

  const pluginOwnedSkills = new Set<string>();
  const pluginOwnedMcps = new Set<string>();

  // Bundle complete plugin roots first so their contributed skills and MCPs
  // are not duplicated as standalone profile items.
  for (const plugin of config.skills.filter((skill) => skill.kind === "plugin")) {
    if (!plugin.installPath) continue;
    const bundleKey = pluginBundleKey(input.agent, plugin.name, plugin.source);
    try {
      const target = path.join(profilePluginsDir(name, options), bundleKey);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(plugin.installPath, target, { recursive: true, filter: profileAssetFilter });
      const digest = await pluginBundleDigest(target);
      profile.plugins.push(toProfilePlugin(input.agent, plugin, bundleKey, digest));
      for (const skill of [...(plugin.pluginSkills ?? []), ...(plugin.pluginCommands ?? [])]) {
        pluginOwnedSkills.add(skill);
      }
      for (const key of plugin.pluginMcps ?? []) pluginOwnedMcps.add(key);
    } catch {
      // An unreadable plugin must not make the rest of a snapshot unusable.
    }
  }
  for (const key of pluginOwnedMcps) delete profile.mcps[key];

  // Bundle plain user-scope skills. Project skills belong to their repo.
  for (const skill of config.skills) {
    if (
      skill.kind === "plugin" ||
      skill.scope !== "user" ||
      !skill.installPath ||
      pluginOwnedSkills.has(skill.name)
    ) continue;
    try {
      const target = path.join(profileSkillsDir(name, options), path.basename(skill.name));
      await mkdir(path.dirname(target), { recursive: true });
      await cp(skill.installPath, target, { recursive: true, filter: profileAssetFilter });
      profile.skills.push({ name: skill.name });
    } catch {
      // unreadable skill dir — skip it rather than failing the snapshot
    }
  }

  await writeProfile(profile, options);
  return profile;
}

/**
 * Rebuild an existing profile from an agent's current environment. The new
 * bundle is prepared in a sibling profile first, then swapped into place so a
 * failed read/copy never destroys the last good profile.
 */
export async function refreshProfileFromAgent(
  input: { agent: AgentName; name: string; cwd: string },
  options: ProfileStoreOptions = {},
): Promise<Profile> {
  const name = assertValidProfileName(input.name);
  const existing = await getProfile(name, options);
  const token = randomUUID();
  const stagingName = `${name}.refresh-${token}`;
  const currentDir = profileDir(name, options);
  const stagingDir = profileDir(stagingName, options);
  const backupDir = path.join(path.dirname(profilesRoot(options)), `.profile-backup-${token}`);
  let staged = false;
  let originalMoved = false;

  try {
    const captured = await snapshotProfileFromAgent(
      {
        agent: input.agent,
        name: stagingName,
        cwd: input.cwd,
        description: existing.description,
      },
      options,
    );
    staged = true;

    await writeFile(
      path.join(stagingDir, "profile.json"),
      `${JSON.stringify({ ...captured, name }, null, 2)}\n`,
      "utf8",
    );
    await rename(currentDir, backupDir);
    originalMoved = true;
    try {
      await rename(stagingDir, currentDir);
      staged = false;
    } catch (error) {
      await rename(backupDir, currentDir);
      originalMoved = false;
      throw error;
    }

    await rm(backupDir, { recursive: true, force: true });
    originalMoved = false;
    return getProfile(name, options);
  } finally {
    if (staged) await rm(stagingDir, { recursive: true, force: true });
    if (originalMoved) await rm(backupDir, { recursive: true, force: true });
  }
}

function pluginBundleKey(agent: AgentName, name: string, source?: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "plugin";
  const digest = createHash("sha256")
    .update(`${agent}\0${source ?? ""}\0${name}`)
    .digest("hex")
    .slice(0, 10);
  return `${slug.slice(0, 60)}-${digest}`;
}

function toProfilePlugin(
  sourceAgent: AgentName,
  plugin: import("../agent-env/index.js").AgentSkillEntry,
  bundleKey: string,
  digest: string,
): ProfilePlugin {
  const version = plugin.installPath ? path.basename(plugin.installPath) : undefined;
  return {
    name: plugin.name,
    sourceAgent,
    ...(plugin.source ? { source: plugin.source } : {}),
    ...(version ? { version } : {}),
    ...(plugin.managed ? { managed: true } : {}),
    bundleKey,
    digest,
    ...(plugin.pluginSkills?.length ? { pluginSkills: plugin.pluginSkills } : {}),
    ...(plugin.pluginMcps?.length ? { pluginMcps: plugin.pluginMcps } : {}),
    ...(plugin.pluginAgents?.length ? { pluginAgents: plugin.pluginAgents } : {}),
    ...(plugin.pluginCommands?.length ? { pluginCommands: plugin.pluginCommands } : {}),
  };
}

function profileAssetFilter(source: string): boolean {
  const base = path.basename(source);
  return base !== ".git" && base !== ".DS_Store";
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

export async function copyPluginBetweenProfiles(
  from: string,
  to: string,
  bundleKey: string,
  options: ProfileStoreOptions = {},
): Promise<void> {
  const safeKey = path.basename(bundleKey);
  const sourceDir = path.join(profilePluginsDir(from, options), safeKey);
  if (!(await pathExists(sourceDir))) return;
  const targetDir = path.join(profilePluginsDir(to, options), safeKey);
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
