import { Bot } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AgentInfo } from "@/lib/api";
import {
  ClaudeLogo,
  CodexLogo,
  GeminiLogo,
  UnknownAgentLogo,
} from "./agent-logos";
import { UsageCard } from "./usage-card";

type AgentBadgeVariant = "primary" | "secondary" | "success" | "warning";

const AGENT_BADGE: Record<
  AgentInfo["detected"]["name"],
  { label: string; variant: AgentBadgeVariant; icon: React.ReactNode }
> = {
  "claude-code": {
    label: "Claude Code",
    variant: "warning",
    icon: <ClaudeLogo />,
  },
  codex: {
    label: "OpenAI Codex CLI",
    variant: "secondary",
    icon: <CodexLogo />,
  },
  gemini: {
    label: "Gemini CLI",
    variant: "primary",
    icon: <GeminiLogo />,
  },
  unknown: {
    label: "Unknown agent",
    variant: "secondary",
    icon: <UnknownAgentLogo />,
  },
};

export function OverviewTab({ agent }: { agent: AgentInfo }) {
  const badge = AGENT_BADGE[agent.detected.name];
  return (
    <>
      <Card className="min-w-0 rounded-none border-0 border-b border-border bg-transparent">
        <CardHeader className="border-b border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <Bot className="size-4 text-muted-foreground" />
            <CardTitle>Active Agent</CardTitle>
          </div>
          <CardDescription className="text-xs">
            Detected from environment variables and parent process of this MCP server.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={badge.variant}
              appearance="subtle"
              size="medium"
              icon={badge.icon}
            >
              {badge.label}
            </Badge>
            {agent.detected.parentProcess ? (
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                parent: {agent.detected.parentProcess}
              </span>
            ) : null}
          </div>
          {agent.detected.signals.length ? (
            <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
              {agent.detected.signals.map((signal) => (
                <li key={signal}>• {signal}</li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No detection signals captured.</p>
          )}
          <div className="pt-1 text-[11px] text-muted-foreground">
            cwd: <span className="font-mono">{agent.project.cwd}</span>
          </div>
        </CardContent>
      </Card>

      <UsageCard />
    </>
  );
}
