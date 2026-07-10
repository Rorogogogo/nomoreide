import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
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

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    loadAddon() {}
    open() {}
    focus() {}
    onData() {
      return { dispose() {} };
    }
    write() {}
    dispose() {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
    proposeDimensions() {
      return { cols: 80, rows: 24 };
    }
  },
}));

describe("TerminalView", () => {
  test("renders the tab strip with a new-terminal control", () => {
    const markup = renderToStaticMarkup(<TerminalView />);

    expect(markup).toContain("Terminal tabs");
    expect(markup).toContain("New terminal");
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
      terminal: {
        onData: () => ({ dispose: vi.fn() }),
        write: vi.fn(),
      },
      reportStatus,
      sendResize: vi.fn(),
      location: { host: "localhost:4321", protocol: "http:" },
    });
    socket.emit("open", {});

    expect(createSocket).toHaveBeenCalledWith(
      "ws://localhost:4321/api/terminal/socket?id=agent%20%2F%20one",
    );
    expect(reportStatus).toHaveBeenCalledTimes(2);
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

  test("exposes functional controls for socket commands, focus, and refit", () => {
    const socket = new FakeSocket();
    socket.readyState = 1;
    const focus = vi.fn();
    const refit = vi.fn();
    const fit = { proposeDimensions: vi.fn(() => ({ cols: 91, rows: 27 })) };
    const sendControl = (type: "restart" | "stop") =>
      sendWebTerminalControl(socket, fit, type);
    const handle = createTerminalViewportHandle({ focus, refit, sendControl });

    handle.restart();
    handle.stop();
    handle.focus();
    handle.refit();

    expect(socket.send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({ cols: 91, rows: 27, type: "restart" }),
    );
    expect(socket.send).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({ cols: 91, rows: 27, type: "stop" }),
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
