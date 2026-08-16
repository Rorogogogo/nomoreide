import { Terminal } from "lucide-react";
import { useState } from "react";
import {
  rowCap,
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
import { OutputGraph } from "./output-graph";
import { useHomeServiceMetrics } from "./use-home-service-metrics";

/**
 * Logs — the tail of each service's stdout, one tab per service.
 *
 * Its own file rather than a fourth entry in `widgets.tsx` because it is the
 * one services widget that is neither counters nor rows: log text is verbatim
 * machine output and gets the terminal treatment, not the row treatment.
 *
 * A machine running two services has two log streams, and no static panel can
 * say which one you want to read — that choice is the widget's to offer, which
 * is why it holds tabs.
 *
 * The payload carries every service's tail interleaved (`mergeServiceLogs` in
 * `web/dashboard.ts`), so switching tabs costs no request. It used to carry one
 * service, chosen by registration order, which is how two services started
 * 200ms apart ended up with one of them invisible.
 */

/**
 * Six lines is a glance, and a glance is all an unsized panel can afford.
 *
 * Give the panel a height and it shows every line the payload carries and
 * scrolls — see `WidgetRenderProps.height`. The payload itself is the real
 * ceiling: 40 lines per service (`PAYLOAD_TAIL`), which is "recent output",
 * not the whole file. The whole file is the Services page's log pane.
 */
const LINE_CAP = 6;

export const outputWidget: WidgetDefinition = {
  id: "output",
  titleKey: "home.widget.output",
  icon: <Terminal />,
  span: 6,
  scope: "global",
  /*
    Still the payload's lines, but now also its own request for the graph above
    them (`use-home-service-metrics.ts`) — and `source` says which fact a picker
    has to be able to show, so a widget that fetches at all declares `fetch`.
    One request, for the tab you are looking at, whatever the payload holds.
  */
  source: "fetch",
  page: "services",
  render: ({ data, height }) => <OutputSummary data={data} height={height} />,
};

function OutputSummary({ data, height }: WidgetRenderProps) {
  const t = useT();
  const streams = groupByService(data.logs);
  const [picked, setPicked] = useState<string | null>(null);

  /* The pick is reconciled rather than stored back: a service can stop and drop
     out of the payload between polls, and a tab pointing at nothing should fall
     back to the liveliest stream instead of blanking the panel. */
  const active = streams.find((stream) => stream.service === picked) ?? streams[0] ?? null;
  /* Resolved before the empty check, because the empty check is a `return` and
     a hook cannot live behind one. The graph follows the tab: one service's
     series, for the service whose lines are underneath it. */
  const samples = useHomeServiceMetrics(active?.service ?? null);

  // A dash rather than a sentence: the panel title already says what is absent.
  if (!active) return <WidgetNote>—</WidgetNote>;

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
      {/*
        Between the counters and the lines, because that is the order the
        question is asked in: how much output, what shape was the last half
        hour, and then — at the moment the shape points at — what did it say.
      */}
      <OutputGraph samples={samples} />
      {/*
        `shrink-0`, and pointedly no `overflow-hidden`: the panel scrolls its own
        content now (`WidgetScroll`), and a list that hides its own overflow
        would quietly defeat that. It clipped here because the body used to clip
        — as a flex item with hidden overflow it was free to shrink to whatever
        room was left and swallow the rest of the lines, which is exactly the
        behaviour the scroll replaced. Keeping its full height is what gives the
        panel something to scroll.
      */}
      <span className="flex shrink-0 flex-col gap-0.5 font-mono text-[10px] leading-relaxed">
        {active.lines.slice(-rowCap(height, LINE_CAP)).map((line) => (
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
