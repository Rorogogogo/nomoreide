import { afterEach, describe, expect, test, vi } from "vitest";
import {
  formatRuntimeDiagnostics,
  getRuntimeConnectionSnapshot,
  probeRuntimeHealth,
  recordRuntimeApiFailure,
  recordRuntimeReachable,
  resetRuntimeConnectionForTests,
  sanitizeRuntimeEndpoint,
} from "../src/web/client/src/lib/runtime-connection";

function healthResponse(
  body: unknown = { ok: true, app: "nomoreide", version: "1.2.3", pid: 42 },
  status = 200,
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  resetRuntimeConnectionForTests();
  vi.restoreAllMocks();
});

describe("runtime connection state", () => {
  test("stays quiet for one health failure and promotes the second", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    await probeRuntimeHealth({ fetch: fetcher as typeof fetch, now: () => 100 });
    expect(getRuntimeConnectionSnapshot()).toMatchObject({
      phase: "reconnecting",
      consecutiveFailures: 1,
    });

    await probeRuntimeHealth({ fetch: fetcher as typeof fetch, now: () => 200 });
    expect(getRuntimeConnectionSnapshot()).toMatchObject({
      phase: "unreachable",
      consecutiveFailures: 2,
      lastFailedEndpoint: "GET /api/health",
      lastError: "Failed to fetch",
      lastFailureAt: 200,
    });
  });

  test("records daemon identity and recovery after an unreachable period", async () => {
    const down = vi.fn(async () => {
      throw new Error("connection refused");
    });
    await probeRuntimeHealth({ fetch: down as typeof fetch, now: () => 100 });
    await probeRuntimeHealth({ fetch: down as typeof fetch, now: () => 200 });

    await expect(
      probeRuntimeHealth({
        fetch: vi.fn(async () => healthResponse()) as typeof fetch,
        now: () => 300,
      }),
    ).resolves.toBe(true);

    expect(getRuntimeConnectionSnapshot()).toMatchObject({
      phase: "connected",
      consecutiveFailures: 0,
      daemonPid: 42,
      daemonVersion: "1.2.3",
      lastReachableAt: 300,
      lastRecoveryAttempts: 2,
      recoveredAt: 300,
    });
  });

  test("accepts a successful dashboard response as recovery evidence", async () => {
    const down = vi.fn(async () => {
      throw new Error("connection refused");
    });
    await probeRuntimeHealth({ fetch: down as typeof fetch, now: () => 100 });
    await probeRuntimeHealth({ fetch: down as typeof fetch, now: () => 200 });

    recordRuntimeReachable(300);

    expect(getRuntimeConnectionSnapshot()).toMatchObject({
      phase: "connected",
      consecutiveFailures: 0,
      lastReachableAt: 300,
      lastRecoveryAttempts: 2,
      recoveredAt: 300,
    });
  });

  test("treats a failed health response as unavailable", async () => {
    await expect(
      probeRuntimeHealth({
        fetch: vi.fn(async () => healthResponse({}, 502)) as typeof fetch,
        now: () => 100,
      }),
    ).resolves.toBe(false);

    expect(getRuntimeConnectionSnapshot()).toMatchObject({
      phase: "reconnecting",
      lastError: "GET /api/health failed (502).",
    });
  });

  test("stores only sanitized API failure context", () => {
    recordRuntimeApiFailure(
      "/api/git/diff?path=%2FUsers%2Fprivate&token=secret#fragment",
      new Error(" request failed\nwith details "),
      "post",
      500,
    );

    expect(getRuntimeConnectionSnapshot()).toMatchObject({
      lastFailedEndpoint: "POST /api/git/diff",
      lastError: "request failed with details",
      lastFailureAt: 500,
    });
    expect(sanitizeRuntimeEndpoint("https://example.com/other?token=x")).toBeNull();

    const copied = formatRuntimeDiagnostics(getRuntimeConnectionSnapshot(), {
      apiTarget: "http://127.0.0.1:4317",
      browserOnline: true,
      frontendVersion: "0.1.99",
    });
    expect(copied).toContain("POST /api/git/diff");
    expect(copied).not.toContain("private");
    expect(copied).not.toContain("secret");
  });
});
