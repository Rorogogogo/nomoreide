import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  tauri_onTerminalOutput,
  tauri_resizeTerminal,
  tauri_startTerminalStream,
  tauri_writeTerminalInput,
} from "@/lib/api";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

export type TerminalConnectionState =
  | "connecting"
  | "running"
  | "exited"
  | "error";

export interface TerminalViewportStatus {
  state: TerminalConnectionState;
  cwd: string;
  detail: string;
}

export interface TerminalViewportHandle {
  restart(): void;
  stop(): void;
  focus(): void;
  refit(): void;
}

export interface TerminalViewportProps {
  /** Server session id this viewport attaches to. */
  sessionId: string;
  /** Hidden viewports remain mounted to preserve their PTY and scrollback. */
  active: boolean;
  /** Reports transport status for optional chrome rendered by a parent. */
  onStatusChange?: (status: TerminalViewportStatus) => void;
}

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

const INITIAL_STATUS: TerminalViewportStatus = {
  state: "connecting",
  cwd: "Local workspace",
  detail: "Opening shell",
};

/**
 * A raw xterm viewport bound to one server-owned PTY. It deliberately renders
 * no toolbar or status chrome so it can be reused by terminal and agent tabs.
 */
export const TerminalViewport = forwardRef<
  TerminalViewportHandle,
  TerminalViewportProps
>(function TerminalViewport(
  { sessionId, active, onStatusChange },
  forwardedRef,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const statusCallbackRef = useRef(onStatusChange);
  const [status, setStatus] = useState<TerminalViewportStatus>(INITIAL_STATUS);
  // Desktop owns its PTY in Rust; the web build attaches to the Node server.
  const tauriMode = isTauri();

  useEffect(() => {
    statusCallbackRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    statusCallbackRef.current?.(status);
  }, [status]);

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

  const sendControl = useCallback(
    (type: "restart" | "stop") => {
      // The Rust PTY has no restart/stop commands yet, matching the existing
      // desktop behavior where these controls are no-ops.
      if (tauriMode) return;
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      const dimensions = fitRef.current?.proposeDimensions();
      socket.send(
        JSON.stringify({
          cols: dimensions?.cols,
          rows: dimensions?.rows,
          type,
        }),
      );
    },
    [tauriMode],
  );

  useImperativeHandle(
    forwardedRef,
    () => ({
      focus: () => terminalRef.current?.focus(),
      refit: sendResize,
      restart: () => sendControl("restart"),
      stop: () => sendControl("stop"),
    }),
    [sendControl, sendResize],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    setStatus(INITIAL_STATUS);
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
    terminal.open(container);
    terminalRef.current = terminal;
    fitRef.current = fit;

    let cleanupTransport: () => void;

    if (tauriMode) {
      let unlisten: (() => void) | null = null;
      let disposed = false;
      const inputSubscription = terminal.onData((data) => {
        void tauri_writeTerminalInput(sessionId, data);
      });
      void tauri_onTerminalOutput(sessionId, (data) => terminal.write(data)).then(
        (off) => {
          if (disposed) {
            off();
            return;
          }
          unlisten = off;
          setStatus((current) => ({
            ...current,
            state: "running",
            detail: "Shell connected",
          }));
          // Attach the listener before releasing buffered startup output.
          void tauri_startTerminalStream(sessionId);
          sendResize();
        },
        (caught) => {
          if (disposed) return;
          setStatus((current) => ({
            ...current,
            state: "error",
            detail: caught instanceof Error ? caught.message : String(caught),
          }));
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
        setStatus((current) => ({
          ...current,
          state: "running",
          detail: "Shell connected",
        }));
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
          setStatus((current) => ({
            ...current,
            state: "error",
            detail: message.error,
          }));
          return;
        }
        setStatus((current) => ({
          state: message.state === "idle" ? "connecting" : message.state,
          cwd: message.cwd ?? current.cwd,
          detail: message.error ?? message.shell ?? "Shell connected",
        }));
      });

      socket.addEventListener("close", () => {
        setStatus((current) => ({
          ...current,
          state: current.state === "exited" ? current.state : "exited",
          detail: "Socket closed",
        }));
      });

      socket.addEventListener("error", () => {
        setStatus((current) => ({
          ...current,
          state: "error",
          detail: "Terminal socket error",
        }));
      });

      cleanupTransport = () => {
        inputSubscription.dispose();
        socket.close();
        socketRef.current = null;
      };
    }

    window.addEventListener("resize", sendResize);
    window.setTimeout(sendResize, 0);

    const observer = new ResizeObserver(() => sendResize());
    observer.observe(container);

    return () => {
      window.removeEventListener("resize", sendResize);
      observer.disconnect();
      cleanupTransport();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, sendResize, tauriMode]);

  // A hidden xterm has zero dimensions. Refit and focus after it is revealed.
  useEffect(() => {
    if (!active) return;
    const id = window.setTimeout(() => {
      sendResize();
      terminalRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [active, sendResize]);

  return (
    <section
      aria-label="terminal viewport"
      className={cn(
        "h-full min-h-0 overflow-hidden bg-[#090909] px-3 py-0.5",
        !active && "hidden",
      )}
    >
      {/* Padding stays outside xterm's mount so FitAddon does not provision an
          extra row and clip the final line. */}
      <div className="h-full w-full" ref={containerRef} />
    </section>
  );
});

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
