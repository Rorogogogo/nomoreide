import { Play, RotateCcw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";

export type BulkAction = "start" | "stop" | "restart";

/**
 * Start / restart / stop for the whole list, in the rail heading beside the
 * other list-wide controls.
 *
 * These used to live in a kebab menu, which cost two clicks and hid the labels
 * behind a glyph that says nothing about what is in it. They are not a row of
 * their own either — DESIGN.md forbids stacking a second header bar on a
 * panel, and a whole line of permanent chrome to hold one button is more than
 * it is worth. So the constructive action carries its label into the space the
 * heading was already wasting, and stop rides along as an icon — it is the one
 * action whose square is read without a word next to it.
 *
 * Nothing here is framed. An outline button would be the only border in the
 * strip, which reads as a panel of its own rather than as the toolbar it is;
 * the hairline at the end does that job instead, grouping the list-wide
 * lifecycle apart from the view controls (graph, logs, add) beside it.
 *
 * Which buttons appear follows the list's state, because the others are not
 * merely unnecessary, they are wrong: nothing is running, so there is nothing
 * to stop or restart; everything is running, so "start all" is a no-op. A
 * partly-running list keeps start (bring the rest up) and stop (take it all
 * down) — a blanket restart there is exactly those two in sequence, so it
 * earns no button of its own.
 */
export function ServiceBulkActions({
  busy,
  onRun,
  runningCount,
  total,
}: {
  /** The action currently running, so its button can show progress. */
  busy: BulkAction | null;
  onRun: (action: BulkAction) => void;
  runningCount: number;
  total: number;
}) {
  const t = useT();
  if (total === 0) return null;

  const allRunning = runningCount === total;
  const primary = allRunning
    ? ({
        action: "restart",
        icon: <RotateCcw className="text-amber-600" />,
        label: t("services.bulk.restart"),
        title: t("services.restartAll"),
      } as const)
    : ({
        action: "start",
        icon: <Play className="text-emerald-600" />,
        label: t("services.bulk.start"),
        title: t("services.startAll"),
      } as const);

  return (
    <>
      <Button
        // Every bulk run walks the dependency graph one service at a time, so
        // both buttons are out of action until it finishes, not just the one
        // that started it.
        className="h-7 min-w-0 max-w-40 shrink gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground [&_svg]:size-3"
        disabled={busy !== null && busy !== primary.action}
        loading={busy === primary.action}
        onClick={() => onRun(primary.action)}
        size="sm"
        title={primary.title}
        type="button"
        variant="ghost"
      >
        {primary.icon}
        <span className="truncate">{primary.label}</span>
      </Button>
      {runningCount === 0 ? null : (
        <Button
          aria-label={t("services.stopAll")}
          className="size-7"
          disabled={busy !== null && busy !== "stop"}
          loading={busy === "stop"}
          onClick={() => onRun("stop")}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <Tooltip label={t("services.stopAll")} side="bottom">
            <Square aria-hidden="true" className="size-3.5 text-destructive" />
          </Tooltip>
        </Button>
      )}
      <span aria-hidden="true" className="mx-0.5 h-3 w-px shrink-0 bg-border" />
    </>
  );
}
