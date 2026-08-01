// @vitest-environment happy-dom

import { describe, expect, test, vi } from "vitest";
import { installWebsiteMockApi } from "../website/src/mock-api";

describe("website Activity Monitor mock", () => {
  test("returns machine history and managed-service usage", async () => {
    window.fetch = vi.fn(async () => new Response(null, { status: 404 }));
    installWebsiteMockApi();

    const response = await window.fetch("/api/metrics");
    const body = await response.json();

    expect(body).toMatchObject({
      ok: true,
      metrics: {
        sampleIntervalMs: 3000,
        host: {
          current: {
            cpuPercent: expect.any(Number),
            memoryUsedPercent: expect.any(Number),
            disk: { usedPercent: expect.any(Number) },
          },
          samples: expect.any(Array),
        },
        services: {
          "web-client": {
            cpuPercent: expect.any(Number),
            rssMb: expect.any(Number),
            processCount: 3,
          },
          api: {
            cpuPercent: expect.any(Number),
          },
        },
        systemProcesses: expect.arrayContaining([
          expect.objectContaining({ command: expect.stringContaining("Google Chrome") }),
        ]),
      },
    });
    expect(body.metrics.host.samples.length).toBeGreaterThan(10);
  });
});
