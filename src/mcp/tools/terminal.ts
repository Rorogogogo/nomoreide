import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { stringify, type ToolContext } from "./context.js";

export const TERMINAL_TOOL_NAMES = [
  "nomoreide_list_terminal_sessions",
  "nomoreide_open_terminal",
  "nomoreide_reclaim_terminal",
] as const;

const sessionSchema = z.object({
  id: z.string().min(1).max(200)
    .refine((id) => !hasControlCharacters(id) && !id.includes("/") && !id.includes("\\"))
    .describe("Existing daemon terminal session id."),
});

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

export function registerTerminalTools(server: FastMCP, ctx: ToolContext): void {
  server.addTool({
    name: "nomoreide_list_terminal_sessions",
    description:
      "List terminal sessions owned by the shared NoMoreIDE daemon, including whether each agent is controlled in the web dock or Terminal.app.",
    execute: async () => stringify(await (await ctx.daemon.client()).listTerminalSessions()),
  });

  server.addTool({
    name: "nomoreide_open_terminal",
    description:
      "Move an existing running agent session from the NoMoreIDE web dock to macOS Terminal.app without restarting it.",
    parameters: sessionSchema,
    execute: async ({ id }) => stringify(await (await ctx.daemon.client()).openTerminal(id)),
  });

  server.addTool({
    name: "nomoreide_reclaim_terminal",
    description:
      "Bring an externally presented agent session back from macOS Terminal.app to the NoMoreIDE web dock without restarting it.",
    parameters: sessionSchema,
    execute: async ({ id }) => stringify(await (await ctx.daemon.client()).reclaimTerminal(id)),
  });
}
