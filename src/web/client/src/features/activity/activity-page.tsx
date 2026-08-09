import { useCallback, useEffect, useState } from "react";
import { Server } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/cvui-badge";
import { Loading } from "@/components/ui/loading";
import { useRegisterRefresh } from "@/components/refresh-registry";
import {
  getRemoteHostMetrics,
  listSshServers,
  type DashboardData,
  type RemoteHostMetrics,
  type SshServerSummary,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { ActivityView } from "./activity-view";

const REMOTE_REFRESH_MS = 5_000;

export function ActivityPage({
  data,
  onOpenService,
  scopeName,
}: {
  data: DashboardData;
  onOpenService: (name: string) => void;
  scopeName: string | null;
}) {
  const t = useT();
  const [servers, setServers] = useState<SshServerSummary[]>([]);
  const [host, setHost] = useState("local");

  const loadServers = useCallback(async () => {
    setServers(await listSshServers().catch(() => []));
  }, []);
  useEffect(() => {
    void loadServers();
  }, [loadServers]);
  useRegisterRefresh(loadServers);

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
          onChange={(event) => setHost(event.target.value)}
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
          <RemoteActivityView server={selected} />
        ) : (
          <ActivityView data={data} onOpenService={onOpenService} scopeName={scopeName} />
        )}
      </div>
    </div>
  );
}

function RemoteActivityView({ server }: { server: SshServerSummary }) {
  const t = useT();
  const [metrics, setMetrics] = useState<RemoteHostMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const next = await getRemoteHostMetrics(server.host);
      setMetrics(next);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  }, [server.host]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    setMetrics(null);
    setLoading(true);
    const poll = async () => {
      await refresh();
      if (!cancelled) timer = window.setTimeout(() => void poll(), REMOTE_REFRESH_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refresh]);
  useRegisterRefresh(refresh);

  if (loading && !metrics) return <Loading fill label={t("activity.remoteLoading")} />;

  return (
    <div className="h-full min-h-0 overflow-auto">
      {error ? (
        <Alert aria-live="polite" className="m-3" variant="destructive">
          {t("activity.remoteError", { error })}
        </Alert>
      ) : null}
      {metrics ? (
        <div>
          <div className="border-b border-border px-3 py-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold">{server.name ?? metrics.hostname}</h2>
                <p className="font-mono text-[10px] text-muted-foreground">
                  {metrics.hostname} · {metrics.platform} · ssh {server.host}
                </p>
              </div>
              <span className="font-mono text-[9px] text-muted-foreground">
                {t("activity.sampled", { time: new Date(metrics.current.t).toLocaleTimeString() })}
              </span>
            </div>
            <div className="mt-3 grid gap-px overflow-hidden rounded border border-border bg-border sm:grid-cols-4">
              <RemoteStat label="CPU" value={`${metrics.current.cpuPercent.toFixed(1)}%`} />
              <RemoteStat
                label={t("activity.memory")}
                value={`${formatBytes(metrics.current.memoryUsedBytes)} / ${formatBytes(metrics.current.memoryTotalBytes)}`}
              />
              <RemoteStat
                label={t("activity.disk")}
                value={metrics.current.disk ? `${metrics.current.disk.usedPercent.toFixed(1)}%` : "—"}
              />
              <RemoteStat
                label={t("activity.loadUptime")}
                value={`${metrics.current.loadAverage[0].toFixed(2)} · ${formatUptime(metrics.current.uptimeSeconds)}`}
              />
            </div>
          </div>

          <section aria-labelledby="remote-processes-heading">
            <div className="flex items-start justify-between gap-3 border-b border-border px-3 py-2">
              <div>
                <h3 className="text-xs font-semibold" id="remote-processes-heading">
                  {t("activity.system.title")}
                </h3>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {t("activity.remoteReadOnly", { count: metrics.processes.length })}
                </p>
              </div>
              <Badge appearance="subtle" size="small" variant="secondary">
                {t("activity.remoteBadge")}
              </Badge>
            </div>
            <table className="w-full table-fixed text-left text-[11px]">
              <thead className="sticky top-0 border-b border-border bg-background/95 text-[9px] uppercase tracking-wide text-muted-foreground backdrop-blur">
                <tr>
                  <th className="w-[52%] px-3 py-2 font-semibold">{t("activity.system.process")}</th>
                  <th className="w-[18%] px-2 py-2 font-semibold">{t("activity.system.owner")}</th>
                  <th className="w-[15%] px-2 py-2 text-right font-semibold">CPU</th>
                  <th className="w-[15%] px-3 py-2 text-right font-semibold">{t("activity.memory")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {metrics.processes.map((process) => (
                  <tr className="hover:bg-muted/20" key={process.pid}>
                    <td className="truncate px-3 py-1.5 font-mono" title={process.command}>
                      {process.command}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
                      {process.user} · {process.pid}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                      {process.cpuPercent.toFixed(1)}%
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                      {formatMb(process.rssMb)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function RemoteStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-background px-3 py-2">
      <div className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 truncate font-mono text-xs font-semibold tabular-nums" title={value}>
        {value}
      </div>
    </div>
  );
}

function formatBytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  return `${(value / 1024 ** 2).toFixed(0)} MB`;
}

function formatMb(value: number): string {
  return value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${value.toFixed(0)} MB`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}
