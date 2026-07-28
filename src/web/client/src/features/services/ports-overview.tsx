import { Network } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { PortOverview } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { EmptyState } from "./empty-state";

export function PortsOverview({ ports }: { ports: PortOverview[] }) {
  const t = useT();
  const occupiedCount = ports.filter((port) => port.state === "occupied").length;
  const managedCount = ports.filter((port) => port.state === "managed").length;

  return (
    <Card className="rounded-none border-0 border-b border-border bg-transparent">
      <CardHeader className="border-b border-border px-3 py-2">
        <CardTitle className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          <Network aria-hidden="true" className="size-3.5" />
          {t("services.ports")}
        </CardTitle>
        <CardDescription className="text-[10px]">
          {t("services.portsSummary", { managed: managedCount, occupied: occupiedCount })}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {ports.length ? (
          <div className="divide-y divide-border">
            {ports.map((port) => (
              <div
                className="grid grid-cols-[1fr_auto] items-center gap-2 px-3 py-2 transition-colors hover:bg-muted/20"
                key={port.port}
              >
                <div className="min-w-0">
                  <div className="font-mono text-xs">:{port.port}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {port.services.join(", ") || t("services.unassigned")}
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
          <EmptyState label={t("services.noPorts")} />
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
  const t = useT();
  const label =
    port.state === "managed"
      ? t("services.portManaged")
      : port.state === "occupied"
        ? t("services.portOccupied")
        : t("services.portAvailable");
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
