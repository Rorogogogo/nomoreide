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
import { useAgentDock } from "../chat/agent-context";
import { buildAddMcpPrompt, buildAskMcpPrompt, buildRemoveMcpPrompt } from "../prompts";
import type { AgentId } from "../agent-types";
import { AddButton, AddInline, RowActions } from "./tools-shared";

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
      source: { type: "agent-mcp", label: "New MCP server" },
      label: `Add MCP server: ${input}`,
    });
  }

  function ask(server: DisplayServer) {
    sendToAgent({
      prompt: buildAskMcpPrompt(server),
      source: { type: "agent-mcp", label: `${server.name} server` },
      mode: "draft",
    });
  }

  function remove(server: DisplayServer) {
    sendToAgent({
      prompt: buildRemoveMcpPrompt(server, agentId),
      source: { type: "agent-mcp", label: `Remove ${server.name}` },
      label: `Remove MCP server: ${server.name}`,
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
              title="Re-check authentication status"
              aria-label="Re-check authentication status"
            >
              <RefreshCw className={loading ? "animate-spin" : undefined} />
            </Button>
            <AddButton
              label="Register an MCP server with AI"
              onClick={() => setAdding((value) => !value)}
            />
          </div>
        </div>
        {adding ? (
          <AddInline
            className="mt-1.5"
            placeholder="Paste the MCP install command or URL…"
            onSubmit={add}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <CardDescription className="text-xs">
            From{" "}
            <code className="font-mono">
              {agentId === "codex" ? "~/.codex/config.toml" : "~/.claude.json"}
            </code>
            {agentId === "codex" ? "" : " + claude.ai connectors"}. Status via{" "}
            <code className="font-mono">{agentId === "codex" ? "codex" : "claude"} mcp list</code>{" "}
            (fresh health check).
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {servers.length ? (
          <ul className="divide-y divide-border">
            {servers.map((server) => (
              <li
                key={`${server.scope}:${server.name}`}
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
                    <RowActions
                      askLabel={`Ask AI about the ${server.name} server`}
                      removeLabel={`Remove the ${server.name} server`}
                      onAsk={() => ask(server)}
                      onRemove={() => remove(server)}
                    />
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <AuthStatusBadge state={statuses[server.name]} loading={loading} />
                    <Badge variant="outline" size="small">
                      {server.synthetic ? "connector" : server.scope}
                    </Badge>
                  </div>
                </div>
                <div
                  className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
                  title={server.synthetic ? "claude.ai managed connector" : formatMcpServer(server)}
                >
                  {server.synthetic ? "claude.ai managed connector" : formatMcpServer(server)}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-3 py-4 text-xs text-muted-foreground">No MCP servers configured.</p>
        )}
      </CardContent>
    </Card>
  );
}

const AUTH_DISPLAY: Record<
  Exclude<McpAuthState, "unknown">,
  { label: string; dot: string }
> = {
  connected: { label: "Connected", dot: "bg-emerald-500" },
  "needs-auth": { label: "Needs auth", dot: "bg-amber-500" },
  failed: { label: "Failed", dot: "bg-red-500" },
  "no-auth": { label: "local", dot: "bg-muted-foreground/50" },
};

function AuthStatusBadge({ state, loading }: { state?: McpAuthState; loading: boolean }) {
  if (!state) {
    return loading ? <Loader2 className="size-3 animate-spin text-muted-foreground" /> : null;
  }
  const display = state === "unknown" ? undefined : AUTH_DISPLAY[state];
  if (!display) return null;
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className={cn("size-1.5 shrink-0 rounded-full", display.dot)} aria-hidden />
      {display.label}
    </span>
  );
}

function formatMcpServer(server: AgentMcpServer): string {
  if (server.command) {
    return [server.command, ...(server.args ?? [])].join(" ");
  }
  return server.url ?? server.type ?? "-";
}
