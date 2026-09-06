import { ArrowUp, Server } from "lucide-react";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import type {
  ServiceActivityMetric,
  ServiceDefinition,
  ServiceStatus,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ActivitySortHeader, type SortDirection } from "./activity-sort-header";
import type { SortKey } from "./activity-sort-keys";
import { formatDuration, formatMb, } from "./activity-format";
import { EnergyImpactBadge, estimateEnergyImpact } from "./energy-impact";
import {
  metricPressure,
  metricPressureBarClass,
  metricPressureTextClass,
} from "./metric-pressure";

/**
 * Per-service CPU, memory and energy, sorted by the column the user picked.
 *
 * Its own module for the same reason as the host panel: it renders the service
 * rows and nothing else, so `activity-view.tsx` is left holding the data
 * fetching and the page layout.
 */

export function ServiceActivityTable({
  definitions,
  metrics,
  onOpenService,
  runtime,
  setSort,
  setSortDirection,
  sort,
  sortDirection,
  totalMemoryBytes,
}: {
  definitions: ServiceDefinition[];
  metrics: Record<string, ServiceActivityMetric>;
  onOpenService: (name: string) => void;
  runtime: Record<string, ServiceStatus>;
  setSort: (sort: SortKey) => void;
  setSortDirection: (direction: SortDirection) => void;
  sort: SortKey;
  sortDirection: SortDirection;
  totalMemoryBytes: number;
}) {
  const t = useT();
  const rows = useMemo(
    () =>
      definitions
        .map((definition) => ({
          definition,
          metric: metrics[definition.name],
          status: runtime[definition.name],
        }))
        .sort((a, b) => {
          const compared =
            sort === "name"
              ? a.definition.name.localeCompare(b.definition.name)
              : sort === "energy"
                ? serviceEnergyScore(a.metric, totalMemoryBytes) -
                  serviceEnergyScore(b.metric, totalMemoryBytes)
              : sort === "memory"
                ? (a.metric?.rssMb ?? -1) - (b.metric?.rssMb ?? -1)
                : (a.metric?.cpuPercent ?? -1) - (b.metric?.cpuPercent ?? -1);
          return sortDirection === "asc" ? compared : -compared;
        }),
    [definitions, metrics, runtime, sort, sortDirection, totalMemoryBytes],
  );

  const changeSort = (next: SortKey) => {
    if (next === sort) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
      return;
    }
    setSort(next);
    setSortDirection(next === "name" ? "asc" : "desc");
  };

  return (
    <section aria-labelledby="activity-services-heading">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3
            className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground"
            id="activity-services-heading"
          >
            <Server className="size-3.5" />
            {t("activity.managedServices")}
          </h3>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("activity.managedOnly")}
          </p>
        </div>
      </div>

      <div className="overflow-x-auto border-y border-border/70">
        <table className="w-full min-w-[820px] text-left text-xs">
          <thead className="border-b border-border/60 text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
            <tr>
              <ActivitySortHeader
                active={sort === "name"}
                ariaLabel={t("activity.sortColumn", {
                  column: t("activity.service"),
                })}
                direction={sortDirection}
                onClick={() => changeSort("name")}
              >
                {t("activity.service")}
              </ActivitySortHeader>
              <th className="px-2 py-2 font-semibold">{t("activity.state")}</th>
              <ActivitySortHeader
                active={sort === "cpu"}
                align="right"
                ariaLabel={t("activity.sortColumn", { column: "CPU" })}
                direction={sortDirection}
                onClick={() => changeSort("cpu")}
              >
                CPU
              </ActivitySortHeader>
              <ActivitySortHeader
                active={sort === "memory"}
                align="right"
                ariaLabel={t("activity.sortColumn", {
                  column: t("activity.memory"),
                })}
                direction={sortDirection}
                onClick={() => changeSort("memory")}
              >
                {t("activity.memory")}
              </ActivitySortHeader>
              <ActivitySortHeader
                active={sort === "energy"}
                align="right"
                ariaLabel={t("activity.sortColumn", {
                  column: t("activity.energy.title"),
                })}
                direction={sortDirection}
                onClick={() => changeSort("energy")}
              >
                {t("activity.energy.title")}
              </ActivitySortHeader>
              <th className="px-2 py-2 text-right font-semibold">{t("activity.processes")}</th>
              <th className="px-2 py-2 text-right font-semibold">{t("activity.uptimeLabel")}</th>
              <th className="w-10 px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ definition, metric, status }) => {
              const local = (definition.kind ?? "local") === "local";
              const docker = definition.kind === "docker-compose";
              const running = status?.state === "running";
              const measurable = (local || docker) && running && metric;
              const memoryPressure = measurable
                ? metric.memoryPercent ??
                  (totalMemoryBytes > 0
                    ? (metric.rssMb * 1024 * 1024 * 100) / totalMemoryBytes
                    : null)
                : null;
              return (
                <tr
                  className="group border-b border-border/50 transition-colors hover:bg-muted/20 last:border-b-0"
                  key={definition.name}
                >
                  <td className="max-w-[280px] px-2 py-2.5">
                    <button
                      className="block max-w-full truncate rounded-sm font-semibold tracking-tight hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => onOpenService(definition.name)}
                      type="button"
                    >
                      {definition.name}
                    </button>
                    <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                      <Badge size="small" variant="outline">
                        {definition.kind === "docker-compose"
                          ? "DOCKER"
                          : definition.kind === "ssh"
                            ? `SSH · ${definition.host ?? "remote"}`
                            : "LOCAL"}
                      </Badge>
                      {definition.description ? ` · ${definition.description}` : ""}
                    </div>
                  </td>
                  <td className="px-2 py-2.5">
                    <ServiceState state={status?.state ?? "stopped"} />
                  </td>
                  <td className="px-2 py-2.5 text-right">
                    <MetricCell
                      percent={measurable ? metric.cpuPercent : null}
                      unavailable={!local && (!docker || !measurable)}
                      value={measurable ? `${metric.cpuPercent.toFixed(1)}%` : "—"}
                    />
                  </td>
                  <td className="px-2 py-2.5 text-right">
                    <MetricCell
                      percent={
                        memoryPressure
                      }
                      unavailable={!local && (!docker || !measurable)}
                      value={measurable ? formatMb(metric.rssMb) : "—"}
                    />
                  </td>
                  <td className="px-2 py-2.5 text-right">
                    {measurable ? (
                      <EnergyImpactBadge
                        cpuPercent={metric.cpuPercent}
                        memoryPercent={memoryPressure}
                      />
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-2 py-2.5 text-right font-mono tabular-nums">
                    {measurable ? metric.processCount ?? "—" : "—"}
                  </td>
                  <td className="px-2 py-2.5 text-right font-mono tabular-nums text-muted-foreground">
                    {running && status.startedAt
                      ? formatDuration(Date.now() - new Date(status.startedAt).getTime())
                      : "—"}
                  </td>
                  <td className="px-2 py-2.5 text-muted-foreground">
                    <span className="flex size-6 items-center justify-center rounded-md transition-colors group-hover:bg-primary/10 group-hover:text-primary">
                      <ArrowUp className="size-3.5 rotate-45 opacity-40 transition-opacity group-hover:opacity-100" />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            {t("activity.noServices")}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function serviceEnergyScore(
  metric: ServiceActivityMetric | undefined,
  totalMemoryBytes: number,
): number {
  if (!metric) return -1;
  const memoryPercent =
    metric.memoryPercent ??
    (totalMemoryBytes > 0
      ? (metric.rssMb * 1024 * 1024 * 100) / totalMemoryBytes
      : null);
  return estimateEnergyImpact(metric.cpuPercent, memoryPercent).score;
}

function MetricCell({
  percent,
  unavailable,
  value,
}: {
  percent: number | null;
  unavailable: boolean;
  value: string;
}) {
  const t = useT();
  return (
    <div
      className="ml-auto w-28"
      title={unavailable ? t("activity.externalUnavailable") : undefined}
    >
      <span
        className={cn(
          "font-mono font-semibold tabular-nums",
          metricPressureTextClass(percent),
        )}
        data-pressure={metricPressure(percent)}
      >
        {value}
      </span>
      <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-muted">
        <span
          className={cn(
            "block h-full rounded-full transition-[width] duration-500",
            metricPressureBarClass(percent),
          )}
          style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }}
        />
      </span>
    </div>
  );
}

function ServiceState({ state }: { state: ServiceStatus["state"] }) {
  const t = useT();
  const variant =
    state === "running" ? "success" : state === "exited" ? "danger" : "secondary";
  return (
    <Badge size="small" variant={variant}>
      {t(`activity.state.${state}`)}
    </Badge>
  );
}
