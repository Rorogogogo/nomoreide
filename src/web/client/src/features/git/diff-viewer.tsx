import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

// Diffs whose individual lines run this long (data dumps: CSV, logs, minified
// blobs) are unreadable as a code diff and bog the layout down. Hide by default.
const LONG_LINE_THRESHOLD = 800;

type DiffRowKind = "add" | "delete" | "hunk" | "context" | "meta";

export interface DiffRow {
  content: string;
  hunkIndex: number | null;
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
  const [showAnyway, setShowAnyway] = useState(false);

  const longestLine = useMemo(
    () => rows.reduce((max, row) => Math.max(max, row.content.length), 0),
    [rows],
  );
  const isDataDump = longestLine > LONG_LINE_THRESHOLD;

  // Reset the "show anyway" override whenever the file/diff changes.
  useEffect(() => {
    setShowAnyway(false);
  }, [diff]);

  useEffect(() => {
    if (isDataDump && !showAnyway) return;
    const hunk = hunkRefs.current[activeHunkIndex];
    hunk?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [activeHunkIndex, diff, isDataDump, showAnyway]);

  if (isDataDump && !showAnyway) {
    const additions = rows.filter((row) => row.kind === "add").length;
    const deletions = rows.filter((row) => row.kind === "delete").length;
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-white p-6">
        <div className="max-w-sm space-y-3 text-center">
          <p className="text-[13px] font-medium text-foreground">
            Diff hidden for this data file
          </p>
          <p className="text-[12px] text-muted-foreground">
            Rows run up to {longestLine.toLocaleString()} characters, so this looks
            like a CSV, log, or other data dump rather than source code.
          </p>
          <p className="font-mono text-[11px]">
            <span className="text-emerald-700">+{additions}</span>{" "}
            <span className="text-red-700">-{deletions}</span> lines changed
          </p>
          <Button onClick={() => setShowAnyway(true)} size="sm" type="button" variant="outline">
            Show diff anyway
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 overflow-auto bg-white text-xs leading-6">
      <div className="min-w-full font-mono">
        {rows.map((row, index) => (
          <div
            className={cn(
              "grid grid-cols-[3rem_3rem_minmax(0,1fr)]",
              row.kind === "add" && "bg-emerald-50 text-emerald-800",
              row.kind === "delete" && "bg-red-50 text-red-800",
              scrollTargetRowForHunk(rows, index) &&
                row.hunkIndex === activeHunkIndex &&
                "outline outline-1 outline-offset-[-1px] outline-primary/35",
            )}
            key={`${index}-${row.content}`}
            ref={
              row.hunkIndex !== null && scrollTargetRowForHunk(rows, index)
                ? (node) => {
                    hunkRefs.current[row.hunkIndex ?? 0] = node;
                  }
                : undefined
            }
          >
            <LineNumber value={row.oldLine} />
            <LineNumber value={row.newLine} />
            <span className="min-w-0 whitespace-pre-wrap break-all px-2">{row.content || " "}</span>
          </div>
        ))}
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
  return rows.filter((row) => row.kind !== "meta" && row.kind !== "hunk");
}

export function buildDiffRows(diff: string): DiffRow[] {
  let oldLine: number | null = null;
  let newLine: number | null = null;
  let hunkIndex: number | null = null;

  return diff.split("\n").map((line) => {
    if (isDiffMetadata(line)) {
      oldLine = null;
      newLine = null;
      hunkIndex = null;
      return {
        content: line,
        hunkIndex,
        kind: "meta" as const,
        oldLine: null,
        newLine: null,
      };
    }

    if (line.startsWith("@@")) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
      }
      hunkIndex = (hunkIndex ?? -1) + 1;
      return {
        content: line,
        hunkIndex,
        kind: "hunk" as const,
        oldLine: null,
        newLine: null,
      };
    }

    if (oldLine === null || newLine === null) {
      return {
        content: line,
        hunkIndex: null,
        kind: "meta" as const,
        oldLine: null,
        newLine: null,
      };
    }

    if (line.startsWith("\\ No newline")) {
      return {
        content: line,
        hunkIndex,
        kind: "meta" as const,
        oldLine: null,
        newLine: null,
      };
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      const row = {
        content: line,
        hunkIndex,
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
        hunkIndex,
        kind: "delete" as const,
        oldLine,
        newLine: null,
      };
      oldLine += 1;
      return row;
    }

    const row = {
      content: line,
      hunkIndex,
      kind: "context" as const,
      oldLine,
      newLine,
    };
    oldLine += 1;
    newLine += 1;
    return row;
  });
}

function scrollTargetRowForHunk(rows: DiffRow[], index: number): boolean {
  const hunkIndex = rows[index]?.hunkIndex;
  if (hunkIndex === null) {
    return false;
  }

  const firstChangedRow = rows.findIndex(
    (row) =>
      row.hunkIndex === hunkIndex && (row.kind === "add" || row.kind === "delete"),
  );
  if (firstChangedRow !== -1) {
    return firstChangedRow === index;
  }

  return rows.findIndex((row) => row.hunkIndex === hunkIndex) === index;
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
