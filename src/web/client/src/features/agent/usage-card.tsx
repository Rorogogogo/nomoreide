import { useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getAgentUsage, type UsageInfo } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ClaudeLogo, CodexLogo } from "./agent-logos";

export function UsageCard() {
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = () => {
      void getAgentUsage()
        .then((info) => {
          if (active) {
            setUsage(info);
            setError(null);
          }
        })
        .catch((err: unknown) => {
          if (active) setError(err instanceof Error ? err.message : String(err));
        });
    };
    load();
    const interval = window.setInterval(load, 10_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  return (
    <Card className="min-w-0 rounded-none border-0 bg-transparent">
      <CardHeader className="border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <Gauge className="size-4 text-muted-foreground" />
          <CardTitle>Token & Cost Usage</CardTitle>
        </div>
        <CardDescription className="text-xs">
          Last-session metrics from <code className="font-mono">~/.claude.json</code> and rate limits scraped from <code className="font-mono">~/.codex/sessions</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-3">
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {usage?.claude ? <ClaudeUsageBlock usage={usage.claude} /> : null}
          {usage?.codex ? <CodexUsageBlock usage={usage.codex} /> : null}
        </div>
        {!usage?.claude && !usage?.codex && !error ? (
          <p className="text-xs text-muted-foreground">
            No usage data yet. Run a session with Claude Code or Codex CLI in this project.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ClaudeUsageBlock({ usage }: { usage: NonNullable<UsageInfo["claude"]> }) {
  const totalInput =
    usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
  const cachePct = totalInput > 0 ? (usage.cacheReadInputTokens / totalInput) * 100 : 0;
  return (
    <div className="rounded-md border border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <div className="flex items-center gap-2">
          <ClaudeLogo className="size-3.5 text-amber-700" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Claude Code · last session
          </span>
          {usage.sessionId ? (
            <span className="font-mono text-[10px] text-muted-foreground">
              {usage.sessionId.slice(0, 8)}
            </span>
          ) : null}
        </div>
        <span className="font-mono text-sm font-semibold text-emerald-700">
          ${usage.costUSD.toFixed(4)}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 px-3 py-2 text-[11px] sm:grid-cols-4">
        <Stat label="Input" value={formatTokens(usage.inputTokens)} />
        <Stat label="Output" value={formatTokens(usage.outputTokens)} />
        <Stat label="Cache read" value={formatTokens(usage.cacheReadInputTokens)} />
        <Stat label="Cache create" value={formatTokens(usage.cacheCreationInputTokens)} />
        <Stat label="Lines +" value={String(usage.linesAdded)} />
        <Stat label="Lines −" value={String(usage.linesRemoved)} />
        <Stat label="Wall" value={formatDuration(usage.durationMs)} />
        <Stat label="API" value={formatDuration(usage.apiDurationMs)} />
      </div>

      <div className="border-t border-border px-3 py-2">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>Cache read share of input</span>
          <span className="font-mono">{cachePct.toFixed(1)}%</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-emerald-500"
            style={{ width: `${Math.min(100, cachePct).toFixed(2)}%` }}
          />
        </div>
      </div>

      {usage.fiveHour || usage.weekly ? (
        <div className="space-y-2 border-t border-border px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Rate limits
          </div>
          {usage.fiveHour ? <UsageBar label="5h block" window={usage.fiveHour} /> : null}
          {usage.weekly ? <UsageBar label="This week" window={usage.weekly} /> : null}
        </div>
      ) : null}

      {usage.models.length ? (
        <div className="space-y-1 border-t border-border px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            By model
          </div>
          {usage.models.map((model) => (
            <div
              key={model.model}
              className="flex items-center justify-between gap-2 font-mono text-[11px]"
            >
              <span className="truncate">{model.model}</span>
              <span className="shrink-0 text-muted-foreground">
                {formatTokens(model.inputTokens + model.outputTokens)} tok ·{" "}
                <span className="text-emerald-700">${model.costUSD.toFixed(4)}</span>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CodexUsageBlock({ usage }: { usage: NonNullable<UsageInfo["codex"]> }) {
  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <div className="flex items-center gap-2">
          <CodexLogo className="size-3.5 text-foreground" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Codex · rate limits
          </span>
        </div>
        {usage.timestamp ? (
          <span className="font-mono text-[10px] text-muted-foreground">
            {new Date(usage.timestamp).toLocaleString()}
          </span>
        ) : null}
      </div>
      <div className="space-y-2 px-3 py-2">
        {usage.primary ? <UsageBar label="5h window" window={usage.primary} /> : null}
        {usage.secondary ? <UsageBar label="Weekly window" window={usage.secondary} /> : null}
      </div>
    </div>
  );
}

function UsageBar({
  label,
  window: window_,
}: {
  label: string;
  window: { usedPercent: number; resetsAtUnix: number };
}) {
  const pct = Math.min(100, Math.max(0, window_.usedPercent));
  const resetsAt = window_.resetsAtUnix
    ? new Date(window_.resetsAtUnix * 1000).toLocaleString()
    : null;
  const tone = pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono">{pct.toFixed(1)}%</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full", tone)} style={{ width: `${pct.toFixed(2)}%` }} />
      </div>
      {resetsAt ? (
        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
          resets {resetsAt}
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-mono text-xs font-semibold">{value}</div>
    </div>
  );
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatDuration(ms: number): string {
  if (!ms) return "0s";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = Math.round(seconds - minutes * 60);
  return `${minutes}m ${remSeconds}s`;
}
