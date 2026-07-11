import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
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
  /** Claims one-time inputs after the PTY has finished its startup output. */
  claimInitialInput?: () => readonly string[] | undefined;
  /** Delay between composed initial input and its submit key. */
  initialInputIntervalMs?: number;
}

type StatusUpdate =
  | TerminalViewportStatus
  | ((current: TerminalViewportStatus) => TerminalViewportStatus);

interface TerminalSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(
    type: string,
    listener: (event: { data?: unknown }) => void,
  ): void;
}

interface FitDimensionsLike {
  proposeDimensions(): { cols: number; rows: number } | undefined;
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
const WEB_SOCKET_OPEN = 1;

export function createTerminalViewportHandle(options: {
  focus: () => void;
  refit: () => void;
  sendControl: (type: "restart" | "stop") => void;
}): TerminalViewportHandle {
  return {
    focus: options.focus,
    refit: options.refit,
    restart: () => options.sendControl("restart"),
    stop: () => options.sendControl("stop"),
  };
}

export function sendWebTerminalControl(
  socket: TerminalSocketLike | null,
  fit: FitDimensionsLike | null,
  type: "restart" | "stop",
): void {
  if (!socket || socket.readyState !== WEB_SOCKET_OPEN) return;
  const dimensions = fit?.proposeDimensions();
  socket.send(
    JSON.stringify({
      cols: dimensions?.cols,
      rows: dimensions?.rows,
      type,
    }),
  );
}

export function scheduleTerminalActivation(
  active: boolean,
  options: {
    focus: () => void;
    refit: () => void;
    schedule: (callback: () => void) => number;
    cancel: (id: number) => void;
  },
): (() => void) | undefined {
  if (!active) return;
  const id = options.schedule(() => {
    options.refit();
    options.focus();
  });
  return () => options.cancel(id);
}

export function connectWebTerminal(options: {
  sessionId: string;
  terminal: {
    onData(callback: (data: string) => void): { dispose(): void };
    write(data: string): void;
  };
  initialStatus: TerminalViewportStatus;
  reportStatus: (update: StatusUpdate) => void;
  sendResize: () => void;
  location?: { protocol: string; host: string };
  createSocket?: (url: string) => TerminalSocketLike;
  claimInitialInput?: () => readonly string[] | undefined;
  initialInputIntervalMs?: number;
  scheduleInitialInput?: (callback: () => void) => () => void;
  scheduleInput?: (callback: () => void, delay: number) => () => void;
}): { socket: TerminalSocketLike; dispose: () => void } {
  const location = options.location ?? window.location;
  const createSocket =
    options.createSocket ??
    ((url: string) => new WebSocket(url) as unknown as TerminalSocketLike);
  options.reportStatus(options.initialStatus);
  const socket = createSocket(terminalSocketUrl(options.sessionId, location));
  let disposed = false;
  let cancelInitialInput: (() => void) | undefined;
  const cancelStaggeredInputs: Array<() => void> = [];
  const scheduleInitialInput =
    options.scheduleInitialInput ??
    ((callback: () => void) => {
      const id = window.setTimeout(callback, 200);
      return () => window.clearTimeout(id);
    });
  const queueInitialInput = () => {
    cancelInitialInput?.();
    cancelInitialInput = scheduleInitialInput(() => {
      cancelInitialInput = undefined;
      const inputs = options.claimInitialInput?.() ?? [];
      inputs.forEach((data, index) => {
        const send = () => socket.send(JSON.stringify({ data, type: "input" }));
        if (index === 0) send();
        else {
          const schedule = options.scheduleInput ?? ((callback: () => void, delay: number) => {
            const id = window.setTimeout(callback, delay);
            return () => window.clearTimeout(id);
          });
          cancelStaggeredInputs.push(
            schedule(send, index * (options.initialInputIntervalMs ?? 75)),
          );
        }
      });
    });
  };
  const inputSubscription = options.terminal.onData((data) => {
    if (disposed) return;
    if (socket.readyState !== WEB_SOCKET_OPEN) return;
    socket.send(JSON.stringify({ data, type: "input" }));
  });

  socket.addEventListener("open", () => {
    if (disposed) return;
    options.reportStatus((current) => ({
      ...current,
      state: "running",
      detail: "Shell connected",
    }));
    options.sendResize();
  });

  socket.addEventListener("message", (event) => {
    if (disposed) return;
    const message = parseServerMessage(event.data);
    if (!message) return;
    if (message.type === "output") {
      options.terminal.write(message.data);
      queueInitialInput();
      return;
    }
    if (message.type === "error") {
      options.reportStatus((current) => ({
        ...current,
        state: "error",
        detail: message.error,
      }));
      return;
    }
    options.reportStatus((current) => ({
      state: message.state === "idle" ? "connecting" : message.state,
      cwd: message.cwd ?? current.cwd,
      detail: message.error ?? message.shell ?? "Shell connected",
    }));
  });

  socket.addEventListener("close", () => {
    if (disposed) return;
    options.reportStatus((current) => ({
      ...current,
      state: current.state === "exited" ? current.state : "exited",
      detail: "Socket closed",
    }));
  });

  socket.addEventListener("error", () => {
    if (disposed) return;
    options.reportStatus((current) => ({
      ...current,
      state: "error",
      detail: "Terminal socket error",
    }));
  });

  return {
    socket,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelInitialInput?.();
      cancelStaggeredInputs.forEach((cancel) => cancel());
      inputSubscription.dispose();
      socket.close();
    },
  };
}

/**
 * A raw xterm viewport bound to one server-owned PTY. It deliberately renders
 * no toolbar or status chrome so it can be reused by terminal and agent tabs.
 */
export const TerminalViewport = forwardRef<
  TerminalViewportHandle,
  TerminalViewportProps
>(function TerminalViewport(
  { sessionId, active, claimInitialInput, initialInputIntervalMs, onStatusChange },
  forwardedRef,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<TerminalSocketLike | null>(null);
  const statusCallbackRef = useRef(onStatusChange);
  const statusRef = useRef<TerminalViewportStatus>(INITIAL_STATUS);
  // Desktop owns its PTY in Rust; the web build attaches to the Node server.
  const tauriMode = isTauri();

  useEffect(() => {
    statusCallbackRef.current = onStatusChange;
  }, [onStatusChange]);

  const reportStatus = useCallback((update: StatusUpdate) => {
    const next =
      typeof update === "function" ? update(statusRef.current) : update;
    statusRef.current = next;
    statusCallbackRef.current?.(next);
  }, []);

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
    if (socket?.readyState !== WEB_SOCKET_OPEN) return;
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
      sendWebTerminalControl(socketRef.current, fitRef.current, type);
    },
    [tauriMode],
  );

  useImperativeHandle(
    forwardedRef,
    () =>
      createTerminalViewportHandle({
        focus: () => terminalRef.current?.focus(),
        refit: sendResize,
        sendControl,
      }),
    [sendControl, sendResize],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

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
      reportStatus(INITIAL_STATUS);
      let unlisten: (() => void) | null = null;
      let disposed = false;
      let initialInputTimer: number | undefined;
      const inputSubscription = terminal.onData((data) => {
        void tauri_writeTerminalInput(sessionId, data);
      });
      void tauri_onTerminalOutput(sessionId, (data) => {
        terminal.write(data);
        if (initialInputTimer !== undefined) window.clearTimeout(initialInputTimer);
        initialInputTimer = window.setTimeout(() => {
          initialInputTimer = undefined;
          void (async () => {
            const inputs = claimInitialInput?.() ?? [];
            for (let index = 0; index < inputs.length; index += 1) {
              if (index > 0) {
                await new Promise<void>((resolve) =>
                  window.setTimeout(resolve, initialInputIntervalMs ?? 75),
                );
              }
              await tauri_writeTerminalInput(sessionId, inputs[index]);
            }
          })();
        }, 200);
      }).then(
        (off) => {
          if (disposed) {
            off();
            return;
          }
          unlisten = off;
          reportStatus((current) => ({
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
          reportStatus((current) => ({
            ...current,
            state: "error",
            detail: caught instanceof Error ? caught.message : String(caught),
          }));
        },
      );
      cleanupTransport = () => {
        disposed = true;
        if (initialInputTimer !== undefined) window.clearTimeout(initialInputTimer);
        inputSubscription.dispose();
        unlisten?.();
      };
    } else {
      const transport = connectWebTerminal({
        claimInitialInput,
        initialInputIntervalMs,
        initialStatus: INITIAL_STATUS,
        reportStatus,
        sendResize,
        sessionId,
        terminal,
      });
      socketRef.current = transport.socket;

      cleanupTransport = () => {
        transport.dispose();
        socketRef.current = null;
      };
    }

    window.addEventListener("resize", sendResize);
    const initialResizeTimer = window.setTimeout(sendResize, 0);

    const observer = new ResizeObserver(() => sendResize());
    observer.observe(container);

    return () => {
      window.removeEventListener("resize", sendResize);
      window.clearTimeout(initialResizeTimer);
      observer.disconnect();
      cleanupTransport();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [reportStatus, sessionId, sendResize, tauriMode]);

  // A hidden xterm has zero dimensions. Refit and focus after it is revealed.
  useEffect(() => {
    return scheduleTerminalActivation(active, {
      cancel: (id) => window.clearTimeout(id),
      focus: () => terminalRef.current?.focus(),
      refit: sendResize,
      schedule: (callback) => window.setTimeout(callback, 0),
    });
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

function terminalSocketUrl(
  sessionId: string,
  location: { protocol: string; host: string },
): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const id = encodeURIComponent(sessionId);
  return `${protocol}//${location.host}/api/terminal/socket?id=${id}`;
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
