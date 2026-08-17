import { useEffect, useState } from "react";
import {
  getGitHubPR,
  getGitHubPRDiff,
  listGitHubPRs,
  type GitHubPR,
} from "@/lib/api";
import {
  githubCacheKey,
  readGitHubCache,
  revalidateGitHubCache,
  useGitHubScope,
  writeGitHubCache,
} from "../github-cache";

// Mirrors the server's `per_page`; a full page back means there may be more.
const PAGE_SIZE = 30;

export function useGitHubPRs(state: "open" | "closed" | "all" = "open") {
  const scope = useGitHubScope();
  const listKey = githubCacheKey(scope, "prs", state);
  const selectionKey = githubCacheKey(scope, "prs", state, "selected");
  // Only used to seed the first render; the effects below re-seed on key change.
  const seedList = readGitHubCache<GitHubPR[]>(listKey);

  const [prs, setPrs] = useState<GitHubPR[]>(seedList ?? []);
  const [loading, setLoading] = useState(!seedList);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(seedList?.length === PAGE_SIZE);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(
    readGitHubCache<number>(selectionKey) ?? null,
  );
  const [selectedPR, setSelectedPR] = useState<GitHubPR | null>(null);
  const [diff, setDiff] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    // Read the cache here rather than reusing `seedList`: the state filter can
    // change without a remount, and that has to swap in the other list's cache.
    const seeded = readGitHubCache<GitHubPR[]>(listKey);
    setPage(1);
    setError(null);
    if (seeded) {
      setPrs(seeded);
      setHasMore(seeded.length === PAGE_SIZE);
      setLoading(false);
    } else {
      setPrs([]);
      setLoading(true);
    }
    void revalidateGitHubCache(listKey, () => listGitHubPRs(state, 1))
      .then((next) => {
        if (!active) return;
        setPrs(next);
        setHasMore(next.length === PAGE_SIZE);
      })
      .catch((caught) => {
        // A cached list stays on screen and keeps working; only a cold miss is
        // a hard error worth replacing the pane with.
        if (active && !seeded) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [listKey, state]);

  // Seeding the selection off `prs` rather than off the fetch covers both
  // paths: the synchronous cache seed and the request that follows it.
  useEffect(() => {
    if (prs.length === 0) return;
    setSelectedNumber((current) =>
      current && prs.some((pr) => pr.number === current) ? current : prs[0]?.number ?? null,
    );
  }, [prs]);

  // Remember which PR was open so returning to the tab lands where you left.
  useEffect(() => {
    if (selectedNumber) writeGitHubCache(selectionKey, selectedNumber);
  }, [selectedNumber, selectionKey]);

  useEffect(() => {
    if (!selectedNumber) {
      setSelectedPR(null);
      return;
    }
    let active = true;
    const detailKey = githubCacheKey(scope, "pr", selectedNumber);
    setSelectedPR(readGitHubCache<GitHubPR>(detailKey) ?? null);
    void revalidateGitHubCache(detailKey, () => getGitHubPR(selectedNumber))
      .then((pr) => { if (active) setSelectedPR(pr); })
      .catch(() => { /* list already has enough info */ });
    return () => { active = false; };
  }, [scope, selectedNumber]);

  useEffect(() => {
    if (!selectedNumber) {
      setDiff("");
      return;
    }
    let active = true;
    const diffKey = githubCacheKey(scope, "pr-diff", selectedNumber);
    const seeded = readGitHubCache<string>(diffKey);
    setDiff(seeded ?? "");
    setDiffError(null);
    setDiffLoading(!seeded);
    void revalidateGitHubCache(diffKey, () => getGitHubPRDiff(selectedNumber))
      .then((text) => { if (active) setDiff(text); })
      .catch((caught) => {
        if (active && !seeded) {
          setDiffError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => { if (active) setDiffLoading(false); });
    return () => { active = false; };
  }, [scope, selectedNumber]);

  function loadMore() {
    if (loadingMore || !hasMore) return;
    const nextPage = page + 1;
    setLoadingMore(true);
    // Deliberately uncached: the cache holds page 1 only, so `hasMore` can stay
    // a straight `length === PAGE_SIZE` test when a later visit seeds from it.
    void listGitHubPRs(state, nextPage)
      .then((next) => {
        setPrs((prev) => {
          const seen = new Set(prev.map((p) => p.number));
          return [...prev, ...next.filter((p) => !seen.has(p.number))];
        });
        setHasMore(next.length === PAGE_SIZE);
        setPage(nextPage);
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setLoadingMore(false));
  }

  function refresh() {
    setError(null);
    setPage(1);
    // Nothing on screen yet means the spinner is the honest state; otherwise
    // the rows stay put and are replaced when the request lands.
    setLoading(prs.length === 0);
    void revalidateGitHubCache(listKey, () => listGitHubPRs(state, 1))
      .then((next) => {
        setPrs(next);
        setHasMore(next.length === PAGE_SIZE);
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setLoading(false));
  }

  return {
    prs,
    loading,
    loadingMore,
    hasMore,
    error,
    selectedNumber,
    setSelectedNumber,
    selectedPR,
    diff,
    diffLoading,
    diffError,
    loadMore,
    refresh,
  };
}
