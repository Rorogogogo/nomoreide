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
        "h-full max-w-full overflow-auto font-mono text-[11px] leading-5",
        className,
      )}
      ref={containerRef}
      role="log"
    >
      {logs.length ? (
        logs.map((entry, index) => (
          <div
            className={cn(
              "grid min-w-max grid-cols-[168px_minmax(420px,1fr)] gap-2 border-b border-border/45 px-3 py-0.5",
              entry.stream === "stderr"
                ? "bg-red-50/70 text-red-800"
                : "bg-emerald-50/35 text-zinc-800",
            )}
            key={`${entry.timestamp}-${entry.stream}-${index}`}
          >
            <span className="text-muted-foreground">{entry.timestamp}</span>
            <span className="whitespace-pre-wrap break-words">
              {entry.stream === "stderr" ? (
                <span className="mr-2 rounded bg-red-100 px-1 font-semibold uppercase text-red-700">
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
        className="rounded bg-amber-200 px-0.5 text-amber-950"
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
