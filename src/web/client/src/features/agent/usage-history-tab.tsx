import { Alert } from "@/components/ui/alert";
import type { UsageDayBucket, UsageHistorySummary } from "@/lib/api";
import { useUsageHistory } from "./use-usage-history";

/**
 * Persisted cost/run history: headline totals + a per-day cost chart, so you can
 * see roughly what a stretch of agent work cost over time. Claude carries real
 * per-session cost; Codex is shown as a token total (no honest per-run price).
 */
export function UsageHistoryTab() {
  const { data, error, loading } = useUsageHistory();

  if (loading && !data) {
    return <Section><Alert variant="muted">Loading usage history…</Alert></Section>;
  }
  if (error) {
    return (
      <Section>
        <Alert variant="muted" className="border-destructive/40 text-destructive">
          Failed to load usage history: {error}
        </Alert>
      </Section>
    );
  }
  const summary = data?.summary;
  if (!summary || (summary.runs === 0 && summary.codexTotalTokens === 0)) {
    return (
      <Section>
        <Alert variant="muted">
          No usage recorded yet. History accrues as you run the in-dock agent — check back after a session.
        </Alert>
      </Section>
    );
  }

  return (
    <Section>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Total cost" value={`$${summary.totalCostUSD.toFixed(2)}`} accent />
        <Stat label="Agent runs" value={String(summary.runs)} />
        <Stat label="Tokens (in+out)" value={formatTokens(summary.totalTokens)} />
        <Stat label="Codex tokens" value={formatTokens(summary.codexTotalTokens)} />
      </div>

      {summary.byDay.length > 0 ? (
        <div className="rounded-md border border-border p-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Cost by day
          </div>
          <DayCostChart days={summary.byDay} />
        </div>
      ) : null}

      <SpanNote summary={summary} />
    </Section>
  );
}

function DayCostChart({ days }: { days: UsageDayBucket[] }) {
  const max = Math.max(...days.map((d) => d.costUSD), 0.0001);
  return (
    <div className="space-y-1.5">
      {days.map((day) => (
        <div key={day.date} className="flex items-center gap-2 text-[11px]">
          <span className="w-20 shrink-0 font-mono text-muted-foreground">{day.date.slice(5)}</span>
          <div className="h-3.5 flex-1 overflow-hidden rounded bg-muted/50">
            <div
              className="h-full rounded bg-emerald-500/80"
              style={{ width: `${Math.max(2, (day.costUSD / max) * 100)}%` }}
            />
          </div>
          <span className="w-14 shrink-0 text-right font-mono text-emerald-700">
            ${day.costUSD.toFixed(2)}
          </span>
          <span className="w-12 shrink-0 text-right text-muted-foreground">
            {day.runs} run{day.runs === 1 ? "" : "s"}
          </span>
        </div>
      ))}
    </div>
  );
}

function SpanNote({ summary }: { summary: UsageHistorySummary }) {
  if (!summary.firstAt || !summary.lastAt) return null;
  const first = summary.firstAt.slice(0, 10);
  const last = summary.lastAt.slice(0, 10);
  return (
    <p className="text-[11px] text-muted-foreground">
      {first === last ? `Recorded on ${first}.` : `Recorded ${first} → ${last}.`} Costs are
      Claude per-session figures; Codex reports lifetime token totals only.
    </p>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return <div className="space-y-3 p-4">{children}</div>;
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={accent ? "font-mono text-lg font-semibold text-emerald-700" : "font-mono text-lg font-semibold"}>
        {value}
      </div>
    </div>
  );
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
