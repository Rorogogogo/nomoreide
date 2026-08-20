import { getCommitCIStatus, type CommitCIStatus } from "@/lib/api";

/**
 * Shared, throttled fetcher for per-commit CI status.
 *
 * The commit tree renders one badge per commit; without coordination each badge
 * fires its own request on mount, flooding the GitHub API (and its rate limit)
 * with hundreds of simultaneous calls. This module funnels every badge through a
 * single cache + concurrency gate so at most `MAX_CONCURRENT` requests are in
 * flight, identical SHAs are deduped, and resolved results are reused across
 * re-renders and tab switches.
 */

const MAX_CONCURRENT = 5;

const cache = new Map<string, CommitCIStatus>();
const inflight = new Map<string, Promise<CommitCIStatus>>();
const queue: Array<() => void> = [];
let active = 0;

function pump(): void {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift();
    if (job) {
      active++;
      job();
    }
  }
}

export function getCachedCiStatus(sha: string): CommitCIStatus | undefined {
  return cache.get(sha);
}

export function fetchCiStatus(sha: string): Promise<CommitCIStatus> {
  const cached = cache.get(sha);
  if (cached) return Promise.resolve(cached);

  const existing = inflight.get(sha);
  if (existing) return existing;

  const promise = new Promise<CommitCIStatus>((resolve, reject) => {
    queue.push(() => {
      getCommitCIStatus(sha)
        .then((status) => {
          // Cache terminal results; let "pending" re-fetch so it can update.
          if (status.state !== "pending") cache.set(sha, status);
          resolve(status);
        })
        .catch(reject)
        .finally(() => {
          active--;
          inflight.delete(sha);
          pump();
        });
    });
  });
  inflight.set(sha, promise);
  pump();
  return promise;
}
