import { useEffect, useRef, useState } from "react";
import {
  getAgentInfo,
  getMcpAuthStatuses,
  getRecentToolCalls,
  type AgentHook,
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

const EMPTY: HomeAgentSummary = {
  servers: [],
  connected: 0,
  degraded: 0,
  calls: 0,
  failedCalls: 0,
  skills: [],
  mcpServers: [],
  plugins: [],
  hooks: [],
  loaded: false,
};

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

export function useHomeAgentSummary(pollMs = POLL_MS): HomeAgentSummary {
  const [summary, setSummary] = useState<HomeAgentSummary>(EMPTY);
  /*
    Which agent to ask, resolved once.

    `/api/agent` is the workbench's whole agent picture — memory files, skills,
    plugins, projects — and answering it is tens of kilobytes. All this widget
    wants from it is a name that cannot change while the tab is open, so paying
    for it on every poll is a large repeated request for a constant. Home is the
    page people leave open.
  */
  const agentRef = useRef<AgentName | null>(null);
  /*
    And the configured tools from that same answer, kept rather than discarded.

    The call was already being made to learn the name; the profile rides along
    with it for free. Holding it here means the tabs cost no request of their
    own and no second trip when the poll comes round.
  */
  const toolsRef = useRef<Pick<
    HomeAgentSummary,
    "hooks" | "mcpServers" | "plugins" | "skills"
  > | null>(null);

  useEffect(() => {
    let active = true;

    const resolveAgent = async (): Promise<AgentName> => {
      if (agentRef.current) return agentRef.current;
      /*
        `mcp-status` is per-agent and the endpoint only knows the two that have
        a CLI to ask. Detection can also come back "gemini" or "unknown", so
        anything that isn't Codex asks as Claude Code — the same defaulting the
        agent terminal already does, rather than a second rule to keep in sync.
      */
      const info = await getAgentInfo().catch(() => null);
      const agent: AgentName = info?.detected.name === "codex" ? "codex" : "claude-code";
      // Only remember a real answer: caching the fallback would make one failed
      // call permanent for the life of the tab.
      if (info) {
        agentRef.current = agent;
        /* The detected agent's own profile, not the union of both — `AgentInfo`
           extends `AgentProfile` with exactly that at the top level. */
        toolsRef.current = {
          skills: info.skills,
          mcpServers: info.mcpServers,
          plugins: info.plugins,
          hooks: info.hooks,
        };
      }
      return agent;
    };

    const load = async () => {
      const agent = await resolveAgent();
      if (!active) return;

      const [servers, calls] = await Promise.all([
        getMcpAuthStatuses(agent).catch(() => [] as McpAuthStatus[]),
        getRecentToolCalls(CALL_WINDOW).catch(() => []),
      ]);
      if (!active) return;

      setSummary({
        servers,
        skills: toolsRef.current?.skills ?? [],
        mcpServers: toolsRef.current?.mcpServers ?? [],
        plugins: toolsRef.current?.plugins ?? [],
        hooks: toolsRef.current?.hooks ?? [],
        connected: servers.filter((server) => server.state === "connected").length,
        // `needs-auth` and `failed` are both "you have to go do something";
        // `no-auth` and `unknown` are neither working nor broken.
        degraded: servers.filter(
          (server) => server.state === "failed" || server.state === "needs-auth",
        ).length,
        calls: calls.length,
        failedCalls: calls.filter((call) => call.status === "error").length,
        loaded: true,
      });
    };

    void load();
    const interval = window.setInterval(() => void load(), pollMs);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [pollMs]);

  return summary;
}
