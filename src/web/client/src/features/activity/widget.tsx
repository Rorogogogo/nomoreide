import { Activity } from "lucide-react";
import {
  WidgetMore,
  WidgetNote,
  WidgetRow,
  WidgetRows,
  WidgetStat,
  WidgetStats,
  type WidgetTone,
} from "@/features/home/widget-grid";
import type { WidgetDefinition, WidgetRenderProps } from "@/features/home/widget-types";
import type { TimelineEvent } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/utils";

/**
 * Activity — what just happened, newest first.
 *
 * The counters are over the whole window the payload carries (the last 120
 * events), not just the rows shown, so "2 errors" stays true when only six
 * lines fit. The rows are capped at six: a longer list turns the panel into a
 * scrolling log, which is the Activity page's job.
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

const EVENT_CAP = 6;

const SEVERITY_TONE: Record<TimelineEvent["severity"], WidgetTone> = {
  info: "idle",
  warning: "warn",
  error: "bad",
};

function ActivitySummary({ data }: WidgetRenderProps) {
  const t = useT();
  const events = data.timeline;

  if (events.length === 0) {
    return <WidgetNote>{t("home.activity.none")}</WidgetNote>;
  }

  const errors = events.filter((event) => event.severity === "error").length;
  const warnings = events.filter((event) => event.severity === "warning").length;

  return (
    <>
      <WidgetStats>
        <WidgetStat
          label={t("home.activity.errors")}
          tone={errors > 0 ? "bad" : "idle"}
          value={errors}
        />
        <WidgetStat
          label={t("home.activity.warnings")}
          tone={warnings > 0 ? "warn" : "idle"}
          value={warnings}
        />
        <WidgetStat label={t("home.activity.events")} value={events.length} />
      </WidgetStats>
      <WidgetRows>
        {events.slice(0, EVENT_CAP).map((event) => (
          <WidgetRow
            key={event.id}
            /*
              `title` is the sentence and `service` is the identifier, so they
              swap the usual cells: the mono column carries the service when
              there is one, and the event itself reads as prose beside it.
            */
            meta={eventText(event)}
            name={event.service ?? event.kind}
            tone={SEVERITY_TONE[event.severity]}
            trailing={formatRelativeTime(event.timestamp)}
          />
        ))}
        {events.length > EVENT_CAP ? (
          <WidgetMore>{t("home.more", { count: events.length - EVENT_CAP })}</WidgetMore>
        ) : null}
      </WidgetRows>
    </>
  );
}

/**
 * The event minus the service name it already starts with.
 *
 * Timeline titles are written as full sentences for the Activity page, where
 * there is no service column — `"api started"`, `"api reported http://…"`. Here
 * the service *is* the row's first cell, so printing the title verbatim spends
 * half the width saying the same word twice. This was visible the moment the
 * panel had real events in it and invisible before.
 */
function eventText(event: TimelineEvent): string {
  if (!event.service) return event.title;
  const prefix = `${event.service} `;
  return event.title.startsWith(prefix) ? event.title.slice(prefix.length) : event.title;
}
