import type { LogVolumeBucket } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * How much the service said, and how badly, on the axis the panes above share.
 *
 * The CPU and memory panes answer "when did something happen". They cannot
 * answer "did the service *notice*" — a process can burn a core in silence and
 * it can also sit at 2% while pouring stack traces. This strip is the second
 * question, drawn against the first one's clock, directly above the lines it is
 * pointing at.
 *
 * **A stacked bar, not three lines.** The parts sum to something meaningful —
 * total output in that slice — which is exactly the case a stack is for, and the
 * case a multi-line chart is not. Errors sit at the *bottom* so their baseline
 * never moves: comparing red across a row of bars is what this strip exists for,
 * and a segment floating on a shifting stack cannot be compared at all.
 *
 * The hues are the checked pair `#dc2626` / `#c98500` — all six checks pass on
 * both this app's surfaces (`#ffffff` light, `#191615` dark), including the CVD
 * separation between them, which is the only pair that shares a mark here. The
 * amber does sit close to the CPU pane's green under protanopia; identity never
 * rests on that, because every swatch is a keystroke away from its own written
 * label and the two live in different panes with different baselines.
 */

/**
 * Shorter than a metric pane, deliberately.
 *
 * A curve needs vertical room to have a shape; a bar only has to be tall enough
 * to compare against its neighbours. Spending 44px here would push the log lines
 * — the thing all three charts are pointing at — off the bottom of a panel that
 * has not been given a height.
 */
const STRIP_PX = 28;

/** Surface between fills, both between stacked bands and between neighbours. */
const GAP_PX = 2;

/**
 * The height the *data* is scaled into, with room for the gaps left out of it.
 *
 * Scaled against the full strip instead, a full-height bar in three bands is
 * taller than the box that holds it by exactly the gaps inside it, and
 * `justify-end` pushes that overflow up over the caption — which is what the
 * first cut did, live, on a bucket that happened to be half neutral and half
 * warnings.
 *
 * Two gaps are reserved for every bucket, not just the three-band ones, because
 * the alternative is a scale that changes with how many severities a slice
 * happened to contain — two bars of the same total drawn different heights.
 */
const PLOT_PX = STRIP_PX - 2 * GAP_PX;

/**
 * The floor, in pixels, under any segment that is not zero.
 *
 * Without it the strip lies by rounding: one error beside a 200-line burst is
 * 0.5% of 28px, which paints nothing at all, and "no errors" and "an error you
 * cannot see" would render identically. That is the one confusion this strip
 * cannot afford, so presence is allowed to overstate magnitude at the very
 * bottom of the scale — the peak is printed, so the scale is still recoverable.
 */
const MIN_SEGMENT_PX = 2;

const ERROR_COLOR = "#dc2626";
const WARNING_COLOR = "#c98500";

export function OutputVolume({
  at,
  buckets,
  cursor,
}: {
  /** The moment being pointed at, ms epoch, or `null` when nobody is. */
  at: number | null;
  buckets: LogVolumeBucket[];
  /** Where that moment is across the shared range, as a percentage. */
  cursor: number | null;
}) {
  const t = useT();
  const totals = buckets.reduce(
    (sum, bucket) => ({
      info: sum.info + bucket.info,
      warning: sum.warning + bucket.warning,
      error: sum.error + bucket.error,
    }),
    { info: 0, warning: 0, error: 0 },
  );
  const lines = totals.info + totals.warning + totals.error;

  /* Nothing was said in the window the graph covers. That is a fact, but it is
     not a chart — sixty empty slots under a "PEAK 0" would be a row of noise
     claiming to be a reading. The service that logged 400 lines at boot and has
     been quiet for half an hour lands here, correctly. */
  if (lines === 0) return null;

  const peak = Math.max(...buckets.map(total));
  const hovered = at === null ? null : bucketAt(buckets, at);

  return (
    <span className="flex flex-col gap-0.5">
      <span className="flex items-baseline justify-between font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
        {/* Three fills in one mark, so unlike the single-series panes this one
            genuinely needs a key — and it is a key of written words, so the
            colours are a shortcut rather than the whole message. */}
        <span className="flex items-center gap-2">
          <Key label={t("home.output.lines")} />
          <Key color={WARNING_COLOR} label={t("home.output.warnings")} />
          <Key color={ERROR_COLOR} label={t("home.output.errors")} />
        </span>
        <span className="flex items-baseline gap-2 tabular-nums">
          <span className="text-muted-foreground/60">
            {t("home.output.peak")} {peak}
          </span>
          {/* Only while pointing, matching the hovered clock in the axis row
              below. The newest bucket is still filling — a third of a slice of
              time — so showing it as "now" would quietly understate every
              reading taken between two ticks. */}
          <span className={hovered === null ? "invisible" : "text-foreground/80"}>
            {hovered === null ? "0" : total(hovered)}
          </span>
        </span>
      </span>
      <span
        aria-label={`${t("home.output.lines")} ${lines}, ${t("home.output.warnings")} ${totals.warning}, ${t("home.output.errors")} ${totals.error}`}
        /* `overflow-hidden` is the backstop, not the mechanism: `PLOT_PX` is
           what makes the bars fit. It only bites when several bands are floored
           up to `MIN_SEGMENT_PX` at once, where losing a pixel off the tallest
           bar is a better failure than a bar climbing over its own caption. */
        className="relative block overflow-hidden"
        role="img"
        style={{ height: STRIP_PX }}
      >
        {buckets.map((bucket, index) => (
          <span
            /* Positioned by index across the range rather than measured from
               `bucket.t`, because the server cut them evenly over exactly this
               axis — so index *is* time here, and arithmetic on it cannot drift
               from the panes above the way a second time mapping could. */
            className="absolute inset-y-0 flex flex-col justify-end px-px"
            /* The gap is a style rather than a class so it and `PLOT_PX` cannot
               drift apart — the scale is only correct while they are the same
               number. */
            key={bucket.t}
            style={{
              gap: GAP_PX,
              left: `${(index / buckets.length) * 100}%`,
              width: `${100 / buckets.length}%`,
            }}
          >
            {/* A 2px gap of surface between fills, and 1px of padding a side so
                neighbouring bars get the same 2px — the separation is what keeps
                three bands legible when the whole bar is a dozen pixels tall. */}
            <Segment
              className="bg-muted-foreground/40"
              count={bucket.info}
              peak={peak}
              top={bucket.info > 0}
            />
            <Segment
              color={WARNING_COLOR}
              count={bucket.warning}
              peak={peak}
              top={bucket.info === 0}
            />
            <Segment
              color={ERROR_COLOR}
              count={bucket.error}
              peak={peak}
              top={bucket.info === 0 && bucket.warning === 0}
            />
          </span>
        ))}
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
 * One severity's share of one slice, or nothing when it did not happen.
 *
 * Only the stack's *data end* is rounded — the top of whichever band happens to
 * be topmost. Rounding every segment would put a curve at each internal seam and
 * read as a column of separate marks rather than one bar cut into bands.
 */
function Segment({
  className,
  color,
  count,
  peak,
  top,
}: {
  className?: string;
  color?: string;
  count: number;
  peak: number;
  /** Whether this is the highest band present, and so carries the rounded end. */
  top: boolean;
}) {
  if (count === 0) return null;
  return (
    <span
      className={cn("w-full shrink-0", top && "rounded-t-[2px]", className)}
      style={{
        background: color,
        /* Pixels rather than a percentage, because the box these sit in is
           taller than the space the data is scaled into — see `PLOT_PX`. */
        height: Math.max(MIN_SEGMENT_PX, (count / peak) * PLOT_PX),
      }}
    />
  );
}

function Key({ color, label }: { color?: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span
        aria-hidden
        className={cn("size-1.5 rounded-[1px]", color ? undefined : "bg-muted-foreground/40")}
        style={color ? { background: color } : undefined}
      />
      {label}
    </span>
  );
}

function total(bucket: LogVolumeBucket): number {
  return bucket.info + bucket.warning + bucket.error;
}

/**
 * The slice a moment falls in.
 *
 * Found by scanning starts rather than by dividing, so it stays correct if the
 * server ever cuts the window into something other than equal slices — the
 * client's job here is to read the buckets it was given, not to re-derive them.
 */
function bucketAt(buckets: LogVolumeBucket[], at: number): LogVolumeBucket | null {
  let found: LogVolumeBucket | null = null;
  for (const bucket of buckets) {
    if (bucket.t > at) break;
    found = bucket;
  }
  return found ?? buckets[0] ?? null;
}
