import { Activity, Cpu, MemoryStick } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ServiceHealth } from "@/lib/api";
import { cn } from "@/lib/utils";

export function HealthSummary({ health }: { health?: ServiceHealth }) {
  if (!health) return null;

  const processTree = health.processTree;

  return (
    <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
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
