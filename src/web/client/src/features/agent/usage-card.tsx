import type { UsageInfo } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ClaudeLogo, CodexLogo } from "./agent-logos";

export function ClaudeUsageBlock({ usage }: { usage: NonNullable<UsageInfo["claude"]> }) {
  const t = useT();
  const segments: TokenSegment[] = [
    { label: t("agent.usage.cacheRead"), value: usage.cacheReadInputTokens, className: "bg-emerald-500" },
    { label: t("agent.usage.cacheCreate"), value: usage.cacheCreationInputTokens, className: "bg-teal-400" },
    { label: t("agent.usage.freshInput"), value: usage.inputTokens, className: "bg-amber-500" },
    { label: t("agent.usage.output"), value: usage.outputTokens, className: "bg-violet-500", isOutput: true },
  ];
  return (
    <div className="rounded-md border border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <div className="flex items-center gap-2">
          <ClaudeLogo className="size-3.5 text-amber-700" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("agent.usage.claudeLastSession")}
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

      <TokenBar segments={segments} />

      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-border px-3 py-2 text-[11px] sm:grid-cols-4">
        <Stat label={t("agent.usage.input")} value={formatTokens(usage.inputTokens)} />
        <Stat label={t("agent.usage.output")} value={formatTokens(usage.outputTokens)} />
        <Stat label={t("agent.usage.cacheRead")} value={formatTokens(usage.cacheReadInputTokens)} />
        <Stat label={t("agent.usage.cacheCreate")} value={formatTokens(usage.cacheCreationInputTokens)} />
        <Stat label={t("agent.usage.linesAdded")} value={String(usage.linesAdded)} />
        <Stat label={t("agent.usage.linesRemoved")} value={String(usage.linesRemoved)} />
        <Stat label={t("agent.usage.wall")} value={formatDuration(usage.durationMs)} />
        <Stat label={t("agent.usage.api")} value={formatDuration(usage.apiDurationMs)} />
      </div>

      {usage.fiveHour || usage.weekly ? (
        <div className="space-y-2 border-t border-border px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("agent.usage.rateLimits")}
          </div>
          {usage.fiveHour ? <UsageBar label={t("agent.usage.fiveHourBlock")} window={usage.fiveHour} /> : null}
          {usage.weekly ? <UsageBar label={t("agent.usage.thisWeek")} window={usage.weekly} /> : null}
        </div>
      ) : null}

      {usage.models.length ? (
        <div className="space-y-1 border-t border-border px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("agent.usage.byModel")}
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

export function CodexUsageBlock({ usage }: { usage: NonNullable<UsageInfo["codex"]> }) {
  const t = useT();
  const contextPct =
    usage.contextWindow && usage.contextWindow > 0
      ? (usage.lastTotalTokens / usage.contextWindow) * 100
      : 0;
  const segments: TokenSegment[] = [
    { label: t("agent.usage.cacheRead"), value: usage.cachedInputTokens, className: "bg-emerald-500" },
    { label: t("agent.usage.freshInput"), value: Math.max(0, usage.inputTokens - usage.cachedInputTokens), className: "bg-amber-500" },
    { label: t("agent.usage.output"), value: usage.outputTokens, className: "bg-violet-500", isOutput: true },
    { label: t("agent.usage.reasoning"), value: usage.reasoningOutputTokens, className: "bg-sky-500" },
  ];

  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <div className="flex items-center gap-2">
          <CodexLogo className="size-3.5 text-foreground" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("agent.usage.codexLastSession")}
          </span>
        </div>
        {usage.timestamp ? (
          <span className="font-mono text-[10px] text-muted-foreground">
            {new Date(usage.timestamp).toLocaleString()}
          </span>
        ) : null}
      </div>

      <TokenBar segments={segments} />

      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-border px-3 py-2 text-[11px] sm:grid-cols-4">
        <Stat label={t("agent.usage.input")} value={formatTokens(usage.inputTokens)} />
        <Stat label={t("agent.usage.output")} value={formatTokens(usage.outputTokens)} />
        <Stat label={t("agent.usage.cacheRead")} value={formatTokens(usage.cachedInputTokens)} />
        <Stat label={t("agent.usage.reasoning")} value={formatTokens(usage.reasoningOutputTokens)} />
        <Stat label={t("agent.usage.total")} value={formatTokens(usage.totalTokens)} />
        <Stat label={t("agent.usage.lastTurn")} value={formatTokens(usage.lastTotalTokens)} />
        <Stat label={t("agent.usage.context")} value={usage.contextWindow ? formatTokens(usage.contextWindow) : "n/a"} />
        <Stat label={t("agent.usage.cost")} value="n/a" />
      </div>

      {usage.contextWindow ? (
        <div className="border-t border-border px-3 py-2">
          <MetricBar label={t("agent.usage.lastTurnContextShare")} value={contextPct} tone="bg-sky-500" />
        </div>
      ) : null}

      {usage.primary || usage.secondary ? (
        <div className="space-y-2 border-t border-border px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("agent.usage.rateLimits")}
          </div>
          {usage.primary ? <UsageBar label={t("agent.usage.fiveHourWindow")} window={usage.primary} /> : null}
          {usage.secondary ? <UsageBar label={t("agent.usage.weeklyWindow")} window={usage.secondary} /> : null}
        </div>
      ) : null}
    </div>
  );
}

interface TokenSegment {
  label: string;
  value: number;
  /** Tailwind background class for this slice + its legend swatch. */
  className: string;
  /** Marks the output slice, so the bar can split input vs output totals
   *  without matching on the (now translated) label text. */
  isOutput?: boolean;
}

/**
 * Hero token-composition viz: one stacked bar showing how the session's tokens
 * split across cache reads / cache creates / fresh input / output, with a legend
 * carrying each slice's share. Makes cache efficiency (cheap reads vs fresh
 * input) and output weight readable at a glance — the numeric breakdown lives in
 * the Stat grid below.
 */
function TokenBar({ segments }: { segments: TokenSegment[] }) {
  const t = useT();
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const inputTotal = segments
    .filter((segment) => !segment.isOutput)
    .reduce((sum, segment) => sum + segment.value, 0);
  const outputTotal = total - inputTotal;
  return (
    <div className="px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
        <span className="font-semibold">Tokens</span>
        <span className="font-mono normal-case">
          {t("agent.usage.inOut", { in: formatTokens(inputTotal), out: formatTokens(outputTotal) })}
        </span>
      </div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={t("agent.usage.tokenComposition")}>
        {segments.map((segment) =>
          total > 0 && segment.value > 0 ? (
            <div
              className={cn("h-full", segment.className)}
              key={segment.label}
              style={{ width: `${((segment.value / total) * 100).toFixed(2)}%` }}
              title={`${segment.label}: ${formatTokens(segment.value)} (${((segment.value / total) * 100).toFixed(1)}%)`}
            />
          ) : null,
        )}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-4">
        {segments.map((segment) => (
          <div className="flex items-center gap-1.5 text-[11px]" key={segment.label}>
            <span className={cn("size-2 shrink-0 rounded-sm", segment.className)} />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{segment.label}</span>
            <span className="shrink-0 font-mono text-foreground">
              {total > 0 ? ((segment.value / total) * 100).toFixed(0) : "0"}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MetricBar({ label, value, tone }: { label: string; value: number; tone: string }) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono">{pct.toFixed(1)}%</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full", tone)} style={{ width: `${pct.toFixed(2)}%` }} />
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
  const t = useT();
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
          {t("agent.usage.resets", { time: resetsAt })}
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
