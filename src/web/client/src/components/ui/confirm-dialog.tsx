import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";

/**
 * App-styled replacement for `window.confirm`. Portals a modal with the same
 * overlay/card treatment as ComposerDialog, an icon, a message, and a
 * Cancel/Confirm pair. `tone` colors the confirm button (danger → destructive,
 * primary → success/merge). Escape and backdrop click both cancel.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  icon,
  loading = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: string;
  tone?: "default" | "danger" | "success";
  icon?: ReactNode;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !loading) {
        onCancel();
      }
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onCancel, loading]);

  const confirmVariant =
    tone === "danger" ? "destructive" : tone === "success" ? "success" : "default";

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: click-to-dismiss backdrop; Escape also cancels.
    <div
      className="fixed inset-0 z-[1000] grid place-items-center bg-black/35 px-4"
      onMouseDown={() => !loading && onCancel()}
    >
      <div
        aria-modal="true"
        className="flex w-full max-w-md flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="flex items-start gap-3 px-4 py-4">
          {icon ? (
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground [&_svg]:size-4">
              {icon}
            </div>
          ) : null}
          <div className="min-w-0 flex-1 space-y-1">
            <h2 className="text-sm font-semibold">{title}</h2>
            <div className="text-[13px] text-muted-foreground">{message}</div>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border bg-muted/30 px-4 py-3">
          <Button disabled={loading} onClick={onCancel} size="sm" type="button" variant="outline">
            {cancelLabel}
          </Button>
          <Button disabled={loading} onClick={onConfirm} size="sm" type="button" variant={confirmVariant}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
