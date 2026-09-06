import {
  Activity,
} from "lucide-react";
import {
  lazy,
  Suspense,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Loading } from "@/components/ui/loading";
import { useRegisterRefresh } from "@/components/refresh-registry";
import {
  getActivityMetrics,
  type ActivityMetrics,
  type DashboardData,
  type HostMetricSample,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type {
  SortDirection,
} from "./activity-sort-header";
import { formatMb, } from "./activity-format";
import { HostOverview } from "./host-overview";
import { ServiceActivityTable } from "./service-activity-table";

import type { SortKey } from "./activity-sort-keys";

const LazySystemProcessTable = lazy(() =>
  import("./system-process-table").then((module) => ({
    default: module.SystemProcessTable,
  })),
);


export function ActivityView({
  data,
  headerControl,
  onOpenService,
  scopeName,
}: {
  data: DashboardData;
  headerControl?: ReactNode;
  onOpenService: (name: string) => void;
  scopeName?: string | null;
}) {
  const t = useT();
  const [processBoundary, setProcessBoundary] = useState<HTMLDivElement | null>(null);
  const [loadProcesses, setLoadProcesses] = useState(false);
  const { metrics, loading, error, refresh } = useActivityMetrics(loadProcesses);
  const [sort, setSort] = useState<SortKey>("cpu");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  useRegisterRefresh(refresh);

  useEffect(() => {
    if (!processBoundary || loadProcesses) return;
    if (typeof IntersectionObserver === "undefined") {
      setLoadProcesses(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setLoadProcesses(true);
        observer.disconnect();
      },
      { rootMargin: "300px 0px" },
    );
    observer.observe(processBoundary);
    return () => observer.disconnect();
  }, [loadProcesses, processBoundary]);

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
          processes: summary.processes + (service.processCount ?? 0),
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
            {headerControl}
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
          <Loading fill label={t("activity.loading")} />
        ) : metrics && current ? (
          <div className="space-y-4 p-4">
            <HostOverview current={current} samples={metrics.host.samples} />
            <ServiceActivityTable
              definitions={data.config.services}
              metrics={visibleMetrics}
              onOpenService={onOpenService}
              runtime={data.runtime.services}
              sort={sort}
              sortDirection={sortDirection}
              setSort={setSort}
              setSortDirection={setSortDirection}
              totalMemoryBytes={current.memoryTotalBytes}
            />
            <div ref={setProcessBoundary}>
              {loadProcesses ? (
                metrics.systemProcesses ? (
                <Suspense fallback={<ActivitySectionLoading />}>
                  <LazySystemProcessTable
                    processes={metrics.systemProcesses}
                    refresh={refresh}
                    totalMemoryBytes={current.memoryTotalBytes}
                  />
                </Suspense>
                ) : (
                  <ActivitySectionLoading />
                )
              ) : (
                <DeferredProcessSection />
              )}
            </div>
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

function useActivityMetrics(includeProcesses: boolean) {
  const [metrics, setMetrics] = useState<ActivityMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const currentRequest = ++requestId.current;
    try {
      const next = await getActivityMetrics({ includeProcesses });
      if (currentRequest !== requestId.current) return;
      setMetrics(next);
      setError(null);
    } catch (caught) {
      if (currentRequest !== requestId.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, [includeProcesses]);

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

function ActivitySectionLoading() {
  const t = useT();
  return <Loading className="min-h-40" label={t("activity.sectionLoading")} />;
}

function DeferredProcessSection() {
  const t = useT();
  return (
    <div
      className="border-y border-border/70 px-3 py-3 text-[11px] text-muted-foreground"
      data-process-lazy-boundary
    >
      {t("activity.system.deferred")}
    </div>
  );
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
