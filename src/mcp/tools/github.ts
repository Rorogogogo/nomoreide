import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { GitManager } from "../../core/git-manager.js";
import {
  GitHubManager,
  type GitHubPR,
  type GitHubIssue,
} from "../../core/github-manager.js";
import { stringify, type ToolContext } from "./context.js";

export const GITHUB_TOOL_NAMES = [
  "nomoreide_github_set_token",
  "nomoreide_github_list_prs",
  "nomoreide_github_get_pr",
  "nomoreide_github_get_pr_diff",
  "nomoreide_github_create_pr",
  "nomoreide_github_merge_pr",
  "nomoreide_github_list_issues",
  "nomoreide_github_get_issue",
  "nomoreide_github_list_issue_comments",
  "nomoreide_github_add_issue_comment",
  "nomoreide_github_create_issue",
  "nomoreide_github_get_commit_ci",
  "nomoreide_github_list_workflow_runs",
] as const;

const cwdSchema = z.object({
  cwd: z.string().min(1).optional().describe("Git repository directory. Defaults to selected repository."),
});

async function buildManager(
  ctx: ToolContext,
  cwd?: string,
): Promise<{ manager: GitHubManager; owner: string; repo: string }> {
  const config = await ctx.configStore.load();
  const token = ctx.configStore.getGithubToken(config);
  if (!token) {
    throw new Error("No GitHub token configured. Use nomoreide_github_set_token first.");
  }

  const gitCwd = cwd ?? process.cwd();
  const remoteUrl = await new GitManager(gitCwd).remoteUrl("origin");
  if (!remoteUrl) {
    throw new Error("No git remote 'origin' found in the repository.");
  }

  const parsed = GitHubManager.parseRemoteUrl(remoteUrl);
  if (!parsed) {
    throw new Error(`Could not parse GitHub remote URL: ${remoteUrl}`);
  }

  return {
    manager: new GitHubManager(token, parsed.owner, parsed.repo),
    owner: parsed.owner,
    repo: parsed.repo,
  };
}

export function registerGithubTools(server: FastMCP, ctx: ToolContext): void {
  const { configStore } = ctx;

  server.addTool({
    name: "nomoreide_github_set_token",
    description: "Store a GitHub Personal Access Token (PAT) for API access.",
    parameters: z.object({
      token: z.string().min(1).describe("GitHub PAT (ghp_...)."),
      host: z.string().min(1).default("github.com").describe("GitHub host (default: github.com)."),
    }),
    execute: async ({ token, host }) => {
      await configStore.setGithubToken(host, token);
      return `GitHub token stored for ${host}.`;
    },
  });

  server.addTool({
    name: "nomoreide_github_list_prs",
    description: "List pull requests for the active GitHub repository.",
    parameters: cwdSchema.extend({
      state: z.enum(["open", "closed", "all"]).default("open").describe("PR state filter."),
      page: z.number().int().positive().default(1),
    }),
    execute: async ({ cwd, state, page }) => {
      const { manager } = await buildManager(ctx, cwd);
      return stringify(await manager.listPRs(state, page));
    },
  });

  server.addTool({
    name: "nomoreide_github_get_pr",
    description: "Get details for a pull request including review status.",
    parameters: cwdSchema.extend({
      number: z.number().int().positive().describe("Pull request number."),
    }),
    execute: async ({ cwd, number }) => {
      const { manager } = await buildManager(ctx, cwd);
      return stringify(await manager.getPR(number));
    },
  });

  server.addTool({
    name: "nomoreide_github_get_pr_diff",
    description: "Get the unified diff for a pull request.",
    parameters: cwdSchema.extend({
      number: z.number().int().positive().describe("Pull request number."),
    }),
    execute: async ({ cwd, number }) => {
      const { manager } = await buildManager(ctx, cwd);
      return manager.getPRDiff(number);
    },
  });

  server.addTool({
    name: "nomoreide_github_create_pr",
    description: "Create a pull request on GitHub.",
    parameters: cwdSchema.extend({
      title: z.string().min(1).describe("PR title."),
      body: z.string().optional().describe("PR description (markdown)."),
      head: z.string().min(1).describe("Source branch name."),
      base: z.string().min(1).describe("Target branch (e.g. main)."),
      draft: z.boolean().default(false).describe("Create as draft PR."),
    }),
    execute: async ({ cwd, title, body, head, base, draft }) => {
      const { manager } = await buildManager(ctx, cwd);
      const pr: GitHubPR = await manager.createPR({ title, body, head, base, draft });
      return `Created PR #${pr.number}: ${pr.html_url}`;
    },
  });

  server.addTool({
    name: "nomoreide_github_merge_pr",
    description:
      "Merge a pull request (squash by default). Fails if GitHub reports the PR is not mergeable (conflicts, failing required checks, branch protection).",
    parameters: cwdSchema.extend({
      number: z.number().int().positive().describe("Pull request number."),
      method: z.enum(["merge", "squash", "rebase"]).default("squash").describe("Merge method."),
      commitTitle: z.string().optional().describe("Override the merge commit title."),
      commitMessage: z.string().optional().describe("Override the merge commit body."),
    }),
    execute: async ({ cwd, number, method, commitTitle, commitMessage }) => {
      const { manager } = await buildManager(ctx, cwd);
      return stringify(await manager.mergePR(number, { method, commitTitle, commitMessage }));
    },
  });

  server.addTool({
    name: "nomoreide_github_list_issues",
    description: "List issues for the active GitHub repository.",
    parameters: cwdSchema.extend({
      state: z.enum(["open", "closed", "all"]).default("open").describe("Issue state filter."),
      page: z.number().int().positive().default(1),
    }),
    execute: async ({ cwd, state, page }) => {
      const { manager } = await buildManager(ctx, cwd);
      return stringify(await manager.listIssues(state, page));
    },
  });

  server.addTool({
    name: "nomoreide_github_get_issue",
    description: "Get details for a GitHub issue.",
    parameters: cwdSchema.extend({
      number: z.number().int().positive().describe("Issue number."),
    }),
    execute: async ({ cwd, number }) => {
      const { manager } = await buildManager(ctx, cwd);
      return stringify(await manager.getIssue(number));
    },
  });

  server.addTool({
    name: "nomoreide_github_list_issue_comments",
    description: "List comments on a GitHub issue.",
    parameters: cwdSchema.extend({
      number: z.number().int().positive().describe("Issue number."),
    }),
    execute: async ({ cwd, number }) => {
      const { manager } = await buildManager(ctx, cwd);
      return stringify(await manager.listIssueComments(number));
    },
  });

  server.addTool({
    name: "nomoreide_github_add_issue_comment",
    description: "Add a comment to a GitHub issue or pull request.",
    parameters: cwdSchema.extend({
      number: z.number().int().positive().describe("Issue or PR number."),
      body: z.string().min(1).describe("Comment text (markdown)."),
    }),
    execute: async ({ cwd, number, body }) => {
      const { manager } = await buildManager(ctx, cwd);
      const comment = await manager.addIssueComment(number, body);
      return `Comment added: ${comment.html_url}`;
    },
  });

  server.addTool({
    name: "nomoreide_github_create_issue",
    description: "Create a new GitHub issue.",
    parameters: cwdSchema.extend({
      title: z.string().min(1).describe("Issue title."),
      body: z.string().optional().describe("Issue description (markdown)."),
    }),
    execute: async ({ cwd, title, body }) => {
      const { manager } = await buildManager(ctx, cwd);
      const issue: GitHubIssue = await manager.createIssue({ title, body });
      return `Created issue #${issue.number}: ${issue.html_url}`;
    },
  });

  server.addTool({
    name: "nomoreide_github_get_commit_ci",
    description: "Get CI check status for a commit SHA.",
    parameters: cwdSchema.extend({
      sha: z.string().min(7).describe("Commit SHA (full or abbreviated to ≥7 chars)."),
    }),
    execute: async ({ cwd, sha }) => {
      const { manager } = await buildManager(ctx, cwd);
      return stringify(await manager.getCommitChecks(sha));
    },
  });

  server.addTool({
    name: "nomoreide_github_list_workflow_runs",
    description: "List recent GitHub Actions workflow runs.",
    parameters: cwdSchema.extend({
      branch: z.string().optional().describe("Filter by branch name."),
      page: z.number().int().positive().default(1),
    }),
    execute: async ({ cwd, branch, page }) => {
      const { manager } = await buildManager(ctx, cwd);
      return stringify(await manager.listWorkflowRuns(branch, page));
    },
  });
}
