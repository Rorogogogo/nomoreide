// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  RuntimeDiagnostics,
  runtimeApiTarget,
  runtimeDiagnosticsMockEnabled,
  runtimeRestartCommand,
} from "../src/web/client/src/components/runtime-diagnostics";
import {
  probeRuntimeHealth,
  resetRuntimeConnectionForTests,
} from "../src/web/client/src/lib/runtime-connection";

let host: HTMLDivElement;
let root: Root;

async function markBackendUnreachable() {
  const down = vi.fn(async () => {
    throw new TypeError("Failed to fetch");
  });
  await probeRuntimeHealth({ fetch: down as typeof fetch });
  await probeRuntimeHealth({ fetch: down as typeof fetch });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.replaceChildren();
  resetRuntimeConnectionForTests();
  delete window.__TAURI_INTERNALS__;
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("RuntimeDiagnostics", () => {
  test("stays hidden while the browser backend is healthy", async () => {
    await act(async () => {
      root.render(
        <RuntimeDiagnostics autoProbe={false} onReconnect={vi.fn()} />,
      );
    });

    expect(host.textContent).toBe("");
  });

  test("shows a safe development preview from the URL switch", async () => {
    window.history.replaceState(null, "", "/?mockBackendDown=1");
    await act(async () => {
      root.render(
        <RuntimeDiagnostics autoProbe={false} onReconnect={vi.fn()} />,
      );
    });

    const trigger = host.querySelector<HTMLButtonElement>(
      '[aria-haspopup="dialog"]',
    );
    expect(trigger?.textContent).toContain("Backend unreachable");
    expect(trigger?.className).toContain("text-red-700");
    await act(async () => trigger?.click());

    const panel = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(panel?.textContent).toContain("Mock preview");
    expect(panel?.textContent).toContain("Failed to fetch (mock preview)");
    expect(
      [...(panel?.querySelectorAll("button") ?? [])].find((button) =>
        button.textContent?.includes("Mock preview"),
      )?.disabled,
    ).toBe(true);
  });

  test("keeps drawer context-menu events out of the workspace layer", async () => {
    await markBackendUnreachable();
    const workspaceContextMenu = vi.fn();
    await act(async () => {
      root.render(
        <div onContextMenu={workspaceContextMenu}>
          <RuntimeDiagnostics autoProbe={false} onReconnect={vi.fn()} />
        </div>,
      );
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')?.click();
    });

    const panel = document.body.querySelector<HTMLElement>('[role="dialog"]');
    await act(async () => {
      panel?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
    });

    expect(workspaceContextMenu).not.toHaveBeenCalled();
    expect(
      [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
        (item) => item.textContent,
      ),
    ).toEqual(["Retry connection", "Copy diagnostics"]);

    await act(async () => {
      panel?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      panel?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      panel?.click();
    });
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBe(panel);

    await act(async () => {
      document.body.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  test("opens developer diagnostics and exposes retry and copy actions", async () => {
    await markBackendUnreachable();
    const onReconnect = vi.fn();
    const healthProbe = vi.fn(async () => true);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await act(async () => {
      root.render(
        <RuntimeDiagnostics
          autoProbe={false}
          healthProbe={healthProbe}
          onReconnect={onReconnect}
        />,
      );
    });

    const trigger = host.querySelector<HTMLButtonElement>(
      '[aria-haspopup="dialog"]',
    );
    expect(trigger?.textContent).toContain("Backend unreachable");
    await act(async () => trigger?.click());

    const panel = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(panel?.textContent).toContain("Runtime diagnostics");
    expect(panel?.textContent).toContain("GET /api/health");
    expect(panel?.textContent).toContain("Failed to fetch");
    expect(panel?.textContent).toContain("node dist/index.js daemon restart");
    expect(panel?.textContent).toContain(
      "Restarting the daemon stops every service it manages",
    );

    const installedCopy = panel?.querySelector<HTMLButtonElement>(
      '[aria-label="Copy Installed NoMoreIDE restart command"]',
    );
    await act(async () => installedCopy?.click());
    expect(writeText).toHaveBeenCalledWith("nomoreide daemon restart");

    const copyDiagnostics = [...(panel?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.includes("Copy diagnostics"),
    );
    await act(async () => copyDiagnostics?.click());
    expect(writeText.mock.calls.at(-1)?.[0]).toContain(
      "NoMoreIDE runtime diagnostics",
    );

    const retry = [...(panel?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.includes("Retry connection"),
    );
    await act(async () => retry?.click());
    expect(healthProbe).toHaveBeenCalledOnce();
    expect(onReconnect).toHaveBeenCalledOnce();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  test("keeps an open panel useful after recovery", async () => {
    vi.useFakeTimers();
    await markBackendUnreachable();
    await act(async () => {
      root.render(
        <RuntimeDiagnostics autoProbe={false} onReconnect={vi.fn()} />,
      );
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')?.click();
    });

    await act(async () => {
      await probeRuntimeHealth({
        fetch: vi.fn(async () => ({
          ok: true,
          json: async () => ({
            ok: true,
            app: "nomoreide",
            version: "1.2.3",
            pid: 42,
          }),
        })) as typeof fetch,
      });
    });

    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(
      "reopen those terminal tabs or reload the dashboard",
    );
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(
      "Backend restored",
    );
    vi.useRealTimers();
  });

  test("uses the development API port and preserves custom daemon ports", () => {
    expect(runtimeDiagnosticsMockEnabled("?mockBackendDown=1", true)).toBe(true);
    expect(runtimeDiagnosticsMockEnabled("?mockBackendDown=1", false)).toBe(false);
    expect(
      runtimeApiTarget({ origin: "http://127.0.0.1:5173" }, true),
    ).toBe("http://127.0.0.1:4317");
    expect(runtimeRestartCommand("http://127.0.0.1:4320")).toBe(
      "nomoreide daemon restart --port=4320",
    );
    expect(runtimeRestartCommand("http://127.0.0.1:4320", true)).toBe(
      "node dist/index.js daemon restart --port=4320",
    );
  });

  test("does not advertise the Node daemon inside Tauri", () => {
    window.__TAURI_INTERNALS__ = {};
    const markup = renderToStaticMarkup(
      <RuntimeDiagnostics autoProbe={false} onReconnect={vi.fn()} />,
    );

    expect(markup).toBe("");
  });
});
