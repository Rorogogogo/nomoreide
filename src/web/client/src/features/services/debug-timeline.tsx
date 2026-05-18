import { Activity, AlertTriangle, Clock3, Info, XCircle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { TimelineEvent } from "@/lib/api";
import { cn } from "@/lib/utils";
import { EmptyState } from "./empty-state";

const severityIcon = {
  error: XCircle,
  info: Info,
  warning: AlertTriangle,
} satisfies Record<TimelineEvent["severity"], typeof Info>;

export function DebugTimeline({ events }: { events: TimelineEvent[] }) {
  const sortedEvents = [...events]
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, 40);

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
          <div className="divide-y divide-border">
            {sortedEvents.map((event) => (
              <TimelineEventRow event={event} key={event.id} />
            ))}
          </div>
        ) : (
          <EmptyState label="No runtime timeline events yet." />
        )}
      </CardContent>
    </Card>
  );
}

function TimelineEventRow({ event }: { event: TimelineEvent }) {
  const Icon = severityIcon[event.severity];

  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 px-3 py-2">
      <span
        className={cn(
          "mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-white",
          severityClassName(event.severity),
        )}
      >
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
            {event.title}
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] text-muted-foreground">
            <Clock3 className="size-3" />
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
    </div>
  );
}

function severityClassName(severity: TimelineEvent["severity"]) {
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
