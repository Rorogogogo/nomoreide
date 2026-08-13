import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { selectedProviderCwd } from "../../core/providers/project-resolution.js";
import {
  deployProviderManifests,
  requireProviderContext,
  type ProviderContext,
} from "../../core/providers/registry.js";
import { stringify, type ToolContext } from "./context.js";

/**
 * Read-only deploy-provider tools.
 *
 * Four tools with a `provider` parameter, deliberately **not** four tools per
 * provider: the tool list is already 70+, and per-provider tools would be the
 * fastest way to make it unusable.
 *
 * Also deliberately no redeploy/cancel/promote/rollback: those live behind
 * `DeployProviderActions` and are reachable only from the dashboard, where a
 * human clicked the button. An agent can diagnose a failed deploy here — read
 * its state, its commit, and its build logs — but cannot ship one.
 */
export const PROVIDER_TOOL_NAMES = [
  "nomoreide_deploy_list_projects",
  "nomoreide_deploy_list_deployments",
  "nomoreide_deploy_get_deployment",
  "nomoreide_deploy_logs",
] as const;

const DEFAULT_PROVIDER = "vercel";

const baseSchema = z.object({
  provider: z
    .string()
    .min(1)
    .optional()
    .describe(
      `Deploy provider id. Defaults to "${DEFAULT_PROVIDER}". Registered: ${deployProviderManifests()
        .map((manifest) => manifest.id)
        .join(", ")}.`,
    ),
  cwd: z
    .string()
    .min(1)
    .optional()
    .describe("Git repository directory. Defaults to selected repository."),
});

async function buildContext(
  ctx: ToolContext,
  provider?: string,
  cwd?: string,
): Promise<ProviderContext> {
  const config = await ctx.configStore.load();
  return requireProviderContext(
    provider ?? DEFAULT_PROVIDER,
    ctx.configStore,
    cwd ?? selectedProviderCwd(config, process.cwd()),
  );
}

/** Deployment reads need a linked project; say which knob fixes it when there isn't one. */
function requireProject(context: ProviderContext): string {
  if (!context.project) {
    throw new Error(
      "No project is linked to this repository. Link it with the provider's CLI, or pick one in the NoMoreIDE deploy tab.",
    );
  }
  return context.project.id;
}

export function registerProviderTools(server: FastMCP, ctx: ToolContext): void {
  server.addTool({
    name: "nomoreide_deploy_list_projects",
    description:
      "List deploy-provider projects for the connected account or team, and which one the current repository deploys.",
    parameters: baseSchema.extend({
      search: z.string().min(1).optional().describe("Filter projects by name."),
    }),
    execute: async ({ provider, cwd, search }) => {
      const context = await buildContext(ctx, provider, cwd);
      return stringify({
        linkedProjectId: context.project?.id ?? null,
        projects: await context.provider.listProjects({ search }),
      });
    },
  });

  server.addTool({
    name: "nomoreide_deploy_list_deployments",
    description:
      "List recent deployments for the repository's linked project, newest first. Use this to check whether a deploy succeeded.",
    parameters: baseSchema.extend({
      target: z
        .enum(["production", "preview"])
        .optional()
        .describe("Filter by environment. Omit for both."),
      limit: z.number().int().positive().max(100).default(20),
    }),
    execute: async ({ provider, cwd, target, limit }) => {
      const context = await buildContext(ctx, provider, cwd);
      return stringify(
        await context.provider.listDeployments({
          projectId: requireProject(context),
          target,
          limit,
        }),
      );
    },
  });

  server.addTool({
    name: "nomoreide_deploy_get_deployment",
    description:
      "Get one deployment's state, target, aliases, commit, and error message (if it failed).",
    parameters: baseSchema.extend({
      deployment: z.string().min(1).describe("Deployment id or its hostname."),
    }),
    execute: async ({ provider, cwd, deployment }) => {
      const context = await buildContext(ctx, provider, cwd);
      return stringify(await context.provider.getDeployment(deployment));
    },
  });

  server.addTool({
    name: "nomoreide_deploy_logs",
    description:
      "Read build logs for a deployment — the output to diagnose a failed build.",
    parameters: baseSchema.extend({
      deployment: z.string().min(1).describe("Deployment id or its hostname."),
      limit: z.number().int().positive().max(2_000).default(500),
    }),
    execute: async ({ provider, cwd, deployment, limit }) => {
      const context = await buildContext(ctx, provider, cwd);
      const logs = await context.provider.buildLogs(deployment, limit);
      if (logs.length === 0) return "No build logs available for this deployment.";
      return logs.map((line) => line.text).join("\n");
    },
  });
}
