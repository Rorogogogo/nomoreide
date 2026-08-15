import { Terminal } from "lucide-react";
import {
  WidgetNote,
  WidgetStat,
  WidgetStats,
} from "@/features/home/widget-grid";
import type { WidgetDefinition, WidgetRenderProps } from "@/features/home/widget-types";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Output — the tail of a service's stdout, full width.
 *
 * Its own file rather than a fourth entry in `widgets.tsx` because it is the
 * one services widget that is neither counters nor rows: log text is verbatim
 * machine output and gets the terminal treatment, not the row treatment.
 *
 * The payload carries **one** service's tail — `logs` in `buildDashboardPayload`
 * reads the first registered service — so the panel names whose output this is
 * rather than implying it is the whole system's.
 */

/** Six lines is a glance. More is the Services page's log pane. */
const LINE_CAP = 6;

export const outputWidget: WidgetDefinition = {
  id: "output",
  titleKey: "home.widget.output",
  icon: <Terminal />,
  span: 12,
  scope: "global",
  page: "services",
  render: ({ data }) => <OutputSummary data={data} />,
};

function OutputSummary({ data }: WidgetRenderProps) {
  const t = useT();
  const lines = data.logs.slice(-LINE_CAP);

  if (lines.length === 0) {
    return <WidgetNote>{t("home.output.none")}</WidgetNote>;
  }

  const errors = data.logs.filter((line) => line.stream === "stderr").length;

  return (
    <>
      <WidgetStats>
        <WidgetStat label={t("home.output.source")} value={lines[0].service} />
        <WidgetStat label={t("home.output.lines")} value={data.logs.length} />
        <WidgetStat
          label={t("home.output.stderr")}
          tone={errors > 0 ? "bad" : "idle"}
          value={errors}
        />
      </WidgetStats>
      <span className="flex flex-col gap-0.5 overflow-hidden font-mono text-[10px] leading-relaxed">
        {lines.map((line) => (
          <span
            className="flex min-w-0 items-baseline gap-2"
            key={`${line.timestamp}:${line.text}`}
          >
            <span className="shrink-0 tabular-nums text-muted-foreground/60">
              {formatClock(line.timestamp)}
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                line.stream === "stderr" ? "text-red-500" : "text-foreground/80",
              )}
            >
              {line.text}
            </span>
          </span>
        ))}
      </span>
    </>
  );
}

/**
 * Wall-clock, not "3 minutes ago". Log lines are read as a sequence, and
 * relative stamps make two lines a second apart look identical.
 */
function formatClock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleTimeString(undefined, { hour12: false });
}
