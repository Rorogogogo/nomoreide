import { useEffect, useState } from "react";
import { ChevronUp, File as FileIcon, Folder, FolderOpen } from "lucide-react";
import { ComposerDialog } from "../service-forms";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  browseServiceConfig,
  type ConfigBrowseEntry,
  type ConfigBrowseResult,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

export function FileBrowserDialog({
  serviceName,
  onClose,
  onPick,
}: {
  serviceName: string;
  onClose: () => void;
  onPick: (relativePath: string) => void;
}) {
  const t = useT();
  const [data, setData] = useState<ConfigBrowseResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [path, setPath] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void (async () => {
      try {
        const result = await browseServiceConfig(serviceName, path);
        if (!cancelled) setData(result);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serviceName, path]);

  function enter(entry: ConfigBrowseEntry) {
    if (entry.kind === "directory") {
      setPath(entry.relativePath);
      return;
    }
    if (!entry.supported) return;
    onPick(entry.relativePath);
  }

  function goUp() {
    if (!data || data.isRoot) return;
    const rel = data.relativePath;
    const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    setPath(parent || undefined);
  }

  return (
    <ComposerDialog
      icon={<FolderOpen />}
      onClose={onClose}
      size="lg"
      title={t("services.fileBrowser.title")}
    >
      <div className="flex flex-col gap-2 p-4">
        <div className="flex items-center gap-2 text-xs">
          <Button
            disabled={!data || data.isRoot}
            onClick={goUp}
            size="sm"
            type="button"
            variant="outline"
          >
            <ChevronUp /> {t("services.fileBrowser.up")}
          </Button>
          <code className="truncate rounded bg-muted px-2 py-1 font-mono">
            {data?.relativePath || "./"}
          </code>
        </div>
        {error ? (
          <div className="text-red-600">{error}</div>
        ) : loading ? (
          <div className="text-muted-foreground">{t("common.loading")}</div>
        ) : !data || data.entries.length === 0 ? (
          <div className="text-muted-foreground">{t("services.fileBrowser.empty")}</div>
        ) : (
          <div className="max-h-[50vh] overflow-auto rounded border border-border/60">
            <ul className="divide-y divide-border/40">
              {data.entries.map((entry) => {
                const isDir = entry.kind === "directory";
                const clickable = isDir || entry.supported;
                return (
                  <li key={entry.relativePath}>
                    <button
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs",
                        clickable ? "hover:bg-muted" : "cursor-not-allowed text-muted-foreground",
                      )}
                      disabled={!clickable}
                      onClick={() => enter(entry)}
                      type="button"
                    >
                      {isDir ? <Folder size={14} /> : <FileIcon size={14} />}
                      <span className="flex-1 truncate font-mono">{entry.name}</span>
                      {!isDir && entry.format ? (
                        <Badge size="small" variant="secondary">
                          {entry.format}
                        </Badge>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {t("services.fileBrowser.hintPre")} <code>.env*</code>, <code>appsettings*.json</code>{" "}
          {t("services.fileBrowser.hintAnd")} <code>application*.yml</code>
          {t("services.fileBrowser.hintTail")}
        </p>
      </div>
    </ComposerDialog>
  );
}
