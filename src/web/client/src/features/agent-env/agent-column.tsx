import { useState } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Globe,
  Package,
  Settings2,
  SlashSquare,
  Sparkles,
  TerminalSquare,
} from "lucide-react";
import {
  AntigravityLogo,
  ClaudeLogo,
  CodexLogo,
} from "@/features/agent/agent-logos";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { AgentSettingsDialog } from "./agent-settings-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OverflowMenu, type OverflowMenuItem } from "@/components/ui/overflow-menu";
import { useT, type Translate } from "@/lib/i18n";
import type {
  AgentEnvAgentName,
  AgentEnvAvailability,
  AgentEnvConfig,
  AgentEnvMcpEntry,
  AgentEnvPendingChange,
  AgentEnvRemoteMcpEntry,
  AgentEnvScope,
  AgentEnvSkill,
} from "@/lib/api";

export const AGENT_LABELS: Record<AgentEnvConfig["agent"], string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  antigravity: "Antigravity",
};

/** Official mark for an agent, brand-colored where the brand has one color. */
export function AgentLogo({
  agent,
  className,
}: {
  agent: AgentEnvAgentName;
  className?: string;
}) {
  if (agent === "claude") return <ClaudeLogo className={cn("text-[#D97757]", className)} />;
  if (agent === "codex") return <CodexLogo className={className} />;
  return <AntigravityLogo className={className} />;
}

const ALL_AGENTS: AgentEnvAgentName[] = ["claude", "codex", "antigravity"];

type StageChange = (change: AgentEnvPendingChange) => void;

/** One agent's live environment: MCP servers by scope, then skills & plugins. */
export function AgentColumn({
  availability,
  config,
  onStage,
}: {
  availability?: AgentEnvAvailability;
  config: AgentEnvConfig;
  onStage?: StageChange;
}) {
  const t = useT();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const userMcps = [
    ...Object.entries(config.mcpServers).map(([name, entry]) => ({
      name,
      detail: localMcpDetail(entry),
      remote: false,
    })),
    ...Object.entries(config.remoteMcpServers).map(([name, entry]) => ({
      name,
      detail: remoteMcpDetail(entry),
      remote: true,
    })),
  ];
  const projectMcps = [
    ...Object.entries(config.projectMcpServers).map(([name, entry]) => ({
      name,
      detail: localMcpDetail(entry),
      remote: false,
    })),
    ...Object.entries(config.projectRemoteMcpServers).map(([name, entry]) => ({
      name,
      detail: remoteMcpDetail(entry),
      remote: true,
    })),
  ];

  return (
    <Card className="flex min-h-0 flex-col">
      <CardHeader className="shrink-0">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-1.5">
            <AgentLogo agent={config.agent} className="size-4" />
            {AGENT_LABELS[config.agent]}
          </CardTitle>
          <span className="flex items-center gap-1">
            {availability ? (
              <Badge size="small" variant={availability.available ? "success" : "warning"}>
                {availability.available ? t("agentEnv.installed") : t("agentEnv.notOnPath")}
              </Badge>
            ) : null}
            <button
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              onClick={() => setSettingsOpen(true)}
              title={t("agentEnv.settingsTitle", { name: AGENT_LABELS[config.agent] })}
              type="button"
            >
              <Settings2 className="size-3.5" />
            </button>
          </span>
        </div>
        {settingsOpen ? (
          <AgentSettingsDialog agent={config.agent} onClose={() => setSettingsOpen(false)} />
        ) : null}
        <p
          className="truncate font-mono text-[11px] text-muted-foreground"
          title={config.configPath}
        >
          {config.exists ? config.configPath : t("agentEnv.noConfig", { path: config.configPath })}
        </p>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 space-y-4 overflow-y-auto">
        <McpSection
          agent={config.agent}
          label={t("agentEnv.mcpServers")}
          mcps={userMcps}
          onStage={onStage}
          scope="user"
        />
        {projectMcps.length > 0 ? (
          <McpSection
            agent={config.agent}
            label={t("agentEnv.projectMcpServers")}
            mcps={projectMcps}
            onStage={onStage}
            scope="project"
          />
        ) : null}
        <SkillsSection
          agent={config.agent}
          onStage={onStage}
          skills={config.skills.filter((skill) => skill.kind !== "plugin")}
        />
        <PluginsSection
          agent={config.agent}
          onStage={onStage}
          plugins={config.skills.filter((skill) => skill.kind === "plugin")}
        />
      </CardContent>
    </Card>
  );
}

/** "Copy to <agent>" / "Move to <agent>" / "Remove" — explicit buttons, no drag-and-drop. */
function changeMenuItems(
  t: Translate,
  change: Omit<AgentEnvPendingChange, "action" | "targetAgent" | "targetScope">,
  onStage: StageChange,
  targetScopeFor: (target: AgentEnvAgentName) => AgentEnvScope,
): OverflowMenuItem[] {
  const others = ALL_AGENTS.filter((agent) => agent !== change.sourceAgent);
  return [
    ...others.map((target) => ({
      label: t("agentEnv.copyTo", { name: AGENT_LABELS[target] }),
      onSelect: () =>
        onStage({ ...change, action: "copy", targetAgent: target, targetScope: targetScopeFor(target) }),
    })),
    ...others.map((target) => ({
      label: t("agentEnv.moveTo", { name: AGENT_LABELS[target] }),
      onSelect: () =>
        onStage({ ...change, action: "move", targetAgent: target, targetScope: targetScopeFor(target) }),
    })),
    { label: t("agentEnv.remove"), onSelect: () => onStage({ ...change, action: "remove" }) },
  ];
}

function McpSection({
  agent,
  label,
  mcps,
  scope,
  onStage,
}: {
  agent: AgentEnvAgentName;
  label: string;
  mcps: Array<{ name: string; detail: string; remote: boolean }>;
  scope: AgentEnvScope;
  onStage?: StageChange;
}) {
  const t = useT();
  return (
    <section>
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </h4>
      {mcps.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("agentEnv.noneConfigured")}</p>
      ) : (
        <ul className="space-y-1">
          {mcps.map((mcp) => (
            <li
              key={mcp.name}
              className="group flex items-start gap-2 rounded-md border border-border/60 bg-background/60 px-2 py-1.5"
            >
              <span className="mt-0.5 text-muted-foreground [&_svg]:size-3.5">
                {mcp.remote ? <Globe /> : <TerminalSquare />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium">{mcp.name}</span>
                <span
                  className="block truncate font-mono text-[11px] text-muted-foreground"
                  title={mcp.detail}
                >
                  {mcp.detail}
                </span>
              </span>
              {onStage ? (
                <OverflowMenu
                  items={changeMenuItems(
                    t,
                    { category: "mcp", name: mcp.name, sourceAgent: agent, sourceScope: scope },
                    onStage,
                    () => scope,
                  )}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SkillsSection({
  agent,
  skills,
  onStage,
}: {
  agent: AgentEnvAgentName;
  skills: AgentEnvSkill[];
  onStage?: StageChange;
}) {
  const t = useT();
  return (
    <section>
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("agentEnv.skills")}
      </h4>
      {skills.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("agentEnv.noneInstalled")}</p>
      ) : (
        <ul className="space-y-1">
          {skills.map((skill) => (
            <li
              key={`${skill.scope}:${skill.name}`}
              className="group flex items-start gap-2 rounded-md border border-border/60 bg-background/60 px-2 py-1.5"
            >
              <span className="mt-0.5 text-muted-foreground [&_svg]:size-3.5">
                <Sparkles />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-medium">{skill.name}</span>
                  {skill.scope === "project" ? (
                    <Badge size="small" variant="outline">
                      project
                    </Badge>
                  ) : null}
                </span>
              </span>
              {onStage ? (
                <OverflowMenu
                  items={changeMenuItems(
                    t,
                    { category: "skill", name: skill.name, sourceAgent: agent, sourceScope: skill.scope },
                    onStage,
                    // Claude and Codex read project-scoped skills; Antigravity is user-only.
                    (target) => (target === "antigravity" ? "user" : skill.scope),
                  )}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Client mirror of core's isRemovablePlugin — drives whether Uninstall shows. */
function isRemovablePlugin(agent: AgentEnvAgentName, plugin: AgentEnvSkill): boolean {
  if (plugin.managed) return true;
  const native = agent === "claude" || agent === "codex";
  return native && !!plugin.installPath && !!plugin.source;
}

function PluginsSection({
  agent,
  plugins,
  onStage,
}: {
  agent: AgentEnvAgentName;
  plugins: AgentEnvSkill[];
  onStage?: StageChange;
}) {
  const t = useT();
  if (plugins.length === 0) return null;
  return (
    <section>
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("agentEnv.plugins")}
      </h4>
      <ul className="space-y-1">
        {plugins.map((plugin) => (
          <PluginRow agent={agent} key={plugin.name} onStage={onStage} plugin={plugin} />
        ))}
      </ul>
    </section>
  );
}

function PluginRow({
  agent,
  plugin,
  onStage,
}: {
  agent: AgentEnvAgentName;
  plugin: AgentEnvSkill;
  onStage?: StageChange;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const contents = [
    ...(plugin.pluginSkills ?? []).map((name) => ({ name, icon: <Sparkles />, label: t("agentEnv.skills") })),
    ...(plugin.pluginMcps ?? []).map((name) => ({ name, icon: <TerminalSquare />, label: t("agentEnv.mcpServers") })),
    ...(plugin.pluginAgents ?? []).map((name) => ({ name, icon: <Bot />, label: t("agentEnv.pluginAgents") })),
    ...(plugin.pluginCommands ?? []).map((name) => ({ name, icon: <SlashSquare />, label: t("agentEnv.pluginCommands") })),
  ];

  return (
    <li className="group rounded-md border border-border/60 bg-background/60 px-2 py-1.5">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-muted-foreground [&_svg]:size-3.5">
          <Package />
        </span>
        <button
          className="min-w-0 flex-1 text-left"
          onClick={() => setExpanded((open) => !open)}
          title={t("agentEnv.toggleContents")}
          type="button"
        >
          <span className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium">{plugin.name}</span>
            {plugin.managed ? (
              <Badge size="small" variant="outline">
                {t("agentEnv.managed")}
              </Badge>
            ) : null}
            {contents.length > 0 ? (
              <span className="text-muted-foreground [&_svg]:size-3">
                {expanded ? <ChevronDown /> : <ChevronRight />}
              </span>
            ) : null}
          </span>
          {plugin.source ? (
            <span className="block truncate font-mono text-[11px] text-muted-foreground" title={plugin.source}>
              {plugin.source}
            </span>
          ) : null}
        </button>
        {onStage && isRemovablePlugin(agent, plugin) ? (
          <OverflowMenu
            items={[
              {
                label: t("agentEnv.uninstall"),
                onSelect: () =>
                  onStage({
                    category: "plugin",
                    action: "remove",
                    name: plugin.name,
                    sourceAgent: agent,
                    sourceScope: "user",
                  }),
              },
            ]}
          />
        ) : null}
      </div>
      {expanded && contents.length > 0 ? (
        <ul className="mt-1.5 space-y-0.5 border-t border-border/40 pt-1.5">
          {contents.map((item) => (
            <li className="flex items-center gap-1.5 pl-5" key={`${item.label}:${item.name}`}>
              <span className="text-muted-foreground [&_svg]:size-3">{item.icon}</span>
              <span className="truncate text-[11px]">{item.name}</span>
              <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                {item.label}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function localMcpDetail(entry: AgentEnvMcpEntry): string {
  return [entry.command, ...(entry.args ?? [])].join(" ").trim() || "(no command)";
}

function remoteMcpDetail(entry: AgentEnvRemoteMcpEntry): string {
  return `${entry.transport} · ${entry.url}`;
}
