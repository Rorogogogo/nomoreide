import { Bot } from "lucide-react";
import { useState } from "react";
import {
  rowCap,
  WidgetLoading,
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
import type { WidgetDefinition, WidgetRenderProps } from "@/features/home/widget-types";
import type { AgentName, McpAuthState } from "@/lib/api";
import { useT, type TranslationKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ClaudeLogo, CodexLogo } from "./agent-logos";
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
  render: ({ height }) => <AgentSummary height={height} />,
};

/**
 * Four rows names the problem; the rest is the Agent page — but only while the
 * panel is fitting its content. Given a height it lists everything and scrolls,
 * which is the whole reason to drag a panel taller (`WidgetRenderProps.height`).
 */
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

const AGENTS: Array<{ id: AgentName; label: string; mark: React.ReactNode }> = [
  { id: "claude-code", label: "Claude", mark: <ClaudeLogo className="size-3" /> },
  { id: "codex", label: "Codex", mark: <CodexLogo className="size-3" /> },
];

function AgentSummary({ height }: Pick<WidgetRenderProps, "height">) {
  const t = useT();
  const [agent, setAgent] = useState<AgentName>("claude-code");
  const summary = useHomeAgentSummary(agent);
  const [tab, setTab] = useState<TabId>("mcp");
  /* One budget for all four tabs: they share a panel, so a tab that listed
     more than its neighbours would resize the page on every click. */
  const cap = rowCap(height, ROW_CAP);
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
        <fieldset
          aria-label={t("dock.providerAria")}
          className="ml-auto flex shrink-0 items-center gap-0.5 border-0 p-0"
        >
          {AGENTS.map((entry) => (
            <button
              aria-pressed={entry.id === agent}
              className={cn(
                "flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                entry.id === agent
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
              key={entry.id}
              onClick={() => setAgent(entry.id)}
              type="button"
            >
              {entry.mark}
              {entry.label}
            </button>
          ))}
        </fieldset>
      </WidgetTabs>
      {!summary.loaded ? <WidgetLoading label={t("common.loading")} /> : null}
      {summary.loaded && tab === "mcp" ? <McpTab cap={cap} summary={summary} /> : null}
      {summary.loaded && tab === "skills" ? <SkillsTab cap={cap} summary={summary} /> : null}
      {summary.loaded && tab === "plugins" ? <PluginsTab cap={cap} summary={summary} /> : null}
      {summary.loaded && tab === "hooks" ? <HooksTab cap={cap} summary={summary} /> : null}
    </>
  );
}

function McpTab({
  cap,
  summary,
}: {
  cap: number;
  summary: HomeAgentSummary;
}) {
  const t = useT();
  const { calls, connected, degraded, failedCalls, loaded, servers } = summary;

  /*
    Healthy first, then auth warnings, then failures and unknown states. MCP is
    an inventory here as well as a warning surface: keeping the green entries
    visible makes the first rows agree with the connected count above instead
    of opening on amber whenever one server needs attention.
  */
  const ordered = [...servers].sort(
    (a, b) => rank(a.state) - rank(b.state) || a.name.localeCompare(b.name),
  );

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
      {ordered.length === 0 ? null : (
        <WidgetRows>
          {ordered.slice(0, cap).map((server) => (
            <WidgetRow
              key={server.name}
              meta={stateLabel(server.state, t)}
              name={server.name}
              tone={STATE_TONE[server.state]}
            />
          ))}
          {ordered.length > cap ? (
            <WidgetMore>{t("home.more", { count: ordered.length - cap })}</WidgetMore>
          ) : null}
        </WidgetRows>
      )}
    </>
  );
}

function SkillsTab({ cap, summary }: { cap: number; summary: HomeAgentSummary }) {
  const t = useT();
  const { loaded, skills } = summary;

  return (
    <Inventory
      cap={cap}
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

function PluginsTab({ cap, summary }: { cap: number; summary: HomeAgentSummary }) {
  const t = useT();
  const { loaded, plugins } = summary;

  return (
    <Inventory
      cap={cap}
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

function HooksTab({ cap, summary }: { cap: number; summary: HomeAgentSummary }) {
  const t = useT();
  const { hooks, loaded } = summary;
  const disabled = hooks.filter((hook) => hook.status === "disabled");

  return (
    <Inventory
      cap={cap}
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
  cap,
  empty,
  rows,
  stats,
}: {
  cap: number;
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
          {rows.slice(0, cap).map((row) => (
            <WidgetRow key={row.key} meta={row.meta} name={row.name} tone={row.tone} />
          ))}
          {rows.length > cap ? (
            <WidgetMore>{t("home.more", { count: rows.length - cap })}</WidgetMore>
          ) : null}
        </WidgetRows>
      )}
    </>
  );
}

function rank(state: McpAuthState): number {
  if (state === "connected") return 0;
  if (state === "needs-auth") return 1;
  if (state === "failed") return 2;
  return 3;
}

function stateLabel(state: McpAuthState, t: ReturnType<typeof useT>): string {
  if (state === "failed") return t("home.agent.stateFailed");
  if (state === "needs-auth") return t("home.agent.stateNeedsAuth");
  if (state === "no-auth") return t("home.agent.stateNoAuth");
  /* Written out rather than left to the green dot alone. A row whose only
     statement of health is its colour says nothing to a reader who cannot
     separate it from the amber one beside it — and every other row in this tab
     names its state in words. */
  if (state === "connected") return t("home.agent.stateConnected");
  return t("home.agent.stateUnknown");
}
