import { listGitHubWorkflowRuns, type GitHubWorkflowRun } from "@/lib/api";

/**
 * The open and collapsed dock surfaces can be mounted at the same time. Share
 * their latest-run request so one status chip does not double the GitHub API
 * traffic.
 */
const FRESH_FOR_MS = 25_000;

interface CacheEntry {
  fetchedAt: number;
  run: GitHubWorkflowRun | null;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<GitHubWorkflowRun | null>>();

export function fetchLatestWorkflowRun(
  repository: string,
  branch?: string,
): Promise<GitHubWorkflowRun | null> {
  const key = `${repository}:${branch ?? ""}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < FRESH_FOR_MS) {
    return Promise.resolve(cached.run);
  }

  const existing = inflight.get(key);
  if (existing) return existing;

  const request = listGitHubWorkflowRuns(branch, 1)
    .then((runs) => {
      const run = runs[0] ?? null;
      cache.set(key, { fetchedAt: Date.now(), run });
      return run;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}
