import { useMemo, useState } from "react";
import { Activity } from "lucide-react";
import { ComposerDialog } from "./service-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { TimelineEvent } from "@/lib/api";
import { cn } from "@/lib/utils";
import { EmptyState } from "./empty-state";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_EVENTS = 120;

export function DebugTimeline({ events }: { events: TimelineEvent[] }) {
  const [selected, setSelected] = useState<TimelineEvent | null>(null);

  const { lanes, windowStart, windowEnd } = useMemo(
    () => buildLanes(events),
    [events],
  );

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
          {lanes.length === 0 ? (
            <EmptyState label="No runtime timeline events yet." />
          ) : (
            <div className="timeline-graph px-3 py-3" data-testid="timeline-graph">
              <div className="space-y-1.5">
                {lanes.map((lane) => (
                  <Swimlane
                    key={lane.service}
                    lane={lane}
                    onSelect={setSelected}
                    windowEnd={windowEnd}
                    windowStart={windowStart}
                  />
                ))}
              </div>
              <div className="mt-2 flex justify-between font-mono text-[10px] text-muted-foreground">
                <span>{formatTime(windowStart)}</span>
                <span>now</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      {selected ? (
        <ComposerDialog
          icon={<Activity />}
          onClose={() => setSelected(null)}
          title={selected.title}
        >
          <EventDetail event={selected} />
        </ComposerDialog>
      ) : null}
    </>
  );
}

type Lane = {
  service: string;
  events: TimelineEvent[];
};

function buildLanes(events: TimelineEvent[]) {
  const now = Date.now();
  const windowEnd = now;
  const windowStart = now - WINDOW_MS;

  const recent = events
    .filter((event) => {
      const ts = new Date(event.timestamp).getTime();
      return !Number.isNaN(ts) && ts >= windowStart;
    })
    .slice(-MAX_EVENTS);

  if (recent.length === 0 && events.length > 0) {
    // Use the events we have; widen the window to fit them.
    const stamps = events
      .map((event) => new Date(event.timestamp).getTime())
      .filter((value) => !Number.isNaN(value));
    const min = Math.min(...stamps);
    return finalizeLanes(events, min, now);
  }

  return finalizeLanes(recent, windowStart, windowEnd);
}

function finalizeLanes(events: TimelineEvent[], windowStart: number, windowEnd: number) {
  const byService = new Map<string, TimelineEvent[]>();
  for (const event of events) {
    const key = event.service || "·system";
    const bucket = byService.get(key) ?? [];
    bucket.push(event);
    byService.set(key, bucket);
  }
  const lanes: Lane[] = Array.from(byService.entries())
    .map(([service, list]) => ({
      service,
      events: list.sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    }))
    .sort((a, b) => a.service.localeCompare(b.service));
  return { lanes, windowStart, windowEnd };
}

function Swimlane({
  lane,
  onSelect,
  windowEnd,
  windowStart,
}: {
  lane: Lane;
  onSelect: (event: TimelineEvent) => void;
  windowEnd: number;
  windowStart: number;
}) {
  const span = Math.max(windowEnd - windowStart, 1);
  const errorCount = lane.events.filter((event) => event.severity === "error").length;
  const warnCount = lane.events.filter((event) => event.severity === "warning").length;

  return (
    <div className="timeline-lane grid grid-cols-[88px_minmax(0,1fr)] items-center gap-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-[11px] font-medium text-foreground" title={lane.service}>
          {lane.service}
        </span>
        {errorCount > 0 ? (
          <span className="rounded bg-red-500/15 px-1 font-mono text-[10px] text-red-500">
            {errorCount}
          </span>
        ) : null}
        {warnCount > 0 ? (
          <span className="rounded bg-amber-500/15 px-1 font-mono text-[10px] text-amber-500">
            {warnCount}
          </span>
        ) : null}
      </div>
      <div className="relative h-5">
        <div className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-border" />
        {lane.events.map((event) => {
          const ts = new Date(event.timestamp).getTime();
          const clamped = Math.max(windowStart, Math.min(windowEnd, ts));
          const left = ((clamped - windowStart) / span) * 100;
          return (
            <button
              aria-label={`${event.title} at ${formatTime(ts)}`}
              className="timeline-marker absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              key={event.id}
              onClick={() => onSelect(event)}
              style={{ left: `${left}%` }}
              title={`${event.title} — ${formatTime(ts)}`}
              type="button"
            >
              <span
                className={cn(
                  "block size-2.5 rounded-full ring-2 ring-background transition-transform hover:scale-125",
                  markerColor(event.severity),
                )}
              />
            </button>
          );
        })}
      </div>
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

function markerColor(severity: TimelineEvent["severity"]) {
  if (severity === "error") return "bg-red-500";
  if (severity === "warning") return "bg-amber-500";
  return "bg-zinc-400";
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
