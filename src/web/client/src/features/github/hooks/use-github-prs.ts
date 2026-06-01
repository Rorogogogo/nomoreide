import { useEffect, useState } from "react";
import {
  getGitHubPR,
  getGitHubPRDiff,
  listGitHubPRs,
  type GitHubPR,
} from "@/lib/api";

export function useGitHubPRs(state: "open" | "closed" | "all" = "open") {
  const [prs, setPrs] = useState<GitHubPR[]>([]);
  const [loading, setLoading] = useState(true);
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
    void listGitHubPRs(state)
      .then((next) => {
        if (!active) return;
        setPrs(next);
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

  function refresh() {
    let active = true;
    setLoading(true);
    setError(null);
    void listGitHubPRs(state)
      .then((next) => { if (active) setPrs(next); })
      .catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : String(caught)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }

  return {
    prs,
    loading,
    error,
    selectedNumber,
    setSelectedNumber,
    selectedPR,
    diff,
    diffLoading,
    diffError,
    refresh,
  };
}
