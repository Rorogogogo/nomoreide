import { Alert } from "@/components/ui/alert";
import type { GitGraphCommit } from "@/lib/api";
import { DiffViewer } from "../diff-viewer";

export function CommitDiffPanel({
  selectedCommit,
  selectedFile,
  diff,
  diffLoading,
  diffError,
}: {
  selectedCommit: GitGraphCommit | null;
  selectedFile: string | null;
  diff: string;
  diffLoading: boolean;
  diffError: string | null;
}) {
  return (
    <section className="flex min-h-0 min-w-0 flex-col bg-white border-b border-border">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-1.5">
        <div className="min-w-0">
          <h2 className="truncate text-[13px] font-semibold tracking-tight">
            {selectedFile ?? (selectedCommit ? selectedCommit.subject : "Commit")}
          </h2>
          {selectedCommit ? (
            <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
              <span className="font-mono">{selectedCommit.hash.slice(0, 12)}</span>
              <span>
                {selectedCommit.author} &lt;{selectedCommit.email}&gt;
              </span>
              <span>
                {new Date(selectedCommit.timestamp * 1000).toLocaleString()}
              </span>
            </div>
          ) : null}
        </div>
      </div>
      <div className="relative min-h-0 min-w-0 flex-1">
        {diffError ? (
          <div className="p-4">
            <Alert variant="destructive">{diffError}</Alert>
          </div>
        ) : selectedCommit ? (
          diffLoading ? (
            <div className="p-4 text-[12px] text-muted-foreground">Loading diff…</div>
          ) : diff ? (
            <DiffViewer activeHunkIndex={0} diff={diff} />
          ) : (
            <div className="p-4">
              <Alert variant="muted" className="border-dashed p-6 text-center">
                {selectedCommit.parents.length > 1
                  ? "Merge commit with no conflict resolution — no diff against the first parent."
                  : "No textual changes in this commit."}
              </Alert>
            </div>
          )
        ) : (
          <div className="p-4">
            <Alert variant="muted" className="border-dashed p-12 text-center">
              Select a commit to inspect its diff.
            </Alert>
          </div>
        )}
      </div>
    </section>
  );
}
