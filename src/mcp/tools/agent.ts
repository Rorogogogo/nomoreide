import type { FastMCP } from "fastmcp";
import { stringify, type ToolContext } from "./context.js";

export const AGENT_TOOL_NAMES = [
  "nomoreide_open_ui",
  "nomoreide_close_ui",
] as const;

export function registerAgentTools(server: FastMCP, ctx: ToolContext): void {
  const { uiLifecycle } = ctx;

  server.addTool({
    name: "nomoreide_open_ui",
    description: "Open or reuse the singleton NoMoreIDE web UI.",
    execute: async () => stringify(await uiLifecycle.ensureStarted()),
  });

  server.addTool({
    name: "nomoreide_close_ui",
    description: "Close the NoMoreIDE web UI owned by this MCP process.",
    execute: async () => stringify(await uiLifecycle.close()),
  });
}
