// @vitest-environment happy-dom

import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TerminalPane } from "../src/web/client/src/features/terminal/terminal-pane";
import {
  connectWebTerminal,
  createTerminalViewportHandle,
  scheduleTerminalActivation,
  sendWebTerminalControl,
  TerminalViewport,
  type TerminalViewportStatus,
} from "../src/web/client/src/features/terminal/terminal-viewport";
import { TerminalView } from "../src/web/client/src/features/terminal/terminal-view";

const xtermMocks = vi.hoisted(() => ({
  fits: [] as Array<{
    fit: ReturnType<typeof vi.fn>;
    proposeDimensions: ReturnType<typeof vi.fn>;
  }>,
  terminals: [] as Array<{
    dispose: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    inputDispose: ReturnType<typeof vi.fn>;
    options: Record<string, unknown>;
    selectionDispose: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    dispose = vi.fn();
    focus = vi.fn();
    getSelection = vi.fn(() => "");
    inputDispose = vi.fn();
    options: Record<string, unknown>;
    selectionDispose = vi.fn();
    write = vi.fn();
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      xtermMocks.terminals.push(this);
    }
    loadAddon() {}
    open() {}
    onData() {
      return { dispose: this.inputDispose };
    }
    onSelectionChange() {
      return { dispose: this.selectionDispose };
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
    constructor() {
      xtermMocks.fits.push(this);
    }
  },
}));

vi.mock("../src/web/client/src/features/settings/settings-context", () => ({
  useSettings: () => ({
    confirmedGlobal: {
      version: 1,
      terminal: {
        fontSize: 13,
        cursorStyle: "block",
        scrollback: 5_000,
        copyOnSelect: false,
        confirmTerminate: false,
      },
    },
  }),
}));

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  xtermMocks.fits.length = 0;
  xtermMocks.terminals.length = 0;
});

describe("TerminalView", () => {
  test("renders the tab strip with a new-terminal control", () => {
    const markup = renderToStaticMarkup(<TerminalView />);

    expect(markup).toContain("Terminal tabs");
    expect(markup).toContain("New terminal");
    expect(markup).toContain("bg-background");
    expect(markup).toContain("border-border bg-card");
    // Effects don't run under SSR, so the page shows its pre-fetch placeholder.
    expect(markup).toContain("Starting terminal");
  });
});

describe("TerminalPane", () => {
  test("renders the per-tab controls and viewport", () => {
    const markup = renderToStaticMarkup(
      <TerminalPane active sessionId="term_1" />,
    );

    expect(markup).toContain("Restart");
    expect(markup).toContain("Stop");
    expect(markup).toContain("bg-background text-foreground");
    expect(markup).toContain("border-border bg-card");
    expect(markup).toContain("terminal viewport");
  });

  test("hides an inactive pane but keeps it mounted", () => {
    const markup = renderToStaticMarkup(
      <TerminalPane active={false} sessionId="term_2" />,
    );

    expect(markup).toContain("hidden");
    expect(markup).toContain("terminal viewport");
  });
});

describe("TerminalViewport", () => {
  test("renders only the raw terminal viewport", () => {
    const markup = renderToStaticMarkup(
      <TerminalViewport active sessionId="term_raw" />,
    );

    expect(markup).toContain("terminal viewport");
    expect(markup).toContain("bg-[#fcfcfc]");
    expect(markup).toContain("dark:bg-[#090909]");
    expect(markup).not.toContain("Restart");
    expect(markup).not.toContain("Stop");
  });

  test("stays rendered while inactive", () => {
    const markup = renderToStaticMarkup(
      <TerminalViewport active={false} sessionId="term_hidden" />,
    );

    expect(markup).toContain("hidden");
    expect(markup).toContain("terminal viewport");
  });

  test("connects the encoded session URL and reports initial and running status", () => {
    const socket = new FakeSocket();
    const statuses: TerminalViewportStatus[] = [];
    const createSocket = vi.fn(() => socket);
    const delayedInputs: Array<() => void> = [];
    const inputDelays: number[] = [];
    const reportStatus = vi.fn(
      (
        next:
          | TerminalViewportStatus
          | ((current: TerminalViewportStatus) => TerminalViewportStatus),
      ) => {
        const current = statuses.at(-1) ?? {
          state: "connecting" as const,
          cwd: "Local workspace",
          detail: "Opening shell",
        };
        statuses.push(typeof next === "function" ? next(current) : next);
      },
    );

    connectWebTerminal({
      createSocket,
      initialStatus: {
        state: "connecting",
        cwd: "Local workspace",
        detail: "Opening shell",
      },
      sessionId: "agent / one",
      claimInitialInput: vi
        .fn<() => readonly string[] | undefined>()
        .mockReturnValueOnce(["\u001b[200~Do the work\u001b[201~", "\r"]),
      initialInputIntervalMs: 500,
      scheduleInitialInput: (callback) => {
        callback();
        return () => {};
      },
      scheduleInput: (callback, delay) => {
        delayedInputs.push(callback);
        inputDelays.push(delay);
        return () => {};
      },
      terminal: {
        onData: () => ({ dispose: vi.fn() }),
        write: vi.fn(),
      },
      reportStatus,
      sendResize: vi.fn(),
      location: { host: "localhost:4321", protocol: "http:" },
    });
    socket.emit("open", {});
    expect(socket.send).not.toHaveBeenCalled();
    socket.emit("message", {
      data: JSON.stringify({ data: "Codex ready", type: "output" }),
    });

    expect(createSocket).toHaveBeenCalledWith(
      "ws://localhost:4321/api/terminal/socket?id=agent%20%2F%20one",
    );
    expect(reportStatus).toHaveBeenCalledTimes(2);
    expect(socket.send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({ data: "\u001b[200~Do the work\u001b[201~", type: "input" }),
    );
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(inputDelays).toEqual([500]);
    delayedInputs.shift()?.();
    expect(socket.send).toHaveBeenNthCalledWith(2, JSON.stringify({ data: "\r", type: "input" }));
    socket.emit("message", {
      data: JSON.stringify({ data: "More output", type: "output" }),
    });
    expect(socket.send).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual([
      {
        state: "connecting",
        cwd: "Local workspace",
        detail: "Opening shell",
      },
      {
        state: "running",
        cwd: "Local workspace",
        detail: "Shell connected",
      },
    ]);
  });

  test("ignores every socket event after the web transport is disposed", () => {
    const socket = new FakeSocket();
    const reportStatus = vi.fn();
    const sendResize = vi.fn();
    const write = vi.fn();
    const inputDispose = vi.fn();
    const transport = connectWebTerminal({
      createSocket: () => socket,
      initialStatus: {
        state: "connecting",
        cwd: "Local workspace",
        detail: "Opening shell",
      },
      location: { host: "localhost", protocol: "http:" },
      reportStatus,
      sendResize,
      sessionId: "disposed",
      terminal: {
        onData: () => ({ dispose: inputDispose }),
        write,
      },
    });
    reportStatus.mockClear();

    transport.dispose();
    socket.emit("open", {});
    socket.emit("message", {
      data: JSON.stringify({ data: "late output", type: "output" }),
    });
    socket.emit("error", {});
    socket.emit("close", {});

    expect(inputDispose).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(reportStatus).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(sendResize).not.toHaveBeenCalled();
  });

  test("exposes functional controls for socket commands, focus, and refit", () => {
    const socket = new FakeSocket();
    socket.readyState = 1;
    const focus = vi.fn();
    const refit = vi.fn();
    const fit = { proposeDimensions: vi.fn(() => ({ cols: 91, rows: 27 })) };
    const sendControl = (type: "restart" | "stop") =>
      sendWebTerminalControl(socket, fit, type);
    const sendInput = (data: string) =>
      socket.send(JSON.stringify({ data, type: "input" }));
    const handle = createTerminalViewportHandle({ focus, refit, sendControl, sendInput });

    handle.restart();
    handle.stop();
    handle.focus();
    handle.refit();
    handle.input("/verify ");

    expect(socket.send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({ cols: 91, rows: 27, type: "restart" }),
    );
    expect(socket.send).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({ cols: 91, rows: 27, type: "stop" }),
    );
    expect(socket.send).toHaveBeenNthCalledWith(
      3,
      JSON.stringify({ data: "/verify ", type: "input" }),
    );
    expect(focus).toHaveBeenCalledOnce();
    expect(refit).toHaveBeenCalledOnce();
  });

  test("activation schedules a refit and terminal focus", () => {
    const refit = vi.fn();
    const focus = vi.fn();
    const cancelTimer = vi.fn();
    let scheduled: (() => void) | undefined;
    const cleanup = scheduleTerminalActivation(true, {
      focus,
      refit,
      schedule: (callback) => {
        scheduled = callback;
        return 42;
      },
      cancel: cancelTimer,
    });

    expect(refit).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    scheduled?.();
    expect(refit).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    cleanup?.();
    expect(cancelTimer).toHaveBeenCalledWith(42);
  });

  test("wires the mounted viewport lifecycle through its public props and ref", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/workbench");
    const sockets: BrowserFakeSocket[] = [];
    vi.stubGlobal(
      "WebSocket",
      class extends BrowserFakeSocket {
        constructor(url: string) {
          super(url);
          sockets.push(this);
        }
      },
    );
    const observers: FakeResizeObserver[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class extends FakeResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          super(callback);
          observers.push(this);
        }
      },
    );
    const statuses: TerminalViewportStatus[] = [];
    const viewportRef = createRef<
      import("../src/web/client/src/features/terminal/terminal-viewport").TerminalViewportHandle
    >();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <TerminalViewport
          active={false}
          onStatusChange={(status) => statuses.push(status)}
          ref={viewportRef}
          sessionId="agent / mounted"
        />,
      );
    });

    const socket = sockets[0];
    const terminal = xtermMocks.terminals[0];
    const fit = xtermMocks.fits[0];
    expect(socket?.url).toBe(
      "ws://localhost:3000/api/terminal/socket?id=agent%20%2F%20mounted",
    );
    expect(statuses[0]).toEqual({
      state: "connecting",
      cwd: "Local workspace",
      detail: "Opening shell",
    });

    socket.readyState = 1;
    await act(async () => socket.emit("open", {}));
    expect(statuses.at(-1)?.state).toBe("running");
    viewportRef.current?.restart();
    viewportRef.current?.stop();
    viewportRef.current?.focus();
    viewportRef.current?.refit();
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ cols: 80, rows: 24, type: "restart" }),
    );
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ cols: 80, rows: 24, type: "stop" }),
    );
    expect(terminal.focus).toHaveBeenCalledOnce();

    await act(async () => vi.runOnlyPendingTimers());
    terminal.focus.mockClear();
    fit.fit.mockClear();
    await act(async () => {
      root.render(
        <TerminalViewport
          active
          onStatusChange={(status) => statuses.push(status)}
          ref={viewportRef}
          sessionId="agent / mounted"
        />,
      );
    });
    expect(terminal.focus).not.toHaveBeenCalled();
    await act(async () => vi.runOnlyPendingTimers());
    expect(terminal.focus).toHaveBeenCalledOnce();
    expect(fit.fit).toHaveBeenCalledOnce();

    const statusCount = statuses.length;
    await act(async () => root.unmount());
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(terminal.inputDispose).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(observers[0]?.disconnect).toHaveBeenCalledOnce();
    socket.emit("message", {
      data: JSON.stringify({ data: "too late", type: "output" }),
    });
    socket.emit("close", {});
    expect(terminal.write).not.toHaveBeenCalled();
    expect(statuses).toHaveLength(statusCount);
    host.remove();
  });
});

class FakeSocket {
  readyState = 0;
  send = vi.fn();
  close = vi.fn();
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class BrowserFakeSocket extends FakeSocket {
  static readonly OPEN = 1;
  constructor(readonly url: string) {
    super();
  }
}

class FakeResizeObserver {
  disconnect = vi.fn();
  observe = vi.fn();
  unobserve = vi.fn();
  constructor(readonly callback: ResizeObserverCallback) {}
}
