import type { ReactNode, RefObject } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { LogEntry } from "@/lib/api";
import { cn } from "@/lib/utils";

export function LogSearchInput({
  onChange,
  value,
}: {
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="relative block">
      <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        aria-label="Search logs"
        className="h-8 w-44 pl-7 text-xs"
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search logs"
        value={value}
      />
    </label>
  );
}

export function LogViewer({
  className,
  containerRef,
  emptyText,
  logs,
  query,
}: {
  className?: string;
  containerRef: RefObject<HTMLDivElement | null>;
  emptyText: string;
  logs: LogEntry[];
  query: string;
}) {
  return (
    <div
      className={cn(
        "code-font-size h-full max-w-full overflow-auto bg-background font-mono leading-5 dark:bg-zinc-950",
        className,
      )}
      ref={containerRef}
      role="log"
    >
      {logs.length ? (
        logs.map((entry, index) => (
          <div
            className={cn(
              "grid min-w-max grid-cols-[88px_minmax(420px,1fr)] gap-2 border-b border-border/45 px-3 py-0.5 dark:border-zinc-800/80",
              entry.stream === "stderr"
                ? "bg-red-50/70 text-red-800 dark:bg-red-950/35 dark:text-red-100"
                : "bg-emerald-50/35 text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:odd:bg-zinc-900/45",
            )}
            key={`${entry.timestamp}-${entry.stream}-${index}`}
          >
            <span className="text-muted-foreground dark:text-zinc-500" title={entry.timestamp}>
              {formatLogTime(entry.timestamp)}
            </span>
            <span className="whitespace-pre-wrap break-words">
              {entry.stream === "stderr" ? (
                <span className="mr-2 rounded bg-red-100 px-1 font-semibold uppercase text-red-700 dark:bg-red-500/15 dark:text-red-300 dark:ring-1 dark:ring-red-400/20">
                  stderr
                </span>
              ) : null}
              {highlightText(entry.text, query)}
            </span>
          </div>
        ))
      ) : (
        <div className="p-3 text-muted-foreground">{emptyText}</div>
      )}
    </div>
  );
}

/**
 * Compact a full ISO timestamp down to `HH:MM:SS.mmm` for the log gutter. The
 * date and microsecond precision are noise when scanning a live tail (and the
 * full value stays available via the cell's title tooltip + search). Falls back
 * to the raw string if it isn't a parseable timestamp.
 */
function formatLogTime(timestamp: string): string {
  const match = /T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?/.exec(timestamp);
  if (!match) return timestamp;
  return match[2] ? `${match[1]}.${match[2]}` : match[1];
}

export function logEntryText(entry: LogEntry): string {
  return `${entry.timestamp} ${entry.stream} ${entry.text}`;
}

function highlightText(text: string, query: string): ReactNode {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return text;

  const lowerText = text.toLowerCase();
  const lowerQuery = trimmedQuery.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let matchIndex = lowerText.indexOf(lowerQuery);

  while (matchIndex !== -1) {
    if (matchIndex > cursor) {
      parts.push(text.slice(cursor, matchIndex));
    }
    const nextCursor = matchIndex + trimmedQuery.length;
    parts.push(
      <mark
        className="rounded bg-amber-200 px-0.5 text-amber-950 dark:bg-amber-400/20 dark:text-amber-200"
        key={`${matchIndex}-${nextCursor}`}
      >
        {text.slice(matchIndex, nextCursor)}
      </mark>,
    );
    cursor = nextCursor;
    matchIndex = lowerText.indexOf(lowerQuery, cursor);
  }

  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }

  return parts;
}
