import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { redactMcpCredentials } from "./credentials.js";
import type { Profile } from "./types.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const profileRegistrySnapshotSchema = z.object({
  description: z.string().optional(),
  sourceAgent: z.enum(["claude", "codex", "antigravity"]).optional(),
  mcps: z.record(digestSchema),
  skills: z.record(digestSchema),
  plugins: z.record(digestSchema),
  contentDigest: digestSchema,
});

export type ProfileRegistrySnapshot = z.infer<typeof profileRegistrySnapshotSchema>;

export const profileRegistryLinkSchema = z.object({
  schemaVersion: z.literal(1),
  origin: z.enum(["published", "installed"]),
  slug: z.string().min(1),
  version: z.string().min(1),
  profileId: z.string().optional(),
  versionId: z.string().optional(),
  linkedAt: z.string().datetime(),
  baseline: profileRegistrySnapshotSchema,
});

export type ProfileRegistryLink = z.infer<typeof profileRegistryLinkSchema>;

export interface ProfileRegistryDiff {
  descriptionChanged: boolean;
  sourceAgentChanged: boolean;
  hasLocalChanges: boolean;
  mcps: ProfileRegistryItemDiff;
  skills: ProfileRegistryItemDiff;
  plugins: ProfileRegistryItemDiff;
}

export interface ProfileRegistryItemDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/** Stable snapshot of local profile content. Only hashes—not secret values—are persisted. */
export async function createProfileRegistrySnapshot(
  profile: Profile,
  directory: string,
): Promise<ProfileRegistrySnapshot> {
  const mcps = Object.fromEntries(
    Object.entries(profile.mcps)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [name, digestValue(redactMcpCredentials(value).redacted)]),
  );
  const skills = Object.fromEntries(
    await Promise.all(
      profile.skills
        .map((skill) => skill.name)
        .sort()
        .map(async (name) => [
          name,
          await digestDirectory(path.join(directory, "skills", path.basename(name))),
        ] as const),
    ),
  );
  const plugins = Object.fromEntries(
    await Promise.all(
      [...profile.plugins]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(async (plugin) => [
          plugin.name,
          digestValue({
            metadata: plugin,
            files: await digestDirectory(path.join(directory, "plugins", plugin.bundleKey)),
          }),
        ] as const),
    ),
  );
  const content = {
    ...(profile.description ? { description: profile.description } : {}),
    ...(profile.sourceAgent ? { sourceAgent: profile.sourceAgent } : {}),
    mcps,
    skills,
    plugins,
  };
  return { ...content, contentDigest: digestValue(content) };
}

export function diffProfileRegistrySnapshots(
  baseline: ProfileRegistrySnapshot,
  current: ProfileRegistrySnapshot,
): ProfileRegistryDiff {
  const mcps = diffItems(baseline.mcps, current.mcps);
  const skills = diffItems(baseline.skills, current.skills);
  const plugins = diffItems(baseline.plugins, current.plugins);
  const descriptionChanged = baseline.description !== current.description;
  const sourceAgentChanged = baseline.sourceAgent !== current.sourceAgent;
  return {
    descriptionChanged,
    sourceAgentChanged,
    hasLocalChanges: baseline.contentDigest !== current.contentDigest,
    mcps,
    skills,
    plugins,
  };
}

function diffItems(
  baseline: Record<string, string>,
  current: Record<string, string>,
): ProfileRegistryItemDiff {
  const before = new Set(Object.keys(baseline));
  const after = new Set(Object.keys(current));
  return {
    added: [...after].filter((name) => !before.has(name)).sort(),
    removed: [...before].filter((name) => !after.has(name)).sort(),
    changed: [...after]
      .filter((name) => before.has(name) && baseline[name] !== current[name])
      .sort(),
  };
}

async function digestDirectory(directory: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(current: string, relative: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      hash.update("missing\0");
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".git" || entry.name === ".DS_Store") continue;
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        hash.update(`dir\0${entryRelative}\0`);
        await visit(entryPath, entryRelative);
      } else if (entry.isFile()) {
        hash.update(`file\0${entryRelative}\0`);
        hash.update(await readFile(entryPath));
        hash.update("\0");
      }
    }
  }
  await visit(directory, "");
  return hash.digest("hex");
}

function digestValue(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
