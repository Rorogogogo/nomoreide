import { Check, RefreshCw } from "lucide-react";
import { headerActionClassName, headerActionIconClassName } from "@/components/header-action";
import { Tooltip } from "@/components/ui/tooltip";
import { useApiBusy } from "@/lib/api-activity";
import { useT, type Translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Where the shared refresh cycle is: `busy` while the dashboard payload and the
 * active page's own data are in flight, `done` for a moment after a manual
 * refresh lands, `error` when the last cycle failed.
 */
export type RefreshPhase = "idle" | "busy" | "done" | "error";

/** Coarse "how long since the last successful cycle", i18n-aware. */
function agoLabel(t: Translate, updatedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (seconds < 10) return t("action.refreshedJustNow");
  if (seconds < 60) return t("action.refreshedSecondsAgo", { n: seconds });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("action.refreshedMinutesAgo", { n: minutes });
  return t("action.refreshedHoursAgo", { n: Math.round(minutes / 60) });
}

/**
 * The header Refresh control doubles as the status light for the app-wide
 * refresh cycle — the 5s poll runs through the same path as a click, so the
 * icon spins on a slow auto-refresh and goes red when polling stops landing.
 */
export function HeaderRefreshButton({
  onClick,
  phase,
  updatedAt,
}: {
  onClick: () => void;
  phase: RefreshPhase;
  updatedAt: number | null;
}) {
  const t = useT();
  // Any API work counts, not just a refresh cycle: opening a PR diff or a
  // workflow's jobs is loading too, and the icon is where the app says so.
  // Only `idle` gives way — a failed cycle must keep showing red, and a manual
  // refresh's confirmation tick must not be cut short by a background fetch.
  const apiBusy = useApiBusy();
  const shown: RefreshPhase = phase === "idle" && apiBusy ? "busy" : phase;

  const label =
    shown === "busy"
      ? t("action.refreshing")
      : shown === "error"
        ? t("action.refreshFailed")
        : updatedAt
          ? agoLabel(t, updatedAt, Date.now())
          : t("action.refreshTitle");

  return (
    <Tooltip align="end" label={label}>
      <button
        aria-label={t("action.refresh")}
        aria-live="polite"
        className={headerActionClassName(
          shown === "error" ? "text-destructive hover:text-destructive" : undefined,
        )}
        onClick={onClick}
        type="button"
      >
        <span className={headerActionIconClassName()}>
          {shown === "done" ? (
            <Check className="text-emerald-500" />
          ) : (
            <RefreshCw className={cn(shown === "busy" && "animate-spin")} />
          )}
        </span>
      </button>
    </Tooltip>
  );
}
