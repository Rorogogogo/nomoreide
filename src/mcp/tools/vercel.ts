import type { FastMCP } from "fastmcp";
import { z } from "zod";
import {
  requireVercelContext,
  selectedVercelCwd,
  type VercelContext,
} from "../../core/vercel-context.js";
import { stringify, type ToolContext } from "./context.js";

/**
 * Read-only Vercel tools.
 *
 * Deliberately no redeploy/cancel/promote/rollback: those live in
 * `core/vercel-actions.ts` and are reachable only from the dashboard, where a
 * human clicked the button. An agent can diagnose a failed deploy here — read
 * its state, its commit, and its build logs — but cannot ship one.
 */
export const VERCEL_TOOL_NAMES = [
  "nomoreide_vercel_list_projects",
  "nomoreide_vercel_list_deployments",
  "nomoreide_vercel_get_deployment",
  "nomoreide_vercel_deployment_logs",
] as const;

const cwdSchema = z.object({
  cwd: z
    .string()
    .min(1)
    .optional()
    .describe("Git repository directory. Defaults to selected repository."),
});

async function buildContext(ctx: ToolContext, cwd?: string): Promise<VercelContext> {
  const config = await ctx.configStore.load();
  return requireVercelContext(ctx.configStore, cwd ?? selectedVercelCwd(config, process.cwd()));
}

/** Deployment reads need a linked project; say which knob fixes it when there isn't one. */
function requireProject(context: VercelContext): string {
  if (!context.project) {
    throw new Error(
      "No Vercel project is linked to this repository. Link it with `vercel link`, or pick one in the NoMoreIDE Vercel tab.",
    );
  }
  return context.project.id;
}

export function registerVercelTools(server: FastMCP, ctx: ToolContext): void {
  server.addTool({
    name: "nomoreide_vercel_list_projects",
    description:
      "List Vercel projects for the connected account or team, and which one the current repository deploys.",
    parameters: cwdSchema.extend({
      search: z.string().min(1).optional().describe("Filter projects by name."),
    }),
    execute: async ({ cwd, search }) => {
      const context = await buildContext(ctx, cwd);
      return stringify({
        linkedProjectId: context.project?.id ?? null,
        projects: await context.manager.listProjects({ search }),
      });
    },
  });

  server.addTool({
    name: "nomoreide_vercel_list_deployments",
    description:
      "List recent Vercel deployments for the repository's linked project, newest first. Use this to check whether a deploy succeeded.",
    parameters: cwdSchema.extend({
      target: z
        .enum(["production", "preview"])
        .optional()
        .describe("Filter by environment. Omit for both."),
      limit: z.number().int().positive().max(100).default(20),
    }),
    execute: async ({ cwd, target, limit }) => {
      const context = await buildContext(ctx, cwd);
      return stringify(
        await context.manager.listDeployments({
          projectId: requireProject(context),
          target,
          limit,
        }),
      );
    },
  });

  server.addTool({
    name: "nomoreide_vercel_get_deployment",
    description:
      "Get one Vercel deployment's state, target, aliases, commit, and error message (if it failed).",
    parameters: cwdSchema.extend({
      deployment: z
        .string()
        .min(1)
        .describe("Deployment id (dpl_...) or its hostname."),
    }),
    execute: async ({ cwd, deployment }) => {
      const context = await buildContext(ctx, cwd);
      return stringify(await context.manager.getDeployment(deployment));
    },
  });

  server.addTool({
    name: "nomoreide_vercel_deployment_logs",
    description:
      "Read build logs for a Vercel deployment — the output to diagnose a failed build.",
    parameters: cwdSchema.extend({
      deployment: z
        .string()
        .min(1)
        .describe("Deployment id (dpl_...) or its hostname."),
      limit: z.number().int().positive().max(2_000).default(500),
    }),
    execute: async ({ cwd, deployment, limit }) => {
      const context = await buildContext(ctx, cwd);
      const logs = await context.manager.deploymentBuildLogs(deployment, limit);
      if (logs.length === 0) return "No build logs available for this deployment.";
      return logs.map((line) => line.text).join("\n");
    },
  });
}
