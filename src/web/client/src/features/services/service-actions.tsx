import { useState, type ReactNode } from "react";
import { ExternalLink, Play, RotateCcw, Square, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToasts } from "@/components/ui/toast";
import {
  PortConflictResponseError,
  postForm,
  type PortConflictDetail,
} from "@/lib/api";
import { ComposerDialog } from "./service-forms";

export function LifecycleActions({
  active,
  baseUrl,
  onRefresh,
  restartAction,
  targetLabel,
}: {
  active: boolean;
  baseUrl: string;
  onRefresh: () => Promise<void>;
  restartAction?: () => Promise<void>;
  targetLabel: string;
}) {
  if (!active) {
    return (
      <ActionButton
        intent="start"
        icon={<Play />}
        label="Start"
        targetLabel={targetLabel}
        url={`${baseUrl}/start`}
        onRefresh={onRefresh}
      />
    );
  }

  return (
    <>
      <ActionButton
        intent="restart"
        icon={<RotateCcw />}
        label="Restart"
        action={restartAction}
        targetLabel={targetLabel}
        url={`${baseUrl}/restart`}
        onRefresh={onRefresh}
      />
      <ActionButton
        intent="stop"
        icon={<Square />}
        label="Stop"
        targetLabel={targetLabel}
        url={`${baseUrl}/stop`}
        onRefresh={onRefresh}
      />
    </>
  );
}

export function actionErrorMessage(
  label: string,
  targetLabel: string,
  caught: unknown,
): string {
  const message = caught instanceof Error ? caught.message : String(caught);
  return `${label} failed for ${targetLabel}: ${message}`;
}

function ActionButton({
  action,
  intent = "neutral",
  icon,
  label,
  targetLabel,
  url,
  onRefresh,
}: {
  action?: () => Promise<void>;
  intent?: "neutral" | "restart" | "start" | "stop";
  icon: ReactNode;
  label: string;
  targetLabel: string;
  url: string;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<PortConflictDetail | null>(null);
  const { error: showErrorToast, success: showSuccessToast } = useToasts();

  async function run(values: Record<string, string> = {}) {
    setBusy(true);
    try {
      if (action) {
        await action();
      } else {
        await postForm(url, values);
      }
      showSuccessToast(`${label} requested for ${targetLabel}.`);
      await onRefresh();
      setConflict(null);
    } catch (caught) {
      if (caught instanceof PortConflictResponseError) {
        setConflict(caught.conflict);
      } else {
        showErrorToast(actionErrorMessage(label, targetLabel, caught));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        className={actionButtonClass[intent]}
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => run()}
      >
        {icon}
        {label}
      </Button>
      {conflict ? (
        <PortConflictDialog
          busy={busy}
          conflict={conflict}
          onCancel={() => setConflict(null)}
          onKillAndStart={() => run({ strategy: "killHolder" })}
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
  const holder = conflict.holder;
  const browserUrl = `http://localhost:${conflict.port}/`;
  return (
    <ComposerDialog
      icon={<Zap />}
      onClose={busy ? () => undefined : onCancel}
      title={`Port ${conflict.port} is already in use`}
    >
      <div className="space-y-3 p-4 text-sm">
        <p>
          <span className="font-medium">{targetLabel}</span> wants port{" "}
          <span className="font-mono">{conflict.port}</span>, but it's already
          held by:
        </p>
        <pre className="overflow-auto whitespace-pre-wrap rounded border border-border bg-background p-3 font-mono text-xs">
          {holder
            ? `pid ${holder.pid}${holder.pgid ? ` (pgid ${holder.pgid})` : ""}\n${holder.command}`
            : "unknown process"}
        </pre>
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <Button onClick={onCancel} size="sm" type="button" variant="outline" disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => window.open(browserUrl, "_blank", "noopener,noreferrer")}
            size="sm"
            type="button"
            variant="outline"
            disabled={busy}
          >
            <ExternalLink />
            Open in browser
          </Button>
          <Button
            className="border-red-600 bg-red-600 text-white hover:bg-red-700"
            disabled={busy || !holder}
            onClick={onKillAndStart}
            size="sm"
            type="button"
          >
            Stop holder &amp; start
          </Button>
        </div>
      </div>
    </ComposerDialog>
  );
}

const actionButtonClass = {
  neutral: "",
  restart: "border-amber-600 bg-amber-600 text-white hover:bg-amber-700",
  start: "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700",
  stop: "border-red-600 bg-red-600 text-white hover:bg-red-700",
} satisfies Record<"neutral" | "restart" | "start" | "stop", string>;
