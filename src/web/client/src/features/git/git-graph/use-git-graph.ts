import { useEffect, useMemo, useState } from "react";
import {
  getGitCommitDiff,
  getGitCommitFiles,
  getGitGraph,
  type GitFileStatus,
  type GitGraphCommit,
} from "@/lib/api";

const DEFAULT_LIMIT = 200;

/**
 * Owns the commit-graph data: the commit list (paged by `limit`), the selected
 * commit's changed files, and the diff for the selected file. Each concern is a
 * self-contained effect; the view just renders what comes back.
 */
export function useGitGraph() {
  const [commits, setCommits] = useState<GitGraphCommit[]>([]);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [files, setFiles] = useState<GitFileStatus[]>([]);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void getGitGraph(limit)
      .then((next) => {
        if (!active) return;
        setCommits(next);
        if (next.length > 0 && !next.some((c) => c.hash === selectedHash)) {
          setSelectedHash(next[0].hash);
        }
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // selectedHash intentionally not in deps — we only want to seed it on first/refresh load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit]);

  useEffect(() => {
    if (!selectedHash) {
      setFiles([]);
      setSelectedFile(null);
      return;
    }
    let active = true;
    setFilesError(null);
    void getGitCommitFiles(selectedHash)
      .then((next) => {
        if (!active) return;
        setFiles(next);
        setSelectedFile(next[0]?.path ?? null);
      })
      .catch((caught) => {
        if (active) setFilesError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      active = false;
    };
  }, [selectedHash]);

  useEffect(() => {
    if (!selectedHash) {
      setDiff("");
      return;
    }
    let active = true;
    setDiffError(null);
    setDiffLoading(true);
    void getGitCommitDiff(selectedHash, selectedFile ?? undefined)
      .then((next) => {
        if (active) setDiff(next);
      })
      .catch((caught) => {
        if (active) setDiffError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (active) setDiffLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedHash, selectedFile]);

  const maxLanes = useMemo(
    () => commits.reduce((acc, c) => Math.max(acc, c.laneCount), 1),
    [commits],
  );

  const selectedCommit = commits.find((c) => c.hash === selectedHash) ?? null;

  return {
    commits,
    loading,
    error,
    selectedHash,
    setSelectedHash,
    files,
    filesError,
    selectedFile,
    setSelectedFile,
    diff,
    diffLoading,
    diffError,
    maxLanes,
    selectedCommit,
    loadMore: () => setLimit((n) => n + DEFAULT_LIMIT),
  };
}
