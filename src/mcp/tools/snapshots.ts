import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { SnapshotManager } from "../../core/snapshot-manager.js";
import { stringify, type ToolContext } from "./context.js";

export const SNAPSHOT_TOOL_NAMES = [
  "nomoreide_snapshots_list",
  "nomoreide_snapshot_create",
] as const;

const snapshotCwdSchema = z.object({
  cwd: z.string().min(1).optional().describe("Git repository directory."),
});

const snapshotCreateSchema = snapshotCwdSchema.extend({
  label: z.string().min(1).describe("Human-readable snapshot label."),
});

/**
 * Read/create only — restore is destructive and stays human-only (web UI
 * with confirmation), mirroring the DbWrite boundary.
 */
export function registerSnapshotTools(server: FastMCP, _ctx: ToolContext): void {
  server.addTool({
    name: "nomoreide_snapshots_list",
    description:
      "List nomoreide working-tree snapshots (refs/nomoreide/snapshots) for a repository.",
    parameters: snapshotCwdSchema,
    execute: async ({ cwd }) =>
      stringify(await new SnapshotManager(cwd ?? process.cwd()).list()),
  });

  server.addTool({
    name: "nomoreide_snapshot_create",
    description:
      "Checkpoint the current working tree as a nomoreide snapshot (never moves HEAD, branches, or the index).",
    parameters: snapshotCreateSchema,
    execute: async ({ cwd, label }) => {
      const manager = new SnapshotManager(cwd ?? process.cwd());
      const snapshot = await manager.snapshot(label);
      await manager.prune();
      return stringify(snapshot);
    },
  });
}
