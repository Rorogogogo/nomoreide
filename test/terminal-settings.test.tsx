// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TerminalPane } from "../src/web/client/src/features/terminal/terminal-pane";
import { TerminalViewport } from "../src/web/client/src/features/terminal/terminal-viewport";
import { TerminalView } from "../src/web/client/src/features/terminal/terminal-view";

const mocks = vi.hoisted(() => ({
  closeSession: vi.fn(),
  createSession: vi.fn(),
  display: {
    fontSize: 13,
    cursorStyle: "block" as "block" | "underline" | "bar",
    scrollback: 5_000,
    copyOnSelect: false,
  },
  confirmTerminate: true,
  resolvedTheme: "light" as "light" | "dark",
  fits: [] as Array<{ fit: ReturnType<typeof vi.fn>; proposeDimensions: ReturnType<typeof vi.fn> }>,
  listSessions: vi.fn(),
  sockets: [] as BrowserFakeSocket[],
  terminals: [] as Array<{
    constructorOptions: Record<string, unknown>;
    dispose: ReturnType<typeof vi.fn>;
    getSelection: ReturnType<typeof vi.fn>;
    inputDispose: ReturnType<typeof vi.fn>;
    options: Record<string, unknown>;
    selectionDispose: ReturnType<typeof vi.fn>;
    selectionListener?: () => void;
  }>,
}));

vi.mock("../src/web/client/src/lib/theme", () => ({
  useResolvedTheme: () => mocks.resolvedTheme,
}));

vi.mock("../src/web/client/src/features/settings/settings-context", () => ({
  useSettings: () => ({
    confirmedGlobal: {
      version: 1,
      terminal: { ...mocks.display, confirmTerminate: mocks.confirmTerminate },
    },
  }),
}));

vi.mock("../src/web/client/src/lib/api", () => ({
  closeTerminalSession: mocks.closeSession,
  createTerminalSession: mocks.createSession,
  listTerminalSessions: mocks.listSessions,
  tauri_onTerminalOutput: vi.fn(),
  tauri_resizeTerminal: vi.fn(),
  tauri_startTerminalStream: vi.fn(),
  tauri_writeTerminalInput: vi.fn(),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructorOptions: Record<string, unknown>;
    dispose = vi.fn();
    focus = vi.fn();
    getSelection = vi.fn(() => "selected output");
    inputDispose = vi.fn();
    options: Record<string, unknown>;
    selectionDispose = vi.fn();
    selectionListener?: () => void;
    write = vi.fn();
    constructor(options: Record<string, unknown>) {
      this.constructorOptions = options;
      this.options = { ...options };
      mocks.terminals.push(this);
    }
    loadAddon() {}
    open() {}
    onData() {
      return { dispose: this.inputDispose };
    }
    onSelectionChange(listener: () => void) {
      this.selectionListener = listener;
      return { dispose: this.selectionDispose };
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
    constructor() {
      mocks.fits.push(this);
    }
  },
}));

class BrowserFakeSocket {
  static readonly OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
  private listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(readonly url: string) {
    mocks.sockets.push(this);
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }
}

class FakeResizeObserver {
  disconnect = vi.fn();
  observe = vi.fn();
  unobserve = vi.fn();
}

async function mount(node: React.ReactNode): Promise<{ host: HTMLDivElement; root: Root }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return { host, root };
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mocks.display = {
    fontSize: 13,
    cursorStyle: "block",
    scrollback: 5_000,
    copyOnSelect: false,
  };
  mocks.confirmTerminate = true;
  mocks.resolvedTheme = "light";
  mocks.closeSession.mockReset().mockResolvedValue(undefined);
  mocks.createSession.mockReset().mockResolvedValue({ id: "term_new", label: "New shell" });
  mocks.listSessions.mockReset().mockResolvedValue([{ id: "term_1", label: "Shell" }]);
  mocks.fits.length = 0;
  mocks.sockets.length = 0;
  mocks.terminals.length = 0;
  vi.stubGlobal("WebSocket", BrowserFakeSocket);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  document.body.replaceChildren();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("terminal display preferences", () => {
  test("constructs xterm from settings and updates confirmed options live", async () => {
    const settings = { ...mocks.display, fontSize: 14, cursorStyle: "bar" as const, scrollback: 9_000 };
    const mounted = await mount(
      <TerminalViewport active displaySettings={settings} sessionId="term_settings" />,
    );
    const terminal = mocks.terminals[0];
    const fit = mocks.fits[0];
    expect(terminal.constructorOptions).toMatchObject({
      fontSize: 14,
      cursorStyle: "bar",
      scrollback: 9_000,
      theme: expect.objectContaining({
        background: "#fcfcfc",
        foreground: "#24211f",
      }),
    });

    fit.fit.mockClear();
    const updated = { ...settings, fontSize: 16, cursorStyle: "underline" as const, scrollback: 12_000 };
    await act(async () => {
      mounted.root.render(
        <TerminalViewport active displaySettings={updated} sessionId="term_settings" />,
      );
    });
    expect(terminal.options).toMatchObject({
      fontSize: 16,
      cursorStyle: "underline",
      scrollback: 12_000,
    });
    expect(fit.fit).toHaveBeenCalled();

    mocks.resolvedTheme = "dark";
    await act(async () => {
      mounted.root.render(
        <TerminalViewport active displaySettings={updated} sessionId="term_settings" />,
      );
    });
    expect(terminal.options.theme).toEqual(
      expect.objectContaining({
        background: "#090909",
        foreground: "#f2f2f2",
      }),
    );
    expect(mocks.terminals).toHaveLength(1);
    await act(async () => mounted.root.unmount());
  });

  test("copies a non-empty selection only while copy-on-select is enabled", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const mounted = await mount(
      <TerminalViewport active displaySettings={mocks.display} sessionId="term_copy" />,
    );
    const terminal = mocks.terminals[0];
    terminal.selectionListener?.();
    expect(writeText).not.toHaveBeenCalled();

    await act(async () => {
      mounted.root.render(
        <TerminalViewport
          active
          displaySettings={{ ...mocks.display, copyOnSelect: true }}
          sessionId="term_copy"
        />,
      );
    });
    terminal.selectionListener?.();
    expect(writeText).toHaveBeenCalledWith("selected output");
    await act(async () => mounted.root.unmount());
    expect(terminal.selectionDispose).toHaveBeenCalledOnce();
  });
});

describe("terminal termination safety", () => {
  test("confirms restart and sends stop directly when confirmation is disabled", async () => {
    const mounted = await mount(<TerminalPane active sessionId="term_actions" />);
    mocks.sockets[0].send.mockClear();
    await act(async () => mounted.host.querySelector<HTMLButtonElement>('[aria-label="Restart terminal"]')?.click());
    expect(mocks.sockets[0].send).not.toHaveBeenCalled();
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Restart terminal");
    expect(dialog?.textContent).toContain("running shell process will be terminated");
    await act(async () => dialog?.querySelectorAll<HTMLButtonElement>("button")[1]?.click());
    expect(mocks.sockets[0].send).toHaveBeenCalledWith(
      JSON.stringify({ cols: 80, rows: 24, type: "restart" }),
    );

    mocks.confirmTerminate = false;
    await act(async () => mounted.root.render(<TerminalPane active sessionId="term_actions" />));
    mocks.sockets[0].send.mockClear();
    await act(async () => mounted.host.querySelector<HTMLButtonElement>('[aria-label="Stop terminal"]')?.click());
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.sockets[0].send).toHaveBeenCalledWith(
      JSON.stringify({ cols: 80, rows: 24, type: "stop" }),
    );
    await act(async () => mounted.root.unmount());
  });

  test("confirms tab close before terminating its server session", async () => {
    const mounted = await mount(<TerminalView />);
    await act(async () => Promise.resolve());
    const close = mounted.host.querySelector<HTMLButtonElement>('[aria-label="Close Shell"]');
    expect(close).not.toBeNull();
    await act(async () => close?.click());
    expect(mocks.closeSession).not.toHaveBeenCalled();
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Close Shell");
    expect(dialog?.textContent).toContain("running shell process will be terminated");
    await act(async () => dialog?.querySelectorAll<HTMLButtonElement>("button")[1]?.click());
    expect(mocks.closeSession).toHaveBeenCalledWith("term_1");
    await act(async () => mounted.root.unmount());
  });
});
