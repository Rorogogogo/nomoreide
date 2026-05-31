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
import { useAgentDock } from "../chat/agent-context";
import {
  buildAddPluginPrompt,
  buildAskPluginPrompt,
  buildRemovePluginPrompt,
} from "../prompts";
import type { AgentId } from "../agent-types";
import { AddButton, AddInline, RowActions } from "./tools-shared";

export function PluginsCard({ agent, agentId }: { agent: AgentProfile; agentId: AgentId }) {
  const { sendToAgent } = useAgentDock();
  const [adding, setAdding] = useState(false);
  const plugins = agent.plugins ?? [];

  function add(input: string) {
    setAdding(false);
    sendToAgent({
      prompt: buildAddPluginPrompt(agentId, input),
      source: { type: "agent-plugin", label: "New plugin" },
      label: `Install plugin: ${input}`,
    });
  }

  function ask(plugin: AgentPlugin) {
    sendToAgent({
      prompt: buildAskPluginPrompt(plugin),
      source: { type: "agent-plugin", label: `${plugin.name} plugin` },
      mode: "draft",
    });
  }

  function remove(plugin: AgentPlugin) {
    sendToAgent({
      prompt: buildRemovePluginPrompt(plugin),
      source: { type: "agent-plugin", label: `Remove ${plugin.name}` },
      label: `Uninstall plugin: ${plugin.name}`,
    });
  }

  return (
    <Card className="min-w-0 rounded-none border-0 border-t border-border bg-transparent xl:border-t">
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
              label="Install a plugin with AI"
              onClick={() => setAdding((value) => !value)}
            />
          </div>
        </div>
        {adding ? (
          <AddInline
            className="mt-1.5"
            placeholder="Paste a plugin name, marketplace, or install command…"
            onSubmit={add}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <CardDescription className="text-xs">
            {agentId === "codex"
              ? "Codex doesn't expose an installed-plugin registry here yet."
              : "Installed from marketplaces (~/.claude/plugins). Each bundles skills, commands, agents, and MCP servers."}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {plugins.length ? (
          <ul className="divide-y divide-border">
            {plugins.map((plugin) => (
              <li key={`${plugin.name}@${plugin.marketplace ?? ""}`} className="group px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs font-semibold">{plugin.name}</span>
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
                    <RowActions
                      askLabel={`Ask AI about the ${plugin.name} plugin`}
                      removeLabel={`Uninstall the ${plugin.name} plugin`}
                      onAsk={() => ask(plugin)}
                      onRemove={() => remove(plugin)}
                    />
                  </div>
                </div>
                {plugin.description ? (
                  <p className="mt-1 text-[11px] text-muted-foreground">{plugin.description}</p>
                ) : null}
                <PluginContributions plugin={plugin} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-3 py-4 text-xs text-muted-foreground">No plugins installed.</p>
        )}
      </CardContent>
    </Card>
  );
}

function PluginContributions({ plugin }: { plugin: AgentPlugin }) {
  const parts: string[] = [];
  if (plugin.skills.length) parts.push(`${plugin.skills.length} skill${plural(plugin.skills.length)}`);
  if (plugin.commands.length)
    parts.push(`${plugin.commands.length} command${plural(plugin.commands.length)}`);
  if (plugin.agents.length) parts.push(`${plugin.agents.length} agent${plural(plugin.agents.length)}`);
  if (plugin.mcpServers.length)
    parts.push(`${plugin.mcpServers.length} MCP server${plural(plugin.mcpServers.length)}`);
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

function plural(count: number): string {
  return count === 1 ? "" : "s";
}
