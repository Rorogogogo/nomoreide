import { useEffect, useRef, useState } from "react";
import { Activity } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { ToolCallRecord } from "@/lib/api";
import { cn } from "@/lib/utils";

const MAX_RECORDS = 100;

export function ToolCallFeed() {
  const [records, setRecords] = useState<ToolCallRecord[]>([]);
  const [connected, setConnected] = useState(false);
  const seenIds = useRef<Set<number>>(new Set());

  useEffect(() => {
    const source = new EventSource("/api/agent/tool-calls/stream");
    source.addEventListener("open", () => setConnected(true));
    source.addEventListener("error", () => setConnected(false));
    source.addEventListener("tool-call", (event) => {
      try {
        const record = JSON.parse((event as MessageEvent).data) as ToolCallRecord;
        setRecords((prev) => {
          if (seenIds.current.has(record.id)) return prev;
          seenIds.current.add(record.id);
          const next = [...prev, record];
          if (next.length > MAX_RECORDS) next.splice(0, next.length - MAX_RECORDS);
          return next;
        });
      } catch {
        // ignore malformed events
      }
    });
    return () => {
      source.close();
    };
  }, []);

  const visible = [...records].reverse();

  return (
    <Card className="min-w-0 rounded-none border-0 border-b border-border bg-transparent">
      <CardHeader className="border-b border-border px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-muted-foreground" />
            <CardTitle>Live MCP Tool Calls</CardTitle>
            <Badge variant="outline" size="small">
              {records.length}
            </Badge>
          </div>
          <Badge
            variant={connected ? "success" : "secondary"}
            appearance="subtle"
            size="small"
            icon={
              <span
                className={cn(
                  "inline-block size-1.5 rounded-full",
                  connected ? "animate-pulse bg-emerald-500" : "bg-muted-foreground/60",
                )}
              />
            }
          >
            {connected ? "live" : "reconnecting…"}
          </Badge>
        </div>
        <CardDescription className="text-xs">
          Streamed from this NoMoreIDE MCP server. Newest at the top.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {visible.length ? (
          <ul className="max-h-96 divide-y divide-border overflow-auto">
            {visible.map((record) => (
              <li key={record.id} className="px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs font-semibold">
                    {record.tool}
                  </span>
                  <div className="flex shrink-0 items-center gap-2 font-mono text-[10px] text-muted-foreground">
                    <span>{record.durationMs} ms</span>
                    <Badge
                      variant={record.status === "ok" ? "success" : "danger"}
                      appearance="subtle"
                      size="small"
                    >
                      {record.status}
                    </Badge>
                  </div>
                </div>
                {record.args ? (
                  <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    {record.args}
                  </div>
                ) : null}
                {record.error ? (
                  <div className="mt-0.5 font-mono text-[11px] text-destructive">
                    {record.error}
                  </div>
                ) : null}
                <div className="mt-0.5 font-mono text-[10px] text-muted-foreground/80">
                  {new Date(record.startedAt).toLocaleTimeString()}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            No tool calls yet. Invoke a NoMoreIDE MCP tool from your agent and it will appear here.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
