import { useEffect, useState } from "react";
import {
  addGitHubIssueComment,
  getGitHubIssue,
  listGitHubIssueComments,
  listGitHubIssues,
  type GitHubComment,
  type GitHubIssue,
} from "@/lib/api";

// Mirrors the server's `per_page`; a full page back means there may be more.
const PAGE_SIZE = 30;

export function useGitHubIssues(state: "open" | "closed" | "all" = "open") {
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<GitHubIssue | null>(null);
  const [comments, setComments] = useState<GitHubComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setPage(1);
    void listGitHubIssues(state, 1)
      .then((next) => {
        if (!active) return;
        setIssues(next);
        setHasMore(next.length === PAGE_SIZE);
        if (next.length > 0 && !next.some((i) => i.number === selectedNumber)) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  useEffect(() => {
    if (!selectedNumber) {
      setSelectedIssue(null);
      setComments([]);
      return;
    }
    let active = true;
    setCommentsLoading(true);
    void Promise.all([
      getGitHubIssue(selectedNumber),
      listGitHubIssueComments(selectedNumber),
    ])
      .then(([issue, c]) => {
        if (!active) return;
        setSelectedIssue(issue);
        setComments(c);
      })
      .catch(() => { /* silent */ })
      .finally(() => { if (active) setCommentsLoading(false); });
    return () => { active = false; };
  }, [selectedNumber]);

  async function addComment(body: string): Promise<void> {
    if (!selectedNumber) return;
    setSubmitting(true);
    setCommentError(null);
    try {
      const comment = await addGitHubIssueComment(selectedNumber, body);
      setComments((prev) => [...prev, comment]);
    } catch (caught) {
      setCommentError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  }

  function loadMore() {
    if (loadingMore || !hasMore) return;
    const nextPage = page + 1;
    setLoadingMore(true);
    void listGitHubIssues(state, nextPage)
      .then((next) => {
        setIssues((prev) => {
          const seen = new Set(prev.map((i) => i.number));
          return [...prev, ...next.filter((i) => !seen.has(i.number))];
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
    setPage(1);
    void listGitHubIssues(state, 1)
      .then((next) => {
        if (!active) return;
        setIssues(next);
        setHasMore(next.length === PAGE_SIZE);
      })
      .catch(() => { /* silent */ })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }

  return {
    issues,
    loading,
    loadingMore,
    hasMore,
    error,
    selectedNumber,
    setSelectedNumber,
    selectedIssue,
    comments,
    commentsLoading,
    commentError,
    submitting,
    addComment,
    loadMore,
    refresh,
  };
}
