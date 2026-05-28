import { Gauge } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useToasts } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import {
  getClaudeAgentSettings,
  updateClaudeAgentSettings,
  type AgentProfile,
} from "@/lib/api";
import type { AgentId } from "./agent-types";
import { ClaudeLogo, CodexLogo } from "./agent-logos";
import { ClaudeUsageBlock, CodexUsageBlock } from "./usage-card";
import { useUsage } from "./use-usage";

const AGENT_META: Record<AgentId, { label: string; icon: React.ReactNode }> = {
  "claude-code": { label: "Claude Code", icon: <ClaudeLogo /> },
  codex: { label: "Codex", icon: <CodexLogo /> },
};

export function OverviewTab({
  agent,
  agentId,
  isDetected,
}: {
  agent: AgentProfile;
  agentId: AgentId;
  isDetected: boolean;
}) {
  const { usage, error } = useUsage();
  const meta = AGENT_META[agentId];
  const isCodex = agentId === "codex";

  return (
    <Card className="min-w-0 rounded-none border-0 bg-transparent">
      <CardHeader className="border-b border-border px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Gauge className="size-4 text-muted-foreground" />
          <CardTitle>{isCodex ? "Token Usage & Rate Limits" : "Token & Cost Usage"}</CardTitle>
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
          {!isCodex ? <CoAuthorButton className="ml-auto" /> : null}
        </div>
        <CardDescription className="truncate text-xs">
          {isCodex ? (
            <>
              Session metrics from <code className="font-mono">~/.codex/sessions</code>
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

function CoAuthorButton({ className }: { className?: string }) {
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const toasts = useToasts();

  useEffect(() => {
    let active = true;
    void getClaudeAgentSettings()
      .then((s) => active && setEnabled(s.coAuthorWithClaude))
      .catch(() => {})
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const onToggle = async () => {
    const next = !enabled;
    setSaving(true);
    setEnabled(next);
    try {
      const updated = await updateClaudeAgentSettings({ coAuthorWithClaude: next });
      setEnabled(updated.coAuthorWithClaude);
      toasts.success(
        updated.coAuthorWithClaude
          ? "Claude co-author trailer enabled for commits"
          : "Claude co-author trailer disabled for commits",
      );
    } catch (err) {
      setEnabled(!next);
      toasts.error(err instanceof Error ? err.message : "Failed to update setting");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Button
      type="button"
      variant={enabled ? "default" : "outline"}
      size="sm"
      onClick={onToggle}
      disabled={loading || saving}
      aria-pressed={enabled}
      title={
        enabled
          ? "Claude will be added as commit co-author. Click to disable."
          : "Co-author trailer disabled. Click to enable."
      }
      className={cn("gap-1.5", className)}
    >
      <ClaudeLogo className="size-3.5" />
      Co-author
    </Button>
  );
}

function EmptyUsage({ agent }: { agent: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      No usage data yet. Run a session with {agent} in this project.
    </p>
  );
}
