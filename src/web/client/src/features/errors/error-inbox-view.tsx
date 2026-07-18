import { useEffect, useMemo, useState } from "react";
import { Inbox } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { IncidentDetail } from "./incident-detail";
import { useErrorIncidents } from "./use-error-incidents";

export function ErrorInboxView({
  inScope,
  onReviewChanges,
}: {
  /** Project-scope filter; when set, only incidents from these services show. */
  inScope?: (service: string) => boolean;
  /** Deep-link to Agent → Changes for a fix run's recorded session. */
  onReviewChanges?: (sessionId: string) => void;
} = {}) {
  const { incidents: allIncidents, connected, error } = useErrorIncidents();
  const incidents = useMemo(
    () => (inScope ? allIncidents.filter((incident) => inScope(incident.service)) : allIncidents),
    [allIncidents, inScope],
  );
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Default to the newest incident; keep the selection if it still exists.
  useEffect(() => {
    if (incidents.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId((current) =>
      current !== null && incidents.some((item) => item.id === current)
        ? current
        : incidents[0].id,
    );
  }, [incidents]);

  const selected = useMemo(
    () => incidents.find((item) => item.id === selectedId) ?? null,
    [incidents, selectedId],
  );

  return (
    <div className="flex h-full min-h-0 bg-card/85">
      <div className="flex w-72 shrink-0 flex-col border-r border-border">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <Inbox className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Incidents</span>
            <Badge variant="outline" size="small">
              {incidents.length}
            </Badge>
          </div>
          <Badge
            variant="outline"
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
        <ul className="min-h-0 flex-1 divide-y divide-border overflow-auto">
          {incidents.map((incident) => (
            <li key={incident.id}>
              <button
                type="button"
                onClick={() => setSelectedId(incident.id)}
                className={cn(
                  "flex w-full flex-col gap-1 px-3 py-2 text-left transition-colors hover:bg-muted/50",
                  incident.id === selectedId && "bg-muted/70",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-[11px] font-semibold">
                    {incident.service}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    {incident.count > 1 ? (
                      <Badge variant="outline" size="small">
                        ×{incident.count}
                      </Badge>
                    ) : null}
                    <Badge
                      variant={incident.level === "error" ? "danger" : "secondary"}
                      appearance="subtle"
                      size="small"
                    >
                      {incident.level}
                    </Badge>
                  </div>
                </div>
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {incident.title}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground/70">
                  {new Date(incident.lastSeen).toLocaleTimeString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="min-h-0 min-w-0 flex-1">
        {error ? (
          <div className="p-4">
            <Alert variant="muted" className="border-destructive/40 text-destructive">
              Failed to load incidents: {error}
            </Alert>
          </div>
        ) : selected ? (
          <IncidentDetail incident={selected} onReviewChanges={onReviewChanges} />
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-center">
            <div className="max-w-sm">
              <Inbox className="mx-auto size-8 text-muted-foreground/50" />
              <p className="mt-3 text-sm font-medium">No incidents yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Errors and stack traces from your running services land here automatically. Each
                one becomes a one-click prompt for your agent.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
