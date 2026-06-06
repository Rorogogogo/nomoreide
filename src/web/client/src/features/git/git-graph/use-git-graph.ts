import { useCallback, useEffect, useMemo, useState } from "react";
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
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  // Switching commits clears the file/diff selection in one batched update so the
  // diff effect never fires with the previous commit's file path, and never falls
  // back to fetching the whole-commit diff (every file at once) while files load.
  const selectHash = useCallback((hash: string) => {
    setSelectedHash(hash);
    setFiles([]);
    setSelectedFile(null);
    setDiff("");
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void getGitGraph(limit)
      .then((next) => {
        if (!active) return;
        setCommits(next);
        if (next.length > 0 && !next.some((c) => c.hash === selectedHash)) {
          selectHash(next[0].hash);
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
      setFilesLoading(false);
      return;
    }
    let active = true;
    setFilesError(null);
    setFilesLoading(true);
    void getGitCommitFiles(selectedHash)
      .then((next) => {
        if (!active) return;
        setFiles(next);
        setSelectedFile(next[0]?.path ?? null);
      })
      .catch((caught) => {
        if (active) setFilesError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (active) setFilesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedHash]);

  useEffect(() => {
    // Per-file only: wait for a concrete file before fetching. Without a file
    // `git show <hash>` returns the entire commit diff, which we never display.
    if (!selectedHash || !selectedFile) {
      setDiff("");
      setDiffLoading(false);
      return;
    }
    let active = true;
    setDiffError(null);
    setDiffLoading(true);
    void getGitCommitDiff(selectedHash, selectedFile)
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
    setSelectedHash: selectHash,
    files,
    filesError,
    selectedFile,
    setSelectedFile,
    diff,
    // While the file list is still resolving there's no file to diff yet — keep the
    // panel in a loading state instead of flashing the empty "no changes" message.
    diffLoading: diffLoading || filesLoading,
    diffError,
    maxLanes,
    selectedCommit,
    loadMore: () => setLimit((n) => n + DEFAULT_LIMIT),
  };
}
