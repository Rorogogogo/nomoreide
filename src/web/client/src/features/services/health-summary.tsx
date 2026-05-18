import { Activity, Cpu, MemoryStick } from "lucide-react";
import type { ServiceHealth } from "@/lib/api";
import { cn } from "@/lib/utils";

export function HealthSummary({ health }: { health?: ServiceHealth }) {
  if (!health) return null;

  const processTree = health.processTree;
  const reason =
    health.status === "healthy" || health.status === "unknown"
      ? undefined
      : compactSummary(health.summary);

  return (
    <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
      <span
        className={cn(
          "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 font-medium",
          healthClassName(health.status),
        )}
      >
        <span className="inline-flex shrink-0">
          <Activity className="size-3" />
        </span>
        <span className="whitespace-nowrap">{health.status}</span>
      </span>
      {reason ? <span className="min-w-0 max-w-[420px] truncate">{reason}</span> : null}
      {processTree ? (
        <>
          <span className="inline-flex items-center gap-1 font-mono">
            <Cpu className="size-3" />
            {processTree.processCount}{" "}
            {processTree.processCount === 1 ? "process" : "processes"}
          </span>
          <span className="font-mono">{formatCpu(processTree.cpuPercent)} CPU</span>
          <span className="inline-flex items-center gap-1 font-mono">
            <MemoryStick className="size-3" />
            {formatMemory(processTree.rssMb)} RAM
          </span>
        </>
      ) : null}
    </div>
  );
}

function healthClassName(status: ServiceHealth["status"]) {
  if (status === "healthy") return "bg-emerald-600 text-white";
  if (status === "warning") return "bg-amber-600 text-white";
  if (status === "unhealthy") return "bg-red-600 text-white";
  return "bg-zinc-700 text-white";
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
