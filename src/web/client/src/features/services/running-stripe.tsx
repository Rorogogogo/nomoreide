import { useMemo } from "react";
import { Activity } from "lucide-react";
import type { DashboardData, ServiceHealth, ServiceStatus } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

type DotTone = "healthy" | "starting" | "warning" | "unhealthy" | "unknown";

interface RunningEntry {
  name: string;
  tone: DotTone;
  port?: number;
  uptime?: string;
  url?: string;
}

/**
 * Global mission-control strip: a dense, terminal-style status line for every
 * running (or starting) service, shown on every page so service health stays
 * visible regardless of which tab is open. Condensed by design — full detail
 * lives on the Services tab.
 */
export function RunningStripe({
  data,
  onOpenService,
}: {
  data: DashboardData;
  onOpenService: (name: string) => void;
}) {
  const t = useT();
  const entries = useMemo(() => collectEntries(data, t("services.startingEllipsis")), [data, t]);
  if (!entries.length) return null;

  return (
    <div className="flex shrink-0 items-center gap-3 overflow-x-auto border-b border-border bg-card/60 px-4 py-1.5 backdrop-blur">
      <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        <Activity className="size-3" />
        {t("services.stripeRunning")}
      </span>
      <div className="flex min-w-0 items-center gap-2">
        {entries.map((entry) => (
          <button
            className="group flex shrink-0 items-center gap-2 rounded-md border border-border/60 bg-background/60 px-2.5 py-1 font-mono text-[11px] transition-colors hover:border-border hover:bg-muted"
            key={entry.name}
            onClick={() => onOpenService(entry.name)}
            title={entry.url ? `${entry.name} — ${entry.url}` : entry.name}
            type="button"
          >
            <span className={cn("size-2 shrink-0 rounded-full", dotClassName(entry.tone))} />
            <span className="max-w-40 truncate font-medium text-foreground">{entry.name}</span>
            {entry.port ? (
              <span className="text-muted-foreground">:{entry.port}</span>
            ) : null}
            {entry.uptime ? (
              <span className="text-muted-foreground/70">↑{entry.uptime}</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function collectEntries(data: DashboardData, startingLabel: string): RunningEntry[] {
  const ports = new Map(data.config.services.map((service) => [service.name, service.port]));

  return Object.values(data.runtime.services)
    .filter((status) => status.state === "running" || status.state === "starting")
    .map((status) => ({
      name: status.name,
      tone: toneFor(status, data.health[status.name]),
      port: ports.get(status.name) ?? portFromUrl(status.url),
      uptime: status.state === "running" ? formatUptime(status.startedAt) : startingLabel,
      url: status.url,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function toneFor(status: ServiceStatus, health?: ServiceHealth): DotTone {
  if (status.state === "starting") return "starting";
  if (health?.status === "healthy") return "healthy";
  if (health?.status === "warning") return "warning";
  if (health?.status === "unhealthy") return "unhealthy";
  return "healthy";
}

function dotClassName(tone: DotTone): string {
  if (tone === "starting") return "animate-pulse bg-amber-500";
  if (tone === "warning") return "bg-amber-500";
  if (tone === "unhealthy") return "bg-red-500";
  if (tone === "unknown") return "bg-zinc-500";
  return "bg-emerald-500";
}

function portFromUrl(url?: string): number | undefined {
  if (!url) return undefined;
  try {
    const port = new URL(url).port;
    return port ? Number(port) : undefined;
  } catch {
    return undefined;
  }
}

function formatUptime(startedAt?: string): string | undefined {
  if (!startedAt) return undefined;
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return undefined;

  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) return `${hours}h${remMinutes ? `${remMinutes}m` : ""}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 ? `${hours % 24}h` : ""}`;
}
