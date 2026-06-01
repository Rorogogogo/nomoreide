import { useEffect, useState } from "react";
import {
  addGitHubIssueComment,
  getGitHubIssue,
  listGitHubIssueComments,
  listGitHubIssues,
  type GitHubComment,
  type GitHubIssue,
} from "@/lib/api";

export function useGitHubIssues(state: "open" | "closed" | "all" = "open") {
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [loading, setLoading] = useState(true);
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
    void listGitHubIssues(state)
      .then((next) => {
        if (!active) return;
        setIssues(next);
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

  function refresh() {
    let active = true;
    setLoading(true);
    void listGitHubIssues(state)
      .then((next) => { if (active) setIssues(next); })
      .catch(() => { /* silent */ })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }

  return {
    issues,
    loading,
    error,
    selectedNumber,
    setSelectedNumber,
    selectedIssue,
    comments,
    commentsLoading,
    commentError,
    submitting,
    addComment,
    refresh,
  };
}
