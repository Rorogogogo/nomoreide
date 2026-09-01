import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { translate, useT } from "@/lib/i18n";
import { Terminal } from "@xterm/xterm";
import { Wrench } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  tauri_onTerminalOutput,
  tauri_resizeTerminal,
  tauri_startTerminalStream,
  tauri_writeTerminalInput,
} from "@/lib/api";
import {
  daemonWebSocketProtocols,
  daemonWebSocketUrl,
} from "@/lib/api/desktop-runtime";
import { isTauri } from "@/lib/tauri";
import { useResolvedTheme, type ResolvedTheme } from "@/lib/theme";
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
  repair(): void;
  restart(): void;
  stop(): void;
  focus(): void;
  refit(): void;
  /** Writes raw data to the PTY, as if typed into the terminal. */
  input(data: string): void;
  /** Pastes text using xterm's bracketed-paste handling. */
  paste(data: string, prefix?: string): boolean;
}

export interface TerminalViewportProps {
  /** Server session id this viewport attaches to. */
  sessionId: string;
  /** Hidden viewports remain mounted to preserve their PTY and scrollback. */
  active: boolean;
  /** Only the focused visible pane should claim keyboard focus. */
  focused?: boolean;
  /** Reports transport status for optional chrome rendered by a parent. */
  onStatusChange?: (status: TerminalViewportStatus) => void;
  /** Claims one-time inputs after the PTY has finished its startup output. */
  claimInitialInput?: () => readonly string[] | undefined;
  /** Delay between composed initial input and its submit key. */
  initialInputIntervalMs?: number;
  /** Confirmed display preferences; optional for isolated consumers/tests. */
  displaySettings?: TerminalDisplaySettings;
  /** False keeps output mirrored while another surface owns input and resize. */
  interactive?: boolean;
  /** Prevents a child TUI from caching the host palette at process startup. */
  suppressColorQueries?: boolean;
}

export interface TerminalDisplaySettings {
  fontSize: number;
  cursorStyle: "block" | "underline" | "bar";
  scrollback: number;
  copyOnSelect: boolean;
  smoothScroll: boolean;
}

export const DEFAULT_TERMINAL_DISPLAY_SETTINGS: TerminalDisplaySettings = {
  fontSize: 13,
  cursorStyle: "block",
  scrollback: 5_000,
  copyOnSelect: false,
  smoothScroll: true,
};

/**
 * How long xterm animates a wheel scroll. Its default of 0 teleports the
 * viewport a whole line per notch, which reads as dropped frames on a trackpad
 * that emits many small deltas. Only affects buffers with scrollback — a
 * full-screen TUI (Claude Code runs in the alternate screen; Codex does not,
 * see `--no-alt-screen`) handles its own scrolling and is unaffected.
 */
const SMOOTH_SCROLL_DURATION_MS = 120;

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

type TerminalControl = "repair" | "restart" | "stop";

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
  cwd: translate("terminal.localWorkspace"),
  detail: translate("terminal.openingShell"),
};
const WEB_SOCKET_OPEN = 1;
const OUTPUT_BATCH_DELAY_MS = 8;
// Layout transitions (notably the hover-expanded navigation rail) can emit a
// ResizeObserver entry every animation frame. Forwarding every intermediate
// width to the PTY makes interactive shells redraw their prompts repeatedly.
// Wait for a short quiet period and resize once at the settled dimensions.
export const TERMINAL_RESIZE_SETTLE_MS = 80;

interface DisposableRenderer {
  dispose(): void;
  clearTextureAtlas?(): void;
}

interface ThemeableTerminal {
  options: Terminal["options"];
  refresh(start: number, end: number): void;
  rows: number;
}

/**
 * Palette assignment alone is not enough for every renderer. In particular,
 * WebGL can retain cells drawn with the previous default foreground/background,
 * which leaves Codex's full-width composer and tool rows as light blocks after
 * a light-to-dark switch. Invalidate both the glyph atlas and visible rows so
 * existing terminal content is repainted against the new palette immediately.
 */
export function applyTerminalTheme(
  terminal: ThemeableTerminal,
  container: HTMLElement | null,
  theme: ReturnType<typeof terminalTheme>,
  renderer?: DisposableRenderer | null,
) {
  terminal.options.theme = theme;
  const viewport = container?.querySelector<HTMLElement>(".xterm-viewport");
  if (viewport) viewport.style.backgroundColor = theme.background;
  renderer?.clearTextureAtlas?.();
  if (terminal.rows > 0) terminal.refresh(0, terminal.rows - 1);
}

export function suppressTerminalColorQuery(data: string): boolean {
  return data.trim() === "?";
}

export function attachWebglRenderer(
  terminal: Pick<Terminal, "loadAddon">,
  runtime: object = globalThis,
): DisposableRenderer | null {
  if (!("WebGL2RenderingContext" in runtime)) return null;

  const addon = new WebglAddon();
  let disposed = false;
  let contextLossSubscription: { dispose(): void } | undefined;
  const renderer = {
    clearTextureAtlas: () => {
      if (!disposed) addon.clearTextureAtlas();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      contextLossSubscription?.dispose();
      addon.dispose();
    },
  };

  try {
    terminal.loadAddon(addon);
    contextLossSubscription = addon.onContextLoss(() => renderer.dispose());
    return renderer;
  } catch {
    renderer.dispose();
    return null;
  }
}

export function createTerminalOutputBuffer(options: {
  write: (data: string) => void;
  schedule?: (callback: () => void) => () => void;
}): { dispose(): void; flush(): void; push(data: string): void } {
  let pending = "";
  let cancelScheduledFlush: (() => void) | undefined;
  let disposed = false;
  const schedule =
    options.schedule ??
    ((callback: () => void) => {
      const id = window.setTimeout(callback, OUTPUT_BATCH_DELAY_MS);
      return () => window.clearTimeout(id);
    });

  const flush = () => {
    cancelScheduledFlush = undefined;
    if (disposed || !pending) return;
    const data = pending;
    pending = "";
    options.write(data);
  };

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelScheduledFlush?.();
      cancelScheduledFlush = undefined;
      pending = "";
    },
    flush,
    push: (data) => {
      if (disposed || !data) return;
      pending += data;
      if (!cancelScheduledFlush) cancelScheduledFlush = schedule(flush);
    },
  };
}

export function terminalTheme(theme: ResolvedTheme) {
  if (theme === "light") {
    return {
      background: "#fcfcfc",
      black: "#24211f",
      blue: "#2869b8",
      brightBlack: "#6e6964",
      brightBlue: "#3478c9",
      brightCyan: "#188e88",
      brightGreen: "#2c8d49",
      brightMagenta: "#925db6",
      brightRed: "#d94747",
      brightWhite: "#ffffff",
      brightYellow: "#9a7200",
      cursor: "#24211f",
      cyan: "#147d78",
      foreground: "#24211f",
      green: "#247a3c",
      magenta: "#8050a6",
      red: "#c43d3d",
      selectionBackground: "#147d7830",
      white: "#d9d5d0",
      yellow: "#8a6500",
    };
  }
  return {
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
    cursor: "#f2f2f2",
    cyan: "#62d0c8",
    foreground: "#f2f2f2",
    green: "#7ac77f",
    magenta: "#c792ea",
    red: "#ff6b6b",
    selectionBackground: "#ffffff33",
    white: "#e8eaed",
    yellow: "#f7c948",
  };
}

export function createTerminalViewportHandle(options: {
  focus: () => void;
  refit: () => void;
  sendControl: (type: TerminalControl) => void;
  sendInput: (data: string) => void;
  paste?: (data: string, prefix?: string) => boolean;
}): TerminalViewportHandle {
  return {
    focus: options.focus,
    input: options.sendInput,
    paste: options.paste ?? (() => false),
    refit: options.refit,
    repair: () => options.sendControl("repair"),
    restart: () => options.sendControl("restart"),
    stop: () => options.sendControl("stop"),
  };
}

export function sendWebTerminalControl(
  socket: TerminalSocketLike | null,
  fit: FitDimensionsLike | null,
  type: TerminalControl,
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

export function isRecoverableTerminalSpawnError(detail: string): boolean {
  return detail.includes("posix_spawnp failed");
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
    ((url: string) =>
      new WebSocket(url, daemonWebSocketProtocols()) as unknown as TerminalSocketLike);
  options.reportStatus(options.initialStatus);
  const fallbackUrl = terminalSocketUrl(options.sessionId, location);
  const socket = createSocket(
    daemonWebSocketUrl(
      `/api/terminal/socket?id=${encodeURIComponent(options.sessionId)}`,
      fallbackUrl,
    ),
  );
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
      detail: translate("terminal.shellConnected"),
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
      detail: message.error ?? message.shell ?? translate("terminal.shellConnected"),
    }));
  });

  socket.addEventListener("close", () => {
    if (disposed) return;
    options.reportStatus((current) => ({
      ...current,
      state: current.state === "exited" ? current.state : "exited",
      detail: translate("terminal.socketClosed"),
    }));
  });

  socket.addEventListener("error", () => {
    if (disposed) return;
    options.reportStatus((current) => ({
      ...current,
      state: "error",
      detail: translate("terminal.socketError"),
    }));
  });

  return {
    socket,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelInitialInput?.();
      cancelStaggeredInputs.forEach((cancel) => {
        cancel();
      });
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
  {
    sessionId,
    active,
    focused = active,
    claimInitialInput,
    initialInputIntervalMs,
    onStatusChange,
    displaySettings = DEFAULT_TERMINAL_DISPLAY_SETTINGS,
    interactive = true,
    suppressColorQueries = false,
  },
  forwardedRef,
) {
  const t = useT();
  const resolvedTheme = useResolvedTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const webglRendererRef = useRef<DisposableRenderer | null>(null);
  const socketRef = useRef<TerminalSocketLike | null>(null);
  const statusCallbackRef = useRef(onStatusChange);
  const displaySettingsRef = useRef(displaySettings);
  const interactiveRef = useRef(interactive);
  const activeRef = useRef(active);
  const suppressColorQueriesRef = useRef(suppressColorQueries);
  const statusRef = useRef<TerminalViewportStatus>(INITIAL_STATUS);
  const [status, setStatus] = useState<TerminalViewportStatus>(INITIAL_STATUS);
  const [repairing, setRepairing] = useState(false);
  // Desktop owns its PTY in Rust; the web build attaches to the Node server.
  const tauriMode = isTauri();

  activeRef.current = active;

  useEffect(() => {
    statusCallbackRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    interactiveRef.current = interactive;
    const terminal = terminalRef.current;
    if (terminal) terminal.options.disableStdin = !interactive;
  }, [interactive]);

  useEffect(() => {
    suppressColorQueriesRef.current = suppressColorQueries;
  }, [suppressColorQueries]);

  const reportStatus = useCallback((update: StatusUpdate) => {
    const next =
      typeof update === "function" ? update(statusRef.current) : update;
    statusRef.current = next;
    setStatus(next);
    if (next.state === "running" || next.state === "error") {
      setRepairing(false);
    }
    statusCallbackRef.current?.(next);
  }, []);

  const sendResize = useCallback(() => {
    // Hidden panes stay mounted for scrollback, but their zero/settling
    // geometry must never resize the shared PTY. Activation schedules the
    // authoritative fit once the pane is visible again.
    if (!interactiveRef.current || !activeRef.current) return;
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

  useEffect(() => {
    if (interactive) sendResize();
  }, [interactive, sendResize]);

  useEffect(() => {
    displaySettingsRef.current = displaySettings;
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontSize = displaySettings.fontSize;
    terminal.options.cursorStyle = displaySettings.cursorStyle;
    terminal.options.scrollback = displaySettings.scrollback;
    terminal.options.smoothScrollDuration = displaySettings.smoothScroll
      ? SMOOTH_SCROLL_DURATION_MS
      : 0;
    sendResize();
  }, [
    displaySettings.copyOnSelect,
    displaySettings.cursorStyle,
    displaySettings.fontSize,
    displaySettings.scrollback,
    displaySettings.smoothScroll,
    sendResize,
  ]);

  const sendControl = useCallback(
    (type: TerminalControl) => {
      // The Rust PTY has no restart/stop commands yet, matching the existing
      // desktop behavior where these controls are no-ops.
      if (tauriMode) return;
      sendWebTerminalControl(socketRef.current, fitRef.current, type);
    },
    [tauriMode],
  );

  const sendInput = useCallback(
    (data: string) => {
      if (!interactiveRef.current) return;
      if (tauriMode) {
        void tauri_writeTerminalInput(sessionId, data);
        return;
      }
      const socket = socketRef.current;
      if (socket?.readyState !== WEB_SOCKET_OPEN) return;
      socket.send(JSON.stringify({ data, type: "input" }));
    },
    [tauriMode, sessionId],
  );

  useImperativeHandle(
    forwardedRef,
    () =>
      createTerminalViewportHandle({
        focus: () => {
          if (interactiveRef.current) terminalRef.current?.focus();
        },
        refit: sendResize,
        sendControl,
        sendInput,
        paste: (data, prefix) => {
          if (!interactiveRef.current) return false;
          const terminal = terminalRef.current;
          if (!terminal) return false;
          if (prefix) sendInput(prefix);
          terminal.paste(data);
          return true;
        },
      }),
    [sendControl, sendInput, sendResize],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: displaySettingsRef.current.cursorStyle,
      fontFamily:
        '"SF Mono", "Symbols Nerd Font Mono", "JetBrains Mono", ui-monospace, Menlo, monospace',
      fontSize: displaySettingsRef.current.fontSize,
      lineHeight: 1.25,
      scrollback: displaySettingsRef.current.scrollback,
      smoothScrollDuration: displaySettingsRef.current.smoothScroll
        ? SMOOTH_SCROLL_DURATION_MS
        : 0,
      disableStdin: !interactiveRef.current,
      theme: terminalTheme(resolvedTheme),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    const colorQuerySubscriptions = [10, 11].map((identifier) =>
      terminal.parser.registerOscHandler(
        identifier,
        (data) =>
          suppressColorQueriesRef.current && suppressTerminalColorQuery(data),
      ),
    );
    terminal.open(container);
    const outputBuffer = createTerminalOutputBuffer({
      write: (data) => terminal.write(data),
    });
    const viewport = container.querySelector<HTMLElement>(".xterm-viewport");
    if (viewport) {
      viewport.style.backgroundColor = terminalTheme(resolvedTheme).background;
    }
    terminalRef.current = terminal;
    fitRef.current = fit;
    if (active) {
      webglRendererRef.current = attachWebglRenderer(terminal);
    }
    const selectionSubscription = terminal.onSelectionChange(() => {
      if (!displaySettingsRef.current.copyOnSelect) return;
      const selection = terminal.getSelection();
      if (!selection) return;
      try {
        void navigator.clipboard?.writeText(selection).catch(() => {});
      } catch {
        // Clipboard access can be denied; selection should remain non-fatal.
      }
    });

    let cleanupTransport: () => void;

    if (tauriMode) {
      reportStatus(INITIAL_STATUS);
      let unlisten: (() => void) | null = null;
      let disposed = false;
      let initialInputTimer: number | undefined;
      const inputSubscription = terminal.onData((data) => {
        if (!interactiveRef.current) return;
        void tauri_writeTerminalInput(sessionId, data);
      });
      void tauri_onTerminalOutput(sessionId, (data) => {
        outputBuffer.push(data);
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
            detail: translate("terminal.shellConnected"),
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
        terminal: {
          onData: (callback) => terminal.onData((data) => {
            if (interactiveRef.current) callback(data);
          }),
          write: (data) => outputBuffer.push(data),
        },
      });
      socketRef.current = transport.socket;

      cleanupTransport = () => {
        transport.dispose();
        socketRef.current = null;
      };
    }

    window.addEventListener("resize", sendResize);
    const initialResizeTimer = window.setTimeout(sendResize, 0);

    let observedResizeTimer: number | undefined;
    const observer = new ResizeObserver(() => {
      if (observedResizeTimer !== undefined) {
        window.clearTimeout(observedResizeTimer);
      }
      observedResizeTimer = window.setTimeout(() => {
        observedResizeTimer = undefined;
        sendResize();
      }, TERMINAL_RESIZE_SETTLE_MS);
    });
    observer.observe(container);

    return () => {
      window.removeEventListener("resize", sendResize);
      window.clearTimeout(initialResizeTimer);
      if (observedResizeTimer !== undefined) {
        window.clearTimeout(observedResizeTimer);
      }
      observer.disconnect();
      cleanupTransport();
      selectionSubscription.dispose();
      colorQuerySubscriptions.forEach((subscription) => {
        subscription.dispose();
      });
      outputBuffer.dispose();
      webglRendererRef.current?.dispose();
      webglRendererRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [reportStatus, sessionId, sendResize, tauriMode]);

  useEffect(() => {
    if (!active) {
      webglRendererRef.current?.dispose();
      webglRendererRef.current = null;
      return;
    }
    if (webglRendererRef.current || !terminalRef.current) return;
    webglRendererRef.current = attachWebglRenderer(terminalRef.current);
  }, [active]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const theme = terminalTheme(resolvedTheme);
    if (terminal) {
      applyTerminalTheme(
        terminal,
        containerRef.current,
        theme,
        webglRendererRef.current,
      );
    }
  }, [resolvedTheme]);

  // A hidden xterm has zero dimensions. Refit after it is revealed, but only
  // the pane the user last interacted with should claim keyboard focus.
  useEffect(() => {
    return scheduleTerminalActivation(active, {
      cancel: (id) => window.clearTimeout(id),
      focus: () => {
        if (focused && interactiveRef.current) terminalRef.current?.focus();
      },
      refit: sendResize,
      schedule: (callback) => window.setTimeout(callback, 0),
    });
  }, [active, focused, sendResize]);

  return (
    <section
      aria-label="terminal viewport"
      className={cn(
        "relative h-full min-h-0 overflow-hidden bg-[#fcfcfc] px-3 py-0.5 dark:bg-[#090909]",
        !active && "hidden",
      )}
      data-terminal-session={sessionId}
    >
      {/* Padding stays outside xterm's mount so FitAddon does not provision an
          extra row and clip the final line. */}
      <div className="h-full w-full" ref={containerRef} />
      {!tauriMode &&
      status.state === "error" &&
      isRecoverableTerminalSpawnError(status.detail) ? (
        <div
          className="absolute inset-x-3 top-3 z-20 flex items-start gap-2 border border-destructive/40 bg-background px-3 py-2 text-foreground shadow-sm"
          role="alert"
        >
          <Wrench aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">{t("terminal.repairTitle")}</p>
            <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
              {t("terminal.repairBody")}
            </p>
          </div>
          <Button
            className="shrink-0"
            disabled={repairing}
            onClick={() => {
              setRepairing(true);
              sendControl("repair");
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            {repairing ? t("terminal.repairing") : t("terminal.repairAction")}
          </Button>
        </div>
      ) : null}
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
