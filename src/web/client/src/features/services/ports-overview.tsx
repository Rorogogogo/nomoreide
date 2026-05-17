import { Network } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { PortOverview } from "@/lib/api";
import { cn } from "@/lib/utils";
import { EmptyState } from "./empty-state";

export function PortsOverview({ ports }: { ports: PortOverview[] }) {
  const occupiedCount = ports.filter((port) => port.state === "occupied").length;
  const managedCount = ports.filter((port) => port.state === "managed").length;

  return (
    <Card className="rounded-none border-0 border-b border-border bg-transparent">
      <CardHeader className="border-b border-border px-3 py-2">
        <CardTitle className="flex items-center gap-2">
          <Network className="size-3.5" />
          Ports
        </CardTitle>
        <CardDescription className="text-xs">
          {managedCount} managed, {occupiedCount} occupied by other
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {ports.length ? (
          <div className="divide-y divide-border">
            {ports.map((port) => (
              <div
                className="grid grid-cols-[1fr_auto] items-center gap-2 px-3 py-2"
                key={port.port}
              >
                <div className="min-w-0">
                  <div className="font-mono text-xs">:{port.port}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {port.services.join(", ") || "Unassigned"}
                  </div>
                  {port.urls[0] ? (
                    <div className="truncate font-mono text-[10px] text-muted-foreground">
                      {port.urls[0]}
                    </div>
                  ) : null}
                </div>
                <PortStateBadge port={port} />
              </div>
            ))}
          </div>
        ) : (
          <EmptyState label="No configured ports yet." />
        )}
      </CardContent>
    </Card>
  );
}

export function PortStateBadge({
  compact,
  port,
}: {
  compact?: boolean;
  port: PortOverview;
}) {
  const label =
    port.state === "managed"
      ? "managed"
      : port.state === "occupied"
        ? "occupied by other"
        : "available";
  const variant =
    port.state === "managed"
      ? "success"
      : port.state === "occupied"
        ? "warning"
        : "outline";

  return (
    <Badge className={cn(compact && "max-w-36 truncate")} variant={variant}>
      {label}
    </Badge>
  );
}
