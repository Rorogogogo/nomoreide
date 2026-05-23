import { useEffect, useState } from "react";
import { Activity, Brain, Gauge, Plug } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { getAgentInfo, type AgentInfo } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ActivityTab } from "./activity-tab";
import { MemoryTab } from "./memory-tab";
import { OverviewTab } from "./overview-tab";
import { ToolsTab } from "./tools-tab";

type AgentTab = "overview" | "memory" | "tools" | "activity";

const TABS: Array<{ id: AgentTab; label: string; icon: React.ReactNode }> = [
  { id: "overview", label: "Overview", icon: <Gauge className="size-3.5" /> },
  { id: "memory", label: "Memory", icon: <Brain className="size-3.5" /> },
  { id: "tools", label: "Skills & MCPs", icon: <Plug className="size-3.5" /> },
  { id: "activity", label: "Activity", icon: <Activity className="size-3.5" /> },
];

export function AgentView() {
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<AgentTab>("overview");

  useEffect(() => {
    let active = true;
    void getAgentInfo()
      .then((info) => {
        if (active) setAgent(info);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, []);

  if (error) {
    return (
      <div className="h-full overflow-auto bg-card/85 p-4">
        <Alert variant="muted" className="border-destructive/40 text-destructive">
          Failed to load agent info: {error}
        </Alert>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="h-full overflow-auto bg-card/85 p-4">
        <Alert variant="muted">Loading agent info…</Alert>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-card/85">
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-card/90 px-3">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            className={cn(
              "relative flex items-center gap-1.5 px-2.5 py-2 text-xs font-medium transition-colors",
              tab === entry.id
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {entry.icon}
            {entry.label}
            {tab === entry.id ? (
              <span className="absolute inset-x-1 -bottom-px h-0.5 bg-primary" />
            ) : null}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "overview" ? <OverviewTab agent={agent} /> : null}
        {tab === "memory" ? <MemoryTab agent={agent} /> : null}
        {tab === "tools" ? <ToolsTab agent={agent} /> : null}
        {tab === "activity" ? <ActivityTab agent={agent} /> : null}
      </div>
    </div>
  );
}
