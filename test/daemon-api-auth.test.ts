// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from "vitest";
import { openApiEventSource } from "../apps/dashboard/src/lib/api/api-event-source";
import { requestJson } from "../apps/dashboard/src/lib/api/client";
import {
  daemonWebSocketProtocols,
  daemonWebSocketUrl,
} from "../apps/dashboard/src/lib/api/daemon-auth";

afterEach(() => {
  delete window.__NOMOREIDE_WEB__;
  vi.unstubAllGlobals();
});

/** What the daemon's shell route injects into the page it serves. */
function servedByDaemon(): void {
  window.__NOMOREIDE_WEB__ = { credential: "daemon-secret" };
}

describe("daemon authentication", () => {
  test("resolves API requests against the page's origin and adds the bearer credential", async () => {
    servedByDaemon();
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
    expect(url).toBe(`${window.location.origin}/api/terminal/capabilities`);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer daemon-secret");
    expect(headers.get("x-nomoreide-terminal-control")).toBe("1");
  });

  test("leaves a request untouched when the page carries no credential", async () => {
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

  test("authenticates and decodes SSE without putting the secret in its URL", async () => {
    servedByDaemon();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
      },
    });
    // The content type is part of the fixture because it is part of the
    // contract: the client refuses a 200 that is not a stream, and all three
    // daemon stream routes send `text/event-stream`.
    const fetch = vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
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
    expect(url).toBe(`${window.location.origin}/api/terminal/events`);
    expect(url).not.toContain("daemon-secret");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer daemon-secret",
    );
  });

  /**
   * The regression this replaced. A browser used to get a native
   * `EventSource`, which cannot set an `Authorization` header — so every
   * stream answered 401 and the terminal, the error inbox and the agent feed
   * silently never updated. The credential is injected into the document as
   * `__NOMOREIDE_WEB__`, and the stream has to use it.
   */
  test("a browser stream carries the injected credential, not a bare EventSource", async () => {
    window.__NOMOREIDE_WEB__ = { credential: "browser-secret" };
    const body = new ReadableStream<Uint8Array>({ start: () => {} });
    const fetch = vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    vi.stubGlobal("fetch", fetch);

    const source = openApiEventSource("/api/errors/stream");
    await new Promise<void>((resolve) => source.addEventListener("open", () => resolve()));
    source.close();

    const [url, init] = fetch.mock.calls[0];
    // Resolved against the page's own origin — in a browser the daemon *is*
    // where the document came from.
    expect(url).toBe(`${window.location.origin}/api/errors/stream`);
    // Never in the URL: a query credential lands in access logs and referrers.
    expect(String(url)).not.toContain("browser-secret");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer browser-secret");
  });

  test("uses a header-capable WebSocket subprotocol instead of a query credential", () => {
    servedByDaemon();
    const url = daemonWebSocketUrl(
      "/api/terminal/socket?id=term_1",
      "ws://fallback.invalid/api/terminal/socket?id=term_1",
    );

    expect(url).toBe(
      `${window.location.origin.replace(/^http/, "ws")}/api/terminal/socket?id=term_1`,
    );
    expect(url).not.toContain("daemon-secret");
    expect(daemonWebSocketProtocols()).toEqual([
      "nomoreide",
      "nomoreide-bearer.daemon-secret",
    ]);
  });
});
