import { useEffect, useId, useMemo, useState } from "react";
import { getServiceMetrics, type MetricSample, type MetricsSeries } from "@/lib/api";
import { useT } from "@/lib/i18n";

export function MetricsTab({ serviceName }: { serviceName: string }) {
  const t = useT();
  const [series, setSeries] = useState<MetricsSeries | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const next = await getServiceMetrics(serviceName);
        if (!cancelled) {
          setSeries(next);
          setNow(Date.now());
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    void tick();
    const interval = setInterval(() => void tick(), 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [serviceName]);

  if (error) {
    return <p className="text-destructive">{t("services.metrics.loadError", { error })}</p>;
  }
  if (!series) {
    return <p className="text-muted-foreground">{t("services.metrics.loading")}</p>;
  }
  if (series.samples.length === 0) {
    return <p className="text-muted-foreground">{t("services.metrics.noSamples")}</p>;
  }

  return <MetricsContent series={series} now={now} />;
}

function MetricsContent({ series, now }: { series: MetricsSeries; now: number }) {
  const t = useT();
  const { samples } = series;
  const cpu = useMemo(() => summarize(samples, (s) => s.cpu), [samples]);
  const mem = useMemo(() => summarize(samples, (s) => s.rss), [samples]);

  const startedAt = series.startedAt ? new Date(series.startedAt) : null;
  const uptimeMs = startedAt ? now - startedAt.getTime() : null;
  const windowMs = samples.length > 1 ? samples[samples.length - 1].t - samples[0].t : 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatCard
          accent="#22c55e"
          label="CPU"
          value={`${cpu.last.toFixed(1)}%`}
          sub={t("services.metrics.peakAvg", {
            peak: `${cpu.max.toFixed(1)}%`,
            avg: `${cpu.avg.toFixed(1)}%`,
          })}
        />
        <StatCard
          accent="#3b82f6"
          label={t("services.metrics.memory")}
          value={formatMb(mem.last)}
          sub={t("services.metrics.peakAvg", {
            peak: formatMb(mem.max),
            avg: formatMb(mem.avg),
          })}
        />
        <StatCard
          accent="#a855f7"
          label={t("services.metrics.uptime")}
          value={uptimeMs != null ? formatDuration(uptimeMs) : "—"}
          sub={
            startedAt
              ? t("services.metrics.since", { time: startedAt.toLocaleTimeString() })
              : t("services.metrics.notRunning")
          }
        />
        <StatCard
          accent="#f59e0b"
          label={t("services.metrics.samples")}
          value={String(samples.length)}
          sub={windowMs ? t("services.metrics.over", { dur: formatDuration(windowMs) }) : t("services.metrics.collecting")}
        />
      </div>
      <Chart
        label="CPU"
        samples={samples}
        pick={(s) => s.cpu}
        summary={cpu}
        color="#22c55e"
        suffix="%"
        unit="percent"
      />
      <Chart
        label={t("services.metrics.memoryRss")}
        samples={samples}
        pick={(s) => s.rss}
        summary={mem}
        color="#3b82f6"
        suffix=" MB"
        unit="mb"
      />
    </div>
  );
}

interface Summary {
  last: number;
  max: number;
  min: number;
  avg: number;
}

function summarize(samples: MetricSample[], pick: (s: MetricSample) => number): Summary {
  const values = samples.map(pick);
  const sum = values.reduce((acc, v) => acc + v, 0);
  return {
    last: values[values.length - 1],
    max: Math.max(...values),
    min: Math.min(...values),
    avg: sum / values.length,
  };
}

function StatCard({
  accent,
  label,
  value,
  sub,
}: {
  accent: string;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="flex items-center gap-1.5">
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: accent }}
        />
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
      </div>
      <div className="mt-1 font-mono text-lg leading-none tabular-nums">{value}</div>
      <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{sub}</div>
    </div>
  );
}

const CHART_HEIGHT = 160;
const Y_AXIS_W = 44;
const X_AXIS_H = 20;
const PLOT_TOP = 40;
const PLOT_BOTTOM = 960;
const PLOT_HEIGHT = PLOT_BOTTOM - PLOT_TOP;

function Chart({
  label,
  samples,
  pick,
  summary,
  color,
  suffix,
  unit,
}: {
  label: string;
  samples: MetricSample[];
  pick: (s: MetricSample) => number;
  summary: Summary;
  color: string;
  suffix: string;
  unit: "percent" | "mb";
}) {
  const t = useT();
  const gradientId = `metric-grad-${unit}-${useId()}`;
  const values = samples.map(pick);
  const rawMax = Math.max(...values, unit === "percent" ? 10 : 1);
  const max = niceMax(rawMax);
  const min = 0;
  const span = max - min || 1;
  const firstT = samples[0].t;
  const lastT = samples[samples.length - 1].t;
  const tSpan = Math.max(1, lastT - firstT);

  // Path uses a normalized 0–1000 × 0–1000 viewBox stretched non-uniformly
  // by the SVG; labels live in HTML so they stay crisp at any width.
  const toX = (t: number) => ((t - firstT) / tSpan) * 1000;
  const toY = (v: number) =>
    PLOT_TOP + (1 - (v - min) / span) * PLOT_HEIGHT;
  const plotTop = (fraction: number) =>
    (PLOT_TOP + (1 - fraction) * PLOT_HEIGHT) / 10;
  const points = samples.map((s) => `${toX(s.t).toFixed(1)},${toY(pick(s)).toFixed(1)}`);
  const area = `M0,${PLOT_BOTTOM} L${points.join(" L")} L1000,${PLOT_BOTTOM} Z`;
  const line = `M${points.join(" L")}`;
  const lastX = toX(lastT);
  const lastY = toY(summary.last);
  const avgY = toY(summary.avg);

  const yTicks = [1, 0.75, 0.5, 0.25, 0]; // top→bottom
  const xTickCount = 5;

  return (
    <figure className="space-y-1">
      <figcaption className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {t("services.metrics.wNow")} <span className="text-foreground">{summary.last.toFixed(1)}{suffix}</span>
          <span className="mx-1.5">·</span>{t("services.metrics.wPeak")} {summary.max.toFixed(1)}{suffix}
          <span className="mx-1.5">·</span>{t("services.metrics.wAvg")} {summary.avg.toFixed(1)}{suffix}
        </span>
      </figcaption>
      <div className="rounded-lg border border-border bg-card p-2">
        <div className="flex">
          {/* Y-axis labels */}
          <div
            className="relative shrink-0 text-right font-mono text-[10px] text-muted-foreground"
            style={{ width: Y_AXIS_W, height: CHART_HEIGHT }}
          >
            {yTicks.map((f) => (
              <span
                className="absolute right-0 -translate-y-1/2 pr-1 leading-none"
                key={f}
                style={{ top: `${plotTop(f)}%` }}
              >
                {formatTick(min + f * span, unit)}
              </span>
            ))}
          </div>
          {/* Plot area */}
          <div className="relative min-w-0 flex-1" style={{ height: CHART_HEIGHT }}>
            {/* Horizontal gridlines via CSS so they stay 1px regardless of scale */}
            {yTicks.map((f, i) => (
              <div
                key={f}
                className="pointer-events-none absolute inset-x-0 border-t border-border/40"
                style={{
                  top: `${plotTop(f)}%`,
                  borderStyle: i === yTicks.length - 1 ? "solid" : "dashed",
                }}
              />
            ))}
            {/* Average reference line */}
            <div
              className="pointer-events-none absolute inset-x-0 border-t border-dashed"
              style={{
                top: `${avgY / 10}%`,
                borderColor: color,
                opacity: 0.4,
              }}
            />
            <svg
              aria-label={label}
              className="absolute inset-0 h-full w-full"
              preserveAspectRatio="none"
              role="img"
              viewBox="0 0 1000 1000"
            >
              <defs>
                <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <path d={area} fill={`url(#${gradientId})`} />
              <path
                d={line}
                fill="none"
                stroke={color}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </svg>
            {/* Live "current value" dot — positioned in HTML so it stays round */}
            <span
              className="pointer-events-none absolute z-10 block h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card"
              style={{
                left: `${(lastX / 1000) * 100}%`,
                top: `${lastY / 10}%`,
                backgroundColor: color,
                boxShadow: `0 0 0 4px ${color}33`,
              }}
            />
          </div>
        </div>
        {/* X-axis labels */}
        <div
          className="flex font-mono text-[10px] text-muted-foreground"
          style={{ height: X_AXIS_H, paddingLeft: Y_AXIS_W }}
        >
          <div className="relative flex-1">
            {Array.from({ length: xTickCount + 1 }, (_, i) => {
              const frac = i / xTickCount;
              const tick = firstT + frac * tSpan;
              return (
                <span
                  className="absolute top-1 whitespace-nowrap"
                  key={tick}
                  style={{
                    left: `${frac * 100}%`,
                    transform:
                      i === 0
                        ? "translateX(0)"
                        : i === xTickCount
                          ? "translateX(-100%)"
                          : "translateX(-50%)",
                  }}
                >
                  {formatRelative(tick - lastT)}
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </figure>
  );
}

function niceMax(value: number): number {
  if (value <= 1) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  const norm = value / exp;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * exp;
}

function formatTick(value: number, unit: "percent" | "mb"): string {
  if (unit === "percent") return `${value.toFixed(0)}%`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)}G`;
  return `${value.toFixed(0)}M`;
}

function formatMb(value: number): string {
  if (value >= 1024) return `${(value / 1024).toFixed(2)} GB`;
  return `${value.toFixed(0)} MB`;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatRelative(deltaMs: number): string {
  const seconds = Math.round(deltaMs / 1000);
  if (seconds === 0) return "now";
  const abs = Math.abs(seconds);
  if (abs < 60) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  if (Math.abs(m) < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}
