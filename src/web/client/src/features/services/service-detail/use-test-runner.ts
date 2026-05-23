import { useCallback, useEffect, useRef, useState } from "react";
import { runServiceTests, type TestRun, type TestRunEvent } from "@/lib/api";

export interface TestOutputLine {
  stream: "stdout" | "stderr";
  text: string;
}

const MAX_LINES = 500;

/**
 * Drives a service's test runs: subscribes to `/api/services/:name/test/stream`
 * for live status + output (also picks up an in-progress run on mount) and
 * exposes `start()` to kick one off. Output resets when a new run begins.
 */
export function useTestRunner(serviceName: string) {
  const [run, setRun] = useState<TestRun | undefined>();
  const [lines, setLines] = useState<TestOutputLine[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [starting, setStarting] = useState(false);
  const runIdRef = useRef<number | undefined>();

  useEffect(() => {
    runIdRef.current = undefined;
    setRun(undefined);
    setLines([]);
    const source = new EventSource(
      `/api/services/${encodeURIComponent(serviceName)}/test/stream`,
    );
    const onEvent = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as TestRunEvent;
        if (payload.run.id !== runIdRef.current) {
          runIdRef.current = payload.run.id;
          setLines([]);
        }
        setRun(payload.run);
        if (payload.line) {
          setLines((prev) => [...prev, payload.line as TestOutputLine].slice(-MAX_LINES));
        }
      } catch {
        // ignore malformed events
      }
    };
    source.addEventListener("status", onEvent);
    source.addEventListener("output", onEvent);
    return () => source.close();
  }, [serviceName]);

  const start = useCallback(
    async (pattern?: string) => {
      setStarting(true);
      setError(undefined);
      try {
        await runServiceTests(serviceName, pattern);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setStarting(false);
      }
    },
    [serviceName],
  );

  return { run, lines, error, starting, start };
}
