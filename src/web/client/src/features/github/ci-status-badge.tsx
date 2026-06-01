import { useEffect, useState } from "react";
import { getCommitCIStatus, type CommitCIStatus } from "@/lib/api";

export function CiStatusBadge({ sha }: { sha: string }) {
  const [status, setStatus] = useState<CommitCIStatus | null>(null);

  useEffect(() => {
    let active = true;
    void getCommitCIStatus(sha)
      .then((s) => { if (active) setStatus(s); })
      .catch(() => { /* silent — badge stays absent */ });
    return () => { active = false; };
  }, [sha]);

  if (!status || status.state === "unknown" || status.totalCount === 0) return null;

  const dot = ciDotClass(status.state);
  const label = `CI: ${status.state} (${status.totalCount} check${status.totalCount !== 1 ? "s" : ""})`;

  return (
    <span
      aria-label={label}
      className={`shrink-0 size-2 rounded-full ${dot}`}
      title={label}
    />
  );
}

function ciDotClass(state: CommitCIStatus["state"]): string {
  switch (state) {
    case "success": return "bg-emerald-500";
    case "pending": return "bg-amber-400 animate-pulse";
    case "failure": return "bg-red-500";
    case "error": return "bg-orange-500";
    default: return "bg-zinc-400";
  }
}
