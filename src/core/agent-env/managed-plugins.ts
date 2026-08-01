import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AgentName, AgentSkillEntry } from "./types.js";

interface ManagedPluginRegistryFile {
  version: 1;
  agents?: Partial<Record<AgentName, AgentSkillEntry[]>>;
}

/**
 * Plugins brainctl installed for agents without a native plugin system are
 * tracked in `~/.brainctl/managed-plugins.json`. Read-only here — Phase 1 never
 * mutates the registry; keeping the path lets migrated brainctl users see the
 * plugins it manages.
 */
export async function readManagedPlugins(options: {
  agent: AgentName;
  homeDir?: string;
}): Promise<AgentSkillEntry[]> {
  const homeDir = options.homeDir ?? homedir();
  const paths = [
    path.join(homeDir, ".config", "nomoreide", "managed-plugins.json"),
    path.join(homeDir, ".brainctl", "managed-plugins.json"),
  ];
  const entries: AgentSkillEntry[] = [];
  for (const registryPath of paths) {
    try {
      const source = await readFile(registryPath, "utf8");
      const parsed = JSON.parse(source) as ManagedPluginRegistryFile;
      entries.push(...(parsed.agents?.[options.agent] ?? []).map((entry) => ({
      ...entry,
      kind: "plugin" as const,
      scope: entry.scope ?? "user",
      managed: true,
      })));
    } catch {
      // Registry is optional.
    }
  }
  const unique = new Map<string, AgentSkillEntry>();
  for (const entry of entries) {
    const identity = `${entry.name}\0${entry.source ?? ""}`;
    if (!unique.has(identity)) unique.set(identity, entry);
  }
  return Array.from(unique.values());
}

export async function writeManagedPlugin(options: {
  agent: AgentName;
  plugin: AgentSkillEntry;
  homeDir?: string;
}): Promise<string> {
  const homeDir = options.homeDir ?? homedir();
  const registryPath = path.join(homeDir, ".config", "nomoreide", "managed-plugins.json");
  let data: ManagedPluginRegistryFile = { version: 1, agents: {} };
  try {
    data = JSON.parse(await readFile(registryPath, "utf8")) as ManagedPluginRegistryFile;
  } catch {
    // Fresh registry.
  }
  const current = data.agents?.[options.agent] ?? [];
  const next = current.filter(
    (entry) => entry.name !== options.plugin.name || entry.source !== options.plugin.source,
  );
  next.push({ ...options.plugin, kind: "plugin", scope: "user", managed: true });
  data.agents = { ...data.agents, [options.agent]: next };
  await mkdir(path.dirname(registryPath), { recursive: true });
  const { atomicWrite } = await import("../agent-env-writers.js");
  await atomicWrite(registryPath, `${JSON.stringify(data, null, 2)}\n`);
  return registryPath;
}

/** Managed plugins first; local skills a plugin already owns are dropped. */
export function mergeManagedPluginsIntoSkills(
  localSkills: AgentSkillEntry[],
  managedPlugins: AgentSkillEntry[],
): AgentSkillEntry[] {
  const pluginOwnedSkills = new Set(
    managedPlugins.flatMap((plugin) => [
      ...(plugin.pluginSkills ?? []),
      ...(plugin.pluginCommands ?? []),
    ]),
  );

  const filteredLocalSkills = localSkills.filter((skill) => !pluginOwnedSkills.has(skill.name));
  return [...managedPlugins, ...filteredLocalSkills];
}
