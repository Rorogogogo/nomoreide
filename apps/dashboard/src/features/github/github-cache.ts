import { createContext, useContext } from "react";

/**
 * Cross-mount cache for the GitHub views.
 *
 * `app.tsx` renders `<GitHubView />` only while the GitHub page is open, so
 * navigating away unmounts the whole subtree and every hook's state with it.
 * Coming back used to mean an empty list, a spinner, and three chained round
 * trips to GitHub — the list, then the auto-selected PR, then its diff —
 * before anything was readable.
 *
 * Holding the last good response at module scope, the same trick
 * `ci-status-cache.ts` and `latest-action-cache.ts` already use for their own
 * narrow slices, lets a revisit paint immediately from cache and revalidate in
 * the background. Nothing here has a freshness window: a read is always served
 * from cache when present and always followed by a request, so the view is
 * stale only for as long as that request is in flight.
 */

interface CacheEntry {
  data: unknown;
  fetchedAt: number;
}

/**
 * Bounded because a cached PR diff can be large and the daemon's browser tab
 * lives for days. Insertion order is eviction order, and writes re-insert, so
 * the entry dropped is the least recently written.
 */
const MAX_ENTRIES = 120;

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();

/** The last good value for `key`, or undefined on a cold miss. */
export function readGitHubCache<T>(key: string): T | undefined {
  const entry = cache.get(key);
  return entry ? (entry.data as T) : undefined;
}

export function writeGitHubCache<T>(key: string, data: T): void {
  cache.delete(key);
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { data, fetchedAt: Date.now() });
}

/**
 * Run `load`, store the result under `key`, and share one in-flight request
 * between every caller asking for the same key — two panes mounting at once,
 * or a poll landing on top of a manual refresh, cost a single request.
 */
export function revalidateGitHubCache<T>(key: string, load: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const request = load()
    .then((data) => {
      writeGitHubCache(key, data);
      return data;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}

/** Drop everything. Exported for tests and for a full credential reset. */
export function clearGitHubCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * The repository this GitHub subtree is about.
 *
 * Every GitHub request resolves server-side against the daemon's selected
 * repository, so the client never names a repo in the URL — but the cache
 * outlives the remount that a project switch triggers, which is exactly why
 * each key has to carry the scope. Without it, switching projects would paint
 * the previous repo's pull requests.
 */
export const GitHubScopeContext = createContext<string>("");

export function useGitHubScope(): string {
  return useContext(GitHubScopeContext);
}

/** Build a cache key that can never collide across repositories. */
export function githubCacheKey(scope: string, ...parts: Array<string | number>): string {
  return [scope, ...parts].join(":");
}
