import { useEffect, useState } from "react";
import {
  getAgentInfo,
  getMcpAuthStatuses,
  getRecentToolCalls,
  type AgentHook,
  type AgentInfo,
  type AgentMcpServer,
  type AgentName,
  type AgentPlugin,
  type AgentSkill,
  type McpAuthStatus,
} from "@/lib/api";

/**
 * The four numbers Home wants about the agent side of the workbench, and the
 * MCP servers behind them.
 *
 * Home's other widgets read the dashboard payload the shell already polls; this
 * one is the first that owns its own request, which is why the loading lives
 * here rather than in Home. Everything is best-effort: a workbench with no agent
 * CLI installed is a normal state, not an error to render, so a failed call
 * leaves the counters empty instead of putting a stack trace on the landing
 * page.
 */

export interface HomeAgentSummary {
  servers: McpAuthStatus[];
  connected: number;
  degraded: number;
  calls: number;
  failedCalls: number;
  /**
   * What the agent is *configured with*, as opposed to how it is currently
   * faring — the same four groups the Agent page's tools tab shows, from the
   * same `/api/agent` call.
   *
   * These come back with the agent name and are then left alone. Skills,
   * plugins, hooks and server definitions change when someone edits a config
   * file, not on a timer, and re-fetching tens of kilobytes every poll to watch
   * for that would cost far more than it could ever catch. Live state is the
   * job of `servers`, which is polled.
   */
  skills: AgentSkill[];
  mcpServers: AgentMcpServer[];
  plugins: AgentPlugin[];
  hooks: AgentHook[];
  /**
   * Whether a request has come back yet.
   *
   * Zero and "not asked yet" are different facts and the widget draws them
   * differently — a dashboard that renders `0 connected` while the request is
   * still in flight is not loading, it is *wrong*, and on this endpoint it is
   * wrong for as long as the request takes. Every other widget reads a payload
   * the shell has already fetched and never has this problem.
   */
  loaded: boolean;
}

/** Recent enough to mean "this session", small enough to stay a summary. */
const CALL_WINDOW = 100;

/**
 * Five minutes, and the interval is the important number in this file.
 *
 * `mcp-status` is not a read — it shells out to `claude mcp list`, which
 * cold-starts every configured server to health-check it, and takes about six
 * seconds here. `core/mcp-auth.ts` caches the answer for 15s, so *any* poll
 * slower than that pays the full six seconds every time; at the 20s interval
 * this widget started with, Home held an open connection to the daemon roughly
 * a third of the time it was on screen. Chrome allows six per host, the
 * dashboard already spends several on its event streams, and the result was a
 * landing page that quietly starved its own polling.
 *
 * Server auth state changes when a token expires or someone runs a login — on
 * the order of hours. Five minutes is generous for that and costs the workbench
 * one subprocess per five minutes instead of three per minute.
 */
const POLL_MS = 300_000;

export function useHomeAgentSummary(
  agent: AgentName,
  pollMs = POLL_MS,
): HomeAgentSummary {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [infoLoaded, setInfoLoaded] = useState(false);
  const [serversByAgent, setServersByAgent] = useState<
    Partial<Record<AgentName, McpAuthStatus[]>>
  >({});
  const [calls, setCalls] = useState<Awaited<ReturnType<typeof getRecentToolCalls>> | null>(null);

  // One profile request carries both Claude Code and Codex. Keep it separate
  // from the selected agent's live MCP check so switching never re-reads it.
  useEffect(() => {
    let active = true;
    void getAgentInfo()
      .then((next) => {
        if (active) setInfo(next);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setInfoLoaded(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const [servers, nextCalls] = await Promise.all([
        getMcpAuthStatuses(agent).catch(() => [] as McpAuthStatus[]),
        getRecentToolCalls(CALL_WINDOW).catch(() => []),
      ]);
      if (!active) return;
      setServersByAgent((current) => ({ ...current, [agent]: servers }));
      setCalls(nextCalls);
    };

    void load();
    const interval = window.setInterval(() => void load(), pollMs);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [agent, pollMs]);

  const servers = serversByAgent[agent] ?? [];
  const profile = info?.agents[agent];
  return {
    servers,
    skills: profile?.skills ?? [],
    mcpServers: profile?.mcpServers ?? [],
    plugins: profile?.plugins ?? [],
    hooks: profile?.hooks ?? [],
    connected: servers.filter((server) => server.state === "connected").length,
    // `needs-auth` and `failed` are both "you have to go do something";
    // `no-auth` and `unknown` are neither working nor broken.
    degraded: servers.filter(
      (server) => server.state === "failed" || server.state === "needs-auth",
    ).length,
    calls: calls?.length ?? 0,
    failedCalls: calls?.filter((call) => call.status === "error").length ?? 0,
    loaded: infoLoaded && serversByAgent[agent] !== undefined && calls !== null,
  };
}
