import { Container } from "lucide-react";
import {
  rowCap,
  WidgetLoading,
  WidgetMore,
  WidgetNote,
  WidgetRow,
  WidgetRows,
  WidgetStat,
  WidgetStats,
  type WidgetTone,
} from "@/features/home/widget-grid";
import type { WidgetDefinition, WidgetRenderProps } from "@/features/home/widget-types";
import type { DockerContainerSummary } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useHomeDockerSummary } from "./use-home-docker-summary";

export const dockerWidget: WidgetDefinition = {
  id: "docker",
  titleKey: "home.widget.docker",
  icon: <Container />,
  span: 4,
  scope: "global",
  source: "fetch",
  page: "docker",
  render: ({ height }) => <DockerSummary height={height} />,
};

const ROW_CAP = 4;

function DockerSummary({ height }: Pick<WidgetRenderProps, "height">) {
  const t = useT();
  const { containers, containersLoaded, loaded, status } = useHomeDockerSummary();
  const cap = rowCap(height, ROW_CAP);

  if (!loaded) return <WidgetLoading label={t("common.loading")} />;
  if (!status) return <WidgetNote>{t("home.docker.statusUnavailable")}</WidgetNote>;
  if (!status.available) {
    return (
      <WidgetRows>
        <WidgetRow
          meta={
            status.canStart
              ? t("home.docker.stopped")
              : status.installUrl
                ? t("home.docker.notInstalled")
                : t("home.docker.unavailable")
          }
          name="Docker Desktop"
          tone={status.canStart ? "warn" : "bad"}
        />
      </WidgetRows>
    );
  }
  if (!containersLoaded) {
    return <WidgetNote>{t("home.docker.containersUnavailable")}</WidgetNote>;
  }

  const running = containers.filter(isRunning);
  const stopped = containers.length - running.length;
  const rows = [...containers].sort(
    (left, right) =>
      stateRank(left) - stateRank(right) || left.name.localeCompare(right.name),
  );

  return (
    <>
      <WidgetStats>
        <WidgetStat label={t("home.docker.running")} tone="ok" value={running.length} />
        <WidgetStat label={t("home.docker.stoppedCount")} value={stopped} />
        <WidgetStat label={t("home.docker.total")} value={containers.length} />
      </WidgetStats>
      {rows.length === 0 ? (
        <WidgetNote>{t("home.docker.none")}</WidgetNote>
      ) : (
        <WidgetRows>
          {rows.slice(0, cap).map((container) => (
            <WidgetRow
              key={container.id}
              meta={container.image}
              name={container.name}
              tone={containerTone(container)}
              trailing={container.state}
            />
          ))}
          {rows.length > cap ? (
            <WidgetMore>{t("home.more", { count: rows.length - cap })}</WidgetMore>
          ) : null}
        </WidgetRows>
      )}
    </>
  );
}

function isRunning(container: DockerContainerSummary): boolean {
  return container.state === "running" || container.state === "restarting";
}

function stateRank(container: DockerContainerSummary): number {
  if (container.state === "dead") return 0;
  if (container.state === "restarting") return 1;
  if (container.state === "running") return 2;
  return 3;
}

function containerTone(container: DockerContainerSummary): WidgetTone {
  if (container.state === "running") return "ok";
  if (container.state === "restarting") return "warn";
  if (container.state === "dead") return "bad";
  return "idle";
}
