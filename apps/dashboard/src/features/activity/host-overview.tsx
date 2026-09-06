import { ChartPie, CircleGauge, Clock3, Database, Gauge, } from "lucide-react";
import { useState, } from "react";
import type { HostMetricSample } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  chartPath,
  formatBytes,
  formatDuration,
  historyPlotY,
  toneClassName,
} from "./activity-format";
import { HISTORY_PLOT_BOTTOM } from "./activity-plot-bounds";

/**
 * The host panel: the gauges, the machine facts, and the history sparkline.
 *
 * Split out of `activity-view.tsx` because it reads one `HostMetricSample` and
 * renders it — it knows nothing about services, sorting, or the process table
 * that shares the page.
 */

export function HostOverview({
  current,
  headingId = "activity-host-heading",
  label,
  samples,
}: {
  current: HostMetricSample;
  headingId?: string;
  label?: string;
  samples: HostMetricSample[];
}) {
  const t = useT();
  const load = current.loadAverage?.[0];
  const normalizedLoad =
    load === undefined || current.logicalCpuCount === 0
      ? null
      : Math.min(100, (load / current.logicalCpuCount) * 100);

  return (
    <section aria-labelledby={headingId}>
      <div className="mb-3 flex items-center justify-between">
        <h3
          className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground"
          id={headingId}
        >
          <CircleGauge aria-hidden="true" className="size-3.5" />
          {label ?? t("activity.thisMachine")}
        </h3>
        <span className="font-mono text-[10px] text-muted-foreground">
          {t("activity.sampled", {
            time: new Date(current.t).toLocaleTimeString(),
          })}
        </span>
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_260px]">
        <div className="overflow-hidden border-y border-border/70">
          <div className="grid divide-y divide-border md:grid-cols-3 md:divide-x md:divide-y-0">
            <GaugeCard
              icon={<Gauge />}
              label="CPU"
              percent={current.cpuPercent}
              value={
                current.cpuPercent === null
                  ? t("activity.collectingShort")
                  : `${current.cpuPercent.toFixed(1)}%`
              }
              detail={t("activity.logicalCpus", {
                count: String(current.logicalCpuCount),
              })}
              tone="emerald"
            />
            <GaugeCard
              icon={<ChartPie />}
              label={t("activity.memory")}
              percent={current.memoryUsedPercent}
              value={`${current.memoryUsedPercent.toFixed(1)}%`}
              detail={`${formatBytes(current.memoryUsedBytes)} / ${formatBytes(current.memoryTotalBytes)}`}
              tone="sky"
            />
            <GaugeCard
              icon={<Database />}
              label={t("activity.disk")}
              percent={current.disk?.usedPercent ?? null}
              value={
                current.disk
                  ? `${current.disk.usedPercent.toFixed(1)}%`
                  : t("activity.unavailable")
              }
              detail={
                current.disk
                  ? `${formatBytes(current.disk.usedBytes)} / ${formatBytes(current.disk.totalBytes)}`
                  : t("activity.diskUnavailable")
              }
              tone="amber"
            />
          </div>
          <HostHistoryChart samples={samples} />
        </div>
        <aside className="overflow-hidden border-y border-border/70">
          <div className="border-b border-border px-3 py-2.5">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <Clock3 aria-hidden="true" className="size-3.5" />
              {t("activity.loadUptime")}
            </div>
            <div className="mt-3 flex items-end justify-between gap-3">
              <div>
                <div className="font-mono text-2xl font-semibold tracking-tight tabular-nums">
                  {load === undefined ? "—" : load.toFixed(2)}
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground">
                  {t("activity.logicalCpus", {
                    count: String(current.logicalCpuCount),
                  })}
                </div>
              </div>
              <MiniLoadGauge percent={normalizedLoad} />
            </div>
          </div>
          <MachineDetail
            label={t("activity.uptimeLabel")}
            value={formatDuration(current.uptimeSeconds * 1000)}
          />
          <MachineDetail
            label={t("activity.available", { value: "" }).trim()}
            value={
              current.disk
                ? formatBytes(current.disk.availableBytes)
                : t("activity.unavailable")
            }
          />
          <MachineDetail
            label={t("activity.sampled", { time: "" }).trim()}
            value={new Date(current.t).toLocaleTimeString()}
          />
        </aside>
      </div>
    </section>
  );
}

function MachineDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2.5 last:border-b-0">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-[11px] font-semibold tabular-nums">
        {value}
      </span>
    </div>
  );
}

function MiniLoadGauge({ percent }: { percent: number | null }) {
  const progress = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <div
      aria-label={`${Math.round(progress)}%`}
      className="relative size-14 rounded-full"
      role="img"
    >
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: `conic-gradient(hsl(var(--primary)) ${progress * 3.6}deg, hsl(var(--muted)) 0deg)`,
        }}
      />
      <div className="absolute inset-[5px] flex items-center justify-center rounded-full bg-background font-mono text-[9px] font-semibold tabular-nums">
        {percent === null ? "—" : `${Math.round(progress)}%`}
      </div>
    </div>
  );
}

function GaugeCard({
  detail,
  icon,
  label,
  percent,
  tone,
  value,
}: {
  detail: string;
  icon: React.ReactNode;
  label: string;
  percent: number | null;
  tone: "amber" | "emerald" | "sky" | "violet";
  value: string;
}) {
  const progress = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  const circumference = 2 * Math.PI * 38;
  const dashOffset = circumference * (1 - progress / 100);
  return (
    <div className="relative min-h-36 overflow-hidden px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 self-stretch">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            <span
              className={cn(
                "flex size-4 items-center justify-center [&_svg]:size-4",
                toneClassName(tone, "icon"),
              )}
            >
              {icon}
            </span>
            {label}
          </div>
          <div className="mt-4 truncate font-mono text-xl font-semibold tracking-tight tabular-nums">
            {value}
          </div>
          <div className="mt-1 max-w-36 truncate font-mono text-[10px] text-muted-foreground">
            {detail}
          </div>
        </div>
        <div className="relative size-24 shrink-0">
          <svg
            aria-hidden="true"
            className="-rotate-90 size-24 overflow-visible"
            viewBox="0 0 96 96"
          >
            <circle
              className="stroke-muted"
              cx="48"
              cy="48"
              fill="none"
              r="38"
              strokeWidth="7"
            />
            <circle
              className={cn(
                "transition-[stroke-dashoffset] duration-700 ease-out",
                toneClassName(tone, "stroke"),
              )}
              cx="48"
              cy="48"
              fill="none"
              r="38"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              strokeLinecap="round"
              strokeWidth="7"
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center font-mono text-[10px] font-semibold tabular-nums text-muted-foreground">
            {percent === null ? "—" : `${Math.round(progress)}`}
          </div>
        </div>
      </div>
    </div>
  );
}

function HostHistoryChart({ samples }: { samples: HostMetricSample[] }) {
  const t = useT();
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const recent = samples.slice(-120);
  if (recent.length < 2) {
    return (
      <div className="border-t border-dashed border-border px-4 py-5 text-xs text-muted-foreground">
        {t("activity.historyCollecting")}
      </div>
    );
  }
  const cpuPath = chartPath(
    recent.map((sample) => sample.cpuPercent),
    recent.length,
  );
  const memoryPath = chartPath(
    recent.map((sample) => sample.memoryUsedPercent),
    recent.length,
  );
  const duration = (recent.at(-1)?.t ?? recent[0].t) - recent[0].t;
  const inspected =
    hoveredIndex === null ? recent.at(-1) : recent[hoveredIndex];
  const inspectedX =
    hoveredIndex === null
      ? null
      : (hoveredIndex / Math.max(1, recent.length - 1)) * 100;

  const inspectPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(
      1,
      Math.max(0, (event.clientX - bounds.left) / bounds.width),
    );
    setHoveredIndex(Math.round(ratio * (recent.length - 1)));
  };

  return (
    <figure className="border-t border-border px-3 pb-3 pt-3">
      <figcaption className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {t("activity.machineHistory")}
          </div>
          <div className="mt-1 font-mono text-[10px] text-muted-foreground">
            {formatDuration(duration)} · {recent.length} samples
          </div>
        </div>
        <span className="flex items-center gap-4 font-mono text-[10px] tabular-nums">
          <span className="flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgb(16_185_129/0.65)]" />
            <span className="text-muted-foreground">CPU</span>
            <span className="font-semibold text-foreground">
              {inspected?.cpuPercent === null ||
              inspected?.cpuPercent === undefined
                ? "—"
                : `${inspected.cpuPercent.toFixed(1)}%`}
            </span>
          </span>
          <span className="flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-sky-500 shadow-[0_0_8px_rgb(14_165_233/0.65)]" />
            <span className="text-muted-foreground">{t("activity.memory")}</span>
            <span className="font-semibold text-foreground">
              {inspected
                ? `${inspected.memoryUsedPercent.toFixed(1)}%`
                : "—"}
            </span>
          </span>
        </span>
      </figcaption>
      {/* A baseline, not a frame: the gridlines and axis labels already give
          the plot its structure, and a full border would run parallel to
          whichever series sits near the top of the range. */}
      <div
        className="relative h-40 touch-none overflow-hidden border-b border-border/70"
        onPointerLeave={() => setHoveredIndex(null)}
        onPointerMove={inspectPointer}
      >
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--border)/0.28)_1px,transparent_1px)] bg-[size:12.5%_100%]" />
        {[25, 50, 75].map((value) => (
          <span
            className="pointer-events-none absolute inset-x-0 border-t border-dashed border-border/50"
            key={value}
            style={{ top: `${historyPlotY(value)}%` }}
          />
        ))}
        {[100, 50, 0].map((value) => (
          <span
            className="pointer-events-none absolute left-2 z-10 -translate-y-1/2 rounded bg-background/70 px-1 font-mono text-[8px] text-muted-foreground"
            key={value}
            style={{ top: `${historyPlotY(value)}%` }}
          >
            {value}
          </span>
        ))}
        <svg
          aria-label={t("activity.machineHistoryAria")}
          className="absolute inset-0 h-full w-full"
          preserveAspectRatio="none"
          role="img"
          viewBox="0 0 1000 100"
        >
          <defs>
            <linearGradient id="activity-memory-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#0ea5e9" stopOpacity="0.24" />
              <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path
            d={`${memoryPath} L1000,${HISTORY_PLOT_BOTTOM} L0,${HISTORY_PLOT_BOTTOM} Z`}
            fill="url(#activity-memory-fill)"
            stroke="none"
          />
          <path
            d={memoryPath}
            fill="none"
            stroke="#0ea5e9"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
          {cpuPath ? (
            <path
              d={cpuPath}
              fill="none"
              stroke="#10b981"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
        {inspectedX !== null ? (
          <span
            className="pointer-events-none absolute inset-y-0 z-20 w-px bg-foreground/35"
            style={{ left: `${inspectedX}%` }}
          >
            <span className="absolute -left-1 top-[calc(50%-4px)] size-2 rounded-full border-2 border-background bg-foreground shadow-sm" />
          </span>
        ) : null}
      </div>
    </figure>
  );
}
