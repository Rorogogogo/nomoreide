import { Activity, Box, Check, ChevronDown, Cpu, Search, Server } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/cvui-badge";
import { Input } from "@/components/ui/input";
import { Loading } from "@/components/ui/loading";
import { useRegisterRefresh } from "@/components/refresh-registry";
import {
  getDockerStatus,
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
import { ActivityView } from "./activity-view";
import { HostOverview } from "./host-overview";
import { DockerActivityView } from "./docker-activity-view";
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
  const [servers, setServers] = useState<SshServerSummary[]>([]);
  /**
   * Whether Docker is worth offering, asked once rather than assumed.
   *
   * The option is hidden when the daemon is not there. A source that is always
   * listed and always empty teaches people to ignore the selector, and this one
   * has to stay worth opening.
   */
  const [dockerAvailable, setDockerAvailable] = useState(false);

  const loadServers = useCallback(async () => {
    setServers(await listSshServers().catch(() => []));
  }, []);
  const loadDocker = useCallback(async () => {
    const status = await getDockerStatus().catch(() => null);
    setDockerAvailable(status?.available ?? false);
  }, []);
  useEffect(() => {
    void loadServers();
    void loadDocker();
  }, [loadDocker, loadServers]);
  useRegisterRefresh(({ manual }) =>
    manual ? Promise.all([loadServers(), loadDocker()]).then(() => undefined) : undefined,
  );

  const selected = servers.find((server) => server.host === host);
  // Docker stays selectable once chosen even if the daemon stops answering, so
  // the view can explain that rather than silently bouncing back to local.
  const showDocker = host === DOCKER_HOST;
  const hostSelector = (
    <ActivityHostSelect
      dockerAvailable={dockerAvailable || showDocker}
      host={showDocker ? DOCKER_HOST : selected ? host : "local"}
      onHostChange={onHostChange}
      servers={servers}
    />
  );

  if (showDocker) {
    return <DockerActivityView headerControl={hostSelector} />;
  }

  return (
    selected ? (
      <RemoteActivityView
        headerControl={hostSelector}
        key={selected.host}
        server={selected}
      />
    ) : (
      <ActivityView
        data={data}
        headerControl={hostSelector}
        onOpenService={onOpenService}
        scopeName={scopeName}
      />
    )
  );
}

/**
 * The selector value that means containers rather than a machine.
 *
 * Not a hostname, and it cannot collide with one: an SSH host is matched by
 * exact `server.host`, and no SSH entry is named `docker` without a user
 * deliberately registering one — in which case they get the containers view,
 * which is the reading a person who typed `docker` would expect anyway.
 */
export const DOCKER_HOST = "docker";

function ActivityHostSelect({
  dockerAvailable,
  host,
  onHostChange,
  servers,
}: {
  dockerAvailable: boolean;
  host: string;
  onHostChange: (host: string) => void;
  servers: SshServerSummary[];
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ left: 0, top: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = servers.find((server) => server.host === host);
  const label =
    host === DOCKER_HOST
      ? t("activity.docker.source")
      : (selected?.name ?? selected?.host ?? t("activity.thisMachine"));

  function toggle() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const menuWidth = Math.max(rect.width, 192);
      setCoords({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8)),
        top: rect.bottom + 4,
      });
    }
    setOpen((value) => !value);
  }

  useEffect(() => {
    if (!open) return;
    function dismiss(event: PointerEvent) {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    const dismissOnViewportChange = () => setOpen(false);
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissOnEscape);
    window.addEventListener("resize", dismissOnViewportChange);
    window.addEventListener("scroll", dismissOnViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissOnEscape);
      window.removeEventListener("resize", dismissOnViewportChange);
      window.removeEventListener("scroll", dismissOnViewportChange, true);
    };
  }, [open]);

  function choose(nextHost: string) {
    setOpen(false);
    onHostChange(nextHost);
  }

  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`${t("activity.host")}: ${label}`}
        className={cn(
          "flex h-6 min-w-0 max-w-44 items-center gap-1 rounded border border-border bg-background px-1.5 text-[10px] text-foreground transition-colors hover:bg-muted",
          open && "bg-muted",
        )}
        onClick={toggle}
        ref={triggerRef}
        title={`${t("activity.host")}: ${label}`}
        type="button"
      >
        {host === DOCKER_HOST ? (
          <Box aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <Server aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{label}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open
        ? createPortal(
            <div
              aria-label={t("activity.host")}
              className="fixed z-[100] max-h-72 min-w-48 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
              ref={menuRef}
              role="menu"
              style={coords}
            >
              <ActivityHostOption
                active={host === "local"}
                label={t("activity.thisMachine")}
                onSelect={() => choose("local")}
              />
              {dockerAvailable ? (
                <ActivityHostOption
                  active={host === DOCKER_HOST}
                  detail={t("activity.docker.sourceDetail")}
                  label={t("activity.docker.source")}
                  onSelect={() => choose(DOCKER_HOST)}
                />
              ) : null}
              {servers.map((server) => (
                <ActivityHostOption
                  active={host === server.host}
                  detail={server.environment
                    ? `${server.environment} · ${server.host}`
                    : server.host}
                  key={server.host}
                  label={server.name ?? server.host}
                  onSelect={() => choose(server.host)}
                />
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function ActivityHostOption({
  active,
  detail,
  label,
  onSelect,
}: {
  active: boolean;
  detail?: string;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      aria-checked={active}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-muted",
        active && "bg-muted/60",
      )}
      onClick={onSelect}
      role="menuitemradio"
      type="button"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs">{label}</span>
        {detail ? (
          <span className="block truncate font-mono text-[9px] text-muted-foreground">
            {detail}
          </span>
        ) : null}
      </span>
      {active ? (
        <Check aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      ) : null}
    </button>
  );
}

export function RemoteActivityView({
  headerControl,
  server,
}: {
  headerControl?: ReactNode;
  server: SshServerSummary;
}) {
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
            {headerControl}
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
