/**
 * Per-project summaries for the all-projects lens.
 *
 * The Git, GitHub, and Vercel pages each read the daemon's *selected*
 * repository, which is global state — so "show me all projects" cannot be
 * served by asking those pages nicely. Everything here resolves a project from
 * its own path instead and never touches `selectedGitRepository`, which is what
 * makes an overview possible without the act of looking changing what the rest
 * of the app is pointed at.
 *
 * One project failing is normal (no remote, no Vercel link, a token that does
 * not cover it), so a failure is carried on that project's own row rather than
 * failing the whole request.
 */

import type { ConfigStore } from "./config-store.js";
import { GitManager } from "./git-manager.js";
import { optionalGitHubContext } from "./github-context.js";
import { optionalProviderContext } from "./providers/registry.js";
import type { ProviderDeploymentState } from "./providers/deploy-provider.js";
import type { GitRepositoryDefinition } from "./types.js";

export type OverviewDomain = "git" | "github" | "vercel";

export interface ProjectGitSummary {
  branch: string;
  /** Files with any working-tree or index change, including untracked. */
  dirty: number;
  ahead: number;
  behind: number;
  upstream?: string;
}

export interface ProjectGitHubSummary {
  owner: string;
  repo: string;
  openPullRequests: number;
  /** CI on the default branch's head, when it could be read. */
  checks?: "success" | "failure" | "pending";
}

export interface ProjectVercelSummary {
  projectId: string;
  projectName: string;
  /** Absent when the project has never deployed. */
  state?: ProviderDeploymentState;
  url?: string;
  createdAt?: number;
}

export interface ProjectOverviewEntry {
  name: string;
  path: string;
  /** The worktree actually read, which may differ from `path`. */
  cwd: string;
  git?: ProjectGitSummary;
  github?: ProjectGitHubSummary;
  vercel?: ProjectVercelSummary;
  /** Why this project has no summary. Rendered on the card, not thrown. */
  error?: string;
}

/**
 * How many projects are summarized concurrently.
 *
 * Each GitHub row costs two API calls and each Vercel row up to three, so an
 * unbounded fan-out over a large workspace would burst straight into a rate
 * limit. Six keeps a realistic workspace responsive without doing that.
 */
const CONCURRENCY = 6;

export async function buildProjectOverview(
  configStore: ConfigStore,
  domain: OverviewDomain,
): Promise<ProjectOverviewEntry[]> {
  const config = await configStore.load();
  return mapWithLimit(config.gitRepositories, CONCURRENCY, (repository) =>
    summarize(configStore, repository, domain),
  );
}

async function summarize(
  configStore: ConfigStore,
  repository: GitRepositoryDefinition,
  domain: OverviewDomain,
): Promise<ProjectOverviewEntry> {
  const cwd = repository.activeWorktreePath ?? repository.path;
  const base = { name: repository.name, path: repository.path, cwd };
  try {
    switch (domain) {
      case "git":
        return { ...base, git: await gitOverview(cwd) };
      case "github":
        return { ...base, github: await githubOverview(configStore, cwd) };
      case "vercel":
        return { ...base, vercel: await vercelOverview(configStore, cwd) };
    }
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}

async function gitOverview(cwd: string): Promise<ProjectGitSummary> {
  const status = await new GitManager(cwd).status();
  return {
    branch: status.branch,
    dirty: status.files.length,
    ahead: status.ahead,
    behind: status.behind,
    upstream: status.upstream,
  };
}

async function githubOverview(configStore: ConfigStore, cwd: string): Promise<ProjectGitHubSummary> {
  const context = await optionalGitHubContext(configStore, cwd);
  if (!context) throw new Error("No GitHub repository resolves for this project.");

  const prs = await context.manager.listPRs("open");
  // CI is a nice-to-have on a card: a repo with no Actions, or a token without
  // the checks scope, should still show its PR count rather than an error.
  const checks = await context.manager
    .repoInfo()
    .then((info) => context.manager.getCommitChecks(info.default_branch ?? "HEAD"))
    .then((result) => normalizeChecks(result.state))
    .catch(() => undefined);

  return {
    owner: context.owner,
    repo: context.repo,
    openPullRequests: prs.length,
    checks,
  };
}

/** The card only distinguishes three outcomes; anything else reads as unknown. */
function normalizeChecks(state: string): ProjectGitHubSummary["checks"] {
  if (state === "success") return "success";
  if (state === "failure") return "failure";
  if (state === "pending" || state === "in_progress" || state === "queued") return "pending";
  return undefined;
}

async function vercelOverview(configStore: ConfigStore, cwd: string): Promise<ProjectVercelSummary> {
  const context = await optionalProviderContext("vercel", configStore, cwd);
  if (!context?.project) throw new Error("No Vercel project is linked to this project.");

  // Production only, and only the latest: the card answers "is what users see
  // healthy", not "what has been built lately".
  const [latest] = await context.provider.listDeployments({
    projectId: context.project.id,
    target: "production",
    limit: 1,
  });

  return {
    projectId: context.project.id,
    projectName: context.project.name,
    state: latest?.state,
    url: latest?.url ?? undefined,
    createdAt: latest?.createdAt,
  };
}

/**
 * `Promise.all` over a bounded worker pool, preserving input order. Workers
 * pull from a shared cursor, so a slow project delays only itself rather than
 * holding up a whole batch the way chunked `Promise.all` rounds would.
 */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await map(items[index] as T);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}
