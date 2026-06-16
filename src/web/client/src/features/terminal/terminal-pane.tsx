import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { RotateCcw, Square } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  tauri_onTerminalOutput,
  tauri_resizeTerminal,
  tauri_startTerminalStream,
  tauri_writeTerminalInput,
} from "@/lib/api";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

type TerminalConnectionState = "connecting" | "running" | "exited" | "error";

type ServerMessage =
  | {
      cols?: number;
      cwd?: string;
      error?: string;
      rows?: number;
      shell?: string;
      state: TerminalConnectionState | "idle";
      type: "state";
    }
  | { data: string; type: "output" }
  | { error: string; type: "error" };

interface TerminalPaneProps {
  /** Server session id this pane attaches to (`?id=` on the socket). */
  sessionId: string;
  /** Whether this pane is the visible tab. Hidden panes keep their shell alive. */
  active: boolean;
  /** Extra buttons rendered next to Restart/Stop in the toolbar. */
  toolbarExtra?: ReactNode;
}

/**
 * One terminal tab: an xterm instance bound to a single server-owned PTY
 * session over a WebSocket. Stays mounted while inactive so its shell and
 * scrollback survive tab switches; it only refits when it becomes visible.
 */
export function TerminalPane({ sessionId, active, toolbarExtra }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [cwd, setCwd] = useState("Local workspace");
  const [connectionState, setConnectionState] =
    useState<TerminalConnectionState>("connecting");
  const [detail, setDetail] = useState("Opening shell");
  // Desktop (Tauri) drives the shell through the Rust PTY (invoke + events);
  // the web build talks to the Node terminal server over a WebSocket. The
  // desktop app has no Node server, so the socket path can never connect there.
  const tauriMode = isTauri();

  const sendResize = useCallback(() => {
    const fit = fitRef.current;
    if (!fit) return;
    fit.fit();
    const dimensions = fit.proposeDimensions();
    if (!dimensions) return;
    if (tauriMode) {
      void tauri_resizeTerminal(sessionId, dimensions.cols, dimensions.rows);
      return;
    }
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        cols: dimensions.cols,
        rows: dimensions.rows,
        type: "resize",
      }),
    );
  }, [tauriMode, sessionId]);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: '"SF Mono", "JetBrains Mono", ui-monospace, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 4000,
      theme: {
        background: "#090909",
        black: "#090909",
        blue: "#69a7ff",
        brightBlack: "#5f6368",
        brightBlue: "#8ab4f8",
        brightCyan: "#7ddfd7",
        brightGreen: "#8fdc8a",
        brightMagenta: "#d7a2ff",
        brightRed: "#ff8a80",
        brightWhite: "#ffffff",
        brightYellow: "#ffd166",
        cyan: "#62d0c8",
        foreground: "#f2f2f2",
        green: "#7ac77f",
        magenta: "#c792ea",
        red: "#ff6b6b",
        selectionBackground: "#ffffff33",
        white: "#e8eaed",
        yellow: "#f7c948",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(containerRef.current);
    terminalRef.current = terminal;
    fitRef.current = fit;

    // Wire the live I/O transport. Both branches install a terminal input
    // subscription and stream output back into xterm; cleanup is unified below.
    let cleanupTransport: () => void;

    if (tauriMode) {
      let unlisten: (() => void) | null = null;
      let disposed = false;
      const inputSubscription = terminal.onData((data) => {
        void tauri_writeTerminalInput(sessionId, data);
      });
      void tauri_onTerminalOutput(sessionId, (data) => terminal.write(data)).then(
        (off) => {
          // The session may have unmounted before `listen` resolved.
          if (disposed) {
            off();
            return;
          }
          unlisten = off;
          setConnectionState("running");
          setDetail("Shell connected");
          // Now that the listener is live, release the PTY's buffered startup
          // output (the initial shell prompt) so the terminal shows immediately
          // instead of looking dead until the first keystroke.
          void tauri_startTerminalStream(sessionId);
          sendResize();
        },
        (caught) => {
          if (disposed) return;
          setConnectionState("error");
          setDetail(caught instanceof Error ? caught.message : String(caught));
        },
      );
      cleanupTransport = () => {
        disposed = true;
        inputSubscription.dispose();
        unlisten?.();
      };
    } else {
      const socket = new WebSocket(terminalSocketUrl(sessionId));
      socketRef.current = socket;

      const inputSubscription = terminal.onData((data) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ data, type: "input" }));
      });

      socket.addEventListener("open", () => {
        setConnectionState("running");
        setDetail("Shell connected");
        sendResize();
      });

      socket.addEventListener("message", (event) => {
        const message = parseServerMessage(event.data);
        if (!message) return;
        if (message.type === "output") {
          terminal.write(message.data);
          return;
        }
        if (message.type === "error") {
          setConnectionState("error");
          setDetail(message.error);
          return;
        }
        setConnectionState(message.state === "idle" ? "connecting" : message.state);
        if (message.cwd) setCwd(message.cwd);
        setDetail(message.error ?? message.shell ?? "Shell connected");
      });

      socket.addEventListener("close", () => {
        setConnectionState((state) => (state === "exited" ? state : "exited"));
        setDetail("Socket closed");
      });

      socket.addEventListener("error", () => {
        setConnectionState("error");
        setDetail("Terminal socket error");
      });

      cleanupTransport = () => {
        inputSubscription.dispose();
        socket.close();
        socketRef.current = null;
      };
    }

    window.addEventListener("resize", sendResize);
    window.setTimeout(sendResize, 0);

    // Refit whenever the container's own size settles or changes (the pane
    // becoming visible, the panel resizing, fonts loading). Without this the
    // initial one-shot fit can be off by a row and clip the bottom line.
    const observer = new ResizeObserver(() => sendResize());
    observer.observe(containerRef.current);

    return () => {
      window.removeEventListener("resize", sendResize);
      observer.disconnect();
      cleanupTransport();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, sendResize, tauriMode]);

  // A hidden pane has zero size, so xterm can't fit. Refit + focus on reveal.
  useEffect(() => {
    if (!active) return;
    const id = window.setTimeout(() => {
      sendResize();
      terminalRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [active, sendResize]);

  const sendControl = useCallback((message: Record<string, unknown>) => {
    // Restart/Stop are control messages the Node terminal server understands.
    // The Rust PTY has no equivalent yet, so they no-op in the desktop app.
    if (tauriMode) return;
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const dimensions = fitRef.current?.proposeDimensions();
    socket.send(
      JSON.stringify({
        cols: dimensions?.cols,
        rows: dimensions?.rows,
        ...message,
      }),
    );
  }, [tauriMode]);

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
            <Badge
              className={cn(
                "border-white/15 bg-white/10 text-white shadow-none",
                connectionState === "running" && "border-emerald-400/35 text-emerald-200",
                connectionState === "error" && "border-red-400/35 text-red-200",
              )}
              variant="outline"
            >
              {connectionState}
            </Badge>
            <span className="truncate font-mono text-[11px] text-white/55">
              {cwd} · {detail}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            aria-label="Restart terminal"
            className="border-white/15 bg-white/5 text-white hover:bg-white/10"
            size="sm"
            variant="outline"
            onClick={() => sendControl({ type: "restart" })}
            type="button"
          >
            <RotateCcw />
            Restart
          </Button>
          <Button
            aria-label="Stop terminal"
            className="border-white/15 bg-white/5 text-white hover:bg-white/10"
            size="sm"
            variant="outline"
            onClick={() => sendControl({ type: "stop" })}
            type="button"
          >
            <Square />
            Stop
          </Button>
          {toolbarExtra}
        </div>
      </div>
      {/* Padding lives on the wrapper, not on the element xterm mounts into:
          FitAddon doesn't subtract the mount element's own padding, so padding
          here would make it provision one row too many and clip the last line. */}
      <div
        aria-label="terminal viewport"
        className="min-h-0 flex-1 overflow-hidden px-3 py-0.5"
      >
        <div className="h-full w-full" ref={containerRef} />
      </div>
    </section>
  );
}

function terminalSocketUrl(sessionId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const id = encodeURIComponent(sessionId);
  return `${protocol}//${window.location.host}/api/terminal/socket?id=${id}`;
}

function parseServerMessage(input: unknown): ServerMessage | null {
  if (typeof input !== "string") return null;
  try {
    const parsed = JSON.parse(input) as ServerMessage;
    return typeof parsed?.type === "string" ? parsed : null;
  } catch {
    return null;
  }
}
