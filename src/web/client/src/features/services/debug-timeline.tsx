import { Activity, AlertTriangle, Info, XCircle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { TimelineEvent } from "@/lib/api";
import { cn } from "@/lib/utils";
import { EmptyState } from "./empty-state";

const severityIcon = {
  error: XCircle,
  info: Info,
  warning: AlertTriangle,
} satisfies Record<TimelineEvent["severity"], typeof Info>;

const MAX_EVENTS = 40;
const RAIL_WINDOW_MS = 15 * 60 * 1000;

export function DebugTimeline({ events }: { events: TimelineEvent[] }) {
  const sortedEvents = [...events]
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, MAX_EVENTS);

  const positioned = computePositions(sortedEvents);

  return (
    <Card className="rounded-none border-0 border-b border-border bg-transparent">
      <CardHeader className="border-b border-border px-3 py-2">
        <CardTitle className="flex items-center gap-2">
          <Activity className="size-3.5" />
          Runtime Monitor
        </CardTitle>
        <CardDescription className="text-xs">
          {events.length} recent {events.length === 1 ? "event" : "events"}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {sortedEvents.length ? (
          <>
            <TimelineGraph positioned={positioned} />
            <ul className="divide-y divide-border" data-testid="timeline-list">
              {sortedEvents.map((event) => (
                <TimelineEventRow event={event} key={event.id} />
              ))}
            </ul>
          </>
        ) : (
          <EmptyState label="No runtime timeline events yet." />
        )}
      </CardContent>
    </Card>
  );
}

type Positioned = {
  event: TimelineEvent;
  leftPercent: number;
};

function computePositions(events: TimelineEvent[]): Positioned[] {
  if (events.length === 0) return [];
  const times = events.map((event) => new Date(event.timestamp).getTime());
  const max = Math.max(...times);
  const min = Math.min(...times);
  const span = Math.max(max - min, RAIL_WINDOW_MS);
  return events.map((event, index) => {
    const time = times[index];
    const left = span === 0 ? 100 : ((time - min) / span) * 100;
    return { event, leftPercent: Math.min(100, Math.max(0, left)) };
  });
}

function TimelineGraph({ positioned }: { positioned: Positioned[] }) {
  if (positioned.length === 0) return null;
  const earliest = positioned.reduce((acc, item) =>
    item.leftPercent < acc.leftPercent ? item : acc,
  );
  const latest = positioned.reduce((acc, item) =>
    item.leftPercent > acc.leftPercent ? item : acc,
  );

  return (
    <div className="timeline-graph px-3 pt-3 pb-2" data-testid="timeline-graph">
      <div className="relative h-10">
        <div
          className="timeline-rail absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-border"
          data-testid="timeline-rail"
        />
        {positioned.map(({ event, leftPercent }) => (
          <span
            className="timeline-marker absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
            data-testid="timeline-marker"
            key={event.id}
            style={{ left: `${leftPercent}%` }}
            title={`${event.title} — ${formatEventTime(event.timestamp)}`}
          >
            <span
              className={cn(
                "block size-2.5 rounded-full ring-2 ring-background",
                markerColor(event.severity),
              )}
            />
          </span>
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>{formatEventTime(earliest.event.timestamp)}</span>
        <span>{formatEventTime(latest.event.timestamp)}</span>
      </div>
    </div>
  );
}

function TimelineEventRow({ event }: { event: TimelineEvent }) {
  const Icon = severityIcon[event.severity];

  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 px-3 py-2">
      <span
        className={cn(
          "mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-md text-white",
          severityBadge(event.severity),
        )}
      >
        <Icon className="size-3" />
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
            {event.title}
          </div>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {formatEventTime(event.timestamp)}
          </span>
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
          {event.service ? (
            <span className="max-w-28 truncate rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-foreground">
              {event.service}
            </span>
          ) : null}
          <span className="max-w-full truncate rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {event.kind}
          </span>
        </div>
        {event.detail ? (
          <div className="mt-1 truncate text-[11px] text-muted-foreground">{event.detail}</div>
        ) : null}
      </div>
    </li>
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

function formatEventTime(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
