import { Globe, HeartPulse, Server, Terminal } from "lucide-react";
import { WidgetFigure, WidgetNote } from "@/features/home/widget-grid";
import type { WidgetDefinition, WidgetRenderProps } from "@/features/home/widget-types";
import { useT } from "@/lib/i18n";

/**
 * The services domain's Home widgets.
 *
 * Four of them share a file because they share a source — every one is a read
 * of the dashboard payload the shell already polls, so none costs a request.
 * Splitting them across four files would spread one idea over four headers.
 */

export const servicesWidget: WidgetDefinition = {
  id: "services",
  titleKey: "home.widget.services",
  icon: <Server />,
  span: 4,
  scope: "global",
  page: "services",
  render: ({ data }) => <ServicesSummary data={data} />,
};

function ServicesSummary({ data }: WidgetRenderProps) {
  const t = useT();
  const services = Object.values(data.runtime.services);
  const running = services.filter(
    (service) => service.state === "running" || service.state === "starting",
  ).length;
  const exited = services.filter((service) => service.state === "exited").length;
  const registered = data.config.services.length;

  if (registered === 0) {
    return <WidgetNote>{t("home.services.none")}</WidgetNote>;
  }

  return (
    <>
      <WidgetFigure>{running}</WidgetFigure>
      <WidgetNote>
        {t("home.services.detail", { total: String(registered), exited: String(exited) })}
      </WidgetNote>
    </>
  );
}

export const healthWidget: WidgetDefinition = {
  id: "health",
  titleKey: "home.widget.health",
  icon: <HeartPulse />,
  span: 4,
  scope: "global",
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
    card cheerfully said "All healthy". So unknowns are excluded from the
    denominator, and a card with nothing known says exactly that.
  */
  const known = entries.filter((entry) => entry.status !== "unknown");
  const failing = known.filter(
    (entry) => entry.status === "unhealthy" || entry.status === "warning",
  );

  if (known.length === 0) {
    return <WidgetNote>{t("home.health.none")}</WidgetNote>;
  }

  return (
    <>
      <WidgetFigure>{failing.length}</WidgetFigure>
      {/*
        The denominator stays on the card in both states. Swapping it for the
        failing names when there are failures would drop the context exactly
        when the number matters most — "2" reads very differently against 3
        probed services than against 30.
      */}
      <WidgetNote>{t("home.health.detail", { total: String(known.length) })}</WidgetNote>
      {failing.length > 0 ? (
        <WidgetNote>{failing.map((entry) => entry.service).join(", ")}</WidgetNote>
      ) : null}
    </>
  );
}

export const portsWidget: WidgetDefinition = {
  id: "ports",
  titleKey: "home.widget.ports",
  icon: <Globe />,
  span: 4,
  scope: "global",
  page: "services",
  render: ({ data }) => <PortsSummary data={data} />,
};

function PortsSummary({ data }: WidgetRenderProps) {
  const t = useT();
  // Only `occupied` is worth a glance: `managed` is our own service holding its
  // port, which is the working case, not a conflict.
  const conflicts = data.ports.filter((port) => port.state === "occupied");

  return (
    <>
      <WidgetFigure>{conflicts.length}</WidgetFigure>
      <WidgetNote>
        {conflicts.length === 0
          ? t("home.ports.clear")
          : conflicts.map((port) => port.port).join(", ")}
      </WidgetNote>
    </>
  );
}

export const outputWidget: WidgetDefinition = {
  id: "output",
  titleKey: "home.widget.output",
  icon: <Terminal />,
  span: 12,
  scope: "global",
  page: "services",
  render: ({ data }) => <OutputSummary data={data} />,
};

function OutputSummary({ data }: WidgetRenderProps) {
  const t = useT();
  // The payload carries one service's tail, not everything's — so the widget
  // names whose output this is rather than implying it is the whole system's.
  const lines = data.logs.slice(-5);

  if (lines.length === 0) {
    return <WidgetNote>{t("home.output.none")}</WidgetNote>;
  }

  return (
    <>
      <WidgetNote>{t("home.output.from", { service: lines[0].service })}</WidgetNote>
      <span className="flex flex-col gap-0.5 overflow-hidden font-mono text-[10px] leading-relaxed text-foreground/80">
        {lines.map((line) => (
          <span
            className={
              line.stream === "stderr" ? "truncate text-destructive/90" : "truncate"
            }
            key={`${line.timestamp}:${line.text}`}
          >
            {line.text}
          </span>
        ))}
      </span>
    </>
  );
}
