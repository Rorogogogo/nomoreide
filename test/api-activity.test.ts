import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  beginApiRequest,
  isApiBusy,
  subscribeToApiActivity,
} from "../src/web/client/src/lib/api-activity";
import { requestJson } from "../src/web/client/src/lib/api/client";

const buttonSource = readFileSync(
  "src/web/client/src/components/header-refresh-button.tsx",
  "utf8",
);

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Server Error",
    json: async () => body,
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  // Every test must leave the counter at rest, or a leak here would silently
  // pin the header spinner for the rest of the suite.
  expect(isApiBusy()).toBe(false);
});

describe("API activity tracking", () => {
  test("tracks overlapping requests and only clears when the last settles", () => {
    expect(isApiBusy()).toBe(false);
    const first = beginApiRequest();
    const second = beginApiRequest();
    expect(isApiBusy()).toBe(true);
    first();
    // Still busy: a second call is in flight, and the icon reflects the page,
    // not whichever request happened to finish first.
    expect(isApiBusy()).toBe(true);
    second();
    expect(isApiBusy()).toBe(false);
  });

  test("a double release cannot drive the count negative", () => {
    const release = beginApiRequest();
    release();
    release();
    // A negative count would make the next real request read as "not busy".
    const next = beginApiRequest();
    expect(isApiBusy()).toBe(true);
    next();
    expect(isApiBusy()).toBe(false);
  });

  test("notifies subscribers on both edges and stops after unsubscribe", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeToApiActivity(() => seen.push(isApiBusy()));

    const release = beginApiRequest();
    release();
    expect(seen).toEqual([true, false]);

    unsubscribe();
    beginApiRequest()();
    expect(seen).toEqual([true, false]);
  });
});

describe("requestJson reports its own activity", () => {
  test("marks the app busy while a request is in flight", async () => {
    let busyDuringFetch = false;
    vi.stubGlobal("fetch", async () => {
      busyDuringFetch = isApiBusy();
      return jsonResponse({ ok: true });
    });

    await requestJson("/api/health");

    expect(busyDuringFetch).toBe(true);
    expect(isApiBusy()).toBe(false);
  });

  test("releases its slot when the request throws", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });

    await expect(requestJson("/api/health")).rejects.toThrow("network down");
    // Without the `finally`, one failed request would wedge the icon spinning
    // for the rest of the session.
    expect(isApiBusy()).toBe(false);
  });

  test("releases its slot on a non-ok response", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ error: "nope" }, false));

    await expect(requestJson("/api/health")).rejects.toThrow("nope");
    expect(isApiBusy()).toBe(false);
  });
});

describe("header refresh icon", () => {
  test("lets API activity fill in only for the idle phase", () => {
    // `error` must keep showing red and `done` must keep its confirmation tick;
    // a background fetch landing mid-cycle cannot overwrite either.
    expect(buttonSource).toContain('phase === "idle" && apiBusy ? "busy" : phase');
    expect(buttonSource).toContain("useApiBusy()");
    // The rendered branches read the resolved phase, not the raw prop.
    expect(buttonSource).not.toContain('phase === "done"');
    expect(buttonSource).not.toContain('phase === "busy"');
    expect(buttonSource).not.toContain('phase === "error"');
  });
});
