import type { FastMCP } from "fastmcp";
import { z } from "zod";
import {
  applyChanges,
  snapshotAgent,
} from "../../core/agent-env-actions.js";
import { addMcp } from "../../core/agent-env-writers.js";
import {
  getAgentAvailability,
  readAllAgentConfigs,
  runAgentDoctor,
} from "../../core/agent-env/index.js";
import { stringify, type ToolContext } from "./context.js";

export const AGENT_ENV_TOOL_NAMES = [
  "nomoreide_agents_status",
  "nomoreide_agents_read_configs",
  "nomoreide_agents_doctor",
  "nomoreide_agents_add_mcp",
  "nomoreide_agents_remove_mcp",
  "nomoreide_agents_move_mcp_scope",
  "nomoreide_agents_move_skill_scope",
  "nomoreide_agents_snapshot_agent",
] as const;

const agentSchema = z.enum(["claude", "codex", "antigravity"]);
const scopeSchema = z.enum(["user", "project"]);

const cwdField = z
  .string()
  .min(1)
  .optional()
  .describe("Project directory used to resolve project-scoped MCPs and skills.");

const agentEnvCwdSchema = z.object({ cwd: cwdField });

/**
 * Read tools shipped with ROR-60; write tools (ROR-61) are apply-scoped — each
 * stages one change through the write-guarded agent-env-actions module and
 * applies it immediately, echoing the backup files it created.
 */
export function registerAgentEnvTools(server: FastMCP, _ctx: ToolContext): void {
  server.addTool({
    name: "nomoreide_agents_status",
    description:
      "Check which coding agent CLIs (Claude Code, Codex, Antigravity) are installed and on PATH.",
    parameters: z.object({}),
    execute: async () => stringify(await getAgentAvailability()),
  });

  server.addTool({
    name: "nomoreide_agents_read_configs",
    description:
      "Read the live MCP servers and skills configured for each coding agent (Claude Code, Codex, Antigravity). Read-only.",
    parameters: agentEnvCwdSchema,
    execute: async ({ cwd }) =>
      stringify(await readAllAgentConfigs({ cwd: cwd ?? process.cwd() })),
  });

  server.addTool({
    name: "nomoreide_agents_doctor",
    description:
      "Diagnose coding agent setup: CLI availability and config file presence per agent.",
    parameters: agentEnvCwdSchema,
    execute: async ({ cwd }) =>
      stringify(await runAgentDoctor({ cwd: cwd ?? process.cwd() })),
  });

  server.addTool({
    name: "nomoreide_agents_add_mcp",
    description:
      "Add (or overwrite) an MCP server in a coding agent's config. Provide command/args/env for a stdio server, or url (+ transport) for a remote one. The previous config file is backed up first; the backup path is returned.",
    parameters: z.object({
      agent: agentSchema,
      key: z.string().min(1).describe("MCP server name."),
      command: z.string().optional().describe("Executable for a stdio MCP server."),
      args: z.array(z.string()).optional(),
      env: z.record(z.string()).optional(),
      url: z.string().optional().describe("URL for a remote MCP server."),
      transport: z.enum(["http", "sse"]).optional().describe("Remote transport (default http)."),
      scope: scopeSchema.default("user"),
      cwd: cwdField,
    }),
    execute: async (input) => {
      if (!input.command && !input.url) {
        throw new Error("Provide either command (stdio server) or url (remote server).");
      }
      const outcome = await addMcp({
        cwd: input.cwd ?? process.cwd(),
        agent: input.agent,
        key: input.key,
        scope: input.scope,
        entry: input.command
          ? { command: input.command, args: input.args, env: input.env }
          : undefined,
        remoteEntry: input.url
          ? { transport: input.transport ?? "http", url: input.url }
          : undefined,
      });
      return stringify({ ok: true, agent: input.agent, key: input.key, ...outcome });
    },
  });

  server.addTool({
    name: "nomoreide_agents_remove_mcp",
    description:
      "Remove an MCP server from a coding agent's config. The config file is backed up first; the backup path is returned.",
    parameters: z.object({
      agent: agentSchema,
      key: z.string().min(1),
      scope: scopeSchema.default("user"),
      cwd: cwdField,
    }),
    execute: async (input) =>
      stringify(
        await applyChanges({
          cwd: input.cwd ?? process.cwd(),
          changes: [
            {
              category: "mcp",
              action: "remove",
              name: input.key,
              sourceAgent: input.agent,
              sourceScope: input.scope,
            },
          ],
        }),
      ),
  });

  server.addTool({
    name: "nomoreide_agents_move_mcp_scope",
    description:
      "Move an MCP server between an agent's user (global) and project scope. Config files are backed up first; backup paths are returned.",
    parameters: z.object({
      agent: agentSchema,
      key: z.string().min(1),
      fromScope: scopeSchema,
      toScope: scopeSchema,
      cwd: cwdField,
    }),
    execute: async (input) =>
      stringify(
        await applyChanges({
          cwd: input.cwd ?? process.cwd(),
          changes: [
            {
              category: "mcp",
              action: "move",
              name: input.key,
              sourceAgent: input.agent,
              sourceScope: input.fromScope,
              targetAgent: input.agent,
              targetScope: input.toScope,
            },
          ],
        }),
      ),
  });

  server.addTool({
    name: "nomoreide_agents_move_skill_scope",
    description:
      "Move a skill between user and project scope (Claude only — other agents have no project skills). The removed source directory is backed up; the backup path is returned.",
    parameters: z.object({
      agent: agentSchema,
      skillName: z.string().min(1),
      fromScope: scopeSchema,
      toScope: scopeSchema,
      cwd: cwdField,
    }),
    execute: async (input) =>
      stringify(
        await applyChanges({
          cwd: input.cwd ?? process.cwd(),
          changes: [
            {
              category: "skill",
              action: "move",
              name: input.skillName,
              sourceAgent: input.agent,
              sourceScope: input.fromScope,
              targetAgent: input.agent,
              targetScope: input.toScope,
            },
          ],
        }),
      ),
  });

  server.addTool({
    name: "nomoreide_agents_snapshot_agent",
    description:
      "Snapshot a coding agent's live config file to a timestamped .bak.* copy before bulk edits. Returns the backup path.",
    parameters: z.object({ agent: agentSchema, cwd: cwdField }),
    execute: async (input) =>
      stringify(
        await snapshotAgent({ cwd: input.cwd ?? process.cwd(), agent: input.agent }),
      ),
  });
}
