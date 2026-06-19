import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { createTerminalSession } from "@/lib/api";
import { TerminalPane } from "@/features/terminal/terminal-pane";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LogsOverlay } from "./logs-tab";

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
  const [fullscreen, setFullscreen] = useState(false);
  const startedRef = useRef(false);
  const mountedRef = useRef(true);

  // Reset on (re)mount so React StrictMode's mount→cleanup→remount cycle can't
  // leave this stuck at `false`. `startedRef` guards the open against re-runs,
  // so the StrictMode remount won't relaunch the request — meaning the original
  // in-flight `createTerminalSession` is the only one that resolves. If its
  // result were discarded (because cleanup flipped this to `false`), the tab
  // would freeze forever on "Opening terminal…".
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active || startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      try {
        const session = await createTerminalSession({ serviceName });
        if (mountedRef.current) setSessionId(session.id);
      } catch (caught) {
        if (mountedRef.current) {
          setError(caught instanceof Error ? caught.message : String(caught));
          startedRef.current = false;
        }
      }
    })();
  }, [active, serviceName]);

  const expandButton = (
    <Button
      aria-label={fullscreen ? "Exit fullscreen terminal" : "Expand terminal"}
      className="text-white/60 hover:bg-white/10 hover:text-white"
      onClick={() => setFullscreen((value) => !value)}
      size="icon-sm"
      title={fullscreen ? "Exit fullscreen" : "Expand"}
      type="button"
      variant="ghost"
    >
      {fullscreen ? <Minimize2 /> : <Maximize2 />}
    </Button>
  );

  const body = error ? (
    <div className="p-3 font-mono text-[11px] text-destructive">
      Could not open terminal: {error}
    </div>
  ) : sessionId ? (
    <TerminalPane active={active} sessionId={sessionId} toolbarExtra={expandButton} />
  ) : (
    <div className="p-3 font-mono text-[11px] text-muted-foreground">
      Opening terminal…
    </div>
  );

  if (fullscreen && active) {
    return (
      <LogsOverlay onClose={() => setFullscreen(false)} title={`Terminal — ${serviceName}`}>
        {body}
      </LogsOverlay>
    );
  }

  return (
    <div
      className={cn(
        // Fixed height matching the Logs tab; the actual scroll lives inside
        // the xterm viewport, not this wrapper.
        "h-[60vh] min-h-[24rem] overflow-hidden rounded-md border border-border",
        !active && "hidden",
      )}
    >
      {body}
    </div>
  );
}
