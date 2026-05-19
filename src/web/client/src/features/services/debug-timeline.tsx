import { useMemo, useState } from "react";
import { Activity, ChevronRight } from "lucide-react";
import { ComposerDialog } from "./service-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { TimelineEvent } from "@/lib/api";
import { cn } from "@/lib/utils";
import { EmptyState } from "./empty-state";

const WINDOW_MS = 15 * 60 * 1000;
const BUCKETS = 12;
const MAX_EVENTS = 200;

export function DebugTimeline({ events }: { events: TimelineEvent[] }) {
  const [openService, setOpenService] = useState<string | null>(null);
  const [openEvent, setOpenEvent] = useState<TimelineEvent | null>(null);

  const { rows, windowStart, windowEnd } = useMemo(() => buildRows(events), [events]);

  const activeRow = openService ? rows.find((row) => row.service === openService) ?? null : null;

  return (
    <>
      <Card className="rounded-none border-0 border-b border-border bg-transparent">
        <CardHeader className="border-b border-border px-3 py-2">
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-3.5" />
            Runtime Monitor
          </CardTitle>
          <CardDescription className="text-xs">
            {events.length === 0
              ? "No events yet"
              : `${events.length} event${events.length === 1 ? "" : "s"} · last 15 min`}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <EmptyState label="No runtime timeline events yet." />
          ) : (
            <div className="divide-y divide-border">
              {rows.map((row) => (
                <ServiceRowButton
                  key={row.service}
                  onClick={() => setOpenService(row.service)}
                  row={row}
                  windowEnd={windowEnd}
                  windowStart={windowStart}
                />
              ))}
              <div className="flex justify-between px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
                <span>{formatTime(windowStart)}</span>
                <span>now</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      {activeRow ? (
        <ComposerDialog
          icon={<Activity />}
          onClose={() => setOpenService(null)}
          title={activeRow.service}
        >
          <ServiceEventList
            onSelect={setOpenEvent}
            row={activeRow}
          />
        </ComposerDialog>
      ) : null}
      {openEvent ? (
        <ComposerDialog
          icon={<Activity />}
          onClose={() => setOpenEvent(null)}
          title={openEvent.title}
        >
          <EventDetail event={openEvent} />
        </ComposerDialog>
      ) : null}
    </>
  );
}

type ServiceRow = {
  service: string;
  events: TimelineEvent[];
  errors: number;
  warnings: number;
  infos: number;
  buckets: number[];
  bucketSeverity: Array<"error" | "warning" | "info" | null>;
  lastNotable: TimelineEvent | null;
  worstSeverity: TimelineEvent["severity"];
};

function buildRows(events: TimelineEvent[]) {
  const now = Date.now();
  const windowEnd = now;
  const windowStart = now - WINDOW_MS;

  let filtered = events.filter((event) => {
    const ts = new Date(event.timestamp).getTime();
    return !Number.isNaN(ts) && ts >= windowStart;
  });

  if (filtered.length === 0 && events.length > 0) {
    filtered = events.slice(-MAX_EVENTS);
  } else if (filtered.length > MAX_EVENTS) {
    filtered = filtered.slice(-MAX_EVENTS);
  }

  const byService = new Map<string, TimelineEvent[]>();
  for (const event of filtered) {
    const key = event.service || "·system";
    const bucket = byService.get(key) ?? [];
    bucket.push(event);
    byService.set(key, bucket);
  }

  const span = Math.max(windowEnd - windowStart, 1);
  const rows: ServiceRow[] = Array.from(byService.entries())
    .map(([service, list]) => {
      const sorted = [...list].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const buckets = new Array<number>(BUCKETS).fill(0);
      const bucketSeverity = new Array<"error" | "warning" | "info" | null>(BUCKETS).fill(null);
      for (const event of sorted) {
        const ts = new Date(event.timestamp).getTime();
        const clamped = Math.max(windowStart, Math.min(windowEnd, ts));
        const idx = Math.min(
          BUCKETS - 1,
          Math.floor(((clamped - windowStart) / span) * BUCKETS),
        );
        buckets[idx] += 1;
        const prev = bucketSeverity[idx];
        bucketSeverity[idx] = mergeSeverity(prev, event.severity);
      }
      const errors = sorted.filter((event) => event.severity === "error").length;
      const warnings = sorted.filter((event) => event.severity === "warning").length;
      const infos = sorted.length - errors - warnings;
      const lastNotable =
        [...sorted].reverse().find((event) => event.severity !== "info") ?? null;
      const worstSeverity: TimelineEvent["severity"] =
        errors > 0 ? "error" : warnings > 0 ? "warning" : "info";
      return {
        service,
        events: sorted,
        errors,
        warnings,
        infos,
        buckets,
        bucketSeverity,
        lastNotable,
        worstSeverity,
      };
    })
    .sort((a, b) => {
      const score = (row: ServiceRow) => row.errors * 1000 + row.warnings;
      const diff = score(b) - score(a);
      if (diff !== 0) return diff;
      return a.service.localeCompare(b.service);
    });

  return { rows, windowStart, windowEnd };
}

function mergeSeverity(
  prev: "error" | "warning" | "info" | null,
  next: TimelineEvent["severity"],
): "error" | "warning" | "info" {
  if (prev === "error" || next === "error") return "error";
  if (prev === "warning" || next === "warning") return "warning";
  return "info";
}

function ServiceRowButton({
  onClick,
  row,
  windowEnd,
  windowStart,
}: {
  onClick: () => void;
  row: ServiceRow;
  windowEnd: number;
  windowStart: number;
}) {
  const maxCount = Math.max(1, ...row.buckets);
  return (
    <button
      className="timeline-service-row block w-full px-3 py-2 text-left transition-colors hover:bg-muted/40 focus:outline-none focus-visible:bg-muted/40"
      data-testid="timeline-service-row"
      onClick={onClick}
      type="button"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("size-2 shrink-0 rounded-full", severityDot(row.worstSeverity))} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" dir="rtl">
          <bdi>{row.service}</bdi>
        </span>
        {row.errors > 0 ? (
          <span className="rounded bg-red-500/15 px-1 font-mono text-[10px] text-red-500">
            {row.errors}E
          </span>
        ) : null}
        {row.warnings > 0 ? (
          <span className="rounded bg-amber-500/15 px-1 font-mono text-[10px] text-amber-500">
            {row.warnings}W
          </span>
        ) : null}
        <ChevronRight className="size-3 text-muted-foreground" />
      </div>
      <div
        className="timeline-density mt-1.5 grid h-3 gap-px"
        data-testid="timeline-density"
        style={{ gridTemplateColumns: `repeat(${BUCKETS}, minmax(0, 1fr))` }}
      >
        {row.buckets.map((count, idx) => (
          <DensityCell
            count={count}
            key={idx}
            max={maxCount}
            severity={row.bucketSeverity[idx]}
          />
        ))}
      </div>
      {row.lastNotable ? (
        <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
          {row.lastNotable.detail ?? row.lastNotable.title}
        </div>
      ) : (
        <div className="mt-1 truncate text-[10px] text-muted-foreground">
          {row.infos} info {row.infos === 1 ? "event" : "events"}
        </div>
      )}
      <div className="mt-0.5 flex justify-between font-mono text-[9px] text-muted-foreground/60">
        <span>{formatTime(windowStart)}</span>
        <span>{formatTime(windowEnd)}</span>
      </div>
    </button>
  );
}

function DensityCell({
  count,
  max,
  severity,
}: {
  count: number;
  max: number;
  severity: "error" | "warning" | "info" | null;
}) {
  if (count === 0) {
    return <span className="rounded-sm bg-border/60" />;
  }
  const intensity = Math.min(1, 0.35 + (count / max) * 0.65);
  return (
    <span
      className={cn("rounded-sm", densityColor(severity))}
      style={{ opacity: intensity }}
      title={`${count} event${count === 1 ? "" : "s"}`}
    />
  );
}

function ServiceEventList({
  onSelect,
  row,
}: {
  onSelect: (event: TimelineEvent) => void;
  row: ServiceRow;
}) {
  const newestFirst = [...row.events].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return (
    <div className="flex max-h-[480px] flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground">
        <span>{row.events.length} events</span>
        <span>·</span>
        <span>{row.errors} error{row.errors === 1 ? "" : "s"}</span>
        <span>·</span>
        <span>{row.warnings} warning{row.warnings === 1 ? "" : "s"}</span>
      </div>
      <ul className="min-h-0 divide-y divide-border overflow-auto">
        {newestFirst.map((event) => (
          <li key={event.id}>
            <button
              className="block w-full px-4 py-2 text-left hover:bg-muted/40 focus:outline-none focus-visible:bg-muted/40"
              onClick={() => onSelect(event)}
              type="button"
            >
              <div className="flex items-center gap-2">
                <span className={cn("size-2 shrink-0 rounded-full", severityDot(event.severity))} />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                  {event.title}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {formatTime(event.timestamp)}
                </span>
              </div>
              {event.detail ? (
                <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                  {event.detail}
                </div>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EventDetail({ event }: { event: TimelineEvent }) {
  const ts = new Date(event.timestamp);
  return (
    <div className="space-y-3 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-mono text-[10px] uppercase text-white",
            severityBadge(event.severity),
          )}
        >
          {event.severity}
        </span>
        <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {event.kind}
        </span>
        {event.service ? (
          <span className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-foreground">
            {event.service}
          </span>
        ) : null}
      </div>
      <div>
        <div className="text-xs text-muted-foreground">When</div>
        <div className="font-mono text-xs">
          {Number.isNaN(ts.getTime()) ? event.timestamp : ts.toLocaleString()}
        </div>
      </div>
      {event.detail ? (
        <div>
          <div className="text-xs text-muted-foreground">Detail</div>
          <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded border border-border bg-background p-3 font-mono text-xs">
            {event.detail}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function severityDot(severity: "error" | "warning" | "info") {
  if (severity === "error") return "bg-red-500";
  if (severity === "warning") return "bg-amber-500";
  return "bg-zinc-400";
}

function densityColor(severity: "error" | "warning" | "info" | null) {
  if (severity === "error") return "bg-red-500";
  if (severity === "warning") return "bg-amber-500";
  return "bg-zinc-500";
}

function severityBadge(severity: TimelineEvent["severity"]) {
  if (severity === "error") return "bg-red-600";
  if (severity === "warning") return "bg-amber-600";
  return "bg-zinc-700";
}

function formatTime(value: number | string) {
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
