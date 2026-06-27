import { useState } from "react";
import { Eye, EyeOff, FolderOpen, Plus, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EnvRuntimeBanner } from "./env-runtime-banner";
import { EnvTable } from "./env-table";
import { FileBrowserDialog } from "./file-browser-dialog";
import { useServiceEnvRuntime } from "./use-service-env-runtime";
import { prettyJson, useServiceEnv } from "./use-service-env";

export function EnvTab({ serviceName }: { serviceName: string }) {
  const {
    files,
    selectedPath,
    setSelectedPath,
    loaded,
    loadingList,
    loadingFile,
    saving,
    dirty,
    error,
    addRow,
    removeRow,
    updateRow,
    updateText,
    save,
    pickFile,
  } = useServiceEnv(serviceName);
  const envRuntime = useServiceEnvRuntime(serviceName);
  const [revealAll, setRevealAll] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);

  async function saveAndRecheck() {
    await save();
    await envRuntime.refresh();
  }

  if (loadingList) {
    return <div className="text-muted-foreground">Loading…</div>;
  }
  if (error && !loaded) {
    return <div className="text-red-600">{error}</div>;
  }

  return (
    <div className="space-y-2">
      <EnvRuntimeBanner
        onReload={() => void envRuntime.reload()}
        reloading={envRuntime.reloading}
        runtime={envRuntime.runtime}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">File:</span>
          {files.length > 0 ? (
            <select
              className="rounded border border-border/60 bg-background px-1.5 py-0.5 font-mono text-xs"
              onChange={(event) => setSelectedPath(event.target.value)}
              value={selectedPath ?? ""}
            >
              {files.map((file) => (
                <option key={file.path} value={file.path}>
                  {file.relativePath} [{file.format}]
                </option>
              ))}
            </select>
          ) : (
            <span className="text-muted-foreground">none detected</span>
          )}
          <Button
            onClick={() => setBrowserOpen(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            <FolderOpen /> Browse files
          </Button>
          {loaded ? (
            <code className="rounded bg-background px-1.5 py-0.5 font-mono text-muted-foreground">
              {loaded.info.path}
            </code>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {loaded?.info.format === "env" ? (
            <>
              <Button onClick={() => setRevealAll((value) => !value)} size="sm" type="button" variant="outline">
                {revealAll ? <EyeOff /> : <Eye />}
                {revealAll ? "Hide secrets" : "Reveal secrets"}
              </Button>
              <Button onClick={addRow} size="sm" type="button" variant="outline">
                <Plus /> Add
              </Button>
            </>
          ) : null}
          <Button
            disabled={!dirty || saving || !loaded}
            onClick={() => void saveAndRecheck()}
            size="sm"
            type="button"
          >
            <Save /> {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      {error && !loaded ? (
        <div className="text-red-600">{error}</div>
      ) : loaded?.info.format === "env" && loaded.rows ? (
        <div className={cn(loadingFile && "opacity-60 transition-opacity")}>
          <EnvTable
            revealAll={revealAll}
            rows={loaded.rows}
            onAdd={addRow}
            onRemove={removeRow}
            onUpdate={updateRow}
          />
        </div>
      ) : loaded?.text !== undefined ? (
        <div className={cn("space-y-1", loadingFile && "opacity-60 transition-opacity")}>
          {loaded.info.format === "json" ? (
            <div className="flex justify-end">
              <Button
                onClick={() => updateText(prettyJson(loaded.text ?? ""))}
                size="sm"
                type="button"
                variant="outline"
              >
                Format JSON
              </Button>
            </div>
          ) : null}
          <textarea
            className="min-h-[300px] w-full rounded border border-border/60 bg-background p-2 font-mono text-[11px] leading-relaxed"
            onChange={(event) => updateText(event.target.value)}
            spellCheck={false}
            value={loaded.text}
          />
        </div>
      ) : loadingFile ? (
        <div className="text-muted-foreground">Loading file…</div>
      ) : null}
      {loaded ? (
        <p className="text-muted-foreground">
          {loaded.info.format === "env"
            ? "Comments and blank lines are preserved."
            : loaded.info.format === "json"
              ? "JSON is validated on save."
              : "YAML is saved as raw text."}{" "}
          The running process won't see changes until you restart it.
        </p>
      ) : null}
      {browserOpen ? (
        <FileBrowserDialog
          onClose={() => setBrowserOpen(false)}
          onPick={(relativePath) => {
            void pickFile(relativePath).then((ok) => {
              if (ok) setBrowserOpen(false);
            });
          }}
          serviceName={serviceName}
        />
      ) : null}
    </div>
  );
}
