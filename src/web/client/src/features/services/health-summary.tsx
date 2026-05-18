import { Activity, ChevronDown, Cpu, MemoryStick } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ServiceHealth } from "@/lib/api";
import { cn } from "@/lib/utils";

export function HealthSummary({ health }: { health?: ServiceHealth }) {
  if (!health) return null;

  const processTree = health.processTree;
  const compactReason =
    health.status === "healthy" || health.status === "unknown"
      ? undefined
      : compactSummary(health.summary);

  return (
    <div className="mt-1.5 min-w-0 text-[11px] text-muted-foreground">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Badge
          appearance="subtle"
          className={cn(
            "shadow-none",
            health.status === "unknown" && "bg-zinc-100 text-zinc-700",
          )}
          size="small"
          variant={healthVariant(health.status)}
        >
          <Activity className="size-3" />
          {health.status}
        </Badge>
        {compactReason ? (
          <span className="min-w-0 max-w-[420px] truncate">{compactReason}</span>
        ) : null}
        {hasDiagnostics(health) ? (
          <details className="group min-w-0">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
              <ChevronDown className="size-3 transition-transform group-open:rotate-180" />
              Diagnostics
            </summary>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-muted/35 px-2 py-1.5">
              <span className="min-w-0 max-w-full truncate">{health.summary}</span>
              {processTree ? (
                <>
                  <span className="inline-flex items-center gap-1 font-mono">
                    <Cpu className="size-3" />
                    {processTree.processCount}{" "}
                    {processTree.processCount === 1 ? "process" : "processes"}
                  </span>
                  <span className="inline-flex items-center gap-1 font-mono">
                    <MemoryStick className="size-3" />
                    {formatMemory(processTree.rssMb)} RSS
                  </span>
                </>
              ) : null}
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
}

function healthVariant(status: ServiceHealth["status"]) {
  if (status === "healthy") return "success";
  if (status === "warning") return "warning";
  if (status === "unhealthy") return "danger";
  return "secondary";
}

function formatMemory(value: number): string {
  if (Number.isInteger(value)) return `${value} MB`;
  return `${value.toFixed(1)} MB`;
}

function hasDiagnostics(health: ServiceHealth): boolean {
  return Boolean(health.summary || health.processTree);
}

function compactSummary(summary: string): string {
  return summary.replace(/^Recent error log:\s*/i, "Recent stderr: ");
}
