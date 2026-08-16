import { classifyLogSeverity } from "./log-store.js";
import type { MetricSample } from "./metrics-store.js";
import type { LogEntry } from "./types.js";

/**
 * How much a service said, and how badly, over the range its graph already
 * covers.
 *
 * The CPU and memory panes gave the log tail an axis; this gives that axis the
 * one series it was still missing — the output itself. A CPU spike says *when*
 * something happened, but not whether the service noticed; a burst of stderr in
 * the same minute says it did, and points at the lines directly below.
 *
 * **Bucketed here rather than in the browser, because the browser cannot.** The
 * dashboard payload carries forty lines per service (`PAYLOAD_TAIL`), which is a
 * few seconds of a service mid-burst — far too short an axis to bucket. The ring
 * buffer this reads holds 500, and lives in the daemon. Sending 500 lines per
 * service per poll to let the client count them would be the same payload
 * mistake at ten times the size; sending sixty triples of small integers is not.
 */

export interface LogVolumeBucket {
  /** Start of the bucket, ms epoch — the same clock `MetricSample.t` is on. */
  t: number;
  /** Lines with nothing to declare. Carries the *volume* half of the signal. */
  info: number;
  warning: number;
  error: number;
}

/**
 * Sixty across the window, whatever the window is.
 *
 * A count, not a duration, because the range is whatever the metrics buffer
 * happens to hold: half an hour for a service that has been up all morning, two
 * minutes for one that just booted. Bucketing by a fixed *duration* would give
 * the young service four bars and the old one a thousand; bucketing by a fixed
 * count keeps the strip the same shape and lets the bar width mean "a sixtieth
 * of what you are looking at" in both.
 *
 * Sixty is also about the widest a panel can draw and still leave a bar with a
 * gap on each side of it at the narrow end of the layout.
 */
const BUCKET_COUNT = 60;

/**
 * Count each severity into evenly spaced buckets over the metric series' range.
 *
 * The range comes from `samples` rather than from the log lines themselves, and
 * that is the whole point: the strip is only honest if it is the *same* axis as
 * the panes above it. Deriving it from the lines would give the strip its own
 * ends, and two charts stacked with different x-ranges is a worse lie than no
 * chart at all — a spike would sit above a moment it did not happen at.
 *
 * Lines outside the range are dropped rather than clamped. A service that
 * emitted 400 lines at boot and has been quiet since is *quiet* in the window
 * being shown, and piling that history onto the first bucket would invent a
 * spike at a moment nothing happened.
 */
export function bucketLogVolume(
  entries: LogEntry[],
  samples: MetricSample[],
  bucketCount = BUCKET_COUNT,
): LogVolumeBucket[] {
  if (samples.length < 2) return [];
  const first = samples[0].t;
  const last = samples[samples.length - 1].t;
  const span = last - first;
  if (span <= 0) return [];

  const width = span / bucketCount;
  const buckets: LogVolumeBucket[] = Array.from({ length: bucketCount }, (_, index) => ({
    t: first + index * width,
    info: 0,
    warning: 0,
    error: 0,
  }));

  for (const entry of entries) {
    const at = Date.parse(entry.timestamp);
    if (Number.isNaN(at) || at < first || at > last) continue;
    /* The final bucket is closed at both ends so the newest line — which is
       exactly `last` whenever a sample and a line share a millisecond — lands in
       the strip rather than one index past it. */
    const index = Math.min(bucketCount - 1, Math.floor((at - first) / width));
    buckets[index][severityOf(entry)] += 1;
  }

  return buckets;
}

/**
 * Which band a line counts toward — decided by what it *says*, never by which
 * pipe it came down.
 *
 * The first version of this read `stream === "stderr"` first, on the reasoning
 * that the panel already counts a `STDERR` stat and paints those lines red in
 * the tail. Ten seconds of a real service settled it: of jobjourney-frontend's
 * ten stderr lines, **none** were errors. They were `[TypeScript] Found 0
 * errors.`, a Browserslist freshness notice, and six Tailwind lines beginning
 * with the literal word `warn`. A rule that paints "found 0 errors" red is not
 * strict, it is broken, and it costs the amber band the exact case amber is for.
 *
 * A red that fires on every dev server is a red nobody looks at, so the pipe is
 * not consulted at all. Nothing is lost: a service that dies on stderr dies
 * saying `panic`, `fatal`, `Traceback`, `uncaught`, `EADDRINUSE` or `error`, and
 * every one of those is what `classifyLogSeverity` is looking for.
 *
 * This does not contradict the `STDERR` counter beside it — that counter names
 * what it counts, and so do these bands. "10 stderr lines, 0 errors" is two true
 * statements about the same ten lines.
 */
function severityOf(entry: LogEntry): "info" | "warning" | "error" {
  return classifyLogSeverity(entry.text) ?? "info";
}
