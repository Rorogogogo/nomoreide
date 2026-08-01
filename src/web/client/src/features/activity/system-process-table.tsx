import { Cpu, Search, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { useToasts } from "@/components/ui/toast";
import {
  type SystemProcess,
  terminateSystemProcess,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  ActivitySortHeader,
  type SortDirection,
} from "./activity-sort-header";
import {
  metricPressure,
  metricPressureTextClass,
} from "./metric-pressure";
import {
  EnergyImpactBadge,
  estimateEnergyImpact,
} from "./energy-impact";

type ProcessSort = "cpu" | "energy" | "memory" | "name";

const PROCESS_BATCH_SIZE = 50;

export function SystemProcessTable({
  processes,
  refresh,
  totalMemoryBytes,
}: {
  processes: SystemProcess[];
  refresh: () => Promise<void>;
  totalMemoryBytes: number;
}) {
  const t = useT();
  const { error: showError, success: showSuccess } = useToasts();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ProcessSort>("cpu");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [pending, setPending] = useState<SystemProcess | null>(null);
  const [terminating, setTerminating] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PROCESS_BATCH_SIZE);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return processes
      .filter((process) => {
        if (!needle) return true;
        return [
          String(process.pid),
          process.user,
          process.command,
          process.managedService ?? "",
        ].some((value) => value.toLocaleLowerCase().includes(needle));
      })
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
  const visible = filtered.slice(0, visibleCount);
  const remaining = Math.max(0, filtered.length - visible.length);

  useEffect(() => {
    setVisibleCount(PROCESS_BATCH_SIZE);
  }, [query]);

  const changeSort = (next: ProcessSort) => {
    if (next === sort) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSort(next);
    setSortDirection(next === "name" ? "asc" : "desc");
  };

  const confirmTerminate = async () => {
    if (!pending) return;
    setTerminating(true);
    try {
      await terminateSystemProcess(pending.pid, pending.command);
      showSuccess(t("activity.system.terminated", { pid: String(pending.pid) }));
      setPending(null);
      await refresh();
    } catch (error) {
      showError(
        t("activity.system.terminateError", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setTerminating(false);
    }
  };

  return (
    <section aria-labelledby="activity-system-heading">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3
            className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground"
            id="activity-system-heading"
          >
            <Cpu aria-hidden="true" className="size-3.5" />
            {t("activity.system.title")}
          </h3>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("activity.system.description", { count: String(processes.length) })}
          </p>
        </div>
        <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
          <label
            className="relative min-w-44 max-w-64 flex-1 sm:flex-none"
            htmlFor="activity-process-search"
          >
            <span className="sr-only">{t("activity.system.search")}</span>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              className="h-7 pl-7 text-[11px]"
              id="activity-process-search"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("activity.system.search")}
              value={query}
            />
          </label>
        </div>
      </div>

      <div className="overflow-x-auto border-y border-border/70">
        <table className="w-full min-w-[840px] text-left text-xs">
          <thead className="border-b border-border/60 text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
            <tr>
              <ActivitySortHeader
                active={sort === "name"}
                ariaLabel={t("activity.sortColumn", {
                  column: t("activity.system.process"),
                })}
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
              <th className="px-2 py-2 font-semibold">{t("activity.system.source")}</th>
              <th className="w-12 px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {visible.map((process) => (
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
                    metricPressureTextClass(
                      memoryPercent(process.rssMb, totalMemoryBytes),
                    ),
                  )}
                  data-pressure={metricPressure(
                    memoryPercent(process.rssMb, totalMemoryBytes),
                  )}
                >
                  {formatMb(process.rssMb)}
                </td>
                <td className="px-2 py-2 text-right">
                  <EnergyImpactBadge
                    cpuPercent={process.cpuPercent}
                    memoryPercent={memoryPercent(process.rssMb, totalMemoryBytes)}
                  />
                </td>
                <td className="px-2 py-2 text-[10px] text-muted-foreground">
                  {process.managedService
                    ? t("activity.system.managed", { service: process.managedService })
                    : t("activity.system.external")}
                </td>
                <td className="px-2 py-2 text-right">
                  <button
                    aria-label={t("activity.system.terminateAria", {
                      name: processName(process),
                      pid: String(process.pid),
                    })}
                    className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-30"
                    disabled={!process.canTerminate}
                    onClick={() => setPending(process)}
                    title={
                      process.canTerminate
                        ? t("activity.system.terminate")
                        : protectionLabel(process, t)
                    }
                    type="button"
                  >
                    <Square aria-hidden="true" className="size-3" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            {t("activity.system.empty")}
          </div>
        ) : null}
        {remaining > 0 ? (
          <div className="flex items-center justify-center border-t border-border/60 px-3 py-2">
            <button
              className="rounded px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() =>
                setVisibleCount((current) => current + PROCESS_BATCH_SIZE)
              }
              type="button"
            >
              {t("activity.system.loadMore", {
                count: String(Math.min(PROCESS_BATCH_SIZE, remaining)),
              })}
            </button>
          </div>
        ) : null}
      </div>

      {pending ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          confirmLabel={t("activity.system.terminate")}
          icon={<Square />}
          loading={terminating}
          message={
            <span>
              {t("activity.system.confirmMessage", { pid: String(pending.pid) })}
              <code className="mt-2 block max-h-20 overflow-auto rounded border border-border bg-background p-2 font-mono text-[10px] text-foreground">
                {pending.command}
              </code>
            </span>
          }
          onCancel={() => setPending(null)}
          onConfirm={() => void confirmTerminate()}
          title={t("activity.system.confirmTitle", { name: processName(pending) })}
          tone="danger"
        />
      ) : null}
    </section>
  );
}

function processName(process: SystemProcess): string {
  const executable = process.command.trim().split(/\s+/, 1)[0] ?? process.command;
  return executable.split("/").at(-1) || executable;
}

function formatMb(value: number): string {
  return value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${value.toFixed(1)} MB`;
}

function memoryPercent(rssMb: number, totalMemoryBytes: number): number | null {
  if (totalMemoryBytes <= 0) return null;
  return (rssMb * 1024 * 1024 * 100) / totalMemoryBytes;
}

function processEnergyScore(
  process: SystemProcess,
  totalMemoryBytes: number,
): number {
  return estimateEnergyImpact(
    process.cpuPercent,
    memoryPercent(process.rssMb, totalMemoryBytes),
  ).score;
}

function protectionLabel(
  process: SystemProcess,
  t: ReturnType<typeof useT>,
): string {
  if (process.protection === "managed") return t("activity.system.protectedManaged");
  if (process.protection === "permission") return t("activity.system.protectedPermission");
  if (process.protection === "this-app") return t("activity.system.protectedSelf");
  return t("activity.system.protectedSystem");
}
