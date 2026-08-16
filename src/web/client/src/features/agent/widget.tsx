import { Bot } from "lucide-react";
import { useState } from "react";
import {
  WidgetMore,
  WidgetNote,
  WidgetRow,
  WidgetRows,
  WidgetStat,
  WidgetStats,
  WidgetTab,
  WidgetTabs,
  type WidgetTone,
} from "@/features/home/widget-grid";
import type { WidgetDefinition } from "@/features/home/widget-types";
import type { McpAuthState } from "@/lib/api";
import { useT, type TranslationKey } from "@/lib/i18n";
import { useHomeAgentSummary, type HomeAgentSummary } from "./use-home-agent-summary";

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
 *
 * The four tabs are the same four groups the Agent page's tools tab shows
 * (`agent.tab.tools`), from the same `/api/agent` call, because "what is this
 * agent set up with" is one question with four answers rather than four
 * questions. MCP is the only one of them with live state, which is why it is
 * the only tab whose rows are coloured.
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

/** Four rows names the problem; the rest is the Agent page. */
const ROW_CAP = 4;

const STATE_TONE: Record<McpAuthState, WidgetTone> = {
  connected: "ok",
  "needs-auth": "warn",
  failed: "bad",
  "no-auth": "idle",
  unknown: "idle",
};

type TabId = "skills" | "mcp" | "plugins" | "hooks";

const TABS: { id: TabId; labelKey: TranslationKey }[] = [
  { id: "skills", labelKey: "home.agent.tabSkills" },
  { id: "mcp", labelKey: "home.agent.tabMcp" },
  { id: "plugins", labelKey: "home.agent.tabPlugins" },
  { id: "hooks", labelKey: "home.agent.tabHooks" },
];

function AgentSummary() {
  const t = useT();
  const summary = useHomeAgentSummary();
  const [tab, setTab] = useState<TabId>("mcp");

  /* MCP leads because it is the only one that can be *broken* — the others are
     inventories, and an inventory has no bad state to land on. */
  return (
    <>
      <WidgetTabs>
        {TABS.map((entry) => (
          <WidgetTab active={entry.id === tab} key={entry.id} onSelect={() => setTab(entry.id)}>
            {t(entry.labelKey)}
          </WidgetTab>
        ))}
      </WidgetTabs>
      {tab === "mcp" ? <McpTab summary={summary} /> : null}
      {tab === "skills" ? <SkillsTab summary={summary} /> : null}
      {tab === "plugins" ? <PluginsTab summary={summary} /> : null}
      {tab === "hooks" ? <HooksTab summary={summary} /> : null}
    </>
  );
}

function McpTab({ summary }: { summary: HomeAgentSummary }) {
  const t = useT();
  const { calls, connected, degraded, failedCalls, loaded, servers } = summary;

  /*
    Only the servers that are not simply working, worst first.

    Listing the connected ones filled the panel with names that carry no
    information — the "12" above already said they are fine, and four arbitrary
    healthy servers plus "+10 more" is exactly the text this page is trying to
    stop printing. When everything is connected the list is empty and the tab
    is four numbers, which is the correct amount of page for "nothing is wrong".
  */
  const rows = servers
    .filter((server) => server.state !== "connected")
    .sort((a, b) => rank(a.state) - rank(b.state) || a.name.localeCompare(b.name));

  return (
    <>
      <WidgetStats>
        <WidgetStat label={t("home.agent.connected")} pending={!loaded} tone="ok" value={connected} />
        <WidgetStat label={t("home.agent.degraded")} pending={!loaded} tone="bad" value={degraded} />
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

function SkillsTab({ summary }: { summary: HomeAgentSummary }) {
  const t = useT();
  const { loaded, skills } = summary;

  return (
    <Inventory
      empty={loaded && skills.length === 0}
      rows={skills.map((skill) => ({ key: skill.path, name: skill.name, meta: skill.scope }))}
      stats={
        <>
          <WidgetStat label={t("home.agent.total")} pending={!loaded} value={skills.length} />
          <WidgetStat
            label={t("home.agent.user")}
            pending={!loaded}
            value={skills.filter((skill) => skill.scope === "user").length}
          />
          <WidgetStat
            label={t("home.agent.project")}
            pending={!loaded}
            value={skills.filter((skill) => skill.scope === "project").length}
          />
        </>
      }
    />
  );
}

function PluginsTab({ summary }: { summary: HomeAgentSummary }) {
  const t = useT();
  const { loaded, plugins } = summary;

  return (
    <Inventory
      empty={loaded && plugins.length === 0}
      rows={plugins.map((plugin) => ({
        key: `${plugin.scope}:${plugin.name}`,
        name: plugin.name,
        /* Version if it has one, else where it came from — a plugin row that
           says only its own name has told you nothing you did not click for. */
        meta: plugin.version ?? plugin.marketplace ?? plugin.scope,
      }))}
      stats={
        <>
          <WidgetStat label={t("home.agent.total")} pending={!loaded} value={plugins.length} />
          <WidgetStat
            label={t("home.agent.user")}
            pending={!loaded}
            value={plugins.filter((plugin) => plugin.scope === "user").length}
          />
          <WidgetStat
            label={t("home.agent.project")}
            pending={!loaded}
            value={plugins.filter((plugin) => plugin.scope === "project").length}
          />
        </>
      }
    />
  );
}

function HooksTab({ summary }: { summary: HomeAgentSummary }) {
  const t = useT();
  const { hooks, loaded } = summary;
  const disabled = hooks.filter((hook) => hook.status === "disabled");

  return (
    <Inventory
      empty={loaded && hooks.length === 0}
      /* Disabled first: a hook you think is running and is not is the only
         surprise this list has to offer. */
      rows={[...disabled, ...hooks.filter((hook) => hook.status !== "disabled")].map((hook) => ({
        key: hook.id,
        name: hook.event,
        meta: hook.matcher ?? hook.scope,
        tone: hook.status === "disabled" ? ("idle" as WidgetTone) : undefined,
      }))}
      stats={
        <>
          <WidgetStat label={t("home.agent.total")} pending={!loaded} value={hooks.length} />
          <WidgetStat
            label={t("home.agent.enabled")}
            pending={!loaded}
            tone="ok"
            value={hooks.length - disabled.length}
          />
          <WidgetStat
            label={t("home.agent.disabled")}
            pending={!loaded}
            value={disabled.length}
          />
        </>
      }
    />
  );
}

/**
 * The shape the three inventory tabs share: counters, then the first few names.
 *
 * Extracted because Skills, Plugins and Hooks differ only in what they count
 * and what a row says — three copies of this would drift the moment one of
 * them gained a state.
 */
function Inventory({
  empty,
  rows,
  stats,
}: {
  empty: boolean;
  rows: { key: string; meta?: string; name: string; tone?: WidgetTone }[];
  stats: React.ReactNode;
}) {
  const t = useT();

  return (
    <>
      <WidgetStats>{stats}</WidgetStats>
      {empty ? <WidgetNote>—</WidgetNote> : null}
      {rows.length === 0 ? null : (
        <WidgetRows>
          {rows.slice(0, ROW_CAP).map((row) => (
            <WidgetRow key={row.key} meta={row.meta} name={row.name} tone={row.tone} />
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
