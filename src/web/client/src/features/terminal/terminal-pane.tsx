import { RotateCcw, Square } from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useSettings } from "@/features/settings/settings-context";
import { cn } from "@/lib/utils";
import {
  TerminalViewport,
  type TerminalConnectionState,
  type TerminalViewportHandle,
  type TerminalViewportStatus,
} from "./terminal-viewport";

const TERMINAL_DOT: Record<TerminalConnectionState, string> = {
  connecting: "bg-amber-500",
  running: "bg-emerald-500",
  exited: "bg-muted-foreground/40",
  error: "bg-red-500",
};

interface TerminalPaneProps {
  /** Server session id this pane attaches to. */
  sessionId: string;
  /** Whether this pane is the visible tab. */
  active: boolean;
  /** Extra buttons rendered next to Restart/Stop in the toolbar. */
  toolbarExtra?: ReactNode;
}

const INITIAL_STATUS: TerminalViewportStatus = {
  state: "connecting",
  cwd: "Local workspace",
  detail: "Opening shell",
};

/** Terminal page chrome around one reusable raw PTY viewport. */
export function TerminalPane({ sessionId, active, toolbarExtra }: TerminalPaneProps) {
  const { confirmedGlobal } = useSettings();
  const viewportRef = useRef<TerminalViewportHandle>(null);
  const [status, setStatus] = useState<TerminalViewportStatus>(INITIAL_STATUS);
  const [pendingAction, setPendingAction] = useState<"restart" | "stop" | null>(null);
  const handleStatusChange = useCallback(
    (nextStatus: TerminalViewportStatus) => setStatus(nextStatus),
    [],
  );

  const runAction = useCallback((action: "restart" | "stop") => {
    viewportRef.current?.[action]();
  }, []);

  const requestAction = useCallback(
    (action: "restart" | "stop") => {
      if (confirmedGlobal.terminal.confirmTerminate) {
        setPendingAction(action);
        return;
      }
      runAction(action);
    },
    [confirmedGlobal.terminal.confirmTerminate, runAction],
  );

  return (
    <section
      className={cn(
        "flex h-full min-h-0 flex-col bg-[#090909] text-white",
        !active && "hidden",
      )}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-[#111111] px-4 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="relative flex size-2.5 shrink-0 items-center justify-center"
              title={status.state}
            >
              {status.state === "connecting" && (
                <span
                  className={cn(
                    "absolute inline-flex size-full animate-ping rounded-full opacity-60",
                    TERMINAL_DOT[status.state],
                  )}
                />
              )}
              <span
                className={cn(
                  "relative inline-flex size-2 rounded-full",
                  TERMINAL_DOT[status.state],
                )}
              />
            </span>
            <span className="truncate font-mono text-[11px] text-white/55">
              {status.cwd} · {status.detail}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            aria-label="Restart terminal"
            className="text-white/60 hover:bg-white/10 hover:text-white"
            size="icon-sm"
            variant="ghost"
            onClick={() => requestAction("restart")}
            title="Restart terminal"
            type="button"
          >
            <RotateCcw />
          </Button>
          <Button
            aria-label="Stop terminal"
            className="text-white/60 hover:bg-white/10 hover:text-white"
            size="icon-sm"
            variant="ghost"
            onClick={() => requestAction("stop")}
            title="Stop terminal"
            type="button"
          >
            <Square />
          </Button>
          {toolbarExtra}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <TerminalViewport
          active={active}
          displaySettings={confirmedGlobal.terminal}
          onStatusChange={handleStatusChange}
          ref={viewportRef}
          sessionId={sessionId}
        />
      </div>
      {pendingAction ? (
        <ConfirmDialog
          confirmLabel={pendingAction === "restart" ? "Restart terminal" : "Stop terminal"}
          message={`The running shell process will be terminated${pendingAction === "restart" ? " and a new shell will be started" : ""}.`}
          onCancel={() => setPendingAction(null)}
          onConfirm={() => {
            runAction(pendingAction);
            setPendingAction(null);
          }}
          title={pendingAction === "restart" ? "Restart terminal?" : "Stop terminal?"}
          tone="danger"
        />
      ) : null}
    </section>
  );
}
