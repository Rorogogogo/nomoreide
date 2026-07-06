import { readFile } from "node:fs/promises";
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
  const registryPath = path.join(homeDir, ".brainctl", "managed-plugins.json");

  try {
    const source = await readFile(registryPath, "utf8");
    const parsed = JSON.parse(source) as ManagedPluginRegistryFile;
    return (parsed.agents?.[options.agent] ?? []).map((entry) => ({
      ...entry,
      kind: "plugin" as const,
      scope: entry.scope ?? "user",
      managed: true,
    }));
  } catch {
    return [];
  }
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
