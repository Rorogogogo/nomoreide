import { useMemo, useState } from "react";
import { Copy, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToasts } from "@/components/ui/toast";
import { postForm, type ServiceStatus, type TimelineEvent } from "@/lib/api";
import { cn } from "@/lib/utils";

interface HttpRow {
  id: string;
  startedAt: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  reqBytes: number;
  resBytes: number;
}

export function HttpTab({
  serviceName,
  status,
  timeline,
  onRefresh,
}: {
  serviceName: string;
  status?: ServiceStatus;
  timeline: TimelineEvent[];
  onRefresh: () => Promise<void>;
}) {
  const { error: showError, success: showSuccess } = useToasts();
  const [busy, setBusy] = useState(false);
  const inspector = status?.inspector;
  const running = status?.state === "running";

  const rows = useMemo<HttpRow[]>(() => {
    return timeline
      .filter((event) => event.kind === "service.http" && event.service === serviceName)
      .map((event) => {
        const data = (event.data ?? {}) as Partial<HttpRow>;
        return {
          id: (data.id as string) ?? event.id,
          startedAt: event.timestamp,
          method: (data.method as string) ?? "?",
          path: (data.path as string) ?? "?",
          status: (data.status as number) ?? 0,
          durationMs: (data.durationMs as number) ?? 0,
          reqBytes: (data.reqBytes as number) ?? 0,
          resBytes: (data.resBytes as number) ?? 0,
        };
      })
      .slice(-500)
      .reverse();
  }, [timeline, serviceName]);

  async function toggle(enabled: boolean) {
    setBusy(true);
    try {
      await postForm(
        `/api/services/${encodeURIComponent(serviceName)}/inspector`,
        { enabled: enabled ? "true" : "false" },
      );
      await onRefresh();
      showSuccess(
        enabled ? `HTTP inspector started for ${serviceName}.` : `HTTP inspector stopped for ${serviceName}.`,
      );
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!running) {
    return <div className="text-muted-foreground">Service is not running.</div>;
  }

  if (!inspector?.enabled) {
    return (
      <div className="space-y-2">
        <p className="text-muted-foreground">
          The HTTP inspector starts a local proxy that forwards traffic to this service and
          records every request. Hit the inspect URL instead of the original port to see
          requests appear here. The service itself is not touched.
        </p>
        <Button disabled={busy} onClick={() => toggle(true)} size="sm" type="button">
          <Play /> Start HTTP inspector
        </Button>
      </div>
    );
  }

  const inspectUrl = inspector.port ? `http://127.0.0.1:${inspector.port}` : undefined;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">Inspect URL:</span>
        {inspectUrl ? (
          <>
            <code className="rounded bg-background px-1.5 py-0.5 font-mono">{inspectUrl}</code>
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(inspectUrl);
                showSuccess("Copied inspect URL.");
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              <Copy /> Copy
            </Button>
            <Button
              onClick={() => window.open(inspectUrl, "_blank", "noopener,noreferrer")}
              size="sm"
              type="button"
              variant="outline"
            >
              Open
            </Button>
          </>
        ) : (
          <span className="text-muted-foreground">starting…</span>
        )}
        <span className="text-muted-foreground">
          → upstream :{inspector.upstreamPort ?? "?"}
        </span>
        <Button disabled={busy} onClick={() => toggle(false)} size="sm" type="button" variant="outline">
          <Square /> Stop
        </Button>
      </div>
      {rows.length === 0 ? (
        <div className="text-muted-foreground">
          No requests captured yet. Hit the inspect URL in your browser to see traffic.
        </div>
      ) : (
        <div className="max-h-80 overflow-auto">
          <table className="w-full font-mono text-[11px]">
            <thead className="sticky top-0 bg-muted/60 text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-3">Time</th>
                <th className="py-1 pr-3">Method</th>
                <th className="py-1 pr-3">Path</th>
                <th className="py-1 pr-3 text-right">Status</th>
                <th className="py-1 pr-3 text-right">Size</th>
                <th className="py-1 pr-3 text-right">ms</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-border/40">
                  <td className="py-1 pr-3 text-muted-foreground">
                    {new Date(row.startedAt).toLocaleTimeString()}
                  </td>
                  <td className="py-1 pr-3">{row.method}</td>
                  <td className="py-1 pr-3 truncate max-w-[40ch]">{row.path}</td>
                  <td className={cn("py-1 pr-3 text-right", statusColor(row.status))}>
                    {row.status}
                  </td>
                  <td className="py-1 pr-3 text-right text-muted-foreground">
                    {formatBytes(row.resBytes)}
                  </td>
                  <td className="py-1 pr-3 text-right">{row.durationMs.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function statusColor(status: number): string {
  if (status >= 500) return "text-red-600 dark:text-red-400";
  if (status >= 400) return "text-amber-600 dark:text-amber-400";
  if (status >= 300) return "text-zinc-500";
  if (status >= 200) return "text-emerald-600 dark:text-emerald-400";
  return "text-muted-foreground";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
