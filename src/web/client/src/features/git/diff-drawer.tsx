import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { getGitDiff } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { DiffViewer, diffStats } from "./diff-viewer";

/**
 * Read-only diff overlay opened from the multi-repo board. The board stays an
 * overview — clicking a file peeks its diff here without leaving the columns.
 */
export function DiffDrawer({
  repo,
  file,
  onClose,
}: {
  repo: string;
  file: string;
  onClose: () => void;
}) {
  const t = useT();
  const [diff, setDiff] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void getGitDiff(file, repo)
      .then((next) => {
        if (active) setDiff(next);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [repo, file]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const stats = diffStats(diff);

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex justify-end">
      <button
        aria-label={t("git.diff.closeAria")}
        className="absolute inset-0 bg-black/35"
        onClick={onClose}
        type="button"
      />
      <div className="relative z-10 flex h-full w-[min(900px,calc(100vw-3rem))] flex-col bg-card shadow-xl">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2">
          <div className="min-w-0">
            <h2 className="truncate text-[13px] font-semibold tracking-tight">{file}</h2>
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <span className="font-mono">{repo}</span>
              {stats.additions || stats.deletions ? (
                <span className="flex items-center gap-1 font-mono">
                  <span className="text-emerald-700">+{stats.additions}</span>
                  <span className="text-red-700">-{stats.deletions}</span>
                </span>
              ) : null}
            </div>
          </div>
          <Button aria-label={t("git.diff.closeAria")} onClick={onClose} size="icon" variant="ghost">
            <X />
          </Button>
        </div>
        <div className="relative min-h-0 min-w-0 flex-1">
          {error ? (
            <div className="p-4">
              <Alert variant="destructive">{error}</Alert>
            </div>
          ) : loading ? (
            <div className="p-4 text-xs text-muted-foreground">{t("git.diff.loading")}</div>
          ) : (
            <DiffViewer diff={diff || t("git.noUnstagedDiff")} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
