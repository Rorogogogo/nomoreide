import { useState, type ReactNode } from "react";
import { ExternalLink, Play, RotateCcw, Square, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOperations } from "@/components/operations/operation-context";
import { Tooltip } from "@/components/ui/tooltip";
import { useToasts } from "@/components/ui/toast";
import {
  PortConflictResponseError,
  postForm,
  restartService,
  startBundleProgressive,
  startService,
  stopBundle,
  stopService,
  type PortConflictDetail,
} from "@/lib/api";
import { openExternal } from "@/lib/tauri";
import { useT, type Translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ComposerDialog } from "./service-forms";

type LifecycleOp = "start" | "stop" | "restart";
export type ResourceKind = "service" | "bundle";

/**
 * Run a lifecycle op through the API seam (`startService` / `startBundle` / …)
 * so it works on both backends. The previous code POSTed straight to
 * `/api/…/start`, which 404s in the desktop app (no Node server). Bundles have
 * no restart endpoint, so we stop-then-start them.
 */
async function performLifecycle(
  op: LifecycleOp,
  kind: ResourceKind,
  name: string,
  /** Called after each service in a bundle starts, so the UI can refresh live. */
  onProgress?: () => Promise<void>,
): Promise<void> {
  if (kind === "bundle") {
    // Progressive start so services appear one-by-one (deps first) instead of
    // all flipping to "running" when the whole sequence finishes.
    if (op === "start") return startBundleProgressive(name, () => onProgress?.());
    if (op === "stop") return stopBundle(name);
    await stopBundle(name);
    await startBundleProgressive(name, () => onProgress?.());
    return;
  }
  if (op === "start") return startService(name);
  if (op === "stop") return stopService(name);
  return restartService(name);
}

export function LifecycleActions({
  active,
  baseUrl,
  compact = false,
  onRefresh,
  onStarted,
  resourceKind,
  resourceName,
  solidStart = false,
  targetLabel,
}: {
  active: boolean;
  /** HTTP base (`/api/services/x`); used only for the web-only port-conflict retry. */
  baseUrl: string;
  compact?: boolean | "widget";
  onRefresh: () => Promise<void>;
  /** Fired after a successful start, so the caller can select the started service. */
  onStarted?: () => void;
  resourceKind: ResourceKind;
  resourceName: string;
  /** Render the start button as a filled green button (used for groups). */
  solidStart?: boolean;
  targetLabel: string;
}) {
  const t = useT();
  if (!active) {
    const start = (
      <ActionButton
        baseUrl={baseUrl}
        compact={compact}
        intent={solidStart ? "startSolid" : "start"}
        icon={<Play />}
        label={t("common.start")}
        op="start"
        resourceKind={resourceKind}
        resourceName={resourceName}
        targetLabel={targetLabel}
        onRefresh={onRefresh}
        onSuccess={onStarted}
      />
    );
    return compact === "widget" ? (
      <span className="inline-flex size-5 shrink-0 items-center">{start}</span>
    ) : (
      start
    );
  }

  const activeActions = (
    <>
      <ActionButton
        baseUrl={baseUrl}
        compact={compact}
        intent="restart"
        icon={<RotateCcw />}
        label={t("common.restart")}
        op="restart"
        resourceKind={resourceKind}
        resourceName={resourceName}
        targetLabel={targetLabel}
        onRefresh={onRefresh}
        onSuccess={onStarted}
      />
      <ActionButton
        baseUrl={baseUrl}
        compact={compact}
        intent="stop"
        icon={<Square />}
        label={t("common.stop")}
        op="stop"
        resourceKind={resourceKind}
        resourceName={resourceName}
        targetLabel={targetLabel}
        onRefresh={onRefresh}
      />
    </>
  );
  return compact === "widget" ? (
    <span className="inline-flex shrink-0 items-center">{activeActions}</span>
  ) : (
    activeActions
  );
}

export function actionErrorMessage(
  t: Translate,
  label: string,
  targetLabel: string,
  caught: unknown,
): string {
  const message = caught instanceof Error ? caught.message : String(caught);
  return t("services.actions.failed", { label, target: targetLabel, message });
}

function ActionButton({
  baseUrl,
  compact = false,
  intent = "neutral",
  icon,
  label,
  op,
  resourceKind,
  resourceName,
  targetLabel,
  onRefresh,
  onSuccess,
}: {
  baseUrl: string;
  compact?: boolean | "widget";
  intent?: "neutral" | "restart" | "start" | "startSolid" | "stop";
  icon: ReactNode;
  label: string;
  op: LifecycleOp;
  resourceKind: ResourceKind;
  resourceName: string;
  targetLabel: string;
  onRefresh: () => Promise<void>;
  /** Fired after the action succeeds (e.g. select the service that was started). */
  onSuccess?: () => void;
}) {
  const t = useT();
  const [conflict, setConflict] = useState<PortConflictDetail | null>(null);
  const { error: showErrorToast, success: showSuccessToast } = useToasts();
  const { isPending, runOperation } = useOperations();
  const operationKey = `${resourceKind}:${resourceName}:${op}`;
  const busy = isPending(operationKey);

  async function run(killHolder = false) {
    await runOperation(
      {
        key: operationKey,
        label: t("services.actions.pending", { label, target: targetLabel }),
      },
      async () => {
        try {
          if (killHolder) {
            // Port conflicts are a Node-backend concept; force the holder kill via
            // the HTTP endpoint (the Rust backend does no port pre-check, so this
            // path is web-only and never reached in the desktop app).
            await postForm(`${baseUrl}/start`, { strategy: "killHolder" });
          } else {
            // Refresh after each service so a bundle start lights up progressively.
            await performLifecycle(op, resourceKind, resourceName, () => onRefresh());
          }
          showSuccessToast(t("services.actions.requested", { label, target: targetLabel }));
          await onRefresh();
          setConflict(null);
          onSuccess?.();
        } catch (caught) {
          if (caught instanceof PortConflictResponseError) {
            setConflict(caught.conflict);
          } else {
            showErrorToast(actionErrorMessage(t, label, targetLabel, caught));
          }
        }
      }
    );
  }

  const widget = compact === "widget";
  const button = (
    <Button
      aria-label={label}
      className={cn(
        actionButtonClass[intent],
        compact === true && "size-7",
        widget &&
          "size-5 rounded-sm border-0 bg-transparent p-0 text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-3",
        widget && widgetActionClass[intent],
      )}
      loading={busy}
      loadingLabel={t("services.actions.pending", { label, target: targetLabel })}
      onClick={() => void run()}
      size={compact ? "icon" : "sm"}
      variant="ghost"
    >
      {icon}
      {compact ? null : label}
    </Button>
  );

  return (
    <>
      {compact ? <Tooltip label={label}>{button}</Tooltip> : button}
      {conflict ? (
        <PortConflictDialog
          busy={busy}
          conflict={conflict}
          onCancel={() => setConflict(null)}
          onKillAndStart={() => run(true)}
          targetLabel={targetLabel}
        />
      ) : null}
    </>
  );
}

function PortConflictDialog({
  busy,
  conflict,
  onCancel,
  onKillAndStart,
  targetLabel,
}: {
  busy: boolean;
  conflict: PortConflictDetail;
  onCancel: () => void;
  onKillAndStart: () => void;
  targetLabel: string;
}) {
  const t = useT();
  const holder = conflict.holder;
  const browserUrl = `http://localhost:${conflict.port}/`;
  return (
    <ComposerDialog
      icon={<Zap />}
      onClose={busy ? () => undefined : onCancel}
      title={t("services.portConflict.title", { port: conflict.port })}
    >
      <div className="space-y-3 p-4 text-sm">
        <p>
          <span className="font-medium">{targetLabel}</span> {t("services.portConflict.wantsPort")}{" "}
          <span className="font-mono">{conflict.port}</span>
          {t("services.portConflict.heldBy")}
        </p>
        <pre className="overflow-auto whitespace-pre-wrap rounded border border-border bg-background p-3 font-mono text-xs">
          {holder
            ? `pid ${holder.pid}${holder.pgid ? ` (pgid ${holder.pgid})` : ""}\n${holder.command}`
            : t("services.portConflict.unknownProcess")}
        </pre>
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <Button onClick={onCancel} size="sm" type="button" variant="outline" disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => void openExternal(browserUrl)}
            size="sm"
            type="button"
            variant="outline"
            disabled={busy}
          >
            <ExternalLink />
            {t("services.portConflict.openBrowser")}
          </Button>
          <Button
            className="border-red-600 bg-red-600 text-white hover:bg-red-700"
            disabled={busy || !holder}
            onClick={onKillAndStart}
            size="sm"
            type="button"
          >
            {t("services.portConflict.stopHolderStart")}
          </Button>
        </div>
      </div>
    </ComposerDialog>
  );
}

const actionButtonClass = {
  neutral: "",
  restart: "border-amber-600 bg-amber-600 text-white hover:bg-amber-700",
  // Individual services: plain outline, no color.
  start: "",
  // Groups: filled green.
  startSolid: "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700",
  stop: "border-red-600 bg-red-600 text-white hover:bg-red-700",
} satisfies Record<"neutral" | "restart" | "start" | "startSolid" | "stop", string>;

/** Restrained semantic color keeps icon-only widget actions recognizable. */
const widgetActionClass = {
  neutral: "",
  restart:
    "text-amber-600/75 hover:bg-amber-500/10 hover:text-amber-600 focus-visible:text-amber-600 dark:text-amber-400/75 dark:hover:text-amber-400 dark:focus-visible:text-amber-400",
  start:
    "text-emerald-600/75 hover:bg-emerald-500/10 hover:text-emerald-600 focus-visible:text-emerald-600 dark:text-emerald-400/75 dark:hover:text-emerald-400 dark:focus-visible:text-emerald-400",
  startSolid:
    "text-emerald-600/75 hover:bg-emerald-500/10 hover:text-emerald-600 focus-visible:text-emerald-600 dark:text-emerald-400/75 dark:hover:text-emerald-400 dark:focus-visible:text-emerald-400",
  stop: "text-red-600/75 hover:bg-red-500/10 hover:text-red-600 focus-visible:text-red-600 dark:text-red-400/75 dark:hover:text-red-400 dark:focus-visible:text-red-400",
} satisfies Record<"neutral" | "restart" | "start" | "startSolid" | "stop", string>;
