import {
  Activity,
  ArrowUp,
  ChartPie,
  CircleGauge,
  Clock3,
  Database,
  Gauge,
  Loader2,
  Server,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { useRegisterRefresh } from "@/components/refresh-registry";
import {
  getActivityMetrics,
  type ActivityMetrics,
  type DashboardData,
  type HostMetricSample,
  type ServiceActivityMetric,
  type ServiceDefinition,
  type ServiceStatus,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type SortKey = "cpu" | "memory" | "name";

const HISTORY_PLOT_TOP = 4;
const HISTORY_PLOT_BOTTOM = 96;

export function ActivityView({
  data,
  onOpenService,
  scopeName,
}: {
  data: DashboardData;
  onOpenService: (name: string) => void;
  scopeName?: string | null;
}) {
  const t = useT();
  const { metrics, loading, error, refresh } = useActivityMetrics();
  const [sort, setSort] = useState<SortKey>("cpu");
  useRegisterRefresh(refresh);

  const serviceNames = useMemo(
    () => new Set(data.config.services.map((service) => service.name)),
    [data.config.services],
  );
  const visibleMetrics = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(metrics?.services ?? {}).filter(([name]) =>
          serviceNames.has(name),
        ),
      ),
    [metrics?.services, serviceNames],
  );
  const totals = useMemo(
    () =>
      Object.values(visibleMetrics).reduce(
        (summary, service) => ({
          cpu: summary.cpu + service.cpuPercent,
          memory: summary.memory + service.rssMb,
          processes: summary.processes + service.processCount,
        }),
        { cpu: 0, memory: 0, processes: 0 },
      ),
    [visibleMetrics],
  );
  const current = metrics?.host.current ?? null;
  const runningCount = Object.values(data.runtime.services).filter(
    (service) => service.state === "running",
  ).length;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-card/75 px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Activity aria-hidden="true" className="size-3.5 text-muted-foreground" />
            <h2 className="truncate text-sm font-semibold tracking-tight">
              {t("activity.title")}
            </h2>
            <HostStateBadge sample={current} />
          </div>
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
            {scopeName
              ? t("activity.scopeProject", { project: scopeName })
              : t("activity.scopeAll")}
          </p>
        </div>
        <div
          aria-label={t("activity.managedSummary")}
          className="order-3 ml-auto flex w-full items-center justify-end gap-2 overflow-x-auto whitespace-nowrap font-mono text-[9px] tabular-nums text-muted-foreground sm:order-none sm:w-auto"
          role="status"
        >
          <SummaryStat label={t("activity.running")} value={String(runningCount)} />
          <SummaryDivider />
          <SummaryStat
            label="CPU"
            tone="text-emerald-600 dark:text-emerald-400"
            value={`${totals.cpu.toFixed(1)}%`}
          />
          <SummaryDivider />
          <SummaryStat
            label={t("activity.memory")}
            tone="text-sky-600 dark:text-sky-400"
            value={formatMb(totals.memory)}
          />
          <SummaryDivider />
          <SummaryStat
            label={t("activity.processes")}
            value={String(totals.processes)}
          />
          <span className="sr-only">
            {runningCount} {t("activity.running")}, {totals.cpu.toFixed(1)}% CPU,{" "}
            {formatMb(totals.memory)}, {totals.processes} {t("activity.processes")}
          </span>
        </div>
      </header>

      {error ? (
        <Alert className="m-3 shrink-0" variant="destructive">
          {t("activity.loadError", { error })}
        </Alert>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && !metrics ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("activity.loading")}
          </div>
        ) : metrics && current ? (
          <div className="space-y-4 p-4">
            <HostOverview current={current} samples={metrics.host.samples} />
            <ServiceActivityTable
              definitions={data.config.services}
              metrics={visibleMetrics}
              onOpenService={onOpenService}
              runtime={data.runtime.services}
              sort={sort}
              setSort={setSort}
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

function useActivityMetrics() {
  const [metrics, setMetrics] = useState<ActivityMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const currentRequest = ++requestId.current;
    try {
      const next = await getActivityMetrics();
      if (currentRequest !== requestId.current) return;
      setMetrics(next);
      setError(null);
    } catch (caught) {
      if (currentRequest !== requestId.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const tick = async () => {
      if (!active) return;
      await refresh();
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 3000);
    return () => {
      active = false;
      requestId.current += 1;
      window.clearInterval(timer);
    };
  }, [refresh]);

  return { metrics, loading, error, refresh };
}

function SummaryStat({
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
      <span
        className={cn(
          "font-semibold text-foreground",
          tone,
        )}
      >
        {value}
      </span>
      {label}
    </span>
  );
}

function SummaryDivider() {
  return (
    <span aria-hidden="true" className="text-border">
      /
    </span>
  );
}

function HostOverview({
  current,
  samples,
}: {
  current: HostMetricSample;
  samples: HostMetricSample[];
}) {
  const t = useT();
  const load = current.loadAverage?.[0];
  const normalizedLoad =
    load === undefined || current.logicalCpuCount === 0
      ? null
      : Math.min(100, (load / current.logicalCpuCount) * 100);

  return (
    <section aria-labelledby="activity-host-heading">
      <div className="mb-3 flex items-center justify-between">
        <h3
          className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground"
          id="activity-host-heading"
        >
          <CircleGauge className="size-3.5" />
          {t("activity.thisMachine")}
        </h3>
        <span className="font-mono text-[10px] text-muted-foreground">
          {t("activity.sampled", {
            time: new Date(current.t).toLocaleTimeString(),
          })}
        </span>
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_260px]">
        <div className="overflow-hidden border-y border-border/70">
          <div className="grid divide-y divide-border md:grid-cols-3 md:divide-x md:divide-y-0">
            <GaugeCard
              icon={<Gauge />}
              label="CPU"
              percent={current.cpuPercent}
              value={
                current.cpuPercent === null
                  ? t("activity.collectingShort")
                  : `${current.cpuPercent.toFixed(1)}%`
              }
              detail={t("activity.logicalCpus", {
                count: String(current.logicalCpuCount),
              })}
              tone="emerald"
            />
            <GaugeCard
              icon={<ChartPie />}
              label={t("activity.memory")}
              percent={current.memoryUsedPercent}
              value={`${current.memoryUsedPercent.toFixed(1)}%`}
              detail={`${formatBytes(current.memoryUsedBytes)} / ${formatBytes(current.memoryTotalBytes)}`}
              tone="sky"
            />
            <GaugeCard
              icon={<Database />}
              label={t("activity.disk")}
              percent={current.disk?.usedPercent ?? null}
              value={
                current.disk
                  ? `${current.disk.usedPercent.toFixed(1)}%`
                  : t("activity.unavailable")
              }
              detail={
                current.disk
                  ? `${formatBytes(current.disk.usedBytes)} / ${formatBytes(current.disk.totalBytes)}`
                  : t("activity.diskUnavailable")
              }
              tone="amber"
            />
          </div>
          <HostHistoryChart samples={samples} />
        </div>
        <aside className="overflow-hidden border-y border-border/70">
          <div className="border-b border-border px-3 py-2.5">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <Clock3 className="size-3.5" />
              {t("activity.loadUptime")}
            </div>
            <div className="mt-3 flex items-end justify-between gap-3">
              <div>
                <div className="font-mono text-2xl font-semibold tracking-tight tabular-nums">
                  {load === undefined ? "—" : load.toFixed(2)}
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground">
                  {t("activity.logicalCpus", {
                    count: String(current.logicalCpuCount),
                  })}
                </div>
              </div>
              <MiniLoadGauge percent={normalizedLoad} />
            </div>
          </div>
          <MachineDetail
            label={t("activity.uptimeLabel")}
            value={formatDuration(current.uptimeSeconds * 1000)}
          />
          <MachineDetail
            label={t("activity.available", { value: "" }).trim()}
            value={
              current.disk
                ? formatBytes(current.disk.availableBytes)
                : t("activity.unavailable")
            }
          />
          <MachineDetail
            label={t("activity.sampled", { time: "" }).trim()}
            value={new Date(current.t).toLocaleTimeString()}
          />
        </aside>
      </div>
    </section>
  );
}

function MachineDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2.5 last:border-b-0">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-[11px] font-semibold tabular-nums">
        {value}
      </span>
    </div>
  );
}

function MiniLoadGauge({ percent }: { percent: number | null }) {
  const progress = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <div
      aria-label={`${Math.round(progress)}%`}
      className="relative size-14 rounded-full"
      role="img"
    >
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: `conic-gradient(hsl(var(--primary)) ${progress * 3.6}deg, hsl(var(--muted)) 0deg)`,
        }}
      />
      <div className="absolute inset-[5px] flex items-center justify-center rounded-full bg-background font-mono text-[9px] font-semibold tabular-nums">
        {percent === null ? "—" : `${Math.round(progress)}%`}
      </div>
    </div>
  );
}

function GaugeCard({
  detail,
  icon,
  label,
  percent,
  tone,
  value,
}: {
  detail: string;
  icon: React.ReactNode;
  label: string;
  percent: number | null;
  tone: "amber" | "emerald" | "sky" | "violet";
  value: string;
}) {
  const progress = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  const circumference = 2 * Math.PI * 38;
  const dashOffset = circumference * (1 - progress / 100);
  return (
    <div className="relative min-h-36 overflow-hidden px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 self-stretch">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            <span
              className={cn(
                "flex size-4 items-center justify-center [&_svg]:size-4",
                toneClassName(tone, "icon"),
              )}
            >
              {icon}
            </span>
            {label}
          </div>
          <div className="mt-4 truncate font-mono text-xl font-semibold tracking-tight tabular-nums">
            {value}
          </div>
          <div className="mt-1 max-w-36 truncate font-mono text-[10px] text-muted-foreground">
            {detail}
          </div>
        </div>
        <div className="relative size-24 shrink-0">
          <svg
            aria-hidden="true"
            className="-rotate-90 size-24 overflow-visible"
            viewBox="0 0 96 96"
          >
            <circle
              className="stroke-muted"
              cx="48"
              cy="48"
              fill="none"
              r="38"
              strokeWidth="7"
            />
            <circle
              className={cn(
                "transition-[stroke-dashoffset] duration-700 ease-out",
                toneClassName(tone, "stroke"),
              )}
              cx="48"
              cy="48"
              fill="none"
              r="38"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              strokeLinecap="round"
              strokeWidth="7"
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center font-mono text-[10px] font-semibold tabular-nums text-muted-foreground">
            {percent === null ? "—" : `${Math.round(progress)}`}
          </div>
        </div>
      </div>
    </div>
  );
}

function HostHistoryChart({ samples }: { samples: HostMetricSample[] }) {
  const t = useT();
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const recent = samples.slice(-120);
  if (recent.length < 2) {
    return (
      <div className="border-t border-dashed border-border px-4 py-5 text-xs text-muted-foreground">
        {t("activity.historyCollecting")}
      </div>
    );
  }
  const cpuPath = chartPath(
    recent.map((sample) => sample.cpuPercent),
    recent.length,
  );
  const memoryPath = chartPath(
    recent.map((sample) => sample.memoryUsedPercent),
    recent.length,
  );
  const duration = (recent.at(-1)?.t ?? recent[0].t) - recent[0].t;
  const inspected =
    hoveredIndex === null ? recent.at(-1) : recent[hoveredIndex];
  const inspectedX =
    hoveredIndex === null
      ? null
      : (hoveredIndex / Math.max(1, recent.length - 1)) * 100;

  const inspectPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(
      1,
      Math.max(0, (event.clientX - bounds.left) / bounds.width),
    );
    setHoveredIndex(Math.round(ratio * (recent.length - 1)));
  };

  return (
    <figure className="border-t border-border px-3 pb-3 pt-3">
      <figcaption className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {t("activity.machineHistory")}
          </div>
          <div className="mt-1 font-mono text-[10px] text-muted-foreground">
            {formatDuration(duration)} · {recent.length} samples
          </div>
        </div>
        <span className="flex items-center gap-4 font-mono text-[10px] tabular-nums">
          <span className="flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgb(16_185_129/0.65)]" />
            <span className="text-muted-foreground">CPU</span>
            <span className="font-semibold text-foreground">
              {inspected?.cpuPercent === null ||
              inspected?.cpuPercent === undefined
                ? "—"
                : `${inspected.cpuPercent.toFixed(1)}%`}
            </span>
          </span>
          <span className="flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-sky-500 shadow-[0_0_8px_rgb(14_165_233/0.65)]" />
            <span className="text-muted-foreground">{t("activity.memory")}</span>
            <span className="font-semibold text-foreground">
              {inspected
                ? `${inspected.memoryUsedPercent.toFixed(1)}%`
                : "—"}
            </span>
          </span>
        </span>
      </figcaption>
      <div
        className="relative h-40 touch-none overflow-hidden rounded-lg border border-border/70 bg-background/65"
        onPointerLeave={() => setHoveredIndex(null)}
        onPointerMove={inspectPointer}
      >
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--border)/0.28)_1px,transparent_1px)] bg-[size:12.5%_100%]" />
        {[25, 50, 75].map((value) => (
          <span
            className="pointer-events-none absolute inset-x-0 border-t border-dashed border-border/50"
            key={value}
            style={{ top: `${historyPlotY(value)}%` }}
          />
        ))}
        {[100, 50, 0].map((value) => (
          <span
            className="pointer-events-none absolute left-2 z-10 -translate-y-1/2 rounded bg-background/70 px-1 font-mono text-[8px] text-muted-foreground"
            key={value}
            style={{ top: `${historyPlotY(value)}%` }}
          >
            {value}
          </span>
        ))}
        <svg
          aria-label={t("activity.machineHistoryAria")}
          className="absolute inset-0 h-full w-full"
          preserveAspectRatio="none"
          role="img"
          viewBox="0 0 1000 100"
        >
          <defs>
            <linearGradient id="activity-memory-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#0ea5e9" stopOpacity="0.24" />
              <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path
            d={`${memoryPath} L1000,${HISTORY_PLOT_BOTTOM} L0,${HISTORY_PLOT_BOTTOM} Z`}
            fill="url(#activity-memory-fill)"
            stroke="none"
          />
          <path
            d={memoryPath}
            fill="none"
            stroke="#0ea5e9"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
          {cpuPath ? (
            <path
              d={cpuPath}
              fill="none"
              stroke="#10b981"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
        {inspectedX !== null ? (
          <span
            className="pointer-events-none absolute inset-y-0 z-20 w-px bg-foreground/35"
            style={{ left: `${inspectedX}%` }}
          >
            <span className="absolute -left-1 top-[calc(50%-4px)] size-2 rounded-full border-2 border-background bg-foreground shadow-sm" />
          </span>
        ) : null}
      </div>
    </figure>
  );
}

function ServiceActivityTable({
  definitions,
  metrics,
  onOpenService,
  runtime,
  setSort,
  sort,
  totalMemoryBytes,
}: {
  definitions: ServiceDefinition[];
  metrics: Record<string, ServiceActivityMetric>;
  onOpenService: (name: string) => void;
  runtime: Record<string, ServiceStatus>;
  setSort: (sort: SortKey) => void;
  sort: SortKey;
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
          if (sort === "name") return a.definition.name.localeCompare(b.definition.name);
          if (sort === "memory") {
            return (b.metric?.rssMb ?? -1) - (a.metric?.rssMb ?? -1);
          }
          return (b.metric?.cpuPercent ?? -1) - (a.metric?.cpuPercent ?? -1);
        }),
    [definitions, metrics, runtime, sort],
  );

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
        <fieldset className="flex items-center gap-1">
          <legend className="sr-only">{t("activity.sortBy")}</legend>
          {(["cpu", "memory", "name"] as const).map((key) => (
            <button
              aria-pressed={sort === key}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                sort === key
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
              key={key}
              onClick={() => setSort(key)}
              type="button"
            >
              {t(`activity.sort.${key}`)}
            </button>
          ))}
        </fieldset>
      </div>

      <div className="overflow-x-auto border-y border-border/70">
        <table className="w-full min-w-[720px] text-left text-xs">
          <thead className="border-b border-border/60 text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
            <tr>
              <th className="px-2 py-2 font-semibold">{t("activity.service")}</th>
              <th className="px-2 py-2 font-semibold">{t("activity.state")}</th>
              <th className="px-2 py-2 text-right font-semibold">CPU</th>
              <th className="px-2 py-2 text-right font-semibold">{t("activity.memory")}</th>
              <th className="px-2 py-2 text-right font-semibold">{t("activity.processes")}</th>
              <th className="px-2 py-2 text-right font-semibold">{t("activity.uptimeLabel")}</th>
              <th className="w-10 px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ definition, metric, status }) => {
              const local = (definition.kind ?? "local") === "local";
              const running = status?.state === "running";
              const measurable = local && running && metric;
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
                      {definition.kind ?? "local"}
                      {definition.description ? ` · ${definition.description}` : ""}
                    </div>
                  </td>
                  <td className="px-2 py-2.5">
                    <ServiceState state={status?.state ?? "stopped"} />
                  </td>
                  <td className="px-2 py-2.5 text-right">
                    <MetricCell
                      percent={measurable ? metric.cpuPercent : null}
                      tone="emerald"
                      unavailable={!local}
                      value={measurable ? `${metric.cpuPercent.toFixed(1)}%` : "—"}
                    />
                  </td>
                  <td className="px-2 py-2.5 text-right">
                    <MetricCell
                      percent={
                        measurable && totalMemoryBytes > 0
                          ? (metric.rssMb * 1024 * 1024 * 100) / totalMemoryBytes
                          : null
                      }
                      tone="sky"
                      unavailable={!local}
                      value={measurable ? formatMb(metric.rssMb) : "—"}
                    />
                  </td>
                  <td className="px-2 py-2.5 text-right font-mono tabular-nums">
                    {measurable ? metric.processCount : "—"}
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

function MetricCell({
  percent,
  tone,
  unavailable,
  value,
}: {
  percent: number | null;
  tone: "emerald" | "sky";
  unavailable: boolean;
  value: string;
}) {
  const t = useT();
  return (
    <div
      className="ml-auto w-28"
      title={unavailable ? t("activity.externalUnavailable") : undefined}
    >
      <span className="font-mono font-medium tabular-nums">{value}</span>
      <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-muted">
        <span
          className={cn(
            "block h-full rounded-full transition-[width] duration-500",
            tone === "emerald" ? "bg-emerald-500" : "bg-sky-500",
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

function HostStateBadge({ sample }: { sample: HostMetricSample | null }) {
  const t = useT();
  if (!sample || sample.cpuPercent === null) {
    return <Badge variant="secondary">{t("activity.collectingShort")}</Badge>;
  }
  const disk = sample.disk?.usedPercent ?? 0;
  const maximum = Math.max(sample.cpuPercent, sample.memoryUsedPercent, disk);
  if (maximum >= 90) return <Badge variant="danger">{t("activity.pressureHigh")}</Badge>;
  if (maximum >= 75) return <Badge variant="warning">{t("activity.pressureElevated")}</Badge>;
  return <Badge variant="success">{t("activity.pressureNormal")}</Badge>;
}

function chartPath(
  values: Array<number | null>,
  totalPoints = values.length,
): string {
  const lastIndex = Math.max(1, totalPoints - 1);
  let drawing = false;
  return values
    .map((value, index) => {
      if (value === null) {
        drawing = false;
        return "";
      }
      const x = (index / lastIndex) * 1000;
      const y = historyPlotY(value);
      const command = drawing ? "L" : "M";
      drawing = true;
      return `${command}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .filter(Boolean)
    .join(" ");
}

function historyPlotY(value: number): number {
  const clamped = Math.min(100, Math.max(0, value));
  const height = HISTORY_PLOT_BOTTOM - HISTORY_PLOT_TOP;
  return HISTORY_PLOT_TOP + ((100 - clamped) / 100) * height;
}

function toneClassName(
  tone: "amber" | "emerald" | "sky" | "violet",
  part: "bar" | "glow" | "icon" | "stroke",
) {
  const classes = {
    amber: {
      bar: "bg-amber-500",
      glow: "bg-amber-500",
      icon: "text-amber-600 dark:text-amber-400",
      stroke: "stroke-amber-500",
    },
    emerald: {
      bar: "bg-emerald-500",
      glow: "bg-emerald-500",
      icon: "text-emerald-600 dark:text-emerald-400",
      stroke: "stroke-emerald-500",
    },
    sky: {
      bar: "bg-sky-500",
      glow: "bg-sky-500",
      icon: "text-sky-600 dark:text-sky-400",
      stroke: "stroke-sky-500",
    },
    violet: {
      bar: "bg-violet-500",
      glow: "bg-violet-500",
      icon: "text-violet-600 dark:text-violet-400",
      stroke: "stroke-violet-500",
    },
  };
  return classes[tone][part];
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(
    units.length - 1,
    Math.max(0, Math.floor(Math.log(value) / Math.log(1024))),
  );
  return `${(value / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatMb(value: number): string {
  return value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${value.toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
