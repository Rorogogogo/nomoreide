import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plug, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  getMcpAuthStatuses,
  type AgentMcpServer,
  type AgentProfile,
  type McpAuthState,
  type McpAuthStatus,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n/en";
import { useAgentDock } from "../chat/agent-context";
import { AiContextTarget } from "../context-menu/ai-context-menu";
import { buildAddMcpPrompt, buildAskMcpPrompt, buildRemoveMcpPrompt } from "../prompts";
import type { AgentId } from "../agent-types";
import { AddButton, AddInline } from "./tools-shared";

/**
 * A server row to render. `synthetic` ones are reported by the agent CLI
 * (`mcp list`) but absent from the config file — e.g. claude.ai connectors,
 * which aren't stored in ~/.claude.json.
 */
type DisplayServer = AgentMcpServer & { synthetic?: boolean };

export function McpServersCard({ agent, agentId }: { agent: AgentProfile; agentId: AgentId }) {
  const { sendToAgent } = useAgentDock();
  const [statusList, setStatusList] = useState<McpAuthStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const t = useT();

  const loadStatuses = useCallback(async () => {
    setLoading(true);
    try {
      setStatusList(await getMcpAuthStatuses(agentId));
    } catch {
      setStatusList([]);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void loadStatuses();
  }, [loadStatuses]);

  const statuses = useMemo(() => {
    const map: Record<string, McpAuthState> = {};
    for (const item of statusList) map[item.name] = item.state;
    return map;
  }, [statusList]);

  // The config file misses CLI-only servers (claude.ai connectors), which are
  // exactly the ones reported as needing auth — surface them as synthetic rows
  // so their status is still visible.
  const servers = useMemo<DisplayServer[]>(() => {
    const configured = new Set(agent.mcpServers.map((server) => server.name));
    const extras: DisplayServer[] = statusList
      .filter((status) => !configured.has(status.name))
      .map((status) => ({ name: status.name, scope: "user", synthetic: true }));
    return [...agent.mcpServers, ...extras];
  }, [agent.mcpServers, statusList]);

  function add(input: string) {
    setAdding(false);
    sendToAgent({
      prompt: buildAddMcpPrompt(agentId, input),
      source: { type: "agent-mcp", label: t("agent.mcp.sourceNew") },
      label: t("agent.mcp.addAction", { input }),
    });
  }

  return (
    <Card className="min-w-0 rounded-none border-0 bg-transparent md:border-l md:border-border">
      <CardHeader className="border-b border-border px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Plug className="size-4 text-muted-foreground" />
            <CardTitle>MCP Servers</CardTitle>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" size="small">
              {servers.length}
            </Badge>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={() => void loadStatuses()}
              disabled={loading}
              title={t("agent.mcp.recheck")}
              aria-label={t("agent.mcp.recheck")}
            >
              <RefreshCw className={loading ? "animate-spin" : undefined} />
            </Button>
            <AddButton
              label={t("agent.mcp.addLabel")}
              onClick={() => setAdding((value) => !value)}
            />
          </div>
        </div>
        {adding ? (
          <AddInline
            className="mt-1.5"
            placeholder={t("agent.mcp.addPlaceholder")}
            onSubmit={add}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <CardDescription className="text-xs">
            {t("agent.mcp.descPre")}
            <code className="font-mono">
              {agentId === "codex" ? "~/.codex/config.toml" : "~/.claude.json"}
            </code>
            {agentId === "codex" ? "" : t("agent.mcp.descConnectors")}
            {t("agent.mcp.descMid")}
            <code className="font-mono">{agentId === "codex" ? "codex" : "claude"} mcp list</code>
            {t("agent.mcp.descPost")}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {servers.length ? (
          <ul className="divide-y divide-border">
            {servers.map((server) => (
              <AiContextTarget
                key={`${server.scope}:${server.name}`}
                target={{
                  label: server.name,
                  intents: [
                    {
                      id: "ask-mcp",
                      label: t("agent.mcp.askLabel", { name: server.name }),
                      resolvePrompt: () => buildAskMcpPrompt(server),
                      source: { type: "agent-mcp", label: t("agent.mcp.sourceServer", { name: server.name }) },
                    },
                    {
                      id: "remove-mcp",
                      label: t("agent.mcp.removeLabel", { name: server.name }),
                      resolvePrompt: () => buildRemoveMcpPrompt(server, agentId),
                      source: { type: "agent-mcp", label: t("agent.mcp.sourceRemove", { name: server.name }) },
                      agentLabel: t("agent.mcp.removeAction", { name: server.name }),
                    },
                  ],
                }}
              >
              <li
                className="group px-3 py-2 hover:bg-muted/40"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1">
                    <span
                      className="min-w-0 truncate font-mono text-xs font-semibold"
                      title={server.name}
                    >
                      {server.name}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <AuthStatusBadge state={statuses[server.name]} loading={loading} />
                    <Badge variant="outline" size="small">
                      {server.synthetic ? t("agent.mcp.connector") : server.scope}
                    </Badge>
                  </div>
                </div>
                <div
                  className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
                  title={server.synthetic ? t("agent.mcp.managedConnector") : formatMcpServer(server)}
                >
                  {server.synthetic ? t("agent.mcp.managedConnector") : formatMcpServer(server)}
                </div>
              </li>
              </AiContextTarget>
            ))}
          </ul>
        ) : (
          <p className="px-3 py-4 text-xs text-muted-foreground">{t("agent.mcp.empty")}</p>
        )}
      </CardContent>
    </Card>
  );
}

const AUTH_DISPLAY: Record<
  Exclude<McpAuthState, "unknown">,
  { labelKey: TranslationKey; dot: string }
> = {
  connected: { labelKey: "agent.mcp.connected", dot: "bg-emerald-500" },
  "needs-auth": { labelKey: "agent.mcp.needsAuth", dot: "bg-amber-500" },
  failed: { labelKey: "agent.mcp.failed", dot: "bg-red-500" },
  "no-auth": { labelKey: "agent.mcp.local", dot: "bg-muted-foreground/50" },
};

function AuthStatusBadge({ state, loading }: { state?: McpAuthState; loading: boolean }) {
  const t = useT();
  if (!state) {
    return loading ? <Loader2 className="size-3 animate-spin text-muted-foreground" /> : null;
  }
  const display = state === "unknown" ? undefined : AUTH_DISPLAY[state];
  if (!display) return null;
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className={cn("size-1.5 shrink-0 rounded-full", display.dot)} aria-hidden />
      {t(display.labelKey)}
    </span>
  );
}

function formatMcpServer(server: AgentMcpServer): string {
  if (server.command) {
    return [server.command, ...(server.args ?? [])].join(" ");
  }
  return server.url ?? server.type ?? "-";
}
