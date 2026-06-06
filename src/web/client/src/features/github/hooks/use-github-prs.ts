import { useEffect, useState } from "react";
import {
  getGitHubPR,
  getGitHubPRDiff,
  listGitHubPRs,
  type GitHubPR,
} from "@/lib/api";

// Mirrors the server's `per_page`; a full page back means there may be more.
const PAGE_SIZE = 30;

export function useGitHubPRs(state: "open" | "closed" | "all" = "open") {
  const [prs, setPrs] = useState<GitHubPR[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [selectedPR, setSelectedPR] = useState<GitHubPR | null>(null);
  const [diff, setDiff] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setPage(1);
    void listGitHubPRs(state, 1)
      .then((next) => {
        if (!active) return;
        setPrs(next);
        setHasMore(next.length === PAGE_SIZE);
        if (next.length > 0 && !next.some((p) => p.number === selectedNumber)) {
          setSelectedNumber(next[0]?.number ?? null);
        }
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
    // selectedNumber intentionally omitted — only seed on list load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  useEffect(() => {
    if (!selectedNumber) {
      setSelectedPR(null);
      return;
    }
    let active = true;
    void getGitHubPR(selectedNumber)
      .then((pr) => { if (active) setSelectedPR(pr); })
      .catch(() => { /* list already has enough info */ });
    return () => { active = false; };
  }, [selectedNumber]);

  useEffect(() => {
    if (!selectedNumber) {
      setDiff("");
      return;
    }
    let active = true;
    setDiffLoading(true);
    setDiffError(null);
    void getGitHubPRDiff(selectedNumber)
      .then((text) => { if (active) setDiff(text); })
      .catch((caught) => {
        if (active) setDiffError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => { if (active) setDiffLoading(false); });
    return () => { active = false; };
  }, [selectedNumber]);

  function loadMore() {
    if (loadingMore || !hasMore) return;
    const nextPage = page + 1;
    setLoadingMore(true);
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
    let active = true;
    setLoading(true);
    setError(null);
    setPage(1);
    void listGitHubPRs(state, 1)
      .then((next) => {
        if (!active) return;
        setPrs(next);
        setHasMore(next.length === PAGE_SIZE);
      })
      .catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : String(caught)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
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
