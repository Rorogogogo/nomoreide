import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { stringify, type ToolContext } from "./context.js";

export const ERROR_TOOL_NAMES = [
  "nomoreide_list_errors",
  "nomoreide_error_prompt",
] as const;

const errorIdSchema = z.object({
  id: z.number().int().positive().describe("Incident id from nomoreide_list_errors."),
});

const listErrorsSchema = z.object({
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("Max incidents to return (default 50)."),
});

/** Error Inbox tools: surface detected incidents and their copy-to-agent prompt. */
export function registerErrorTools(server: FastMCP, ctx: ToolContext): void {
  const { errorInbox } = ctx;

  server.addTool({
    name: "nomoreide_list_errors",
    description:
      "List deduped error / stack-trace incidents detected across managed service logs.",
    parameters: listErrorsSchema,
    execute: async ({ limit }) => stringify(errorInbox.list(limit ?? 50)),
  });

  server.addTool({
    name: "nomoreide_error_prompt",
    description:
      "Assemble a debugging prompt for an incident: the error excerpt, the diff of the affected file, and recent service logs.",
    parameters: errorIdSchema,
    execute: async ({ id }) => {
      const payload = await errorInbox.buildPrompt(id);
      if (!payload) throw new Error(`Incident ${id} not found`);
      return payload.prompt;
    },
  });
}
