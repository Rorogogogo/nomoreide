import type { FastMCP } from "fastmcp";
import { z } from "zod";
import {
  cloneRepository,
  defaultReposDir,
  proposeDatabases,
  proposeServices,
  scanRepo,
} from "../../core/repo-onboard.js";
import { stringify, type ToolContext } from "./context.js";

export const ONBOARD_TOOL_NAMES = ["nomoreide_onboard_repo"] as const;

/**
 * The "agent interprets" half of the hybrid onboarding flow. The tool does the
 * deterministic clone + scan and hands back a structured profile plus heuristic
 * proposals; the agent reads it, decides, then finalises with the existing
 * `nomoreide_register_service` + `nomoreide_start_service` tools.
 */
export function registerOnboardTools(server: FastMCP, _ctx: ToolContext): void {
  server.addTool({
    name: "nomoreide_onboard_repo",
    description:
      "Clone a Git repository from a URL and scan it into a structured profile (manifests, Dockerfile/compose, env keys, README excerpt) plus heuristic service proposals (each with an installCommand hint) and database proposals (Postgres/MySQL detected from compose images, each with a ready connection url). To onboard a repo end-to-end: call this, pick the best proposal, run its install command in the returned clonePath, then nomoreide_register_service (cwd = clonePath), nomoreide_git_register_repository, register any detected databases with nomoreide_register_database, and nomoreide_start_service. This tool only clones + analyzes; it does not register, install, or run anything itself.",
    parameters: z.object({
      url: z
        .string()
        .min(1)
        .describe("Git repository URL (https or ssh, e.g. https://github.com/owner/repo)."),
    }),
    execute: async ({ url }) => {
      const { clonePath } = await cloneRepository(url, defaultReposDir());
      const profile = await scanRepo(clonePath);
      const proposals = proposeServices(profile);
      const databases = proposeDatabases(profile);
      return stringify({ profile, proposals, databases });
    },
  });
}
