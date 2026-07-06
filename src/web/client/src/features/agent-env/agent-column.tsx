import { Globe, Package, Sparkles, TerminalSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OverflowMenu, type OverflowMenuItem } from "@/components/ui/overflow-menu";
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
          <CardTitle>{AGENT_LABELS[config.agent]}</CardTitle>
          {availability ? (
            <Badge size="small" variant={availability.available ? "success" : "warning"}>
              {availability.available ? "installed" : "not on PATH"}
            </Badge>
          ) : null}
        </div>
        <p
          className="truncate font-mono text-[11px] text-muted-foreground"
          title={config.configPath}
        >
          {config.exists ? config.configPath : `no config — ${config.configPath}`}
        </p>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 space-y-4 overflow-y-auto">
        <McpSection
          agent={config.agent}
          label="MCP servers"
          mcps={userMcps}
          onStage={onStage}
          scope="user"
        />
        {projectMcps.length > 0 ? (
          <McpSection
            agent={config.agent}
            label="Project MCP servers"
            mcps={projectMcps}
            onStage={onStage}
            scope="project"
          />
        ) : null}
        <SkillsSection agent={config.agent} onStage={onStage} skills={config.skills} />
      </CardContent>
    </Card>
  );
}

/** "Copy to <agent>" / "Move to <agent>" / "Remove" — explicit buttons, no drag-and-drop. */
function changeMenuItems(
  change: Omit<AgentEnvPendingChange, "action" | "targetAgent" | "targetScope">,
  onStage: StageChange,
  targetScopeFor: (target: AgentEnvAgentName) => AgentEnvScope,
): OverflowMenuItem[] {
  const others = ALL_AGENTS.filter((agent) => agent !== change.sourceAgent);
  return [
    ...others.map((target) => ({
      label: `Copy to ${AGENT_LABELS[target]}`,
      onSelect: () =>
        onStage({ ...change, action: "copy", targetAgent: target, targetScope: targetScopeFor(target) }),
    })),
    ...others.map((target) => ({
      label: `Move to ${AGENT_LABELS[target]}`,
      onSelect: () =>
        onStage({ ...change, action: "move", targetAgent: target, targetScope: targetScopeFor(target) }),
    })),
    { label: "Remove", onSelect: () => onStage({ ...change, action: "remove" }) },
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
  return (
    <section>
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </h4>
      {mcps.length === 0 ? (
        <p className="text-xs text-muted-foreground">None configured.</p>
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
  return (
    <section>
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Skills & plugins
      </h4>
      {skills.length === 0 ? (
        <p className="text-xs text-muted-foreground">None installed.</p>
      ) : (
        <ul className="space-y-1">
          {skills.map((skill) => (
            <li
              key={`${skill.scope}:${skill.name}`}
              className="group flex items-start gap-2 rounded-md border border-border/60 bg-background/60 px-2 py-1.5"
            >
              <span className="mt-0.5 text-muted-foreground [&_svg]:size-3.5">
                {skill.kind === "plugin" ? <Package /> : <Sparkles />}
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
                {skill.kind === "plugin" && skill.pluginSkills?.length ? (
                  <span
                    className="block truncate text-[11px] text-muted-foreground"
                    title={skill.pluginSkills.join(", ")}
                  >
                    {skill.pluginSkills.length} skill
                    {skill.pluginSkills.length === 1 ? "" : "s"}
                    {skill.pluginMcps?.length
                      ? `, ${skill.pluginMcps.length} MCP${skill.pluginMcps.length === 1 ? "" : "s"}`
                      : ""}
                  </span>
                ) : null}
              </span>
              {/* Plugins are managed installs — reinstall via marketplace, don't copy files. */}
              {onStage && skill.kind !== "plugin" ? (
                <OverflowMenu
                  items={changeMenuItems(
                    { category: "skill", name: skill.name, sourceAgent: agent, sourceScope: skill.scope },
                    onStage,
                    // Only Claude reads project-scoped skills; land elsewhere as user scope.
                    (target) => (target === "claude" ? skill.scope : "user"),
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

function localMcpDetail(entry: AgentEnvMcpEntry): string {
  return [entry.command, ...(entry.args ?? [])].join(" ").trim() || "(no command)";
}

function remoteMcpDetail(entry: AgentEnvRemoteMcpEntry): string {
  return `${entry.transport} · ${entry.url}`;
}
