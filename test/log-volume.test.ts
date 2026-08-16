import { describe, expect, test } from "vitest";
import { bucketLogVolume } from "../src/core/log-volume.js";
import type { MetricSample } from "../src/core/metrics-store.js";
import type { LogEntry, LogStream } from "../src/core/types.js";

/**
 * The log-volume strip's counts.
 *
 * The whole value of this strip is that it sits on the *same* axis as the CPU
 * and memory panes above it — so the tests that matter are about the range: what
 * it is taken from, what falls outside it, and where a line lands inside it. A
 * strip whose spike sits above the wrong minute is worse than no strip.
 */

const START = Date.parse("2026-08-16T10:00:00.000Z");
const MINUTE = 60_000;

function sample(offsetMs: number): MetricSample {
  return { t: START + offsetMs, cpu: 1, rss: 100 };
}

function line(offsetMs: number, text = "hello", stream: LogStream = "stdout"): LogEntry {
  return {
    service: "api",
    stream,
    text,
    timestamp: new Date(START + offsetMs).toISOString(),
  };
}

/** A ten-minute window, which at the default 60 buckets is ten seconds each. */
const WINDOW = [sample(0), sample(10 * MINUTE)];

describe("bucketLogVolume", () => {
  test("takes its range from the samples, not from the lines", () => {
    const buckets = bucketLogVolume([line(-MINUTE), line(5 * MINUTE)], WINDOW);

    expect(buckets[0].t).toBe(START);
    expect(buckets.at(-1)?.t).toBe(START + 10 * MINUTE - 10_000);
  });

  test("drops lines outside the window rather than clamping them into it", () => {
    // The service that logged at boot and has been quiet since: piling that
    // history onto the first bucket would invent a spike that never happened.
    const buckets = bucketLogVolume(
      [line(-MINUTE), line(-2 * MINUTE), line(11 * MINUTE)],
      WINDOW,
    );

    expect(buckets.every((bucket) => bucket.info === 0)).toBe(true);
  });

  test("puts a line in the slice that contains its timestamp", () => {
    const buckets = bucketLogVolume([line(5 * MINUTE)], WINDOW);

    expect(buckets.findIndex((bucket) => bucket.info > 0)).toBe(30);
  });

  test("keeps the newest line when it lands exactly on the last sample", () => {
    const buckets = bucketLogVolume([line(10 * MINUTE)], WINDOW);

    expect(buckets.at(-1)?.info).toBe(1);
  });

  test("classifies by the same rule the timeline uses", () => {
    const buckets = bucketLogVolume(
      [line(MINUTE, "ECONNREFUSED"), line(MINUTE, "deprecated option"), line(MINUTE, "ok")],
      WINDOW,
    );

    expect(buckets[6]).toMatchObject({ error: 1, warning: 1, info: 1 });
  });

  test("judges a line by its text, not by the pipe it came down", () => {
    // Every one of these is a real jobjourney-frontend stderr line. A strip that
    // paints "Found 0 errors" red is a red nobody will look at again.
    const buckets = bucketLogVolume(
      [
        line(MINUTE, "[TypeScript] Found 0 errors. Watching for file changes.", "stderr"),
        line(MINUTE, "Browserslist: browsers data (caniuse-lite) is 6 months old.", "stderr"),
        line(MINUTE, "warn - The class `ease-[cubic-bezier(0.4,0,0.2,1)]` is ambiguous", "stderr"),
      ],
      WINDOW,
    );

    expect(buckets[6]).toMatchObject({ error: 0, warning: 1, info: 2 });
  });

  test("still catches a service dying on stderr, because dying says so", () => {
    const buckets = bucketLogVolume(
      [
        line(MINUTE, "Error: listen EADDRINUSE: address already in use :::5014", "stderr"),
        line(MINUTE, "Traceback (most recent call last):", "stderr"),
      ],
      WINDOW,
    );

    expect(buckets[6]).toMatchObject({ error: 2, warning: 0, info: 0 });
  });

  test("has nothing to draw against a series with no direction", () => {
    expect(bucketLogVolume([line(0)], [sample(0)])).toEqual([]);
    expect(bucketLogVolume([line(0)], [])).toEqual([]);
    expect(bucketLogVolume([line(0)], [sample(0), sample(0)])).toEqual([]);
  });

  test("cuts the window evenly, so bar width means one slice of what is shown", () => {
    const buckets = bucketLogVolume([], WINDOW, 4);

    expect(buckets.map((bucket) => bucket.t - START)).toEqual([
      0,
      2.5 * MINUTE,
      5 * MINUTE,
      7.5 * MINUTE,
    ]);
  });
});
