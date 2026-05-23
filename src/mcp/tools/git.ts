import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { git, stringify, type ToolContext } from "./context.js";

export const GIT_TOOL_NAMES = [
  "nomoreide_git_status",
  "nomoreide_git_branches",
  "nomoreide_git_switch_branch",
  "nomoreide_git_create_branch",
  "nomoreide_git_fetch",
  "nomoreide_git_diff",
  "nomoreide_git_staged_diff",
  "nomoreide_git_log",
  "nomoreide_git_stage",
  "nomoreide_git_unstage",
  "nomoreide_git_commit",
  "nomoreide_git_register_repository",
  "nomoreide_git_select_repository",
] as const;

const gitCwdSchema = z.object({
  cwd: z.string().min(1).optional().describe("Git repository directory."),
});

const gitPathSchema = gitCwdSchema.extend({
  path: z.string().min(1).optional().describe("Optional file path."),
});

const gitBranchSchema = gitCwdSchema.extend({
  name: z.string().min(1).describe("Branch name."),
});

const gitPathsSchema = gitCwdSchema.extend({
  paths: z.array(z.string().min(1)).min(1),
});

export function registerGitTools(server: FastMCP, ctx: ToolContext): void {
  const { configStore } = ctx;

  server.addTool({
    name: "nomoreide_git_status",
    description: "Show safe Git branch and porcelain status for a repository.",
    parameters: gitCwdSchema,
    execute: async ({ cwd }) => stringify(await git(cwd).status()),
  });

  server.addTool({
    name: "nomoreide_git_diff",
    description: "Show unstaged Git diff for a repository or file.",
    parameters: gitPathSchema,
    execute: async ({ cwd, path }) => await git(cwd).diff(path),
  });

  server.addTool({
    name: "nomoreide_git_branches",
    description: "List local and remote Git branches for a repository.",
    parameters: gitCwdSchema,
    execute: async ({ cwd }) => stringify(await git(cwd).branches()),
  });

  server.addTool({
    name: "nomoreide_git_switch_branch",
    description: "Switch to a local branch, or track a remote branch.",
    parameters: gitBranchSchema,
    execute: async ({ cwd, name }) => await git(cwd).switchBranch(name),
  });

  server.addTool({
    name: "nomoreide_git_create_branch",
    description: "Create and switch to a new Git branch.",
    parameters: gitBranchSchema,
    execute: async ({ cwd, name }) => await git(cwd).createBranch(name),
  });

  server.addTool({
    name: "nomoreide_git_fetch",
    description: "Fetch and prune remote Git refs for a repository.",
    parameters: gitCwdSchema,
    execute: async ({ cwd }) => await git(cwd).fetch(),
  });

  server.addTool({
    name: "nomoreide_git_staged_diff",
    description: "Show staged Git diff for a repository or file.",
    parameters: gitPathSchema,
    execute: async ({ cwd, path }) => await git(cwd).stagedDiff(path),
  });

  server.addTool({
    name: "nomoreide_git_log",
    description: "Show recent Git commits.",
    parameters: gitCwdSchema.extend({
      limit: z.number().int().positive().max(50).optional(),
    }),
    execute: async ({ cwd, limit }) => stringify(await git(cwd).log(limit)),
  });

  server.addTool({
    name: "nomoreide_git_stage",
    description: "Stage explicit file paths.",
    parameters: gitPathsSchema,
    execute: async ({ cwd, paths }) => stringify(await git(cwd).stage(paths)),
  });

  server.addTool({
    name: "nomoreide_git_unstage",
    description: "Unstage explicit file paths.",
    parameters: gitPathsSchema,
    execute: async ({ cwd, paths }) => stringify(await git(cwd).unstage(paths)),
  });

  server.addTool({
    name: "nomoreide_git_commit",
    description: "Create a Git commit from currently staged changes.",
    parameters: gitCwdSchema.extend({
      message: z.string().min(1),
    }),
    execute: async ({ cwd, message }) => await git(cwd).commit(message),
  });

  server.addTool({
    name: "nomoreide_git_register_repository",
    description: "Register a named Git repository folder for NoMoreIDE.",
    parameters: z.object({
      name: z.string().min(1),
      path: z.string().min(1),
    }),
    execute: async (args) => stringify(await configStore.registerGitRepository(args)),
  });

  server.addTool({
    name: "nomoreide_git_select_repository",
    description: "Select the registered Git repository shown by NoMoreIDE.",
    parameters: z.object({
      name: z.string().min(1),
    }),
    execute: async ({ name }) =>
      stringify(await configStore.selectGitRepository(name)),
  });
}
