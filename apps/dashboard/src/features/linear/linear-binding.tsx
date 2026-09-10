import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { useLinearTasks } from "./use-linear-tasks";

/**
 * "Use for <repository>" — the repository's default Linear team and project.
 *
 * **It lives in the team menu, not the toolbar.** It used to be a "Link to
 * repository" button beside Refresh, which named no repository, showed no
 * state, and produced nothing visible when pressed: the only safe move was to
 * press it again forever. As a row under the team list it is read at the moment
 * the team is chosen, it names the repository it would apply to, and the tick
 * *is* the stored state rather than something you have to remember doing.
 *
 * What the binding buys, and why it is worth a control at all: the panel opens
 * on this team next time, `nomoreide linear` works without `--team`, and an
 * agent filing an issue from this checkout files it in the right place.
 */
export function BindingToggle({
  m,
  t,
}: {
  m: ReturnType<typeof useLinearTasks>;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const { binding, bound, busy, repository, team, teams } = m;
  const disabled = !repository || !team || busy;
  // The team this repository defaults to *today*, when that is not the one
  // being looked at. Nowhere else in the panel says so, and "unticked" alone
  // cannot distinguish "no default" from "a different one".
  const other =
    binding && !bound ? (teams.find((entry) => entry.id === binding.team)?.name ?? null) : null;

  return (
    // A real checkbox, visually replaced rather than imitated: it carries its
    // own checked state, label association and keyboard behaviour, which a
    // `role="checkbox"` button has to re-implement and usually gets wrong.
    <label
      className={cn(
        "flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left transition-colors",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-muted",
      )}
    >
      <input
        checked={bound}
        className="peer sr-only"
        disabled={disabled}
        onChange={() => void m.toggleBinding()}
        type="checkbox"
      />
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring",
          bound ? "border-foreground bg-foreground text-background" : "border-border",
        )}
      >
        {bound ? <Check className="size-2.5" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs">
          {repository ? t("useForRepo", { repository }) : t("useForNoRepo")}
        </span>
        <span className="mt-0.5 block text-[10px] leading-tight text-muted-foreground">
          {other ? t("useForCurrent", { team: other }) : t("useForRepoHint")}
        </span>
      </span>
    </label>
  );
}
