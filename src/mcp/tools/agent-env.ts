import type { FastMCP } from "fastmcp";
import { z } from "zod";
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
] as const;

const agentEnvCwdSchema = z.object({
  cwd: z
    .string()
    .min(1)
    .optional()
    .describe("Project directory used to resolve project-scoped MCPs and skills."),
});

/**
 * Read-only (ROR-60). Mutating agent configs is Phase 2 (ROR-61) and will live
 * behind the write-guarded agent-env-actions module.
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
}
