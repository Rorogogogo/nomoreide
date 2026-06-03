import { useEffect, useState } from "react";
import { Activity, Brain, Gauge, Plug } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { getAgentInfo, type AgentInfo, type AgentProfile } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ActivityTab } from "./activity-tab";
import { ClaudeLogo, CodexLogo } from "./agent-logos";
import type { AgentId } from "./agent-types";
import { useAgentDock } from "./chat/agent-context";
import { ConversationHealth } from "./conversation-health";
import { MemoryTab } from "./memory-tab";
import { OverviewTab } from "./overview-tab";
import { ToolsTab } from "./tools-tab";

type AgentTab = "overview" | "memory" | "tools" | "activity";

const AGENTS: Array<{ id: AgentId; label: string; icon: React.ReactNode }> = [
  { id: "claude-code", label: "Claude Code", icon: <ClaudeLogo className="size-4" /> },
  { id: "codex", label: "Codex", icon: <CodexLogo className="size-4" /> },
];

const TABS: Array<{ id: AgentTab; label: string; icon: React.ReactNode }> = [
  { id: "overview", label: "Overview", icon: <Gauge className="size-3.5" /> },
  { id: "memory", label: "Memory", icon: <Brain className="size-3.5" /> },
  { id: "tools", label: "Skills, MCPs, Plugins & Hooks", icon: <Plug className="size-3.5" /> },
  { id: "activity", label: "Activity", icon: <Activity className="size-3.5" /> },
];

export function AgentView() {
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<AgentId>("claude-code");
  const [tab, setTab] = useState<AgentTab>("overview");
  const { clear, turns } = useAgentDock();

  useEffect(() => {
    let active = true;
    void getAgentInfo()
      .then((info) => {
        if (!active) return;
        setAgent(info);
        if (info.detected.name === "codex") setAgentId("codex");
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

  const activeAgent: AgentProfile = agent.agents?.[agentId] ?? agent;
  const alternateHooks =
    agentId === "codex"
      ? { agentLabel: "Claude Code", count: agent.agents["claude-code"].hooks.length }
      : { agentLabel: "Codex", count: agent.agents.codex.hooks.length };

  return (
    <div className="flex h-full min-h-0 flex-col bg-card/85">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card/90 px-3 py-2">
        {AGENTS.map((entry) => {
          const selected = agentId === entry.id;
          const detected = agent.detected.name === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => setAgentId(entry.id)}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                selected
                  ? "border-border bg-background text-foreground shadow-sm"
                  : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              {entry.icon}
              {entry.label}
              {detected ? (
                <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
              ) : null}
            </button>
          );
        })}
      </div>

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

      <ConversationHealth onNewChat={clear} turns={turns} />

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "overview" ? (
          <OverviewTab
            agent={activeAgent}
            agentId={agentId}
            isDetected={agent.detected.name === agentId}
          />
        ) : null}
        {tab === "memory" ? <MemoryTab agent={activeAgent} agentId={agentId} /> : null}
        {tab === "tools" ? (
          <ToolsTab agent={activeAgent} agentId={agentId} alternateHooks={alternateHooks} />
        ) : null}
        {tab === "activity" ? <ActivityTab agent={activeAgent} agentId={agentId} /> : null}
      </div>
    </div>
  );
}
