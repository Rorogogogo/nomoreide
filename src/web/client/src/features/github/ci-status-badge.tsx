import { useEffect, useRef, useState } from "react";
import type { CommitCIStatus } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { fetchCiStatus, getCachedCiStatus } from "./ci-status-cache";

export function CiStatusBadge({ sha }: { sha: string }) {
  const t = useT();
  const [status, setStatus] = useState<CommitCIStatus | null>(
    () => getCachedCiStatus(sha) ?? null,
  );
  const anchorRef = useRef<HTMLSpanElement>(null);

  // Defer the fetch until the row scrolls into view — the commit tree mounts
  // every row at once, so eager fetching would stampede the GitHub API. The
  // shared cache/queue (fetchCiStatus) then throttles and dedupes the visible
  // burst. Anything already cached skips the observer entirely.
  useEffect(() => {
    if (status) return;
    const el = anchorRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    let active = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void fetchCiStatus(sha)
          .then((s) => { if (active) setStatus(s); })
          .catch(() => { /* silent — badge stays empty */ });
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => { active = false; observer.disconnect(); };
  }, [sha, status]);

  if (!status || status.state === "unknown" || status.totalCount === 0) {
    // Reserve the dot's footprint (transparent) so the observer has a stable
    // target to watch and resolving a badge doesn't shift the row's layout.
    return <span ref={anchorRef} aria-hidden className="inline-block size-2 shrink-0" />;
  }

  const dot = ciDotClass(status.state);
  const label = t("github.ci.badgeLabel", { state: status.state, count: status.totalCount });

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
