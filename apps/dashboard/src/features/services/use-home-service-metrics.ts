import { useEffect, useState } from "react";
import { getServiceMetrics, type LogVolumeBucket, type MetricSample } from "@/lib/api";

/**
 * The CPU, memory, and output a service has produced lately, for the graph above
 * its log.
 *
 * A `fetch`-source read (the contract in `features/home/widget-types.ts`), and a
 * cheap one: `/api/services/:name/metrics` is a copy of an in-memory ring buffer
 * the daemon fills anyway — `MetricsStore` samples every 3s and keeps 600, so
 * what comes back is the last half hour and costs no work to produce.
 *
 * **One service, not all of them.** The service asked for is whichever tab the
 * Logs panel is showing, so the graph and the lines under it are the same
 * subject and the panel costs exactly one request no matter how many services
 * are registered. Fetching every series to draw one would be the mistake
 * `use-home-agent-summary.ts` documents — a landing page that quietly opens a
 * connection per service is how the browser's six-per-host budget goes.
 */

/**
 * Slower than the dashboard's own poll, and deliberately.
 *
 * The daemon samples every 3s, so a faster poll would return the same series
 * twice; a slower one would let the right-hand edge visibly lag the log lines
 * beside it, which is the one thing a shared time axis must not do.
 */
const POLL_MS = 5_000;

/**
 * What the graph draws: the series, and the log volume counted over its range.
 *
 * They arrive together and are returned together because they are one axis —
 * see the route in `web/routes/metrics-routes.ts`. There is no `loaded` flag
 * because nothing downstream would do anything different with one: a series too
 * short to have a direction draws no graph, and "not fetched yet" and "this
 * service has never run" are the same panel — a log tail with nothing above it.
 */
export interface HomeServiceMetrics {
  samples: MetricSample[];
  volume: LogVolumeBucket[];
}

/* A frozen shared value, so an empty poll does not hand React a new object every
   five seconds and re-render the panel over nothing. */
const EMPTY: HomeServiceMetrics = { samples: [], volume: [] };

export function useHomeServiceMetrics(
  service: string | null,
  pollMs = POLL_MS,
): HomeServiceMetrics {
  const [metrics, setMetrics] = useState<HomeServiceMetrics>(EMPTY);

  useEffect(() => {
    if (!service) {
      setMetrics(EMPTY);
      return;
    }
    let active = true;
    // Cleared up front, not on arrival: the previous tab's series must not sit
    // under the new tab's name for the length of a request.
    setMetrics(EMPTY);

    const load = async () => {
      /* A service that has never run has no buffer, and the route answers with
         an empty series rather than an error — so does a request that races a
         daemon restart. Both are "nothing to draw", not something to report on
         a landing page. */
      const series = await getServiceMetrics(service).catch(() => null);
      if (!active) return;
      setMetrics(
        series
          ? { samples: series.samples, volume: series.logVolume ?? [] }
          : EMPTY,
      );
    };

    void load();
    const interval = window.setInterval(() => void load(), pollMs);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
    /* Keyed on the service: switching tabs must drop the old series rather than
       draw it under the new tab's name until the next poll lands. */
  }, [pollMs, service]);

  return metrics;
}
