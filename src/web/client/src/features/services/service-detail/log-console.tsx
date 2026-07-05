import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronUp, Filter, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getLogSourceLogs, getServiceLogs, type LogEntry, type LogQuery } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n/en";
import { LogSearchInput, LogViewer, logEntryText } from "../log-viewer";
import { type LogTarget, useLogs } from "./use-logs";

/** Time windows pushed to the host as journalctl `--since` for source targets. */
const TIME_RANGES: { labelKey: TranslationKey; value: string }[] = [
  { labelKey: "services.log.range.live", value: "" },
  { labelKey: "services.log.range.15min", value: "15 min ago" },
  { labelKey: "services.log.range.hour", value: "1 hour ago" },
  { labelKey: "services.log.range.today", value: "today" },
  { labelKey: "services.log.range.24h", value: "1 day ago" },
  { labelKey: "services.log.range.7days", value: "7 days ago" },
];

type LevelFilter = "" | "warn" | "error";

/**
 * Presentational log console: search + errors-only + stream controls over a
 * colorized auto-scrolling viewer. Fully controlled so callers can reuse it for
 * a single service tab or a grid of independent panes.
 *
 * For source targets the search box, time range, and level are pushed down to
 * the host (server-side filtering over full history); for managed services the
 * search/errors-only filtering stays client-side over the captured buffer.
 */
export function LogConsole({
  target,
  query,
  setQuery,
  streaming,
  setStreaming,
  hideStdout,
  setHideStdout,
  fill = false,
  leading,
  trailing,
}: {
  target: LogTarget;
  query: string;
  setQuery: (value: string) => void;
  streaming: boolean;
  setStreaming: (value: boolean) => void;
  hideStdout: boolean;
  setHideStdout: (value: boolean) => void;
  /** Stretch to fill the parent height instead of capping at a fixed max. */
  fill?: boolean;
  /** Optional node rendered at the start of the control row (e.g. a picker). */
  leading?: ReactNode;
  /** Optional node pinned to the end of the control row (e.g. expand/remove). */
  trailing?: ReactNode;
}) {
  const t = useT();
  const isSource = target.kind === "source";
  const [since, setSince] = useState("");
  const [level, setLevel] = useState<LevelFilter>("");

  // Debounce the search box so each keystroke doesn't fire a server query.
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedQuery(query), 300);
    return () => window.clearTimeout(id);
  }, [query]);

  // Pushed down to the host for sources and ssh journald/docker services. Empty
  // (no active filters) means the target just serves its live tail/buffer.
  const serverQuery = useMemo<LogQuery>(() => {
    const next: LogQuery = {};
    if (since) next.since = since;
    if (level) next.level = level;
    const grep = debouncedQuery.trim();
    if (grep) next.grep = grep;
    return next;
  }, [since, level, debouncedQuery]);

  const { logs, error, queryable } = useLogs(target, streaming, serverQuery);
  // Whether the time-range / level / load-older controls apply to this target.
  const canQuery = isSource || queryable;
  const paneRef = useRef<HTMLDivElement | null>(null);
  const stickyBottomRef = useRef(true);

  // Older history pulled via "Load older", kept separate from the live tail and
  // prepended. Reset whenever the filters or target change (a fresh window).
  const [olderPages, setOlderPages] = useState<LogEntry[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const serverQueryKey = JSON.stringify(serverQuery);
  // Discard accumulated older pages when the filters or target change.
  useEffect(() => {
    setOlderPages([]);
  }, [serverQueryKey, target.kind, target.name]);

  // Merge older history ahead of the live tail, de-duped by journald cursor.
  const merged = useMemo(() => {
    const live = logs ?? [];
    if (olderPages.length === 0) return live;
    const seen = new Set(olderPages.map((entry) => entry.cursor).filter(Boolean));
    return [...olderPages, ...live.filter((entry) => !entry.cursor || !seen.has(entry.cursor))];
  }, [logs, olderPages]);

  // Oldest cursor in view; its presence means the source supports paging older.
  const oldestCursor = (olderPages[0] ?? (logs ?? [])[0])?.cursor;

  async function loadOlder() {
    if (!canQuery || !oldestCursor || loadingOlder) return;
    setLoadingOlder(true);
    stickyBottomRef.current = false; // don't yank to bottom after prepending
    try {
      const pageQuery = { ...serverQuery, before: oldestCursor, lines: 200 };
      const older =
        target.kind === "source"
          ? await getLogSourceLogs(target.name, pageQuery)
          : (await getServiceLogs(target.name, pageQuery)).logs;
      if (older.length) {
        setOlderPages((current) => {
          const seen = new Set(current.map((entry) => entry.cursor).filter(Boolean));
          const fresh = older.filter((entry) => !entry.cursor || !seen.has(entry.cursor));
          return [...fresh, ...current];
        });
      }
    } finally {
      setLoadingOlder(false);
    }
  }

  const normalizedQuery = query.trim().toLowerCase();
  const visibleLogs = useMemo(() => {
    let result = merged;
    if (hideStdout) result = result.filter((entry) => entry.stream === "stderr");
    if (normalizedQuery) {
      result = result.filter((entry) => logEntryText(entry).toLowerCase().includes(normalizedQuery));
    }
    return result;
  }, [merged, hideStdout, normalizedQuery]);

  // Track whether the user is pinned near the bottom so streaming can keep it pinned.
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const updateStickiness = () => {
      const distanceFromBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
      stickyBottomRef.current = distanceFromBottom < 40;
    };
    updateStickiness();
    pane.addEventListener("scroll", updateStickiness, { passive: true });
    return () => pane.removeEventListener("scroll", updateStickiness);
  }, []);

  useEffect(() => {
    if (!streaming || !stickyBottomRef.current || visibleLogs.length === 0) return;
    const pane = paneRef.current;
    if (pane) pane.scrollTop = pane.scrollHeight;
  }, [streaming, visibleLogs]);

  const emptyText = !logs
    ? t("common.loading")
    : normalizedQuery
      ? t("services.log.noMatch", { query: query.trim() })
      : hideStdout
        ? t("services.log.noStderr")
        : t("services.log.noEntries");

  return (
    <div className={fill ? "flex h-full min-h-0 flex-col gap-2" : "flex flex-col gap-2"}>
      <div className="flex flex-wrap items-center gap-2">
        {leading}
        <LogSearchInput onChange={setQuery} value={query} />
        {canQuery ? (
          <>
            <select
              aria-label={t("services.log.timeRange")}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
              onChange={(event) => setSince(event.target.value)}
              value={since}
            >
              {TIME_RANGES.map((range) => (
                <option key={range.labelKey} value={range.value}>
                  {t(range.labelKey)}
                </option>
              ))}
            </select>
            <select
              aria-label={t("services.log.level")}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
              onChange={(event) => setLevel(event.target.value as LevelFilter)}
              value={level}
            >
              <option value="">{t("services.log.allLevels")}</option>
              <option value="warn">{t("services.log.warningsPlus")}</option>
              <option value="error">{t("services.log.errors")}</option>
            </select>
          </>
        ) : (
          <ToggleButton
            active={hideStdout}
            activeClassName="border-amber-600 bg-amber-50 text-amber-700 dark:border-amber-400/40 dark:bg-amber-500/15 dark:text-amber-300"
            onClick={() => setHideStdout(!hideStdout)}
          >
            <Filter />
            {t("services.log.errorsOnly")}
          </ToggleButton>
        )}
        <ToggleButton
          active={streaming}
          activeClassName="border-emerald-600 bg-emerald-50 text-emerald-700 dark:border-emerald-400/40 dark:bg-emerald-500/15 dark:text-emerald-300"
          onClick={() => setStreaming(!streaming)}
        >
          <Radio />
          {streaming ? t("services.log.streaming") : t("services.log.stream")}
        </ToggleButton>
        {canQuery && oldestCursor ? (
          <Button
            disabled={loadingOlder}
            onClick={() => void loadOlder()}
            size="sm"
            type="button"
            variant="outline"
          >
            <ChevronUp />
            {loadingOlder ? t("common.loading") : t("services.log.loadOlder")}
          </Button>
        ) : null}
        {trailing ? <div className="ml-auto flex items-center gap-2">{trailing}</div> : null}
      </div>
      {error ? <div className="text-red-600">{error}</div> : null}
      <LogViewer
        className={cn("rounded border border-border/60", fill ? "min-h-0 flex-1" : "max-h-80")}
        containerRef={paneRef}
        emptyText={emptyText}
        logs={visibleLogs}
        query={query}
      />
    </div>
  );
}

export function ToggleButton({
  active,
  activeClassName,
  children,
  onClick,
}: {
  active: boolean;
  activeClassName: string;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Button
      aria-pressed={active}
      className={active ? activeClassName : undefined}
      onClick={onClick}
      size="sm"
      type="button"
      variant="outline"
    >
      {children}
    </Button>
  );
}
