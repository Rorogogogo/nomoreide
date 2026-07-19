/**
 * Data layer for the dock's capability strip: what the selected provider has
 * installed (skills / plugins / MCP servers / hooks) as counts for the chips,
 * as named items for the dropdowns, plus the live MCP auth summary.
 */
import { useEffect, useState } from "react";
import {
  getAgentEnvConfigs,
  getAgentInfo,
  getMcpAuthStatuses,
  type AgentEnvConfig,
  type AgentHook,
  type McpAuthState,
  type McpAuthStatus,
} from "@/lib/api";
import type { AgentId } from "../agent-types";

export type CapabilityProviderId = "claude" | "codex";

export interface CapabilityCounts {
  skills: number;
  plugins: number;
  mcps: number;
  hooks: number;
}

export interface McpAuthSummary {
  /** How many servers the CLI health-checked (0 when the CLI is missing). */
  checked: number;
  needsAuth: number;
  failed: number;
}

/**
 * One row in a capability dropdown. `insert` is the prompt text a click sends
 * to the composer; rows without it (hooks fire on their own) are read-only.
 */
export interface CapabilityItem {
  name: string;
  /** Secondary text: scope for skills/MCP, the shell command for hooks. */
  detail?: string;
  insert?: string;
  /** Indented child row (a plugin's bundled skills/commands). */
  sub?: boolean;
}

export interface CapabilityLists {
  skills: CapabilityItem[];
  plugins: CapabilityItem[];
  mcps: CapabilityItem[];
  hooks: CapabilityItem[];
}

export interface AgentCapabilities {
  counts: CapabilityCounts | null;
  items: CapabilityLists | null;
  auth: McpAuthSummary | null;
  /** Per-server live state, keyed by server name (from `<cli> mcp list`). */
  mcpAuth: Record<string, McpAuthState>;
}

/** User + project, local + remote — the same four maps the Agent Env column renders. */
export function countMcpServers(
  config: Pick<
    AgentEnvConfig,
    "mcpServers" | "remoteMcpServers" | "projectMcpServers" | "projectRemoteMcpServers"
  >,
): number {
  return (
    Object.keys(config.mcpServers).length +
    Object.keys(config.remoteMcpServers).length +
    Object.keys(config.projectMcpServers).length +
    Object.keys(config.projectRemoteMcpServers).length
  );
}

export function capabilityCountsFor(
  config: AgentEnvConfig | undefined,
  hooks: number,
): CapabilityCounts {
  const skills = config?.skills ?? [];
  return {
    skills: skills.filter((skill) => skill.kind !== "plugin").length,
    plugins: skills.filter((skill) => skill.kind === "plugin").length,
    mcps: config ? countMcpServers(config) : 0,
    hooks,
  };
}

export function summarizeMcpAuth(statuses: McpAuthStatus[]): McpAuthSummary {
  let needsAuth = 0;
  let failed = 0;
  for (const status of statuses) {
    if (status.state === "needs-auth") needsAuth += 1;
    else if (status.state === "failed") failed += 1;
  }
  return { checked: statuses.length, needsAuth, failed };
}

/** Claude skills are slash-invocable; Codex skills are addressed in prose. */
export function skillInsertText(name: string, provider: CapabilityProviderId): string {
  return provider === "claude" ? `/${name} ` : `Use the "${name}" skill: `;
}

export function mcpInsertText(name: string): string {
  return `Use the "${name}" MCP server: `;
}

/**
 * Expands an Agent Env config + hook list into dropdown rows. Plugins get one
 * parent row plus (on Claude, where `/plugin:command` is the invocation
 * syntax) an indented insertable row per bundled skill/command.
 */
export function capabilityItemsFor(
  config: AgentEnvConfig | undefined,
  hooks: AgentHook[],
  provider: CapabilityProviderId,
): CapabilityLists {
  const skills: CapabilityItem[] = [];
  const plugins: CapabilityItem[] = [];
  for (const skill of config?.skills ?? []) {
    if (skill.kind === "plugin") {
      plugins.push({
        name: skill.name,
        detail: skill.scope,
        insert: `Use the "${skill.name}" plugin: `,
      });
      if (provider === "claude") {
        for (const sub of [...(skill.pluginSkills ?? []), ...(skill.pluginCommands ?? [])]) {
          plugins.push({
            name: `${skill.name}:${sub}`,
            insert: `/${skill.name}:${sub} `,
            sub: true,
          });
        }
      }
    } else {
      skills.push({
        name: skill.name,
        detail: skill.scope,
        insert: skillInsertText(skill.name, provider),
      });
    }
  }

  const mcps: CapabilityItem[] = [];
  const mcpMaps: Array<[Record<string, unknown>, string]> = [
    [config?.mcpServers ?? {}, "user"],
    [config?.remoteMcpServers ?? {}, "user · remote"],
    [config?.projectMcpServers ?? {}, "project"],
    [config?.projectRemoteMcpServers ?? {}, "project · remote"],
  ];
  for (const [map, detail] of mcpMaps) {
    for (const name of Object.keys(map)) {
      mcps.push({ name, detail, insert: mcpInsertText(name) });
    }
  }

  const hookItems = hooks.map((hook) => ({
    name: hook.matcher ? `${hook.event} · ${hook.matcher}` : hook.event,
    detail: hook.command,
  }));

  return { skills, plugins, mcps, hooks: hookItems };
}

/**
 * Loads the selected provider's capabilities (Agent Env view of skills /
 * plugins / MCP servers, plus hooks from agent info) and, separately, the live
 * MCP auth states. The auth check shells out to `<cli> mcp list` and can take
 * seconds, so it streams in after the counts/items.
 */
export function useAgentCapabilities(
  providerId: CapabilityProviderId,
  enabled = true,
): AgentCapabilities {
  const envAgent = providerId === "codex" ? "codex" : "claude";
  const chatAgent: AgentId = providerId === "codex" ? "codex" : "claude-code";
  const [counts, setCounts] = useState<CapabilityCounts | null>(null);
  const [items, setItems] = useState<CapabilityLists | null>(null);
  const [auth, setAuth] = useState<McpAuthSummary | null>(null);
  const [mcpAuth, setMcpAuth] = useState<Record<string, McpAuthState>>({});

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setCounts(null);
    setItems(null);
    setAuth(null);
    setMcpAuth({});
    void Promise.all([
      getAgentEnvConfigs().catch(() => [] as AgentEnvConfig[]),
      getAgentInfo().catch(() => null),
    ]).then(([configs, info]) => {
      if (cancelled) return;
      const config = configs.find((entry) => entry.agent === envAgent);
      const hooks = info?.agents[chatAgent]?.hooks ?? [];
      setCounts(capabilityCountsFor(config, hooks.length));
      setItems(capabilityItemsFor(config, hooks, providerId));
    });
    void getMcpAuthStatuses(chatAgent)
      .then((statuses) => {
        if (cancelled) return;
        setAuth(summarizeMcpAuth(statuses));
        setMcpAuth(Object.fromEntries(statuses.map((status) => [status.name, status.state])));
      })
      .catch(() => {
        if (!cancelled) setAuth({ checked: 0, needsAuth: 0, failed: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, envAgent, chatAgent, providerId]);

  return { counts, items, auth, mcpAuth };
}
