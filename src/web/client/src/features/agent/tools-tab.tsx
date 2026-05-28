import { Plug, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AgentMcpServer, AgentProfile } from "@/lib/api";
import type { AgentId } from "./agent-types";

export function ToolsTab({ agent, agentId }: { agent: AgentProfile; agentId: AgentId }) {
  return (
    <div className="grid grid-cols-1 divide-y divide-border xl:grid-cols-2 xl:divide-x xl:divide-y-0">
      <Card className="min-w-0 rounded-none border-0 bg-transparent">
        <CardHeader className="border-b border-border px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-muted-foreground" />
              <CardTitle>Skills</CardTitle>
            </div>
            <Badge variant="outline" size="small">
              {agent.skills.length}
            </Badge>
          </div>
          <CardDescription className="text-xs">
            {agentId === "codex"
              ? "User, project, and system skills discovered for Codex."
              : "User, project, and plugin skills discovered for the active agent."}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {agent.skills.length ? (
            <ul className="divide-y divide-border">
              {agent.skills.map((skill) => (
                <li key={`${skill.scope}:${skill.name}`} className="px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs font-semibold">
                      {skill.name}
                    </span>
                    <Badge variant="outline" size="small">
                      {skill.scope}
                    </Badge>
                  </div>
                  {skill.description ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">{skill.description}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-4 text-xs text-muted-foreground">No skills found.</p>
          )}
        </CardContent>
      </Card>

      <Card className="min-w-0 rounded-none border-0 bg-transparent">
        <CardHeader className="border-b border-border px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Plug className="size-4 text-muted-foreground" />
              <CardTitle>MCP Servers</CardTitle>
            </div>
            <Badge variant="outline" size="small">
              {agent.mcpServers.length}
            </Badge>
          </div>
          <CardDescription className="text-xs">
            From{" "}
            <code className="font-mono">
              {agentId === "codex" ? "~/.codex/config.toml" : "~/.claude.json"}
            </code>
            {agentId === "codex" ? "." : " (user + project scopes)."}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {agent.mcpServers.length ? (
            <ul className="divide-y divide-border">
              {agent.mcpServers.map((server) => (
                <li key={`${server.scope}:${server.name}`} className="px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs font-semibold">
                      {server.name}
                    </span>
                    <Badge variant="outline" size="small">
                      {server.scope}
                    </Badge>
                  </div>
                  <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                    {formatMcpServer(server)}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-4 text-xs text-muted-foreground">No MCP servers configured.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function formatMcpServer(server: AgentMcpServer): string {
  if (server.command) {
    return [server.command, ...(server.args ?? [])].join(" ");
  }
  return server.url ?? server.type ?? "-";
}
