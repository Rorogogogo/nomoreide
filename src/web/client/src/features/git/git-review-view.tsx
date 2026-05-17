import { useEffect, useState } from "react";
import { getGitDiff, type DashboardData } from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { DiffViewer } from "./diff-viewer";
import { ChangedFilesList } from "./changed-files-list";

export function GitReviewView({
  data,
}: {
  data: DashboardData;
}) {
  const [selectedFile, setSelectedFile] = useState(data.git.status?.files[0]?.path ?? "");
  const [diff, setDiff] = useState("");
  const [diffError, setDiffError] = useState<string | null>(null);

  useEffect(() => {
    const firstFile = data.git.status?.files[0]?.path ?? "";
    setSelectedFile((current) =>
      current && data.git.status?.files.some((file) => file.path === current)
        ? current
        : firstFile,
    );
  }, [data.git.status?.files]);

  useEffect(() => {
    if (!selectedFile) {
      setDiff("");
      return;
    }

    let active = true;
    setDiffError(null);
    void getGitDiff(selectedFile)
      .then((nextDiff) => {
        if (active) setDiff(nextDiff);
      })
      .catch((caught) => {
        if (active) setDiffError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      active = false;
    };
  }, [selectedFile]);

  return (
    <div className="grid h-full min-h-0 overflow-hidden border-0 bg-card/85 xl:grid-cols-[320px_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col overflow-hidden">
        <ChangedFilesList
          branch={data.git.status?.branch || undefined}
          error={data.git.error}
          files={data.git.status?.files ?? []}
          selectedFile={selectedFile}
          onSelectFile={setSelectedFile}
        />
      </aside>

      <section className="flex min-h-0 min-w-0 flex-col border-l border-border bg-white">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-1.5">
          <div className="min-w-0">
            <h2 className="truncate text-[13px] font-semibold tracking-tight">
              {selectedFile || "Diff"}
            </h2>
            <p className="text-[10px] text-muted-foreground">
              Long rows scroll horizontally inside the editor pane.
            </p>
          </div>
        </div>
        <div className="min-h-0 min-w-0 flex-1">
          {diffError ? (
            <div className="p-4">
              <Alert variant="destructive">{diffError}</Alert>
            </div>
          ) : selectedFile ? (
            <DiffViewer diff={diff || "No unstaged diff for this file."} />
          ) : (
            <div className="p-4">
              <Alert variant="muted" className="border-dashed p-12 text-center">
                Select a changed file to inspect its diff.
              </Alert>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
