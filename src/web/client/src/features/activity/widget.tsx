import { Activity } from "lucide-react";
import { WidgetNote } from "@/features/home/widget-grid";
import type { WidgetDefinition, WidgetRenderProps } from "@/features/home/widget-types";
import { useT } from "@/lib/i18n";
import { cn, formatRelativeTime } from "@/lib/utils";

/**
 * Activity — the last few timeline events, newest first.
 *
 * The only widget on Home that is a list rather than a figure, because "what
 * just happened" has no single number. It is capped at five: a longer list
 * turns the card into a scrolling log, which is the Activity page's job.
 */
export const activityWidget: WidgetDefinition = {
  id: "activity",
  titleKey: "home.widget.activity",
  icon: <Activity />,
  span: 6,
  scope: "global",
  page: "activity",
  render: ({ data }) => <ActivitySummary data={data} />,
};

const SEVERITY_DOT: Record<string, string> = {
  info: "bg-muted-foreground/40",
  warning: "bg-amber-500",
  error: "bg-destructive",
};

function ActivitySummary({ data }: WidgetRenderProps) {
  const t = useT();
  const events = data.timeline.slice(0, 5);

  if (events.length === 0) {
    return <WidgetNote>{t("home.activity.none")}</WidgetNote>;
  }

  return (
    <span className="flex flex-col gap-1">
      {events.map((event) => (
        <span className="flex items-center gap-2 text-[11px]" key={event.id}>
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 rounded-full", SEVERITY_DOT[event.severity])}
          />
          <span className="truncate text-foreground/90">{event.title}</span>
          <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
            {formatRelativeTime(event.timestamp)}
          </span>
        </span>
      ))}
    </span>
  );
}
