import { useState, type ReactNode } from "react";
import { Play, RotateCcw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToasts } from "@/components/ui/toast";
import { postForm } from "@/lib/api";

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
  const { error: showErrorToast, success: showSuccessToast } = useToasts();
  return (
    <Button
      className={actionButtonClass[intent]}
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          if (action) {
            await action();
          } else {
            await postForm(url, {});
          }
          showSuccessToast(`${label} requested for ${targetLabel}.`);
          await onRefresh();
        } catch (caught) {
          showErrorToast(actionErrorMessage(label, targetLabel, caught));
        } finally {
          setBusy(false);
        }
      }}
    >
      {icon}
      {label}
    </Button>
  );
}

const actionButtonClass = {
  neutral: "",
  restart: "border-amber-600 bg-amber-600 text-white hover:bg-amber-700",
  start: "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700",
  stop: "border-red-600 bg-red-600 text-white hover:bg-red-700",
} satisfies Record<"neutral" | "restart" | "start" | "stop", string>;
