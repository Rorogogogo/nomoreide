import { useState } from "react";
import { Blocks } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AgentPlugin, AgentProfile } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useAgentDock } from "../chat/agent-context";
import { AiContextTarget } from "../context-menu/ai-context-menu";
import {
  buildAddPluginPrompt,
  buildAskPluginPrompt,
  buildRemovePluginPrompt,
} from "../prompts";
import type { AgentId } from "../agent-types";
import { AddButton, AddInline } from "./tools-shared";

export function PluginsCard({ agent, agentId }: { agent: AgentProfile; agentId: AgentId }) {
  const { sendToAgent } = useAgentDock();
  const [adding, setAdding] = useState(false);
  const plugins = agent.plugins ?? [];
  const t = useT();

  function add(input: string) {
    setAdding(false);
    sendToAgent({
      prompt: buildAddPluginPrompt(agentId, input),
      source: { type: "agent-plugin", label: t("agent.plugins.sourceNew") },
      label: t("agent.plugins.installAction", { input }),
    });
  }

  return (
    <Card className="min-w-0 rounded-none border-0 border-t border-border bg-transparent lg:border-l lg:border-t-0">
      <CardHeader className="border-b border-border px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Blocks className="size-4 text-muted-foreground" />
            <CardTitle>Plugins</CardTitle>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" size="small">
              {plugins.length}
            </Badge>
            <AddButton
              label={t("agent.plugins.addLabel")}
              onClick={() => setAdding((value) => !value)}
            />
          </div>
        </div>
        {adding ? (
          <AddInline
            className="mt-1.5"
            placeholder={t("agent.plugins.addPlaceholder")}
            onSubmit={add}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <CardDescription className="text-xs">
            {agentId === "codex" ? t("agent.plugins.descCodex") : t("agent.plugins.desc")}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {plugins.length ? (
          <ul className="divide-y divide-border">
            {plugins.map((plugin) => (
              <AiContextTarget
                key={`${plugin.name}@${plugin.marketplace ?? ""}`}
                target={{
                  label: plugin.name,
                  intents: [
                    {
                      id: "ask-plugin",
                      label: t("agent.plugins.askLabel", { name: plugin.name }),
                      resolvePrompt: () => buildAskPluginPrompt(plugin),
                      source: { type: "agent-plugin", label: t("agent.plugins.sourcePlugin", { name: plugin.name }) },
                    },
                    {
                      id: "remove-plugin",
                      label: t("agent.plugins.removeLabel", { name: plugin.name }),
                      resolvePrompt: () => buildRemovePluginPrompt(plugin),
                      source: { type: "agent-plugin", label: t("agent.plugins.sourceRemove", { name: plugin.name }) },
                      agentLabel: t("agent.plugins.uninstallAction", { name: plugin.name }),
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
                      title={plugin.name}
                    >
                      {plugin.name}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {plugin.version && plugin.version !== "unknown" ? (
                      <Badge variant="outline" size="small">
                        v{plugin.version}
                      </Badge>
                    ) : null}
                    {plugin.marketplace ? (
                      <Badge variant="outline" size="small">
                        {plugin.marketplace}
                      </Badge>
                    ) : null}
                  </div>
                </div>
                {plugin.description ? (
                  <p className="mt-1 truncate text-[11px] text-muted-foreground" title={plugin.description}>
                    {plugin.description}
                  </p>
                ) : null}
                <PluginContributions plugin={plugin} />
              </li>
              </AiContextTarget>
            ))}
          </ul>
        ) : (
          <p className="px-3 py-4 text-xs text-muted-foreground">{t("agent.plugins.empty")}</p>
        )}
      </CardContent>
    </Card>
  );
}

function PluginContributions({ plugin }: { plugin: AgentPlugin }) {
  const t = useT();
  const parts: string[] = [];
  if (plugin.skills.length) parts.push(t("agent.plugins.contribSkills", { count: plugin.skills.length }));
  if (plugin.commands.length)
    parts.push(t("agent.plugins.contribCommands", { count: plugin.commands.length }));
  if (plugin.agents.length) parts.push(t("agent.plugins.contribAgents", { count: plugin.agents.length }));
  if (plugin.mcpServers.length)
    parts.push(t("agent.plugins.contribMcp", { count: plugin.mcpServers.length }));
  if (!parts.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {parts.map((part) => (
        <span
          key={part}
          className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
        >
          {part}
        </span>
      ))}
    </div>
  );
}
