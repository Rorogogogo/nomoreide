import { Terminal } from "lucide-react";
import { useState } from "react";
import {
  WidgetNote,
  WidgetStat,
  WidgetStats,
  WidgetTab,
  WidgetTabs,
} from "@/features/home/widget-grid";
import type { WidgetDefinition, WidgetRenderProps } from "@/features/home/widget-types";
import type { LogEntry } from "@/lib/api/services-api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Logs — the tail of each service's stdout, one tab per service.
 *
 * Its own file rather than a fourth entry in `widgets.tsx` because it is the
 * one services widget that is neither counters nor rows: log text is verbatim
 * machine output and gets the terminal treatment, not the row treatment.
 *
 * It is also the one widget that declares `interactive`. A machine running two
 * services has two log streams, and no static panel can say which one you want
 * to read — that choice is the widget. See `interactive` in `widget-types.ts`
 * for why every other widget still may not hold a control.
 *
 * The payload carries every service's tail interleaved (`mergeServiceLogs` in
 * `web/dashboard.ts`), so switching tabs costs no request. It used to carry one
 * service, chosen by registration order, which is how two services started
 * 200ms apart ended up with one of them invisible.
 */

/** Six lines is a glance. More is the Services page's log pane. */
const LINE_CAP = 6;

export const outputWidget: WidgetDefinition = {
  id: "output",
  titleKey: "home.widget.output",
  icon: <Terminal />,
  span: 6,
  scope: "global",
  source: "dashboard",
  page: "services",
  interactive: true,
  render: ({ data }) => <OutputSummary data={data} />,
};

function OutputSummary({ data }: WidgetRenderProps) {
  const t = useT();
  const streams = groupByService(data.logs);
  const [picked, setPicked] = useState<string | null>(null);

  // A dash rather than a sentence: the panel title already says what is absent.
  if (streams.length === 0) return <WidgetNote>—</WidgetNote>;

  /* The pick is reconciled rather than stored back: a service can stop and drop
     out of the payload between polls, and a tab pointing at nothing should fall
     back to the liveliest stream instead of blanking the panel. */
  const active = streams.find((stream) => stream.service === picked) ?? streams[0];
  const errors = active.lines.filter((line) => line.stream === "stderr").length;

  return (
    <>
      {streams.length > 1 ? (
        <WidgetTabs>
          {streams.map((stream) => (
            <WidgetTab
              active={stream.service === active.service}
              key={stream.service}
              onSelect={() => setPicked(stream.service)}
            >
              {stream.service}
            </WidgetTab>
          ))}
        </WidgetTabs>
      ) : null}
      <WidgetStats>
        <WidgetStat label={t("home.output.source")} value={active.service} />
        <WidgetStat label={t("home.output.lines")} value={active.lines.length} />
        <WidgetStat label={t("home.output.stderr")} tone="bad" value={errors} />
      </WidgetStats>
      <span className="flex flex-col gap-0.5 overflow-hidden font-mono text-[10px] leading-relaxed">
        {active.lines.slice(-LINE_CAP).map((line) => (
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

interface ServiceStream {
  service: string;
  lines: LogEntry[];
}

/**
 * The interleaved payload, split back into one stream per service and ordered
 * by who spoke most recently.
 *
 * Recency rather than config order so the tab you want is the one already
 * selected — a service that just crashed should not be third in the row behind
 * two that have been quiet since boot.
 */
function groupByService(logs: LogEntry[]): ServiceStream[] {
  const byService = new Map<string, LogEntry[]>();
  for (const line of logs) {
    const lines = byService.get(line.service);
    if (lines) lines.push(line);
    else byService.set(line.service, [line]);
  }
  return [...byService.entries()]
    .map(([service, lines]) => ({ service, lines }))
    .sort((a, b) => {
      /* Newest first, and a genuine 0 when they tie: two services that booted
         in the same millisecond keep the order the payload gave them rather
         than swapping places between polls. */
      const left = a.lines.at(-1)?.timestamp ?? "";
      const right = b.lines.at(-1)?.timestamp ?? "";
      if (left === right) return 0;
      return left > right ? -1 : 1;
    });
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
