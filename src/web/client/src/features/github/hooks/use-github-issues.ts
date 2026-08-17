import { useEffect, useState } from "react";
import {
  addGitHubIssueComment,
  getGitHubIssue,
  listGitHubIssueComments,
  listGitHubIssues,
  type GitHubComment,
  type GitHubIssue,
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

export function useGitHubIssues(state: "open" | "closed" | "all" = "open") {
  const scope = useGitHubScope();
  const listKey = githubCacheKey(scope, "issues", state);
  const selectionKey = githubCacheKey(scope, "issues", state, "selected");
  // Only used to seed the first render; the effects below re-seed on key change.
  const seedList = readGitHubCache<GitHubIssue[]>(listKey);

  const [issues, setIssues] = useState<GitHubIssue[]>(seedList ?? []);
  const [loading, setLoading] = useState(!seedList);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(seedList?.length === PAGE_SIZE);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(
    readGitHubCache<number>(selectionKey) ?? null,
  );
  const [selectedIssue, setSelectedIssue] = useState<GitHubIssue | null>(null);
  const [comments, setComments] = useState<GitHubComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    // Read the cache here rather than reusing `seedList`: the state filter can
    // change without a remount, and that has to swap in the other list's cache.
    const seeded = readGitHubCache<GitHubIssue[]>(listKey);
    setPage(1);
    setError(null);
    if (seeded) {
      setIssues(seeded);
      setHasMore(seeded.length === PAGE_SIZE);
      setLoading(false);
    } else {
      setIssues([]);
      setLoading(true);
    }
    void revalidateGitHubCache(listKey, () => listGitHubIssues(state, 1))
      .then((next) => {
        if (!active) return;
        setIssues(next);
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

  // Seeding the selection off `issues` rather than off the fetch covers both
  // paths: the synchronous cache seed and the request that follows it.
  useEffect(() => {
    if (issues.length === 0) return;
    setSelectedNumber((current) =>
      current && issues.some((issue) => issue.number === current)
        ? current
        : issues[0]?.number ?? null,
    );
  }, [issues]);

  // Remember which issue was open so returning to the tab lands where you left.
  useEffect(() => {
    if (selectedNumber) writeGitHubCache(selectionKey, selectedNumber);
  }, [selectedNumber, selectionKey]);

  useEffect(() => {
    if (!selectedNumber) {
      setSelectedIssue(null);
      setComments([]);
      return;
    }
    let active = true;
    const issueKey = githubCacheKey(scope, "issue", selectedNumber);
    const commentsKey = githubCacheKey(scope, "issue-comments", selectedNumber);
    const seededIssue = readGitHubCache<GitHubIssue>(issueKey);
    const seededComments = readGitHubCache<GitHubComment[]>(commentsKey);
    setSelectedIssue(seededIssue ?? null);
    setComments(seededComments ?? []);
    setCommentsLoading(!seededComments);
    void Promise.all([
      revalidateGitHubCache(issueKey, () => getGitHubIssue(selectedNumber)),
      revalidateGitHubCache(commentsKey, () => listGitHubIssueComments(selectedNumber)),
    ])
      .then(([issue, next]) => {
        if (!active) return;
        setSelectedIssue(issue);
        setComments(next);
      })
      .catch(() => { /* silent — the seeded values stay on screen */ })
      .finally(() => { if (active) setCommentsLoading(false); });
    return () => { active = false; };
  }, [scope, selectedNumber]);

  async function addComment(body: string): Promise<void> {
    if (!selectedNumber) return;
    setSubmitting(true);
    setCommentError(null);
    try {
      const comment = await addGitHubIssueComment(selectedNumber, body);
      const commentsKey = githubCacheKey(scope, "issue-comments", selectedNumber);
      setComments((prev) => {
        const next = [...prev, comment];
        // Write through, or leaving and returning would drop the new comment
        // back to whatever the last fetch saw.
        writeGitHubCache(commentsKey, next);
        return next;
      });
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
    // Deliberately uncached: the cache holds page 1 only, so `hasMore` can stay
    // a straight `length === PAGE_SIZE` test when a later visit seeds from it.
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
    setPage(1);
    // Nothing on screen yet means the spinner is the honest state; otherwise
    // the rows stay put and are replaced when the request lands.
    setLoading(issues.length === 0);
    void revalidateGitHubCache(listKey, () => listGitHubIssues(state, 1))
      .then((next) => {
        setIssues(next);
        setHasMore(next.length === PAGE_SIZE);
      })
      .catch(() => { /* silent */ })
      .finally(() => setLoading(false));
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
