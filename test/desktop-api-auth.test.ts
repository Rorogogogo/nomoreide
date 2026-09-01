// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from "vitest";
import { openApiEventSource } from "../apps/dashboard/src/lib/api/api-event-source";
import { requestJson } from "../apps/dashboard/src/lib/api/client";
import {
  daemonWebSocketProtocols,
  daemonWebSocketUrl,
} from "../apps/dashboard/src/lib/api/desktop-runtime";

afterEach(() => {
  delete window.__NOMOREIDE_DESKTOP__;
  vi.unstubAllGlobals();
});

function desktopRuntime(): void {
  window.__NOMOREIDE_DESKTOP__ = {
    apiBaseUrl: "http://127.0.0.1:54321",
    credential: "desktop-secret",
  };
}

describe("desktop daemon authentication", () => {
  test("rewrites API requests and adds the in-memory bearer credential", async () => {
    desktopRuntime();
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await requestJson("/api/terminal/capabilities", {
      headers: { "x-nomoreide-terminal-control": "1" },
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:54321/api/terminal/capabilities");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer desktop-secret");
    expect(headers.get("x-nomoreide-terminal-control")).toBe("1");
  });

  test("leaves the browser's same-origin request path unchanged", async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await requestJson("/api/health");

    expect(fetch).toHaveBeenCalledWith("/api/health", undefined);
  });

  test("authenticates and decodes desktop SSE without putting the secret in its URL", async () => {
    desktopRuntime();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
      },
    });
    const fetch = vi.fn(async () => new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    const source = openApiEventSource("/api/terminal/events");
    const opened = new Promise<void>((resolve) => source.addEventListener("open", () => resolve()));
    const received = new Promise<string>((resolve) => {
      source.addEventListener("session", (event) => resolve((event as MessageEvent).data));
    });
    await opened;
    stream.enqueue(
      new TextEncoder().encode('event: session\ndata: {"id":"term_1"}\n\n'),
    );

    await expect(received).resolves.toBe('{"id":"term_1"}');
    stream.close();
    source.close();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:54321/api/terminal/events");
    expect(url).not.toContain("desktop-secret");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer desktop-secret",
    );
  });

  test("uses a header-capable WebSocket subprotocol instead of a query credential", () => {
    desktopRuntime();
    const url = daemonWebSocketUrl(
      "/api/terminal/socket?id=term_1",
      "ws://tauri.localhost/api/terminal/socket?id=term_1",
    );

    expect(url).toBe("ws://127.0.0.1:54321/api/terminal/socket?id=term_1");
    expect(url).not.toContain("desktop-secret");
    expect(daemonWebSocketProtocols()).toEqual([
      "nomoreide",
      "nomoreide-bearer.desktop-secret",
    ]);
  });
});
