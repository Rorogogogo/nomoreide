import { useEffect, useRef, useState } from "react";
import { createTerminalSession } from "@/lib/api";
import { TerminalPane } from "@/features/terminal/terminal-pane";
import { cn } from "@/lib/utils";

/**
 * The service detail "Terminal" tab: a shell scoped to the service — a local
 * shell in its cwd/env, an `ssh` session into an SSH service's host, or
 * `docker compose exec` into a compose service. The session is opened lazily
 * the first time the tab is shown (so selecting a service never eagerly opens
 * an ssh/exec connection) under a stable per-service id, so closing the tab or
 * reloading reattaches to the same shell rather than spawning a duplicate. It
 * stays mounted while hidden so the shell and scrollback survive switching to
 * sibling tabs like Logs. The server reaps the session on idle / process exit.
 */
export function TerminalTab({
  serviceName,
  active,
}: {
  serviceName: string;
  active: boolean;
}) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!active || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const session = await createTerminalSession({ serviceName });
        if (!cancelled) setSessionId(session.id);
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, serviceName]);

  return (
    <div
      className={cn(
        // Fixed height matching the Logs tab; the actual scroll lives inside
        // the xterm viewport, not this wrapper.
        "h-[60vh] min-h-[24rem] overflow-hidden rounded-md border border-border",
        !active && "hidden",
      )}
    >
      {error ? (
        <div className="p-3 font-mono text-[11px] text-destructive">
          Could not open terminal: {error}
        </div>
      ) : sessionId ? (
        <TerminalPane active={active} sessionId={sessionId} />
      ) : (
        <div className="p-3 font-mono text-[11px] text-muted-foreground">
          Opening terminal…
        </div>
      )}
    </div>
  );
}
