import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { UsageHistory } from "../src/core/usage-history.js";

let tempDir: string;
let history: UsageHistory;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-usage-history-"));
  history = new UsageHistory({ filePath: join(tempDir, "usage-history.jsonl") });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("UsageHistory", () => {
  test("records a claude run and de-dupes identical snapshots", async () => {
    const reading = {
      claude: { sessionId: "s1", costUSD: 0.25, inputTokens: 1000, outputTokens: 200 },
    };
    expect(await history.record(reading)).toHaveLength(1);
    // Same totals → nothing appended.
    expect(await history.record(reading)).toHaveLength(0);
    const entries = await history.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe("claude");
    expect(entries[0].costUSD).toBe(0.25);
  });

  test("appends a new row when a session's cost grows", async () => {
    await history.record({ claude: { sessionId: "s1", costUSD: 0.1, inputTokens: 500, outputTokens: 50 } });
    await history.record({ claude: { sessionId: "s1", costUSD: 0.3, inputTokens: 1500, outputTokens: 150 } });
    const summary = await history.summary();
    // Still one run, but the final (max) snapshot wins for totals.
    expect(summary.runs).toBe(1);
    expect(summary.totalCostUSD).toBeCloseTo(0.3);
    expect(summary.totalTokens).toBe(1650);
  });

  test("sums cost across distinct sessions and buckets by day", async () => {
    await history.record({ claude: { sessionId: "s1", costUSD: 0.2, inputTokens: 1000, outputTokens: 100 } });
    await history.record({ claude: { sessionId: "s2", costUSD: 0.5, inputTokens: 2000, outputTokens: 300 } });
    const summary = await history.summary();
    expect(summary.runs).toBe(2);
    expect(summary.totalCostUSD).toBeCloseTo(0.7);
    expect(summary.byDay).toHaveLength(1);
    expect(summary.byDay[0].runs).toBe(2);
  });

  test("records codex as token-only and reports the latest cumulative total", async () => {
    await history.record({ codex: { timestamp: "2026-06-27T10:00:00Z", inputTokens: 800, outputTokens: 200, totalTokens: 1000 } });
    await history.record({ codex: { timestamp: "2026-06-27T10:05:00Z", inputTokens: 1600, outputTokens: 400, totalTokens: 2000 } });
    const summary = await history.summary();
    expect(summary.runs).toBe(0); // codex carries no per-run cost
    expect(summary.totalCostUSD).toBe(0);
    expect(summary.codexTotalTokens).toBe(2000);
  });

  test("a fresh instance seeds dedup keys from the file (survives restart)", async () => {
    const reading = { claude: { sessionId: "s1", costUSD: 0.25, inputTokens: 1000, outputTokens: 200 } };
    await history.record(reading);
    const reopened = new UsageHistory({ filePath: join(tempDir, "usage-history.jsonl") });
    expect(await reopened.record(reading)).toHaveLength(0);
    expect(await reopened.list()).toHaveLength(1);
  });
});
