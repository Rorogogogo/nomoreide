import { useEffect, useState } from "react";
import { Activity, Brain, DollarSign, FileDiff, Gauge, Plug } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { getAgentInfo, type AgentInfo, type AgentProfile } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ActivityTab } from "./activity-tab";
import { ClaudeLogo, CodexLogo } from "./agent-logos";
import type { AgentId } from "./agent-types";
import { ChangesTab } from "./changes-tab";
import { useAgentDock } from "./chat/agent-context";
import { MemoryTab } from "./memory-tab";
import { OverviewTab } from "./overview-tab";
import { ToolsTab } from "./tools-tab";
import { UsageHistoryTab } from "./usage-history-tab";

type AgentTab = "overview" | "memory" | "tools" | "activity" | "changes" | "usage";

type ChatProviderId = "claude" | "codex";

const AGENTS: Array<{
  id: AgentId;
  /** The chat-provider id this profile maps to (the dock spawns this CLI). */
  chatId: ChatProviderId;
  label: string;
  icon: React.ReactNode;
}> = [
  { id: "claude-code", chatId: "claude", label: "Claude Code", icon: <ClaudeLogo className="size-4" /> },
  { id: "codex", chatId: "codex", label: "Codex", icon: <CodexLogo className="size-4" /> },
];

const TABS: Array<{ id: AgentTab; label: string; icon: React.ReactNode }> = [
  { id: "overview", label: "Overview", icon: <Gauge className="size-3.5" /> },
  { id: "memory", label: "Memory", icon: <Brain className="size-3.5" /> },
  { id: "tools", label: "Skills, MCPs, Plugins & Hooks", icon: <Plug className="size-3.5" /> },
  { id: "activity", label: "Activity", icon: <Activity className="size-3.5" /> },
  { id: "changes", label: "Changes", icon: <FileDiff className="size-3.5" /> },
  { id: "usage", label: "Usage", icon: <DollarSign className="size-3.5" /> },
];

export function AgentView({
  focusChanges,
  onOpenAgentEnv,
}: { focusChanges?: number; onOpenAgentEnv?: () => void } = {}) {
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<AgentId>("claude-code");
  const [tab, setTab] = useState<AgentTab>("overview");
  const { provider: chatProvider, providers, selectProvider } = useAgentDock();

  // A bump on `focusChanges` (e.g. "Review changes" from an Error Inbox fix)
  // jumps straight to the Changes tab, which auto-selects the newest session.
  useEffect(() => {
    if (focusChanges) setTab("changes");
  }, [focusChanges]);

  // Selecting an agent here views its profile *and* makes it the dock's chat
  // provider — this toggle is the app-wide "which agent am I using" control.
  function chooseAgent(id: AgentId, chatId: ChatProviderId) {
    setAgentId(id);
    if (chatProvider?.id !== chatId) void selectProvider(chatId);
  }

  // Reflect the active chat provider once it loads (falls back to detection).
  useEffect(() => {
    if (!chatProvider) return;
    setAgentId(chatProvider.id === "codex" ? "codex" : "claude-code");
  }, [chatProvider]);

  useEffect(() => {
    let active = true;
    void getAgentInfo()
      .then((info) => {
        if (!active) return;
        setAgent(info);
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
          const activeForChat = chatProvider?.id === entry.chatId;
          // Unknown (older backend that doesn't report `providers`) → assume
          // available so the control still works.
          const option = providers.find((candidate) => candidate.id === entry.chatId);
          const installed = option?.configured ?? true;
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => chooseAgent(entry.id, entry.chatId)}
              title={
                installed
                  ? `Use ${entry.label} for chat`
                  : `${entry.label} CLI isn't installed`
              }
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                selected
                  ? "border-border bg-background text-foreground shadow-sm"
                  : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                !installed && "opacity-60",
              )}
            >
              {entry.icon}
              {entry.label}
              {activeForChat ? (
                <span className="rounded-full bg-primary/15 px-1.5 py-px text-[10px] font-medium text-primary">
                  In use
                </span>
              ) : detected ? (
                <span
                  className="size-1.5 rounded-full bg-emerald-500"
                  title="Detected agent"
                  aria-hidden
                />
              ) : !installed ? (
                <span className="text-[10px] font-normal text-muted-foreground">not installed</span>
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
          <ToolsTab
            agent={activeAgent}
            agentId={agentId}
            alternateHooks={alternateHooks}
            onOpenAgentEnv={onOpenAgentEnv}
          />
        ) : null}
        {tab === "activity" ? <ActivityTab agent={activeAgent} agentId={agentId} /> : null}
        {tab === "changes" ? <ChangesTab /> : null}
        {tab === "usage" ? <UsageHistoryTab /> : null}
      </div>
    </div>
  );
}
