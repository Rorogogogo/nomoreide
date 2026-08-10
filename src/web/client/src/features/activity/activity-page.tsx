import { Activity, Cpu, Search, Server } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/cvui-badge";
import { Input } from "@/components/ui/input";
import { Loading } from "@/components/ui/loading";
import { useRegisterRefresh } from "@/components/refresh-registry";
import {
  getRemoteHostMetrics,
  listSshServers,
  type DashboardData,
  type HostMetricSample,
  type RemoteProcessMetric,
  type RemoteHostMetrics,
  type SshServerSummary,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ActivitySortHeader, type SortDirection } from "./activity-sort-header";
import { ActivityView, HostOverview } from "./activity-view";
import { EnergyImpactBadge, estimateEnergyImpact } from "./energy-impact";
import {
  metricPressure,
  metricPressureTextClass,
} from "./metric-pressure";

const REMOTE_REFRESH_MS = 5_000;
const REMOTE_PROCESS_BATCH_SIZE = 50;

export function ActivityPage({
  data,
  host,
  onHostChange,
  onOpenService,
  scopeName,
}: {
  data: DashboardData;
  host: string;
  onHostChange: (host: string) => void;
  onOpenService: (name: string) => void;
  scopeName: string | null;
}) {
  const t = useT();
  const [servers, setServers] = useState<SshServerSummary[]>([]);

  const loadServers = useCallback(async () => {
    setServers(await listSshServers().catch(() => []));
  }, []);
  useEffect(() => {
    void loadServers();
  }, [loadServers]);
  useRegisterRefresh(({ manual }) => manual ? loadServers() : undefined);

  const selected = servers.find((server) => server.host === host);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card/75 px-3 py-1.5">
        <Server aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <label className="text-[10px] font-medium text-muted-foreground" htmlFor="activity-host">
          {t("activity.host")}
        </label>
        <select
          className="h-7 min-w-40 rounded border border-border bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          id="activity-host"
          onChange={(event) => onHostChange(event.target.value)}
          value={selected ? host : "local"}
        >
          <option value="local">{t("activity.thisMachine")}</option>
          {servers.map((server) => (
            <option key={server.host} value={server.host}>
              {server.name ?? server.host}{server.environment ? ` · ${server.environment}` : ""}
            </option>
          ))}
        </select>
        {selected ? (
          <Badge appearance="subtle" size="small" variant="secondary">
            SSH · {selected.host}
          </Badge>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {selected ? (
          <RemoteActivityView key={selected.host} server={selected} />
        ) : (
          <ActivityView data={data} onOpenService={onOpenService} scopeName={scopeName} />
        )}
      </div>
    </div>
  );
}

export function RemoteActivityView({ server }: { server: SshServerSummary }) {
  const t = useT();
  const [metrics, setMetrics] = useState<RemoteHostMetrics | null>(null);
  const [samples, setSamples] = useState<HostMetricSample[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    try {
      const next = await getRemoteHostMetrics(server.host);
      if (requestId !== requestIdRef.current) return;
      setMetrics(next);
      setSamples((current) => [...current, next.current].slice(-120));
      setError(null);
    } catch (nextError) {
      if (requestId !== requestIdRef.current) return;
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [server.host]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      await refresh();
      if (!cancelled) timer = window.setTimeout(() => void poll(), REMOTE_REFRESH_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      requestIdRef.current += 1;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refresh]);
  // The remote view owns a completion-aware 5s loop. Only a manual header
  // refresh should run an extra sample; the global 5s cycle would duplicate it.
  useRegisterRefresh(({ manual }) => manual ? refresh() : undefined);

  const current = metrics?.current ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-card/75 px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Activity aria-hidden="true" className="size-3.5 text-muted-foreground" />
            <h2 className="truncate text-sm font-semibold tracking-tight">
              {t("activity.title")}
            </h2>
            <Badge appearance="subtle" size="small" variant="secondary">
              {t("activity.remoteBadge")}
            </Badge>
          </div>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
            {metrics
              ? `${metrics.hostname} · ${metrics.platform} · ssh ${server.host}`
              : `ssh ${server.host}`}
          </p>
        </div>
        {current ? (
          <div
            className="order-3 ml-auto flex w-full items-center justify-end gap-2 overflow-x-auto whitespace-nowrap font-mono text-[9px] tabular-nums text-muted-foreground sm:order-none sm:w-auto"
            role="status"
          >
            <RemoteSummaryStat
              label="CPU"
              tone="text-emerald-600 dark:text-emerald-400"
              value={`${current.cpuPercent.toFixed(1)}%`}
            />
            <SummaryDivider />
            <RemoteSummaryStat
              label={t("activity.memory")}
              tone="text-sky-600 dark:text-sky-400"
              value={`${current.memoryUsedPercent.toFixed(1)}%`}
            />
            <SummaryDivider />
            <RemoteSummaryStat
              label={t("activity.processes")}
              value={String(metrics?.processes.length ?? 0)}
            />
          </div>
        ) : null}
      </header>
      {error ? (
        <Alert aria-live="polite" className="m-3" variant="destructive">
          {t("activity.remoteError", { error })}
        </Alert>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {loading && !metrics ? (
          <Loading fill label={t("activity.remoteLoading")} />
        ) : metrics && current ? (
          <div className="space-y-4 p-4">
            <HostOverview
              current={current}
              headingId="activity-remote-host-heading"
              label={server.name ?? metrics.hostname}
              samples={samples}
            />
            <RemoteProcessTable
              processes={metrics.processes}
              totalMemoryBytes={current.memoryTotalBytes}
            />
          </div>
        ) : (
          <Alert className="m-3" variant="muted">
            {t("activity.collecting")}
          </Alert>
        )}
      </div>
    </div>
  );
}

function RemoteSummaryStat({
  label,
  tone,
  value,
}: {
  label: string;
  tone?: string;
  value: string;
}) {
  return (
    <span className="flex items-center gap-1">
      <span className={cn("font-semibold text-foreground", tone)}>{value}</span>
      {label}
    </span>
  );
}

function SummaryDivider() {
  return <span aria-hidden="true" className="text-border">/</span>;
}

type RemoteProcessSort = "cpu" | "energy" | "memory" | "name";

function RemoteProcessTable({
  processes,
  totalMemoryBytes,
}: {
  processes: RemoteProcessMetric[];
  totalMemoryBytes: number;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<RemoteProcessSort>("cpu");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [visibleCount, setVisibleCount] = useState(REMOTE_PROCESS_BATCH_SIZE);
  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return processes
      .filter((process) =>
        !needle || [String(process.pid), process.user, process.command]
          .some((value) => value.toLocaleLowerCase().includes(needle)),
      )
      .sort((a, b) => {
        const compared =
          sort === "name"
            ? processName(a).localeCompare(processName(b))
            : sort === "energy"
              ? processEnergyScore(a, totalMemoryBytes) -
                processEnergyScore(b, totalMemoryBytes)
              : sort === "memory"
                ? a.rssMb - b.rssMb
                : a.cpuPercent - b.cpuPercent;
        return sortDirection === "asc" ? compared : -compared;
      });
  }, [processes, query, sort, sortDirection, totalMemoryBytes]);
  const visible = rows.slice(0, visibleCount);
  const remaining = Math.max(0, rows.length - visible.length);

  const changeSort = (next: RemoteProcessSort) => {
    if (next === sort) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }
    setSort(next);
    setSortDirection(next === "name" ? "asc" : "desc");
  };

  return (
    <section aria-labelledby="activity-remote-processes-heading">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3
            className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground"
            id="activity-remote-processes-heading"
          >
            <Cpu aria-hidden="true" className="size-3.5" />
            {t("activity.system.title")}
          </h3>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("activity.remoteReadOnly", { count: String(processes.length) })}
          </p>
        </div>
        <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
          <Badge appearance="subtle" size="small" variant="secondary">
            {t("activity.remoteBadge")}
          </Badge>
          <label
            className="relative min-w-44 max-w-64 flex-1 sm:flex-none"
            htmlFor="activity-remote-process-search"
          >
            <span className="sr-only">{t("activity.system.search")}</span>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              className="h-7 pl-7 text-[11px]"
              id="activity-remote-process-search"
              onChange={(event) => {
                setQuery(event.target.value);
                setVisibleCount(REMOTE_PROCESS_BATCH_SIZE);
              }}
              placeholder={t("activity.system.search")}
              value={query}
            />
          </label>
        </div>
      </div>

      <div className="overflow-x-auto border-y border-border/70">
        <table className="w-full min-w-[720px] text-left text-xs">
          <thead className="border-b border-border/60 text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
            <tr>
              <ActivitySortHeader
                active={sort === "name"}
                ariaLabel={t("activity.sortColumn", { column: t("activity.system.process") })}
                direction={sortDirection}
                onClick={() => changeSort("name")}
              >
                {t("activity.system.process")}
              </ActivitySortHeader>
              <th className="px-2 py-2 font-semibold">{t("activity.system.owner")}</th>
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
                ariaLabel={t("activity.sortColumn", { column: t("activity.memory") })}
                direction={sortDirection}
                onClick={() => changeSort("memory")}
              >
                {t("activity.memory")}
              </ActivitySortHeader>
              <ActivitySortHeader
                active={sort === "energy"}
                align="right"
                ariaLabel={t("activity.sortColumn", { column: t("activity.energy.title") })}
                direction={sortDirection}
                onClick={() => changeSort("energy")}
              >
                {t("activity.energy.title")}
              </ActivitySortHeader>
            </tr>
          </thead>
          <tbody>
            {visible.map((process) => {
              const memory = memoryPercent(process.rssMb, totalMemoryBytes);
              return (
                <tr
                  className="border-b border-border/50 transition-colors hover:bg-muted/20 last:border-b-0"
                  key={process.pid}
                >
                  <td className="max-w-[420px] px-2 py-2">
                    <div className="truncate font-medium" title={process.command}>
                      {processName(process)}
                    </div>
                    <div
                      className="mt-0.5 truncate font-mono text-[9px] text-muted-foreground"
                      title={process.command}
                    >
                      {process.command}
                    </div>
                  </td>
                  <td className="px-2 py-2 font-mono text-[10px] text-muted-foreground">
                    {process.user} · {process.pid}
                  </td>
                  <td
                    className={cn(
                      "px-2 py-2 text-right font-mono font-semibold tabular-nums",
                      metricPressureTextClass(process.cpuPercent),
                    )}
                    data-pressure={metricPressure(process.cpuPercent)}
                  >
                    {process.cpuPercent.toFixed(1)}%
                  </td>
                  <td
                    className={cn(
                      "px-2 py-2 text-right font-mono font-semibold tabular-nums",
                      metricPressureTextClass(memory),
                    )}
                    data-pressure={metricPressure(memory)}
                  >
                    {formatMb(process.rssMb)}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <EnergyImpactBadge
                      cpuPercent={process.cpuPercent}
                      memoryPercent={memory}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            {t("activity.system.empty")}
          </div>
        ) : null}
        {remaining > 0 ? (
          <div className="flex items-center justify-center border-t border-border/60 px-3 py-2">
            <button
              className="rounded px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() =>
                setVisibleCount((current) => current + REMOTE_PROCESS_BATCH_SIZE)
              }
              type="button"
            >
              {t("activity.system.loadMore", {
                count: String(Math.min(REMOTE_PROCESS_BATCH_SIZE, remaining)),
              })}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function formatMb(value: number): string {
  return value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${value.toFixed(1)} MB`;
}

function memoryPercent(rssMb: number, totalMemoryBytes: number): number | null {
  if (totalMemoryBytes <= 0) return null;
  return (rssMb * 1024 * 1024 * 100) / totalMemoryBytes;
}

function processName(process: RemoteProcessMetric): string {
  const executable = process.command.trim().split(/\s+/, 1)[0] ?? process.command;
  return executable.split("/").at(-1) || executable;
}

function processEnergyScore(
  process: RemoteProcessMetric,
  totalMemoryBytes: number,
): number {
  return estimateEnergyImpact(
    process.cpuPercent,
    memoryPercent(process.rssMb, totalMemoryBytes),
  ).score;
}
