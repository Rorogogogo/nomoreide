import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  AgentMcpEntry,
  AgentSkillEntry,
  RemoteMcpEntry,
} from "./types.js";

export function parseEnvObject(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = String(entry);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Read skill directories (Claude, Codex, and Antigravity share the SKILL.md dir convention). */
export async function readSkillDirs(
  skillsDir: string,
  scope: "user" | "project" = "user",
): Promise<AgentSkillEntry[]> {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skills: AgentSkillEntry[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const installPath = path.join(skillsDir, entry.name);
    if (entry.isDirectory()) {
      skills.push({ name: entry.name, source: "local", kind: "skill", scope, installPath });
    } else if (entry.isSymbolicLink()) {
      skills.push({ name: entry.name, source: "linked", kind: "skill", scope, installPath });
    }
  }

  return skills;
}

/**
 * Walk from `cwd` up to the repo root (first ancestor containing `.git`, or
 * the filesystem root) and emit skills declared in `<ancestor>/.claude/skills/`
 * with `scope: "project"`. Only Claude reads project-scoped skills; the closer
 * ancestor wins on name collisions.
 */
export async function readProjectSkills(cwd: string): Promise<AgentSkillEntry[]> {
  const seen = new Map<string, AgentSkillEntry>();
  let current = path.resolve(cwd);
  const visited = new Set<string>();

  while (!visited.has(current)) {
    visited.add(current);
    const skillsDir = path.join(current, ".claude", "skills");
    try {
      const entries = await readSkillDirs(skillsDir, "project");
      for (const entry of entries) {
        if (!seen.has(entry.name)) seen.set(entry.name, entry);
      }
    } catch {
      // no skills dir at this level
    }

    try {
      await stat(path.join(current, ".git"));
      break;
    } catch {
      // not a repo root; continue up
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return Array.from(seen.values());
}

export interface McpMaps {
  mcpServers: Record<string, AgentMcpEntry>;
  remoteMcpServers: Record<string, RemoteMcpEntry>;
  projectMcpServers: Record<string, AgentMcpEntry>;
  projectRemoteMcpServers: Record<string, RemoteMcpEntry>;
}

/** Drop MCP servers that a plugin owns — the plugin card already lists them. */
export function filterPluginOwnedMcps(maps: McpMaps, skills: AgentSkillEntry[]): McpMaps {
  const pluginOwned = new Set(skills.flatMap((skill) => skill.pluginMcps ?? []));
  if (pluginOwned.size === 0) return maps;
  const notOwned = ([key]: [string, unknown]) => !pluginOwned.has(key);
  return {
    mcpServers: Object.fromEntries(Object.entries(maps.mcpServers).filter(notOwned)),
    remoteMcpServers: Object.fromEntries(
      Object.entries(maps.remoteMcpServers).filter(notOwned),
    ),
    projectMcpServers: Object.fromEntries(
      Object.entries(maps.projectMcpServers).filter(notOwned),
    ),
    projectRemoteMcpServers: Object.fromEntries(
      Object.entries(maps.projectRemoteMcpServers).filter(notOwned),
    ),
  };
}

/**
 * Project-scoped MCPs recorded by brainctl at `<cwd>/.brainctl/project-mcps.json`
 * for agents without native per-project config (Codex, Antigravity). Read for
 * compatibility so brainctl users see their full setup after migrating.
 */
export async function readBrainctlProjectMcps(
  cwd: string,
  agent: "codex" | "antigravity",
): Promise<Pick<McpMaps, "projectMcpServers" | "projectRemoteMcpServers">> {
  try {
    const filePath = path.join(cwd, ".brainctl", "project-mcps.json");
    const data = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    const agentData = (data[agent] ?? {}) as Record<string, unknown>;
    const rawServers = (agentData.mcpServers ?? {}) as Record<string, Record<string, unknown>>;

    const projectMcpServers: Record<string, AgentMcpEntry> = {};
    const projectRemoteMcpServers: Record<string, RemoteMcpEntry> = {};
    for (const [name, entry] of Object.entries(rawServers)) {
      if (typeof entry.url === "string" && entry.url) {
        projectRemoteMcpServers[name] = {
          transport: (entry.transport as "http" | "sse") ?? "http",
          url: entry.url,
          headers: parseEnvObject(entry.headers),
          env: parseEnvObject(entry.env),
        };
      } else {
        projectMcpServers[name] = {
          command: String(entry.command ?? ""),
          args: Array.isArray(entry.args) ? entry.args.map(String) : undefined,
          env: parseEnvObject(entry.env),
        };
      }
    }
    return { projectMcpServers, projectRemoteMcpServers };
  } catch {
    return { projectMcpServers: {}, projectRemoteMcpServers: {} };
  }
}
