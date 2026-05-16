import { useEffect, useState } from "react";
import { getGitDiff, type DashboardData } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
    <div className="grid h-full min-h-0 gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col overflow-hidden pr-1">
        <ChangedFilesList
          branch={data.git.status?.branch || undefined}
          error={data.git.error}
          files={data.git.status?.files ?? []}
          selectedFile={selectedFile}
          onSelectFile={setSelectedFile}
        />
      </aside>

      <section className="min-h-0 min-w-0">
        <Card className="flex h-full min-w-0 flex-col">
          <CardHeader className="border-b border-border">
            <CardTitle className="truncate">{selectedFile || "Diff"}</CardTitle>
            <CardDescription>
              Long rows stay inside this pane and scroll left to right.
            </CardDescription>
          </CardHeader>
          <CardContent className="min-h-0 min-w-0 flex-1 p-4">
            {diffError ? (
              <Alert variant="destructive">
                {diffError}
              </Alert>
            ) : selectedFile ? (
              <DiffViewer diff={diff || "No unstaged diff for this file."} />
            ) : (
              <Alert variant="muted" className="border-dashed p-12 text-center">
                Select a changed file to inspect its diff.
              </Alert>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
