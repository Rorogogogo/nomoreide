import { Gauge } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AgentInfo } from "@/lib/api";
import type { AgentId } from "./agent-types";
import { ClaudeLogo, CodexLogo } from "./agent-logos";
import { ClaudeUsageBlock, CodexUsageBlock } from "./usage-card";
import { useUsage } from "./use-usage";

const AGENT_META: Record<AgentId, { label: string; icon: React.ReactNode }> = {
  "claude-code": { label: "Claude Code", icon: <ClaudeLogo /> },
  codex: { label: "Codex", icon: <CodexLogo /> },
};

export function OverviewTab({ agent, agentId }: { agent: AgentInfo; agentId: AgentId }) {
  const { usage, error } = useUsage();
  const isDetected = agent.detected.name === agentId;
  const meta = AGENT_META[agentId];
  const isCodex = agentId === "codex";

  return (
    <Card className="min-w-0 rounded-none border-0 bg-transparent">
      <CardHeader className="border-b border-border px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Gauge className="size-4 text-muted-foreground" />
          <CardTitle>{isCodex ? "Rate Limits" : "Token & Cost Usage"}</CardTitle>
          <Badge variant="outline" size="small" icon={meta.icon}>
            {meta.label}
          </Badge>
          {isDetected ? (
            <Badge variant="outline" size="small">
              active session
            </Badge>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              Not the active agent in this session
            </span>
          )}
        </div>
        <CardDescription className="truncate text-xs">
          {isCodex ? (
            <>
              Rate-limit windows from <code className="font-mono">~/.codex/sessions</code>
            </>
          ) : (
            <>
              Last-session metrics from <code className="font-mono">~/.claude.json</code>
            </>
          )}
          {" · "}
          <span className="font-mono">{agent.project.cwd}</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="p-3">
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {isCodex ? (
          usage?.codex ? (
            <CodexUsageBlock usage={usage.codex} />
          ) : !error ? (
            <EmptyUsage agent="Codex CLI" />
          ) : null
        ) : usage?.claude ? (
          <ClaudeUsageBlock usage={usage.claude} />
        ) : !error ? (
          <EmptyUsage agent="Claude Code" />
        ) : null}
      </CardContent>
    </Card>
  );
}

function EmptyUsage({ agent }: { agent: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      No usage data yet. Run a session with {agent} in this project.
    </p>
  );
}
