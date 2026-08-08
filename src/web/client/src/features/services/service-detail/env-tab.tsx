import { lazy, Suspense, useState } from "react";
import { Braces, Eye, EyeOff, FolderOpen, Plus, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { EnvRuntimeBanner } from "./env-runtime-banner";
import { EnvTable } from "./env-table";
import { FileBrowserDialog } from "./file-browser-dialog";
import { useServiceEnvRuntime } from "./use-service-env-runtime";
import { prettyJson, useServiceEnv } from "./use-service-env";
import "../../git/file-viewer-theme.css";

/**
 * The same CodeMirror editor the file viewer uses — `.env` gets a key/value
 * table, but JSON and YAML are structured text, and a bare textarea gave them
 * no highlighting, no bracket matching and no line numbers. Lazy for the same
 * reason it is there: CodeMirror is a large chunk, and most visits to this tab
 * are `.env` files that never load it.
 */
const CodeEditor = lazy(() =>
  import("../../git/code-editor").then((module) => ({ default: module.CodeEditor })),
);

export function EnvTab({ serviceName }: { serviceName: string }) {
  const t = useT();
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
    return <div className="text-muted-foreground">{t("common.loading")}</div>;
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
      {/*
        One control row, whatever the path length. The full path used to sit
        between the selector and the actions, so a deep path wrapped the row and
        stranded Save on a line of its own; it is now a caption underneath.
      */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="shrink-0 text-[12px] text-muted-foreground">
          {t("services.env.file")}
        </span>
        {files.length > 0 ? (
          <select
            className="min-w-0 rounded border border-border/60 bg-background px-1.5 py-0.5 font-mono text-[11px]"
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
          <span className="text-[12px] text-muted-foreground">
            {t("services.env.noneDetected")}
          </span>
        )}
        <Button
          onClick={() => setBrowserOpen(true)}
          size="icon-sm"
          title={t("services.env.browseFiles")}
          type="button"
          variant="ghost"
        >
          <FolderOpen />
        </Button>
        {/*
          Only Save is framed. Reveal, Add and Format are a toggle, a row-append
          and a rewrite of the buffer — the same weight as the controls below
          them, not the weight of the one action that writes the file.
        */}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {loaded?.info.format === "json" ? (
            <Button
              onClick={() => updateText(prettyJson(loaded.text ?? ""))}
              size="icon-sm"
              title={t("services.env.formatJson")}
              type="button"
              variant="ghost"
            >
              <Braces />
            </Button>
          ) : null}
          {loaded?.info.format === "env" ? (
            <>
              <Button
                onClick={() => setRevealAll((value) => !value)}
                size="icon-sm"
                title={revealAll ? t("services.env.hideSecrets") : t("services.env.revealSecrets")}
                type="button"
                variant="ghost"
              >
                {revealAll ? <EyeOff /> : <Eye />}
              </Button>
              <Button
                onClick={addRow}
                size="icon-sm"
                title={t("common.add")}
                type="button"
                variant="ghost"
              >
                <Plus />
              </Button>
            </>
          ) : null}
          <Button
            className="ml-1"
            disabled={!dirty || saving || !loaded}
            onClick={() => void saveAndRecheck()}
            size="sm"
            type="button"
          >
            <Save /> {saving ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      </div>
      {/* The selector above already names the file; this is the full location,
          so it reads as quiet caption rather than a second control. */}
      {loaded ? (
        <code className="block truncate font-mono text-[11px] text-muted-foreground">
          {loaded.info.path}
        </code>
      ) : null}
      {error && !loaded ? (
        <div className="text-[12px] text-red-600">{error}</div>
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
        <div
          className={cn(
            "h-[420px] overflow-hidden rounded border border-border/60",
            loadingFile && "opacity-60 transition-opacity",
          )}
        >
          <Suspense
            fallback={
              <div className="p-4 text-[12px] text-muted-foreground">{t("common.loading")}</div>
            }
          >
            <CodeEditor onChange={updateText} path={loaded.info.path} value={loaded.text} />
          </Suspense>
        </div>
      ) : loadingFile ? (
        <div className="text-[12px] text-muted-foreground">{t("services.env.loadingFile")}</div>
      ) : null}
      {loaded ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {loaded.info.format === "env"
            ? t("services.env.preservedEnv")
            : loaded.info.format === "json"
              ? t("services.env.validatedJson")
              : t("services.env.rawYaml")}{" "}
          {t("services.env.restartHint")}
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
