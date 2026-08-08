import { useRef, useState, type ReactNode, type RefObject } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { LogEntry } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { AiContextTarget, type AiContextTargetDescriptor } from "../agent/context-menu/ai-context-menu";

export function LogSearchInput({
  onChange,
  value,
}: {
  onChange: (value: string) => void;
  value: string;
}) {
  const t = useT();
  return (
    <div className="relative block">
      <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        aria-label={t("services.log.search")}
        className="h-8 w-44 pl-7 text-xs"
        onChange={(event) => onChange(event.target.value)}
        placeholder={t("services.log.search")}
        value={value}
      />
    </div>
  );
}

export function LogViewer({
  className,
  containerRef,
  emptyText,
  logs,
  query,
  showTimestamps = true,
  wrapLines = true,
  getAiTarget,
}: {
  className?: string;
  containerRef: RefObject<HTMLDivElement | null>;
  emptyText: string;
  logs: LogEntry[];
  query: string;
  showTimestamps?: boolean;
  wrapLines?: boolean;
  /** Enables row selection and the app-level AI context-menu action. */
  getAiTarget?: (entries: LogEntry[]) => AiContextTargetDescriptor | undefined;
}) {
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const anchorRef = useRef<number | null>(null);

  function selectEntry(index: number, additive: boolean, range: boolean) {
    setSelectedIndices((current) => {
      if (range && anchorRef.current !== null) {
        const start = Math.min(anchorRef.current, index);
        const end = Math.max(anchorRef.current, index);
        return new Set(Array.from({ length: end - start + 1 }, (_, offset) => start + offset));
      }
      if (additive) {
        const next = new Set(current);
        if (next.has(index)) next.delete(index);
        else next.add(index);
        return next;
      }
      return new Set([index]);
    });
    anchorRef.current = index;
  }

  function selectedEntries(): LogEntry[] {
    const indices = selectedIndices.size ? [...selectedIndices].sort((a, b) => a - b) : [];
    return indices.map((index) => logs[index]).filter((entry): entry is LogEntry => Boolean(entry));
  }

  return (
    <div
      className={cn(
        "code-font-size h-full max-w-full overflow-auto bg-background font-mono text-[11px] leading-4 dark:bg-zinc-950",
        className,
      )}
      ref={containerRef}
      role="log"
    >
      {logs.length ? (
        logs.map((entry, index) => {
          const row = (
            <button
              className={cn(
                "group grid min-w-max w-full cursor-default appearance-none border-0 bg-transparent px-2 py-px text-left font-inherit transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                showTimestamps
                  ? "grid-cols-[6.25rem_minmax(420px,1fr)] gap-1"
                  : "grid-cols-[minmax(420px,1fr)]",
                selectedIndices.has(index) && "bg-muted/45",
                !selectedIndices.has(index) && entry.stream === "stderr"
                  ? "bg-red-50/70 text-red-800 hover:bg-red-100 dark:bg-red-950/35 dark:text-red-100 dark:hover:bg-red-900/45"
                  : !selectedIndices.has(index) && "text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:odd:bg-zinc-900/45",
              )}
              type="button"
              key={logEntryKey(entry, index)}
              aria-label={`Log line ${index + 1}`}
              onClick={(event) => selectEntry(index, event.metaKey || event.ctrlKey, event.shiftKey)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  selectEntry(index, event.metaKey || event.ctrlKey, event.shiftKey);
                }
              }}
              onContextMenu={() => {
                if (!selectedIndices.has(index)) selectEntry(index, false, false);
              }}
            >
              {showTimestamps ? (
                <span className="whitespace-nowrap border-r border-border/60 pr-1 text-muted-foreground dark:border-zinc-800 dark:text-zinc-500" title={entry.timestamp}>
                  {formatLogTime(entry.timestamp)}
                </span>
              ) : null}
              <span className={wrapLines ? "whitespace-pre-wrap break-words" : "whitespace-pre"}>
                {entry.stream === "stderr" ? (
                  <span className="mr-1 rounded bg-red-100 px-1 font-semibold uppercase text-red-700 dark:bg-red-500/15 dark:text-red-300 dark:ring-1 dark:ring-red-400/20">
                    stderr
                  </span>
                ) : null}
                {highlightText(entry.text, query)}
              </span>
            </button>
          );
          const target = getAiTarget?.(selectedEntries().length ? selectedEntries() : [entry]);
          return target ? <AiContextTarget key={logEntryKey(entry, index)} target={target}>{row}</AiContextTarget> : row;
        })
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

function logEntryKey(entry: LogEntry, index: number): string {
  return entry.cursor ?? `${entry.service}-${entry.timestamp}-${entry.stream}-${index}`;
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
