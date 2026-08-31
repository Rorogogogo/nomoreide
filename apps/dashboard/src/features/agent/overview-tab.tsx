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
import { useT } from "@/lib/i18n";
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
}: {
  agent: AgentProfile;
  agentId: AgentId;
}) {
  const { usage, error } = useUsage();
  const t = useT();
  const meta = AGENT_META[agentId];
  const isCodex = agentId === "codex";

  return (
    <Card className="min-w-0 rounded-none border-0 bg-transparent">
      <CardHeader className="border-b border-border px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Gauge className="size-4 text-muted-foreground" />
          <CardTitle>{isCodex ? t("agent.overview.titleCodex") : t("agent.overview.titleClaude")}</CardTitle>
          <Badge variant="outline" size="small" icon={meta.icon}>
            {meta.label}
          </Badge>
          {!isCodex ? <CoAuthorButton className="ml-auto" /> : null}
        </div>
        <CardDescription className="truncate text-xs">
          {isCodex ? (
            <>
              {t("agent.overview.metricsCodexPre")}
              <code className="font-mono">~/.codex/sessions</code>
            </>
          ) : (
            <>
              {t("agent.overview.metricsClaudePre")}
              <code className="font-mono">~/.claude.json</code>
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
  const t = useT();

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
          ? t("agent.overview.coAuthorEnabled")
          : t("agent.overview.coAuthorDisabled"),
      );
    } catch (err) {
      setEnabled(!next);
      toasts.error(err instanceof Error ? err.message : t("agent.overview.coAuthorFailed"));
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
          ? t("agent.overview.coAuthorTitleOn")
          : t("agent.overview.coAuthorTitleOff")
      }
      className={cn("gap-1.5", className)}
    >
      <ClaudeLogo className="size-3.5" />
      {t("agent.overview.coAuthor")}
    </Button>
  );
}

function EmptyUsage({ agent }: { agent: string }) {
  const t = useT();
  return (
    <p className="text-xs text-muted-foreground">
      {t("agent.overview.noUsage", { agent })}
    </p>
  );
}
