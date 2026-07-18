import type { FastMCP } from "fastmcp";
import { stringify, type ToolContext } from "./context.js";

export const AGENT_TOOL_NAMES = [
  "nomoreide_open_ui",
  "nomoreide_close_ui",
] as const;

export function registerAgentTools(server: FastMCP, ctx: ToolContext): void {
  const { daemon } = ctx;

  server.addTool({
    name: "nomoreide_open_ui",
    description:
      "Open (or reuse) the machine-global NoMoreIDE daemon and return its web UI URL.",
    execute: async () => stringify(await daemon.ensure()),
  });

  server.addTool({
    name: "nomoreide_close_ui",
    description:
      "Shut down the NoMoreIDE daemon. WARNING: this stops every service it manages, for all sessions on this machine.",
    execute: async () => {
      const client = await daemon.existing();
      if (!client) {
        return stringify({ status: "not_running" });
      }
      await client.shutdown();
      return stringify({
        status: "stopping",
        note: "Daemon is stopping all managed services and exiting.",
      });
    },
  });
}
