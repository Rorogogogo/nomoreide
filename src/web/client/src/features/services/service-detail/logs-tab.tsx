import { useServiceLogs } from "./use-service-logs";

export function LogsTab({ serviceName }: { serviceName: string }) {
  const { logs, error } = useServiceLogs(serviceName);

  if (error) {
    return <div className="text-red-600">{error}</div>;
  }
  if (!logs) {
    return <div className="text-muted-foreground">Loading…</div>;
  }
  if (logs.length === 0) {
    return <div className="text-muted-foreground">No log entries.</div>;
  }
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 font-mono text-[11px]">
      {logs.map((entry) => `${new Date(entry.timestamp).toLocaleTimeString()} [${entry.stream}] ${entry.text}`).join("\n")}
    </pre>
  );
}
