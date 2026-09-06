import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";
import { translate } from "@/lib/i18n";
import {
  daemonWebSocketProtocols,
  daemonWebSocketUrl,
} from "@/lib/api/desktop-runtime";
import type { ResolvedTheme } from "@/lib/theme";
import {
  INITIAL_STATUS,
  OUTPUT_BATCH_DELAY_MS,
  SMOOTH_SCROLL_DURATION_MS,
  TERMINAL_RESIZE_SETTLE_MS,
  WEB_SOCKET_OPEN,
  type DisposableRenderer,
  type FitDimensionsLike,
  type ServerMessage,
  type StatusUpdate,
  type TerminalConnectionState,
  type TerminalControl,
  type TerminalSocketLike,
  type TerminalViewportHandle,
  type TerminalViewportStatus,
  type ThemeableTerminal,
} from "./terminal-types";

/**
 * The terminal's runtime: its palette, its WebGL renderer, its output batching
 * and the WebSocket session behind it.
 *
 * None of it is React. `terminal-viewport.tsx` owns the element and the
 * lifecycle; everything here takes what it needs as an argument, which is what
 * lets `test/terminal-view.test.tsx` drive it with fake sockets and terminals.
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
export function terminalSocketUrl(
  sessionId: string,
  location: { protocol: string; host: string },
): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const id = encodeURIComponent(sessionId);
  return `${protocol}//${location.host}/api/terminal/socket?id=${id}`;
}

export function parseServerMessage(input: unknown): ServerMessage | null {
  if (typeof input !== "string") return null;
  try {
    const parsed = JSON.parse(input) as ServerMessage;
    return typeof parsed?.type === "string" ? parsed : null;
  } catch {
    return null;
  }
}
