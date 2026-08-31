import { useId, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { LogVolumeBucket, MetricSample } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { OutputVolume } from "./output-volume";

/**
 * The half hour behind the log lines, as three graphs sharing one time axis.
 *
 * A tail answers "what did it say"; it cannot answer "when did this start", and
 * forty lines of a service mid-burst can span four seconds. The graph is the
 * axis those lines are missing: a spike says *where* to look, and the lines are
 * directly beneath it.
 *
 * **Separate panes, not one chart with several scales.** CPU is a percentage,
 * memory is megabytes and output is a line count; a second y-axis is the
 * standard way to make unrelated quantities look like they cross. Stacked on a
 * shared x-range they stay comparable in the only way that matters here — in
 * time. The third pane is `output-volume.tsx`, and it goes last because it is
 * the one the log lines beneath are an expansion of.
 *
 * Each metric pane draws a single series, so identity is carried by its own
 * caption rather than by a legend, and the hues are checked against the surfaces
 * in both themes rather than picked: `#16a34a` and `#3b82f6` clear the lightness
 * band, the chroma floor, CVD separation and 3:1 contrast on light and dark.
 *
 * The x mapping is by *timestamp*, not by sample index. The daemon samples on a
 * timer that a busy machine can miss, and an index-based axis would quietly
 * compress those gaps — which would put a spike at the wrong time, the one error
 * this panel exists to avoid.
 */

/** Tall enough to show a shape, short enough that two fit above a log tail. */
const PANE_PX = 44;

/**
 * The smallest peak a zero-based pane will scale to, as a percentage.
 *
 * Each pane is scaled to its own peak, which is the only way a service idling
 * at a fraction of a percent has a visible shape at all — and it is safe to do
 * *because the peak is printed beside the name*. Without that label the same
 * pane would be a lie by omission: identical mountains at 0.1% and at 90%.
 *
 * A tenth of a percent is where the floor sits, and it exists only to stop a
 * completely idle service from having its rounding magnified into weather.
 */
const QUIET_PEAK = 0.1;

const CPU_COLOR = "#16a34a";
const MEMORY_COLOR = "#3b82f6";

/** The plot's own coordinates. Stretched to any width; strokes stay 2px. */
const VIEW = 1000;

export function OutputGraph({
  samples,
  volume,
}: {
  samples: MetricSample[];
  volume: LogVolumeBucket[];
}) {
  const t = useT();
  const [at, setAt] = useState<number | null>(null);

  /* Two points is the minimum that has a direction. Below that there is nothing
     to draw and no honest way to fake it, so the panel is simply a tail again —
     which is also what a service that has never started looks like, and what a
     stopped one decays into once its buffer is dropped. */
  if (samples.length < 2) return null;

  const first = samples[0].t;
  const last = samples[samples.length - 1].t;
  const span = Math.max(1, last - first);
  const index = at ?? samples.length - 1;
  const shown = samples[index] ?? samples[samples.length - 1];

  /* Nearest by time rather than by index, for the same reason the axis is:
     the cursor is over a *moment*, and the sample nearest that moment is the
     one the reader is pointing at even when the series has a gap in it. */
  const track = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const wanted = first + ((event.clientX - rect.left) / rect.width) * span;
    let nearest = 0;
    for (let i = 1; i < samples.length; i += 1) {
      if (Math.abs(samples[i].t - wanted) < Math.abs(samples[nearest].t - wanted)) nearest = i;
    }
    setAt(nearest);
  };

  const cursor = ((shown.t - first) / span) * 100;

  return (
    /* The pointer handler lives on the wrapper rather than on either plot, so a
       cursor anywhere over the pair moves the readout in both — one moment
       being pointed at, not two. */
    <div
      className="flex shrink-0 flex-col gap-1"
      onPointerLeave={() => setAt(null)}
      onPointerMove={track}
    >
      <Pane
        baseline="zero"
        color={CPU_COLOR}
        current={shown.cpu}
        cursor={at === null ? null : cursor}
        first={first}
        format={(value) => `${value.toFixed(1)}%`}
        label={t("home.output.cpu")}
        peakLabel={t("home.output.peak")}
        pick={(sample) => sample.cpu}
        samples={samples}
        span={span}
      />
      <Pane
        baseline="range"
        color={MEMORY_COLOR}
        current={shown.rss}
        cursor={at === null ? null : cursor}
        first={first}
        format={formatMb}
        label={t("home.output.memory")}
        peakLabel={t("home.output.peak")}
        pick={(sample) => sample.rss}
        samples={samples}
        span={span}
      />
      {/* Last of the three, and closest to the lines: the strip is a count of
          the very text underneath it, so a spike and the lines it is made of are
          within a few pixels of each other. */}
      <OutputVolume
        at={at === null ? null : shown.t}
        buckets={volume}
        cursor={at === null ? null : cursor}
      />
      <span className="flex justify-between font-mono text-[9px] text-muted-foreground/60">
        <span>{clock(first)}</span>
        {/* The hovered moment, in the gap between the two ends — the answer to
            "when was that" without a floating tooltip to chase. */}
        <span className={at === null ? "invisible" : "text-muted-foreground"}>
          {clock(shown.t)}
        </span>
        <span>{clock(last)}</span>
      </span>
    </div>
  );
}

/**
 * One measure, over the shared range, with the value beside its name.
 *
 * The `baseline` is the whole difference between the two panes, and it decides
 * the mark as much as the scale:
 *
 * - `zero` is for a quantity that genuinely starts at nothing. CPU does, so the
 *   pane is filled — the area under a percentage means something, and idle
 *   really is the bottom of the pane. It scales to the series' own peak rather
 *   than to 100%, because a service that never passes 4% would otherwise be a
 *   flat line on the floor.
 * - `range` is for a quantity that never goes near zero. Resident memory sits
 *   at a few hundred megabytes and moves by tens, so a zero-based pane is a
 *   solid block with a wobble on top — it was, until this. The pane holds the
 *   band the series actually moved in, **and drops the fill**: an area whose
 *   baseline is 380MB would claim an area that is not there. A line makes no
 *   such claim, and the missing fill is the signal that the floor is not zero.
 */
function Pane({
  baseline,
  color,
  current,
  cursor,
  first,
  format,
  label,
  peakLabel,
  pick,
  samples,
  span,
}: {
  baseline: "zero" | "range";
  color: string;
  /** The value at the moment being pointed at, or the latest one. */
  current: number;
  /** Where the reader is pointing, as a percentage, or `null` when they are not. */
  cursor: number | null;
  first: number;
  format: (value: number) => string;
  label: string;
  peakLabel: string;
  pick: (sample: MetricSample) => number;
  samples: MetricSample[];
  span: number;
}) {
  const gradient = `output-graph-${useId()}`;
  const values = samples.map(pick);
  const peak = Math.max(...values);
  /* A floor on the *scale*, not on the data (see `QUIET_PEAK`), and a quarter
     of headroom above the peak so the tallest spike stops short of the caption
     instead of touching it. */
  const [low, high] =
    baseline === "zero" ? [0, Math.max(peak, QUIET_PEAK) * 1.25] : band(values, peak);
  const x = (sample: MetricSample) => ((sample.t - first) / span) * VIEW;
  const y = (sample: MetricSample) => VIEW - ((pick(sample) - low) / (high - low)) * VIEW;
  const points = samples.map((sample) => `${x(sample).toFixed(1)},${y(sample).toFixed(1)}`);

  return (
    <span className="flex flex-col gap-0.5">
      <span className="flex items-baseline justify-between font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
        {/* Direct label rather than a legend: one series per pane, named where
            it is, so identity never rests on the colour alone. */}
        <span className="flex items-center gap-1">
          <span aria-hidden className="size-1.5 rounded-[1px]" style={{ background: color }} />
          {label}
        </span>
        <span className="flex items-baseline gap-2 tabular-nums">
          {/* The scale, stated. Every pane is scaled to its own peak, so this is
              the number that tells two identical-looking shapes apart. */}
          <span className="text-muted-foreground/60">
            {peakLabel} {format(peak)}
          </span>
          <span className="text-foreground/80">{format(current)}</span>
        </span>
      </span>
      <span className="relative block" style={{ height: PANE_PX }}>
        <svg
          /* The shape is not readable aloud, but the measure and where it
             currently stands are, and that is the whole of what the pane says
             in one line. */
          aria-label={`${label} ${format(current)}`}
          className="absolute inset-0 h-full w-full"
          preserveAspectRatio="none"
          role="img"
          viewBox={`0 0 ${VIEW} ${VIEW}`}
        >
          {baseline === "zero" ? (
            <>
              <defs>
                {/* A wash, not a block: the line carries the value, the fill
                    only says which side of it is "used". */}
                <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.16} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <path
                d={`M0,${VIEW} L${points.join(" L")} L${VIEW},${VIEW} Z`}
                fill={`url(#${gradient})`}
              />
            </>
          ) : null}
          <path
            d={`M${points.join(" L")}`}
            fill="none"
            stroke={color}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            /* The viewBox is stretched to the panel's width, so without this the
               stroke would be squashed with it and thin out on a wide panel. */
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {cursor === null ? null : (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-px bg-border"
            style={{ left: `${cursor}%` }}
          />
        )}
      </span>
    </span>
  );
}

/**
 * The band a non-zero-based pane plots: where the series went, plus air.
 *
 * The padding is what keeps a *flat* series readable. Memory that has not moved
 * in ten minutes has a zero-wide range, and a domain of `[x, x]` is a division
 * by nothing; padded, it draws as the straight line through the middle of the
 * pane that it actually is.
 */
function band(values: number[], peak: number): [number, number] {
  const floor = Math.min(...values);
  const pad = Math.max((peak - floor) * 0.35, peak * 0.02, 1);
  return [floor - pad, peak + pad];
}

/** Megabytes whole, gigabytes to one place — the precision each is read at. */
function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** Wall-clock, to match the stamps on the log lines under the graph. */
function clock(t: number): string {
  return new Date(t).toLocaleTimeString(undefined, { hour12: false });
}
