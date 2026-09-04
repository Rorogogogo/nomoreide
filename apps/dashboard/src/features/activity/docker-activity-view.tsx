import { Box, Search } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Loading } from "@/components/ui/loading";
import { useRegisterRefresh } from "@/components/refresh-registry";
import {
  getDockerContainers,
  getDockerStats,
  getDockerStatus,
  type DockerContainerStats,
  type DockerContainerSummary,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ActivitySortHeader, type SortDirection } from "./activity-sort-header";
import { metricPressureTextClass } from "./metric-pressure";

type DockerSort = "cpu" | "memory" | "name";

const REFRESH_MS = 5_000;

/**
 * Containers as a monitoring source, beside this machine and the SSH hosts.
 *
 * A container is a process the host's own process table describes badly: it
 * shows up under a runtime's pid with none of the names anybody uses, so the
 * Activity page could already see the *cost* of a container and never say which
 * one it was. `docker stats` is the only view that names them.
 *
 * Polled rather than streamed, and only while this source is the selected one.
 * `docker stats --no-stream` shells out per call and is the most expensive
 * question this page asks — running it for a source nobody is looking at is how
 * a monitoring page becomes the thing worth monitoring.
 */
export function DockerActivityView({
  headerControl,
}: {
  headerControl?: ReactNode;
}) {
  const t = useT();
  const [containers, setContainers] = useState<DockerContainerSummary[]>([]);
  const [stats, setStats] = useState<DockerContainerStats[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<DockerSort>("cpu");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  /**
   * Clicking a new column sorts it the way that column is usually read —
   * biggest-first for a cost, A-Z for a name — and clicking the active one
   * flips it.
   */
  const changeSort = useCallback(
    (next: DockerSort) => {
      setSortDirection((current) =>
        sort === next
          ? current === "asc"
            ? "desc"
            : "asc"
          : next === "name"
            ? "asc"
            : "desc",
      );
      setSort(next);
    },
    [sort],
  );

  const refresh = useCallback(async () => {
    try {
      const status = await getDockerStatus();
      setAvailable(status.available);
      if (!status.available) {
        setContainers([]);
        setStats([]);
        setError(status.error ?? null);
        return;
      }
      // Both together: a container that appears between the two calls would
      // otherwise be a row with no usage, or usage with no row.
      const [nextContainers, nextStats] = await Promise.all([
        getDockerContainers(),
        getDockerStats(),
      ]);
      setContainers(nextContainers);
      setStats(nextStats);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  useRegisterRefresh(refresh);

  const usage = useMemo(
    () => new Map(stats.map((entry) => [entry.id, entry])),
    [stats],
  );

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = containers.filter((container) =>
      needle
        ? `${container.name} ${container.image} ${container.service ?? ""}`
            .toLowerCase()
            .includes(needle)
        : true,
    );
    const direction = sortDirection === "asc" ? 1 : -1;
    return [...matched].sort((left, right) => {
      if (sort === "name") {
        return left.name.localeCompare(right.name) * direction;
      }
      const key = sort === "cpu" ? "cpuPercent" : "memoryPercent";
      // A container with no reading sorts last whichever way the column points:
      // "unknown" is not a small number, and floating it to the top of a
      // descending sort would put the least informative rows first.
      const leftValue = usage.get(left.id)?.[key] ?? null;
      const rightValue = usage.get(right.id)?.[key] ?? null;
      if (leftValue === null && rightValue === null) return 0;
      if (leftValue === null) return 1;
      if (rightValue === null) return -1;
      return (leftValue - rightValue) * direction;
    });
  }, [containers, query, sort, sortDirection, usage]);

  const totals = useMemo(() => {
    let cpu = 0;
    let memory = 0;
    for (const container of containers) {
      const entry = usage.get(container.id);
      cpu += entry?.cpuPercent ?? 0;
      memory += entry?.memoryPercent ?? 0;
    }
    return { cpu, memory };
  }, [containers, usage]);

  const running = containers.filter(
    (container) => container.state === "running",
  ).length;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-card/75 px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Box aria-hidden="true" className="size-3.5 text-muted-foreground" />
            <h2 className="truncate text-sm font-semibold tracking-tight">
              {t("activity.docker.title")}
            </h2>
            {headerControl}
          </div>
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
            {t("activity.docker.subtitle")}
          </p>
        </div>
        <div
          className="order-3 ml-auto flex w-full items-center justify-end gap-2 whitespace-nowrap font-mono text-[9px] tabular-nums text-muted-foreground sm:order-none sm:w-auto"
          role="status"
        >
          <span>
            {running} {t("activity.running")}
          </span>
          <span aria-hidden="true">·</span>
          <span className="text-emerald-600 dark:text-emerald-400">
            {totals.cpu.toFixed(1)}% CPU
          </span>
          <span aria-hidden="true">·</span>
          <span className="text-sky-600 dark:text-sky-400">
            {totals.memory.toFixed(1)}% {t("activity.memory")}
          </span>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {loading && available === null ? (
          <Loading fill label={t("activity.docker.loading")} />
        ) : available === false ? (
          <Alert variant="muted">{t("activity.docker.unavailable")}</Alert>
        ) : (
          <>
            {error ? (
              <Alert className="mb-3" variant="destructive">
                {t("activity.loadError", { error })}
              </Alert>
            ) : null}

            <div className="mb-2 flex items-center gap-2">
              <Search
                aria-hidden="true"
                className="size-3 shrink-0 text-muted-foreground"
              />
              <Input
                aria-label={t("activity.docker.filter")}
                className="h-6 text-[11px]"
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("activity.docker.filter")}
                value={query}
              />
            </div>

            {rows.length === 0 ? (
              <Alert variant="muted">{t("activity.docker.empty")}</Alert>
            ) : (
              <table className="w-full border-collapse text-[11px]">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <ActivitySortHeader
                      active={sort === "name"}
                      ariaLabel={t("activity.sortColumn", {
                        column: t("activity.docker.container"),
                      })}
                      direction={sortDirection}
                      onClick={() => changeSort("name")}
                    >
                      {t("activity.docker.container")}
                    </ActivitySortHeader>
                    <ActivitySortHeader
                      active={sort === "cpu"}
                      ariaLabel={t("activity.sortColumn", { column: "CPU" })}
                      direction={sortDirection}
                      onClick={() => changeSort("cpu")}
                    >
                      CPU
                    </ActivitySortHeader>
                    <ActivitySortHeader
                      active={sort === "memory"}
                      ariaLabel={t("activity.sortColumn", {
                        column: t("activity.memory"),
                      })}
                      direction={sortDirection}
                      onClick={() => changeSort("memory")}
                    >
                      {t("activity.memory")}
                    </ActivitySortHeader>
                    <th className="px-2 py-1 font-medium">
                      {t("activity.docker.netIo")}
                    </th>
                    <th className="px-2 py-1 font-medium">
                      {t("activity.docker.blockIo")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((container) => {
                    const entry = usage.get(container.id);
                    return (
                      <tr
                        className="border-b border-border/50 last:border-0"
                        key={container.id}
                      >
                        <td className="max-w-56 px-2 py-1">
                          <div className="truncate font-medium text-foreground">
                            {container.name}
                          </div>
                          <div className="truncate text-[10px] text-muted-foreground">
                            {container.image}
                          </div>
                        </td>
                        <MetricCell percent={entry?.cpuPercent ?? null} />
                        <td className="px-2 py-1 font-mono tabular-nums">
                          <span
                            className={cn(
                              metricPressureTextClass(entry?.memoryPercent ?? null),
                            )}
                          >
                            {formatPercent(entry?.memoryPercent ?? null)}
                          </span>
                          <span className="ml-1 text-[10px] text-muted-foreground">
                            {entry?.memoryUsage ?? "—"}
                          </span>
                        </td>
                        <td className="px-2 py-1 font-mono text-[10px] tabular-nums text-muted-foreground">
                          {entry?.netIo ?? "—"}
                        </td>
                        <td className="px-2 py-1 font-mono text-[10px] tabular-nums text-muted-foreground">
                          {entry?.blockIo ?? "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function MetricCell({ percent }: { percent: number | null }) {
  return (
    <td className="px-2 py-1 font-mono tabular-nums">
      <span className={cn(metricPressureTextClass(percent))}>
        {formatPercent(percent)}
      </span>
    </td>
  );
}

/**
 * An em dash, not `0.0%`.
 *
 * A stopped container has no reading, and printing zero for it says the
 * container is running and idle — the opposite of what is true.
 */
function formatPercent(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}
