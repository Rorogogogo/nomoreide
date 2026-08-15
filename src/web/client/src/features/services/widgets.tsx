import { Globe, HeartPulse, Server } from "lucide-react";
import type { ReactNode } from "react";
import {
  WidgetId,
  WidgetMore,
  WidgetNote,
  WidgetRow,
  WidgetRows,
  WidgetStat,
  WidgetStats,
  type WidgetTone,
} from "@/features/home/widget-grid";
import type { WidgetDefinition, WidgetRenderProps } from "@/features/home/widget-types";
import type { ServiceHealth, ServiceStatus } from "@/lib/api";
import { type Translate, useT } from "@/lib/i18n";
import { formatUptime } from "@/lib/utils";

/**
 * The services domain's Home widgets.
 *
 * Three of them share a file because they share a source — every one is a read
 * of the dashboard payload the shell already polls, so none costs a request.
 * Splitting them across three files would spread one idea over three headers.
 *
 * Each is a strip of counters over a short list of *names*. The counters answer
 * "is anything wrong"; the list answers "what", which is the question a bare
 * figure left you to open the page for.
 */

/** Enough rows to name the problem, few enough that the panel stays a summary. */
const ROW_CAP = 4;

export const servicesWidget: WidgetDefinition = {
  id: "services",
  titleKey: "home.widget.services",
  icon: <Server />,
  span: 4,
  scope: "global",
  source: "dashboard",
  page: "services",
  render: ({ data }) => <ServicesSummary data={data} />,
};

function ServicesSummary({ data }: WidgetRenderProps) {
  const t = useT();
  const registered = data.config.services.length;
  const statuses = Object.values(data.runtime.services);

  if (registered === 0) {
    return <WidgetNote>{t("home.services.none")}</WidgetNote>;
  }

  const ports = new Map(data.config.services.map((service) => [service.name, service.port]));
  const live = statuses.filter(
    (service) => service.state === "running" || service.state === "starting",
  );
  const exited = statuses.filter((service) => service.state === "exited");
  /*
    A service that has never been started has no runtime entry at all, so
    "stopped" is what is left over from the registered count rather than a
    state to filter for. Clamped because runtime can briefly hold an entry for
    a service that was just unregistered.
  */
  const stopped = Math.max(0, registered - live.length - exited.length);

  // Exits first: a service that fell over is the only thing here worth reading
  // before the ones that are simply up.
  const rows = [...exited, ...live];

  return (
    <>
      <WidgetStats>
        <WidgetStat label={t("home.services.running")} tone="ok" value={live.length} />
        <WidgetStat label={t("home.services.exitedLabel")} tone="bad" value={exited.length} />
        <WidgetStat label={t("home.services.stopped")} value={stopped} />
      </WidgetStats>
      {rows.length === 0 ? null : (
        <WidgetRows>
          {rows.slice(0, ROW_CAP).map((service) => (
            <WidgetRow
              key={service.name}
              meta={serviceMeta(service, ports.get(service.name), t)}
              name={service.name}
              tone={serviceTone(service)}
              trailing={service.state === "running" ? formatUptime(service.startedAt) : undefined}
            />
          ))}
          {rows.length > ROW_CAP ? (
            <WidgetMore>
              {t("home.more", { count: String(rows.length - ROW_CAP) })}
            </WidgetMore>
          ) : null}
        </WidgetRows>
      )}
    </>
  );
}

function serviceTone(service: ServiceStatus): WidgetTone {
  if (service.state === "exited") return service.exitCode === 0 ? "idle" : "bad";
  if (service.state === "starting") return "warn";
  return "ok";
}

function serviceMeta(service: ServiceStatus, port: number | undefined, t: Translate): ReactNode {
  if (service.state === "exited") {
    return t("home.services.exitCode", { code: service.exitCode ?? "?" });
  }
  if (service.state === "starting") return t("home.services.starting");
  return port ? <WidgetId>:{port}</WidgetId> : t("home.services.up");
}

export const healthWidget: WidgetDefinition = {
  id: "health",
  titleKey: "home.widget.health",
  icon: <HeartPulse />,
  span: 4,
  scope: "global",
  source: "dashboard",
  page: "services",
  render: ({ data }) => <HealthSummary data={data} />,
};

function HealthSummary({ data }: WidgetRenderProps) {
  const t = useT();
  const entries = Object.values(data.health);
  /*
    `unknown` is neither healthy nor failing — it means nothing has probed yet.
    Counting it as a failure makes a fresh daemon look broken; counting it as a
    pass is worse, and was the first thing this widget got wrong: nineteen
    stopped services all reported `unknown`, no failures were found, and the
    panel cheerfully said "All healthy". So unknowns get their own counter and
    stay out of the other two.
  */
  const failing = entries.filter(
    (entry) => entry.status === "unhealthy" || entry.status === "warning",
  );
  const healthy = entries.filter((entry) => entry.status === "healthy");
  const unknown = entries.filter((entry) => entry.status === "unknown");

  if (entries.length === 0) {
    return <WidgetNote>{t("home.health.none")}</WidgetNote>;
  }

  // Failing first, then healthy — the panel is read top-down and the top line
  // should be the one that costs something.
  const rows = [...failing, ...healthy];

  return (
    <>
      <WidgetStats>
        <WidgetStat label={t("home.health.failing")} tone="bad" value={failing.length} />
        <WidgetStat label={t("home.health.healthy")} tone="ok" value={healthy.length} />
        <WidgetStat label={t("home.health.unknown")} value={unknown.length} />
      </WidgetStats>
      {/*
        The counters stay even when nothing has been probed. Bailing to a bare
        sentence made this the one panel on the page with no numbers on it,
        which reads as broken rather than as "nothing known yet" — and "19
        unprobed" is itself the useful fact in that state.
      */}
      {rows.length === 0 ? null : (
        <WidgetRows>
          {rows.slice(0, ROW_CAP).map((entry) => (
            <WidgetRow
              key={entry.service}
              meta={entry.summary}
              name={entry.service}
              tone={healthTone(entry.status)}
              trailing={latencyLabel(entry)}
            />
          ))}
          {rows.length > ROW_CAP ? (
            <WidgetMore>{t("home.more", { count: String(rows.length - ROW_CAP) })}</WidgetMore>
          ) : null}
        </WidgetRows>
      )}
    </>
  );
}

function healthTone(status: ServiceHealth["status"]): WidgetTone {
  if (status === "unhealthy") return "bad";
  if (status === "warning") return "warn";
  if (status === "healthy") return "ok";
  return "idle";
}

/** The slowest passing check — the number that moves first when something rots. */
function latencyLabel(entry: ServiceHealth): string | undefined {
  const latencies = entry.checks
    .map((check) => check.latencyMs)
    .filter((ms): ms is number => typeof ms === "number");
  return latencies.length > 0 ? `${Math.max(...latencies)}ms` : undefined;
}

export const portsWidget: WidgetDefinition = {
  id: "ports",
  titleKey: "home.widget.ports",
  icon: <Globe />,
  span: 4,
  scope: "global",
  source: "dashboard",
  page: "services",
  render: ({ data }) => <PortsSummary data={data} />,
};

function PortsSummary({ data }: WidgetRenderProps) {
  const t = useT();
  // `occupied` is a port held by something we did not spawn — the only state
  // that blocks a start. `managed` is our own service holding its port, which
  // is the working case, and `available` is nothing at all.
  const occupied = data.ports.filter((port) => port.state === "occupied");
  const managed = data.ports.filter((port) => port.state === "managed");

  const rows = [...occupied, ...managed];

  return (
    <>
      <WidgetStats>
        <WidgetStat label={t("home.ports.conflicts")} tone="bad" value={occupied.length} />
        <WidgetStat label={t("home.ports.managed")} tone="ok" value={managed.length} />
        <WidgetStat label={t("home.ports.watched")} value={data.ports.length} />
      </WidgetStats>
      {rows.length === 0 ? null : (
        <WidgetRows>
          {rows.slice(0, ROW_CAP).map((port) => (
            <WidgetRow
              key={port.port}
              meta={
                port.services.length > 0
                  ? port.services.join(", ")
                  : t("home.ports.unknownHolder")
              }
              name={`:${port.port}`}
              tone={port.state === "occupied" ? "bad" : "ok"}
            />
          ))}
          {rows.length > ROW_CAP ? (
            <WidgetMore>{t("home.more", { count: String(rows.length - ROW_CAP) })}</WidgetMore>
          ) : null}
        </WidgetRows>
      )}
    </>
  );
}
