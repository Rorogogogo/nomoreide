import { useEffect, useState } from "react";
import { Activity, Brain, DollarSign, FileDiff, Gauge, Plug } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { getAgentInfo, type AgentInfo, type AgentProfile } from "@/lib/api";
import { useT } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n/en";
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

const AGENT_SWITCH: Array<{
  chatId: "claude" | "codex";
  label: string;
  icon: React.ReactNode;
}> = [
  { chatId: "claude", label: "Claude Code", icon: <ClaudeLogo className="size-3.5" /> },
  { chatId: "codex", label: "Codex", icon: <CodexLogo className="size-3.5" /> },
];

const TABS: Array<{ id: AgentTab; labelKey: TranslationKey; icon: React.ReactNode }> = [
  { id: "overview", labelKey: "agent.tab.overview", icon: <Gauge className="size-3.5" /> },
  { id: "memory", labelKey: "agent.tab.memory", icon: <Brain className="size-3.5" /> },
  { id: "tools", labelKey: "agent.tab.tools", icon: <Plug className="size-3.5" /> },
  { id: "activity", labelKey: "agent.tab.activity", icon: <Activity className="size-3.5" /> },
  { id: "changes", labelKey: "agent.tab.changes", icon: <FileDiff className="size-3.5" /> },
  { id: "usage", labelKey: "agent.tab.usage", icon: <DollarSign className="size-3.5" /> },
];

export function AgentView({
  focusChanges,
  onOpenAgentEnv,
}: { focusChanges?: number; onOpenAgentEnv?: () => void } = {}) {
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<AgentTab>("overview");
  const t = useT();
  const { provider: chatProvider, providers, selectProvider } = useAgentDock();
  const agentId: AgentId = chatProvider?.id === "codex" ? "codex" : "claude-code";

  // A bump on `focusChanges` (e.g. "Review changes" from an Error Inbox fix)
  // jumps straight to the Changes tab, which auto-selects the newest session.
  useEffect(() => {
    if (focusChanges) setTab("changes");
  }, [focusChanges]);

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
          {t("agent.loadFailed", { error })}
        </Alert>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="h-full overflow-auto bg-card/85 p-4">
        <Alert variant="muted">{t("agent.loadingInfo")}</Alert>
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
            {t(entry.labelKey)}
            {tab === entry.id ? (
              <span className="absolute inset-x-1 -bottom-px h-0.5 bg-primary" />
            ) : null}
          </button>
        ))}
        <fieldset aria-label={t("dock.providerAria")} className="ml-auto flex shrink-0 items-center gap-0.5 border-0 p-0">
          {AGENT_SWITCH.map((entry) => {
            const option = providers.find((candidate) => candidate.id === entry.chatId);
            const configured = option?.configured ?? true;
            const selected = chatProvider?.id === entry.chatId;
            return (
              <button
                aria-pressed={selected}
                className={cn(
                  "flex items-center gap-1 rounded-sm px-2 py-1 text-[11px] font-medium transition-colors",
                  selected ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  !configured && "opacity-50",
                )}
                disabled={!configured}
                key={entry.chatId}
                onClick={() => void selectProvider(entry.chatId)}
                title={configured ? t("agent.useForChat", { label: entry.label }) : t("agent.cliNotInstalled", { label: entry.label })}
                type="button"
              >
                {entry.icon}
                <span className="hidden sm:inline">{entry.label}</span>
              </button>
            );
          })}
        </fieldset>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "overview" ? (
          <OverviewTab
            agent={activeAgent}
            agentId={agentId}
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
