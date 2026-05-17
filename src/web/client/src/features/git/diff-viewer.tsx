import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

type DiffRowKind = "add" | "delete" | "hunk" | "context" | "meta";

export interface DiffRow {
  content: string;
  kind: DiffRowKind;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffStats {
  additions: number;
  deletions: number;
  hunks: number;
}

export function DiffViewer({
  activeHunkIndex = 0,
  diff,
}: {
  activeHunkIndex?: number;
  diff: string;
}) {
  const rows = visibleDiffRows(diff);
  const hunkRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    const hunk = hunkRefs.current[activeHunkIndex];
    hunk?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [activeHunkIndex, diff]);

  let hunkIndex = -1;

  return (
    <div className="h-full min-h-0 overflow-auto bg-white text-xs leading-6">
      <div className="min-w-max font-mono">
        {rows.map((row, index) => {
          if (row.kind === "hunk") {
            hunkIndex += 1;
          }
          const currentHunkIndex = hunkIndex;

          return (
            <div
              className={cn(
                "grid grid-cols-[3rem_3rem_minmax(40rem,1fr)]",
                row.kind === "add" && "bg-emerald-50 text-emerald-800",
                row.kind === "delete" && "bg-red-50 text-red-800",
                row.kind === "hunk" && "bg-muted text-muted-foreground",
                row.kind === "hunk" &&
                  currentHunkIndex === activeHunkIndex &&
                  "outline outline-1 outline-offset-[-1px] outline-primary/35",
              )}
              key={`${index}-${row.content}`}
              ref={
                row.kind === "hunk"
                  ? (node) => {
                      hunkRefs.current[currentHunkIndex] = node;
                    }
                  : undefined
              }
            >
              <LineNumber value={row.oldLine} />
              <LineNumber value={row.newLine} />
              <span className="whitespace-pre px-2">{row.content || " "}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function diffStats(diff: string): DiffStats {
  return diff.split("\n").reduce<DiffStats>(
    (stats, line) => {
      if (line.startsWith("@@")) {
        stats.hunks += 1;
      } else if (line.startsWith("+") && !line.startsWith("+++")) {
        stats.additions += 1;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        stats.deletions += 1;
      }
      return stats;
    },
    { additions: 0, deletions: 0, hunks: 0 },
  );
}

export function visibleDiffRows(diff: string): DiffRow[] {
  const rows = buildDiffRows(diff);
  if (!rows.some((row) => row.kind === "hunk")) {
    return rows;
  }
  return rows.filter((row) => row.kind !== "meta");
}

export function buildDiffRows(diff: string): DiffRow[] {
  let oldLine: number | null = null;
  let newLine: number | null = null;

  return diff.split("\n").map((line) => {
    if (isDiffMetadata(line)) {
      oldLine = null;
      newLine = null;
      return { content: line, kind: "meta" as const, oldLine: null, newLine: null };
    }

    if (line.startsWith("@@")) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
      }
      return { content: line, kind: "hunk" as const, oldLine: null, newLine: null };
    }

    if (oldLine === null || newLine === null) {
      return { content: line, kind: "meta" as const, oldLine: null, newLine: null };
    }

    if (line.startsWith("\\ No newline")) {
      return { content: line, kind: "meta" as const, oldLine: null, newLine: null };
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      const row = {
        content: line,
        kind: "add" as const,
        oldLine: null,
        newLine,
      };
      newLine += 1;
      return row;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      const row = {
        content: line,
        kind: "delete" as const,
        oldLine,
        newLine: null,
      };
      oldLine += 1;
      return row;
    }

    const row = {
      content: line,
      kind: "context" as const,
      oldLine,
      newLine,
    };
    oldLine += 1;
    newLine += 1;
    return row;
  });
}

function isDiffMetadata(line: string): boolean {
  return (
    line.startsWith("diff --git ") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("old mode ") ||
    line.startsWith("new mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ") ||
    line.startsWith("Binary files ")
  );
}

function LineNumber({ value }: { value: number | null }) {
  return (
    <span
      className={cn(
        "select-none border-r border-border/70 px-2 text-right text-muted-foreground",
        value === null && "text-transparent",
      )}
    >
      {value ?? "-"}
    </span>
  );
}
