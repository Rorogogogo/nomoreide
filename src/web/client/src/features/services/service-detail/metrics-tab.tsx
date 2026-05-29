import { useEffect, useState } from "react";
import { getServiceMetrics, type MetricsSeries } from "@/lib/api";

export function MetricsTab({ serviceName }: { serviceName: string }) {
  const [series, setSeries] = useState<MetricsSeries | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const next = await getServiceMetrics(serviceName);
        if (!cancelled) {
          setSeries(next);
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
    return <p className="text-destructive">Failed to load metrics: {error}</p>;
  }
  if (!series) {
    return <p className="text-muted-foreground">Loading metrics…</p>;
  }
  if (series.samples.length === 0) {
    return (
      <p className="text-muted-foreground">
        No samples yet. Metrics start collecting once the service is running.
      </p>
    );
  }

  const latest = series.samples[series.samples.length - 1];
  const startedAt = series.startedAt ? new Date(series.startedAt) : null;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <Stat label="CPU" value={`${latest.cpu.toFixed(1)}%`} />
        <Stat label="RSS" value={`${latest.rss.toFixed(1)} MB`} />
        <Stat label="Samples" value={String(series.samples.length)} />
        {startedAt ? (
          <Stat label="Started" value={startedAt.toLocaleTimeString()} />
        ) : null}
      </header>
      <Chart
        label="CPU"
        samples={series.samples}
        pick={(s) => s.cpu}
        color="#22c55e"
        suffix="%"
        unit="percent"
      />
      <Chart
        label="Memory (RSS)"
        samples={series.samples}
        pick={(s) => s.rss}
        color="#3b82f6"
        suffix=" MB"
        unit="mb"
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-sm">{value}</span>
    </div>
  );
}

const CHART_HEIGHT = 160;
const Y_AXIS_W = 44;
const X_AXIS_H = 20;

function Chart({
  label,
  samples,
  pick,
  color,
  suffix,
  unit,
}: {
  label: string;
  samples: { t: number; cpu: number; rss: number }[];
  pick: (s: { t: number; cpu: number; rss: number }) => number;
  color: string;
  suffix: string;
  unit: "percent" | "mb";
}) {
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
  const toY = (v: number) => (1 - (v - min) / span) * 1000;
  const points = samples.map((s) => `${toX(s.t).toFixed(1)},${toY(pick(s)).toFixed(1)}`);
  const area = `M0,1000 L${points.join(" L")} L1000,1000 Z`;
  const line = `M${points.join(" L")}`;

  const yTicks = [1, 0.75, 0.5, 0.25, 0]; // top→bottom
  const xTickCount = 5;
  const latest = values[values.length - 1];
  const peak = Math.max(...values);

  return (
    <figure className="space-y-1">
      <figcaption className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          now <span className="text-foreground">{latest.toFixed(1)}{suffix}</span>
          <span className="mx-1.5">·</span>peak {peak.toFixed(1)}{suffix}
        </span>
      </figcaption>
      <div className="rounded border border-border bg-card p-2">
        <div className="flex">
          {/* Y-axis labels */}
          <div
            className="relative flex shrink-0 flex-col justify-between text-right font-mono text-[10px] text-muted-foreground"
            style={{ width: Y_AXIS_W, height: CHART_HEIGHT }}
          >
            {yTicks.map((f) => (
              <span key={f} className="pr-1 leading-none">
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
                  top: `${f === 1 ? 0 : f === 0 ? CHART_HEIGHT - 1 : (1 - f) * CHART_HEIGHT}px`,
                  borderStyle: i === yTicks.length - 1 ? "solid" : "dashed",
                }}
              />
            ))}
            <svg
              aria-label={label}
              className="absolute inset-0 h-full w-full"
              preserveAspectRatio="none"
              role="img"
              viewBox="0 0 1000 1000"
            >
              <path d={area} fill={color} fillOpacity={0.18} />
              <path
                d={line}
                fill="none"
                stroke={color}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
              />
            </svg>
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
                  key={i}
                  className="absolute top-1 whitespace-nowrap"
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
  const exp = Math.pow(10, Math.floor(Math.log10(value)));
  const norm = value / exp;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * exp;
}

function formatTick(value: number, unit: "percent" | "mb"): string {
  if (unit === "percent") return `${value.toFixed(0)}%`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)}G`;
  return `${value.toFixed(0)}M`;
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
