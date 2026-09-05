import { FolderOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AgentProfile } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { AgentId } from "./agent-types";
import { AgentWorkGraph } from "./agent-work-graph";
import { ToolCallFeed } from "./tool-call-feed";

export function ActivityTab({ agent }: { agent: AgentProfile; agentId: AgentId }) {
  const t = useT();
  return (
    <>
      <AgentWorkGraph />
      <ToolCallFeed />

      <Card className="min-w-0 rounded-none border-0 bg-transparent">
        <CardHeader className="border-b border-border px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <FolderOpen className="size-4 text-muted-foreground" />
              <CardTitle>{t("agent.activity.recentProjects")}</CardTitle>
            </div>
            <Badge variant="outline" size="small">
              {agent.projects.length}
            </Badge>
          </div>
          <CardDescription className="text-xs">
            {t("agent.activity.recentDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {agent.projects.length ? (
            <ul className="divide-y divide-border">
              {agent.projects.map((project) => (
                <li
                  key={project.path}
                  className={cn(
                    "flex items-start justify-between gap-3 px-3 py-2",
                    project.current && "bg-primary/5",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-xs font-semibold">
                        {project.path}
                      </span>
                      {project.current ? (
                        <Badge variant="outline" size="small">
                          {t("agent.current")}
                        </Badge>
                      ) : null}
                    </div>
                    {project.lastSessionFirstPrompt ? (
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {project.lastSessionFirstPrompt}
                      </p>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                    {project.mcpServerCount ? (
                      <div>{project.mcpServerCount} mcp</div>
                    ) : null}
                    {project.lastSessionModified ? (
                      <div>{formatTimestamp(project.lastSessionModified)}</div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-4 text-xs text-muted-foreground">{t("agent.activity.noProjects")}</p>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function formatTimestamp(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed).toLocaleString();
}
