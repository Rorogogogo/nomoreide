/**
 * Agent Environments staged writes (ROR-61) — the write-guarded surface over
 * `agent-env-writers.ts`. Mirrors the GitManager/GitActions and DbPeek/DbWrite
 * split: `core/agent-env/` only reads; every mutation flows through this
 * module's preview → apply gate and reports the backup files it created.
 */
import { z } from "zod";
import {
  readAllAgentConfigs,
  AGENT_NAMES,
  type AgentLiveConfig,
  type AgentMcpEntry,
  type AgentName,
  type RemoteMcpEntry,
} from "./agent-env/index.js";
import {
  addMcp,
  copySkill,
  moveSkill,
  removeMcp,
  removeSkill,
  snapshotAgentConfig,
  type AgentEnvScope,
  type WriteOutcome,
} from "./agent-env-writers.js";
import { isRemovablePlugin, removePlugin } from "./agent-env-plugin-uninstall.js";

const agentNameSchema = z.enum(["claude", "codex", "antigravity"]);
const scopeSchema = z.enum(["user", "project"]);

/** One staged mutation. `name` is the MCP key, skill directory, or plugin name. */
export const pendingChangeSchema = z.object({
  category: z.enum(["mcp", "skill", "plugin"]),
  action: z.enum(["copy", "move", "remove"]),
  name: z.string().min(1),
  sourceAgent: agentNameSchema,
  sourceScope: scopeSchema.default("user"),
  targetAgent: agentNameSchema.optional(),
  targetScope: scopeSchema.optional(),
});

export type PendingChange = z.infer<typeof pendingChangeSchema>;

export const pendingChangesSchema = z.array(pendingChangeSchema).min(1).max(50);

export interface ChangePreviewItem {
  change: PendingChange;
  ok: boolean;
  /** Human-readable, e.g. `Copy MCP "linear" from Claude Code to Codex CLI (user scope)`. */
  summary: string;
  warnings: string[];
  error?: string;
}

export interface AgentDiffSummary {
  agent: AgentName;
  add: string[];
  remove: string[];
}

export interface ChangePreview {
  valid: boolean;
  items: ChangePreviewItem[];
  agents: AgentDiffSummary[];
}

export interface AppliedChange {
  change: PendingChange;
  ok: boolean;
  summary: string;
  backups: string[];
  error?: string;
}

export interface ApplyResult {
  ok: boolean;
  applied: number;
  failed: number;
  results: AppliedChange[];
  /** Every backup file/directory created across all changes. */
  backups: string[];
}

export interface AgentEnvActionOptions {
  cwd: string;
  homeDir?: string;
}

const AGENT_LABELS: Record<AgentName, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  antigravity: "Antigravity",
};

export async function previewChanges(
  options: AgentEnvActionOptions & { changes: PendingChange[] },
): Promise<ChangePreview> {
  const configs = await readAllAgentConfigs(options);
  const byAgent = new Map(configs.map((config) => [config.agent, config]));
  const items = options.changes.map((change) => previewOne(change, byAgent));

  const agents: AgentDiffSummary[] = AGENT_NAMES.map((agent) => ({
    agent,
    add: [],
    remove: [],
  }));
  const diffFor = (agent: AgentName) => agents.find((entry) => entry.agent === agent)!;

  for (const item of items) {
    if (!item.ok) continue;
    const { change } = item;
    const label = `${change.category} "${change.name}"`;
    if (change.action !== "remove" && change.targetAgent) {
      diffFor(change.targetAgent).add.push(label);
    }
    if (change.action !== "copy") {
      diffFor(change.sourceAgent).remove.push(label);
    }
  }

  return {
    valid: items.every((item) => item.ok),
    items,
    agents: agents.filter((entry) => entry.add.length > 0 || entry.remove.length > 0),
  };
}

function previewOne(
  change: PendingChange,
  byAgent: Map<AgentName, AgentLiveConfig>,
): ChangePreviewItem {
  const warnings: string[] = [];
  const fail = (error: string): ChangePreviewItem => ({
    change,
    ok: false,
    summary: describeChange(change),
    warnings,
    error,
  });

  const source = byAgent.get(change.sourceAgent);
  if (!source) return fail(`Unknown agent "${change.sourceAgent}".`);

  if (change.category === "plugin") {
    if (change.action !== "remove") {
      return fail(
        `Plugins are managed installs; install "${change.name}" through the target agent's plugin marketplace instead of copying files.`,
      );
    }
    if (change.targetAgent) return fail("A remove cannot have a target agent.");
    const plugin = source.skills.find(
      (candidate) => candidate.kind === "plugin" && candidate.name === change.name,
    );
    if (!plugin) {
      return fail(`Plugin "${change.name}" not found in ${AGENT_LABELS[change.sourceAgent]}.`);
    }
    if (!isRemovablePlugin(change.sourceAgent, plugin)) {
      return fail(
        `Plugin "${change.name}" can't be uninstalled from here — no install path or marketplace source was detected.`,
      );
    }
    const contents = [
      [plugin.pluginSkills?.length, "skills"],
      [plugin.pluginMcps?.length, "MCPs"],
      [plugin.pluginAgents?.length, "agents"],
      [plugin.pluginCommands?.length, "commands"],
    ]
      .filter(([count]) => (count as number) > 0)
      .map(([count, label]) => `${count} ${label}`)
      .join(", ");
    if (contents) {
      warnings.push(`Uninstalling "${change.name}" removes ${contents}.`);
    }
    return { change, ok: true, summary: describeChange(change), warnings };
  }

  if (change.action !== "remove") {
    if (!change.targetAgent) return fail(`A ${change.action} needs a target agent.`);
    const targetScope = change.targetScope ?? "user";
    if (change.targetAgent === change.sourceAgent && targetScope === change.sourceScope) {
      return fail(`Source and target are the same; nothing to ${change.action}.`);
    }
    if (change.category === "skill" && targetScope === "project" && change.targetAgent === "antigravity") {
      return fail(`${AGENT_LABELS[change.targetAgent]} has no project-scoped skills; Claude reads .claude/skills/ and Codex reads .agents/skills/.`);
    }
  } else if (change.targetAgent) {
    return fail("A remove cannot have a target agent.");
  }

  if (change.category === "mcp") {
    const { entry, remoteEntry } = findMcp(source, change.name, change.sourceScope);
    if (!entry && !remoteEntry) {
      return fail(
        `MCP "${change.name}" not found in ${AGENT_LABELS[change.sourceAgent]} ${change.sourceScope} scope.`,
      );
    }
    if (change.targetAgent) {
      const target = byAgent.get(change.targetAgent);
      const targetScope = change.targetScope ?? "user";
      if (target) {
        const existing = findMcp(target, change.name, targetScope);
        if (existing.entry || existing.remoteEntry) {
          warnings.push(
            `${AGENT_LABELS[change.targetAgent]} already has an MCP named "${change.name}"; it will be overwritten.`,
          );
        }
      }
      if (
        change.targetAgent === "codex" &&
        targetScope === "user" &&
        remoteEntry &&
        (remoteEntry.headers || remoteEntry.transport === "sse")
      ) {
        warnings.push(
          "Codex config only stores a URL for remote MCPs; transport and headers will be dropped.",
        );
      }
    }
  } else {
    const skill = source.skills.find(
      (candidate) => candidate.name === change.name && candidate.scope === change.sourceScope,
    );
    if (!skill) {
      return fail(
        `Skill "${change.name}" not found in ${AGENT_LABELS[change.sourceAgent]} ${change.sourceScope} scope.`,
      );
    }
    if (skill.kind === "plugin") {
      return fail(
        `"${change.name}" is a plugin managed by ${AGENT_LABELS[change.sourceAgent]}; install it through the plugin marketplace instead of copying files.`,
      );
    }
    if (change.targetAgent) {
      const target = byAgent.get(change.targetAgent);
      const targetScope = change.targetScope ?? "user";
      const collision = target?.skills.some(
        (candidate) => candidate.name === change.name && candidate.scope === targetScope,
      );
      if (collision) {
        warnings.push(
          `${AGENT_LABELS[change.targetAgent]} already has a skill named "${change.name}"; it will be replaced.`,
        );
      }
    }
  }

  return { change, ok: true, summary: describeChange(change), warnings };
}

export function describeChange(change: PendingChange): string {
  const kind = change.category === "mcp" ? "MCP" : change.category;
  const from = `${AGENT_LABELS[change.sourceAgent]} (${change.sourceScope})`;
  if (change.action === "remove") {
    if (change.category === "plugin") {
      return `Uninstall plugin "${change.name}" from ${AGENT_LABELS[change.sourceAgent]}`;
    }
    return `Remove ${kind} "${change.name}" from ${from}`;
  }
  const targetScope = change.targetScope ?? "user";
  const target = change.targetAgent ? AGENT_LABELS[change.targetAgent] : "?";
  const verb = change.action === "copy" ? "Copy" : "Move";
  return `${verb} ${kind} "${change.name}" from ${from} to ${target} (${targetScope})`;
}

/**
 * Validate the full batch, then apply changes in order. Validation failures
 * abort before anything is written; a mid-batch write failure stops the batch
 * (earlier changes stay applied — their backups are in the result).
 */
export async function applyChanges(
  options: AgentEnvActionOptions & { changes: PendingChange[] },
): Promise<ApplyResult> {
  const preview = await previewChanges(options);
  if (!preview.valid) {
    return {
      ok: false,
      applied: 0,
      failed: preview.items.filter((item) => !item.ok).length,
      results: preview.items.map((item) => ({
        change: item.change,
        ok: false,
        summary: item.summary,
        backups: [],
        error: item.error ?? "Not applied — another staged change failed validation.",
      })),
      backups: [],
    };
  }

  const configs = await readAllAgentConfigs(options);
  const byAgent = new Map(configs.map((config) => [config.agent, config]));
  const results: AppliedChange[] = [];

  for (const change of options.changes) {
    const summary = describeChange(change);
    try {
      const outcome = await applyOne(change, byAgent, options);
      results.push({ change, ok: true, summary, backups: outcome.backups });
    } catch (error) {
      results.push({
        change,
        ok: false,
        summary,
        backups: [],
        error: error instanceof Error ? error.message : String(error),
      });
      break; // stop the batch on the first write failure
    }
  }

  const applied = results.filter((result) => result.ok).length;
  return {
    ok: applied === options.changes.length,
    applied,
    failed: results.length - applied,
    results,
    backups: results.flatMap((result) => result.backups),
  };
}

async function applyOne(
  change: PendingChange,
  byAgent: Map<AgentName, AgentLiveConfig>,
  options: AgentEnvActionOptions,
): Promise<WriteOutcome> {
  const base = { cwd: options.cwd, homeDir: options.homeDir };

  if (change.category === "plugin") {
    const source = byAgent.get(change.sourceAgent)!;
    const plugin = source.skills.find(
      (candidate) => candidate.kind === "plugin" && candidate.name === change.name,
    );
    if (!plugin) {
      throw new Error(`Plugin "${change.name}" not found in ${AGENT_LABELS[change.sourceAgent]}.`);
    }
    return removePlugin({ ...base, agent: change.sourceAgent, plugin });
  }

  if (change.category === "mcp") {
    const source = byAgent.get(change.sourceAgent)!;
    const { entry, remoteEntry } = findMcp(source, change.name, change.sourceScope);

    if (change.action === "remove") {
      return removeMcp({ ...base, agent: change.sourceAgent, key: change.name, scope: change.sourceScope });
    }

    const added = await addMcp({
      ...base,
      agent: change.targetAgent!,
      key: change.name,
      entry,
      remoteEntry,
      scope: change.targetScope ?? "user",
    });
    if (change.action === "copy") return added;
    const removed = await removeMcp({
      ...base,
      agent: change.sourceAgent,
      key: change.name,
      scope: change.sourceScope,
    });
    return { backups: [...added.backups, ...removed.backups] };
  }

  const source = { agent: change.sourceAgent, skillName: change.name, scope: change.sourceScope };
  if (change.action === "remove") {
    return removeSkill({ ...base, location: source });
  }
  const target = {
    agent: change.targetAgent!,
    skillName: change.name,
    scope: (change.targetScope ?? "user") as AgentEnvScope,
  };
  return change.action === "copy"
    ? copySkill({ ...base, source, target })
    : moveSkill({ ...base, source, target });
}

function findMcp(
  config: AgentLiveConfig,
  name: string,
  scope: AgentEnvScope,
): { entry?: AgentMcpEntry; remoteEntry?: RemoteMcpEntry } {
  const local = scope === "project" ? config.projectMcpServers : config.mcpServers;
  const remote = scope === "project" ? config.projectRemoteMcpServers : config.remoteMcpServers;
  return { entry: local[name], remoteEntry: remote[name] };
}

/* ---- Snapshot ---- */

export interface SnapshotResult {
  agent: AgentName;
  backups: string[];
}

/** Back up an agent's live config file (`<file>.bak.<ts>`) before bulk edits. */
export async function snapshotAgent(
  options: AgentEnvActionOptions & { agent: AgentName },
): Promise<SnapshotResult> {
  const outcome = await snapshotAgentConfig(options);
  return { agent: options.agent, backups: outcome.backups };
}
