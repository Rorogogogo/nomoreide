import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { LinearDetail } from "./linear-detail";
import type { LinearIssue, LinearState } from "./linear-types";

/**
 * One task, over the board.
 *
 * **A modal here and a side pane in the list, deliberately.** The board wants
 * its full width — the columns are the thing you came for, and a detail pane
 * stealing a third of the screen pushes half of them off it. In a list the
 * opposite holds: you are scanning and reading in sequence, and a dialog you
 * must dismiss between rows adds a click per row. So each view keeps the shape
 * that suits how it is read, and `LinearDetail` is the same component in both.
 *
 * The frame follows `ConfirmDialog`: portal, dimmed backdrop, one card, escape
 * and backdrop-click to close. DESIGN.md allows the card precisely here — a
 * dialog is a genuinely floating object.
 */
export function LinearTaskDialog({
  busy,
  issue,
  onClose,
  onComment,
  onStateChange,
  states,
  t,
  taskAction,
}: {
  busy: boolean;
  issue: LinearIssue;
  onClose: () => void;
  onComment: (body: string) => Promise<boolean>;
  onStateChange: (state: LinearState) => void;
  states: LinearState[];
  t: (key: string) => string;
  taskAction?: (issue: LinearIssue) => ReactNode;
}) {
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: click-to-dismiss backdrop; Escape also closes.
    <div
      className="fixed inset-0 z-[1000] grid place-items-center bg-black/35 px-4 py-8"
      onMouseDown={onClose}
    >
      <div
        aria-label={issue.identifier}
        aria-modal="true"
        className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <LinearDetail
          busy={busy}
          issue={issue}
          onBack={onClose}
          onComment={onComment}
          onStateChange={onStateChange}
          states={states}
          t={t}
          taskAction={taskAction}
          trailing={
            <button
              aria-label={t("close")}
              className="shrink-0 rounded px-1 py-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onClose}
              type="button"
            >
              <X className="size-3.5" />
            </button>
          }
        />
      </div>
    </div>,
    document.body,
  );
}
