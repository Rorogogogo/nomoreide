import { Activity, Cpu, MemoryStick } from "lucide-react";
import type { ServiceHealth } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

export function HealthSummary({ health }: { health?: ServiceHealth }) {
  const t = useT();
  if (!health) return null;

  const processTree = health.processTree;
  const reason =
    health.status === "healthy" || health.status === "unknown"
      ? undefined
      : compactSummary(health.summary);

  return (
    <div className="mt-1.5 grid min-w-0 gap-2 text-[11px] text-muted-foreground sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            "inline-flex h-5 shrink-0 items-center gap-1 rounded border px-1.5 text-[10px] font-medium",
            healthClassName(health.status),
          )}
        >
          <span className="inline-flex shrink-0">
            <Activity className="size-3" />
          </span>
          <span className="whitespace-nowrap">{health.status}</span>
        </span>
        {reason ? <span className="min-w-0 truncate">{reason}</span> : null}
      </div>
      {processTree ? (
        <div className="health-metrics flex min-w-max items-center gap-2 font-mono sm:justify-end">
          <span className="inline-flex items-center gap-1 font-mono">
            <Cpu className="size-3" />
            {processTree.processCount}{" "}
            {processTree.processCount === 1 ? t("services.process") : t("services.processes")}
          </span>
          <span>{formatCpu(processTree.cpuPercent)} CPU</span>
          <span className="inline-flex items-center gap-1 font-mono">
            <MemoryStick className="size-3" />
            {formatMemory(processTree.rssMb)} RAM
          </span>
        </div>
      ) : null}
    </div>
  );
}

function healthClassName(status: ServiceHealth["status"]) {
  if (status === "healthy") {
    return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (status === "warning") {
    return "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  if (status === "unhealthy") {
    return "border-red-500/35 bg-red-500/10 text-red-700 dark:text-red-300";
  }
  return "border-border bg-muted text-muted-foreground";
}

function formatMemory(value: number): string {
  if (Number.isInteger(value)) return `${value} MB`;
  return `${value.toFixed(1)} MB`;
}

function formatCpu(value: number): string {
  return `${value.toFixed(1)}%`;
}

function compactSummary(summary: string): string {
  return summary
    .replace(/^Recent error log:\s*/i, "Recent stderr: ")
    .replace(/:\s*\d+(?:\.\d+)? MB RSS\.?$/i, "")
    .replace(/\s+RSS\.?$/i, "");
}
