import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { cloneRepository } from "../../core/repo-onboard.js";
import { GitWorktreeManager } from "../../core/git-worktrees.js";
import { git, gitActions, stringify, type ToolContext } from "./context.js";

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
  "nomoreide_git_push",
  "nomoreide_git_clone",
  "nomoreide_git_register_repository",
  "nomoreide_git_select_repository",
  "nomoreide_git_worktrees",
  "nomoreide_git_create_worktree",
  "nomoreide_git_select_worktree",
  "nomoreide_git_prune_worktrees",
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
    name: "nomoreide_git_push",
    description:
      "Push the current branch to its remote (sets upstream on first push). Write op — does not force-push.",
    parameters: gitCwdSchema.extend({
      remote: z.string().min(1).optional().describe("Remote name (default origin)."),
    }),
    execute: async ({ cwd, remote }) => stringify(await gitActions(cwd).push({ remote })),
  });

  server.addTool({
    name: "nomoreide_git_clone",
    description:
      "Clone a remote Git repository (HTTPS or SSH/scp-style URL) into the managed repos dir and register it as a Git project. SSH uses the host's ssh-agent/keys; interactive credential prompts are disabled so private repos fail fast. Write op — creates a new local clone.",
    parameters: z.object({
      url: z.string().min(1).describe("Git remote URL (https:// or git@host:owner/repo.git)."),
    }),
    execute: async ({ url }) => {
      const config = await configStore.load();
      const githubToken = configStore.getGithubToken(config);
      const { name, clonePath } = await cloneRepository(url, undefined, githubToken);
      await configStore.registerGitRepository({ name, path: clonePath });
      return stringify({ name, path: clonePath });
    },
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

  server.addTool({
    name: "nomoreide_git_worktrees",
    description:
      "List the primary and linked worktrees for a Git repository, including branch, dirty, locked, and stale state.",
    parameters: gitCwdSchema,
    execute: async ({ cwd }) =>
      stringify(await new GitWorktreeManager(cwd ?? process.cwd()).list()),
  });

  server.addTool({
    name: "nomoreide_git_create_worktree",
    description:
      "Create an isolated managed worktree for a new or existing branch. Write op — creates a fresh directory without changing the current worktree.",
    parameters: gitCwdSchema.extend({
      branch: z.string().min(1).describe("New or existing local branch name."),
      createBranch: z.boolean().default(true),
      baseRef: z.string().min(1).optional().describe("Start point for a new branch."),
      projectName: z.string().min(1).optional().describe("Managed folder group name."),
    }),
    execute: async ({ cwd, branch, createBranch, baseRef, projectName }) =>
      stringify(
        await new GitWorktreeManager(cwd ?? process.cwd()).create({
          branch,
          createBranch,
          baseRef,
          projectName,
        }),
      ),
  });

  server.addTool({
    name: "nomoreide_git_select_worktree",
    description:
      "Select one registered project's worktree for Git review, new terminals, agents, snapshots, and GitHub workflows.",
    parameters: z.object({
      repository: z.string().min(1).describe("Registered NoMoreIDE project name."),
      path: z.string().min(1).describe("Path returned by nomoreide_git_worktrees."),
    }),
    execute: async ({ repository, path }) =>
      stringify(await configStore.selectGitWorktree(repository, path)),
  });

  server.addTool({
    name: "nomoreide_git_prune_worktrees",
    description:
      "Prune stale Git worktree administrative records. Does not delete a live worktree directory or branch.",
    parameters: gitCwdSchema,
    execute: async ({ cwd }) => {
      await new GitWorktreeManager(cwd ?? process.cwd()).prune();
      return stringify({ pruned: true });
    },
  });
}
