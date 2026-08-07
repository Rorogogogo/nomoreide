import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * A count of API calls currently in flight, so the header Refresh icon can
 * spin for *any* loading — a PR diff, a workflow's jobs, a Load more, a merge —
 * not just the refresh cycle it was wired to originally.
 *
 * This is a module-level store rather than React state because the reporters
 * are plain modules (`requestJson`, `tauriInvoke`) sitting under every feature's
 * API seam. Instrumenting those two funnels covers the whole app and keeps
 * individual views from having to remember to report anything.
 *
 * Streaming endpoints deliberately don't count: `EventSource`/`WebSocket`
 * connections stay open for the life of the page and would pin the icon on
 * forever. They don't go through these funnels, so nothing to exclude.
 */
let inFlight = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Mark a request as started; call the returned fn when it settles. */
export function beginApiRequest(): () => void {
  inFlight += 1;
  emit();
  let released = false;
  return () => {
    // Guard against a double release leaking the count negative and wedging
    // the icon off for the rest of the session.
    if (released) return;
    released = true;
    inFlight = Math.max(0, inFlight - 1);
    emit();
  };
}

/** Observe the flag directly — `useApiBusy` is this plus the display timing. */
export function subscribeToApiActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Raw "is anything in flight", before any spin-delay smoothing. */
export function isApiBusy(): boolean {
  return inFlight > 0;
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * Matches the refresh cycle's own threshold in `app.tsx`: the 5s dashboard poll
 * completes well inside this, so routine polling never strobes the icon. Only
 * work slow enough to be worth noticing shows up.
 */
const SPIN_AFTER_MS = 600;
/** Once it does show, hold it long enough to read as a spin, not a flash. */
const SPIN_AT_LEAST_MS = 400;

/** True while API work has been in flight long enough to be worth showing. */
export function useApiBusy(): boolean {
  const active = useSyncExternalStore(subscribeToApiActivity, isApiBusy, getServerSnapshot);
  const [spinning, setSpinning] = useState(false);
  const shownAt = useRef(0);

  useEffect(() => {
    if (active) {
      if (spinning) return;
      const timer = window.setTimeout(() => {
        shownAt.current = Date.now();
        setSpinning(true);
      }, SPIN_AFTER_MS);
      return () => window.clearTimeout(timer);
    }
    if (!spinning) return;
    const remaining = Math.max(0, SPIN_AT_LEAST_MS - (Date.now() - shownAt.current));
    const timer = window.setTimeout(() => setSpinning(false), remaining);
    return () => window.clearTimeout(timer);
  }, [active, spinning]);

  return spinning;
}
