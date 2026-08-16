import { HeartPulse, Server } from "lucide-react";
import type { ReactNode } from "react";
import {
  rowCap,
  WidgetId,
  WidgetMore,
  WidgetNote,
  WidgetOpenLink,
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
import { serviceUrl } from "./service-list";

/**
 * The services domain's Home widgets.
 *
 * Both share a file because they share a source — each is a read of the
 * dashboard payload the shell already polls, so neither costs a request.
 * Splitting them across two files would spread one idea over two headers.
 *
 * Each is a strip of counters over a short list of *names*. The counters answer
 * "is anything wrong"; the list answers "what", which is the question a bare
 * figure left you to open the page for.
 *
 * **There was a third.** Ports listed `:port → service`, which is Services'
 * `service → :port` read backwards, so the page spent two panels saying one
 * thing. The only fact it held alone was a port taken by a process we did not
 * spawn — a service that cannot start and has no runtime entry to be a row —
 * and that moved into Services rather than leaving with it.
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
  render: ({ data, height }) => <ServicesSummary data={data} height={height} />,
};

function ServicesSummary({ data, height }: WidgetRenderProps) {
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
    A port held by something we did not spawn — the one fact this widget cannot
    derive from its own statuses, because the blocked service has no runtime
    entry to be a row. It used to be the Ports widget's reason for existing;
    that widget was otherwise this one inverted, so the duplicate went and the
    signal moved here rather than being lost with it.
  */
  const conflicts = data.ports.filter((port) => port.state === "occupied");
  /*
    A service that has never been started has no runtime entry at all, so
    "stopped" is what is left over from the registered count rather than a
    state to filter for. Clamped because runtime can briefly hold an entry for
    a service that was just unregistered.
  */
  const stopped = Math.max(0, registered - live.length - exited.length);

  // Exits first: a service that fell over is the only thing here worth reading
  // before the ones that are simply up. A blocked port outranks even that — it
  // is the one state where nothing is wrong with a service *and* it still
  // cannot start, so it must survive `ROW_CAP` on a busy page.
  const rows = [...exited, ...live];
  // Conflicts are never dropped, so the budget the service rows share is what
  // is left of the cap after them.
  const cap = Math.max(0, rowCap(height, ROW_CAP) - conflicts.length);

  return (
    <>
      <WidgetStats>
        <WidgetStat label={t("home.services.running")} tone="ok" value={live.length} />
        <WidgetStat label={t("home.services.exitedLabel")} tone="bad" value={exited.length} />
        <WidgetStat label={t("home.services.stopped")} value={stopped} />
      </WidgetStats>
      {conflicts.length === 0 && rows.length === 0 ? null : (
        <WidgetRows>
          {conflicts.map((port) => (
            <WidgetRow
              key={`port:${port.port}`}
              meta={
                port.services.length > 0
                  ? t("home.services.portBlocks", { name: port.services.join(", ") })
                  : t("home.ports.unknownHolder")
              }
              name={`:${port.port}`}
              tone="bad"
            />
          ))}
          {rows.slice(0, cap).map((service) => (
            <WidgetRow
              key={service.name}
              meta={serviceMeta(service, ports.get(service.name), t)}
              name={service.name}
              tone={serviceTone(service)}
              trailing={serviceTrailing(service, ports.get(service.name), t)}
            />
          ))}
          {rows.length > cap ? (
            <WidgetMore>
              {t("home.more", {
                count: String(rows.length - cap),
              })}
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

/**
 * How long it has been up, and a way to actually go there.
 *
 * Only for `running`. A service that is starting has no URL worth handing over
 * yet and an exited one has none at all, so both keep the plain uptime cell —
 * offering a link that lands on a connection refused would be worse than
 * offering nothing.
 *
 * The service's own reported URL wins over one built from the port: a service
 * that announced `http://127.0.0.1:5175/` on stdout knows its path and scheme,
 * and `serviceUrl` is the guess for when nothing was announced.
 */
function serviceTrailing(
  service: ServiceStatus,
  port: number | undefined,
  t: Translate,
): ReactNode {
  if (service.state !== "running") return undefined;
  const url = service.url ?? (port ? serviceUrl(port) : undefined);
  const uptime = formatUptime(service.startedAt);
  if (!url) return uptime;
  return (
    <span className="flex items-center justify-end gap-1.5">
      {uptime}
      <WidgetOpenLink label={t("services.openUrl", { url })} url={url} />
    </span>
  );
}

export const healthWidget: WidgetDefinition = {
  id: "health",
  titleKey: "home.widget.health",
  icon: <HeartPulse />,
  span: 4,
  scope: "global",
  source: "dashboard",
  page: "services",
  render: ({ data, height }) => <HealthSummary data={data} height={height} />,
};

function HealthSummary({ data, height }: WidgetRenderProps) {
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
  const cap = rowCap(height, ROW_CAP);

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
          {rows.slice(0, cap).map((entry) => (
            <WidgetRow
              key={entry.service}
              meta={entry.summary}
              name={entry.service}
              tone={healthTone(entry.status)}
              trailing={latencyLabel(entry)}
            />
          ))}
          {rows.length > cap ? (
            <WidgetMore>{t("home.more", { count: String(rows.length - cap) })}</WidgetMore>
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
