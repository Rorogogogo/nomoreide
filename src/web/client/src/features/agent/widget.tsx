import { Bot } from "lucide-react";
import {
  WidgetMore,
  WidgetRow,
  WidgetRows,
  WidgetStat,
  WidgetStats,
  type WidgetTone,
} from "@/features/home/widget-grid";
import type { WidgetDefinition } from "@/features/home/widget-types";
import type { McpAuthState } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useHomeAgentSummary } from "./use-home-agent-summary";

/**
 * Agent — the AI side of the workbench, on the page you land on.
 *
 * NoMoreIDE's whole premise is that an agent is a first-class operator of these
 * services, and Home shipped without a word about whether that half was even
 * working. A dashboard for an AI-native tool that only reports processes and
 * ports is describing the old half of the product.
 *
 * It is also the first widget that pays for its own data — see `source` on the
 * widget contract. The hook beside it owns the loading, so Home itself still
 * knows nothing about fetching.
 */
export const agentWidget: WidgetDefinition = {
  id: "agent",
  titleKey: "home.widget.agent",
  icon: <Bot />,
  span: 6,
  scope: "global",
  source: "fetch",
  page: "agent",
  render: () => <AgentSummary />,
};

/** Four servers names the problem; the rest is the Agent page. */
const ROW_CAP = 4;

const STATE_TONE: Record<McpAuthState, WidgetTone> = {
  connected: "ok",
  "needs-auth": "warn",
  failed: "bad",
  "no-auth": "idle",
  unknown: "idle",
};

function AgentSummary() {
  const t = useT();
  const { calls, connected, degraded, failedCalls, loaded, servers } = useHomeAgentSummary();

  /*
    Only the servers that are not simply working, worst first.

    Listing the connected ones filled the panel with names that carry no
    information — the "12" above already said they are fine, and four arbitrary
    healthy servers plus "+10 more" is exactly the text this page is trying to
    stop printing. When everything is connected the list is empty and the widget
    is four numbers, which is the correct amount of page for "nothing is wrong".
  */
  const rows = servers
    .filter((server) => server.state !== "connected")
    .sort((a, b) => rank(a.state) - rank(b.state) || a.name.localeCompare(b.name));

  return (
    <>
      <WidgetStats>
        <WidgetStat
          label={t("home.agent.connected")}
          pending={!loaded}
          tone="ok"
          value={connected}
        />
        <WidgetStat
          label={t("home.agent.degraded")}
          pending={!loaded}
          tone="bad"
          value={degraded}
        />
        <WidgetStat label={t("home.agent.calls")} pending={!loaded} value={calls} />
        <WidgetStat
          label={t("home.agent.failedCalls")}
          pending={!loaded}
          tone="warn"
          value={failedCalls}
        />
      </WidgetStats>
      {rows.length === 0 ? null : (
        <WidgetRows>
          {rows.slice(0, ROW_CAP).map((server) => (
            <WidgetRow
              key={server.name}
              meta={stateLabel(server.state, t)}
              name={server.name}
              tone={STATE_TONE[server.state]}
            />
          ))}
          {rows.length > ROW_CAP ? (
            <WidgetMore>{t("home.more", { count: rows.length - ROW_CAP })}</WidgetMore>
          ) : null}
        </WidgetRows>
      )}
    </>
  );
}

function rank(state: McpAuthState): number {
  if (state === "failed") return 0;
  if (state === "needs-auth") return 1;
  if (state === "unknown" || state === "no-auth") return 2;
  return 3;
}

function stateLabel(state: McpAuthState, t: ReturnType<typeof useT>): string {
  if (state === "failed") return t("home.agent.stateFailed");
  if (state === "needs-auth") return t("home.agent.stateNeedsAuth");
  if (state === "no-auth") return t("home.agent.stateNoAuth");
  return t("home.agent.stateUnknown");
}
