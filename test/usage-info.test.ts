import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildUsageInfo } from "../src/web/usage-info.js";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CODEX_HOME = process.env.CODEX_HOME;

let tempDir: string | undefined;

afterEach(async () => {
  restoreEnv("HOME", ORIGINAL_HOME);
  restoreEnv("CODEX_HOME", ORIGINAL_CODEX_HOME);
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("usage info", () => {
  test("reads Codex token usage and rate limits from session events", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nomoreide-usage-info-"));
    const home = join(tempDir, "home");
    const codexHome = join(home, ".codex");
    const sessionDir = join(codexHome, "sessions", "2026", "05", "27");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "rollout.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-05-27T12:00:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 1000,
                cached_input_tokens: 800,
                output_tokens: 90,
                reasoning_output_tokens: 20,
                total_tokens: 1090,
              },
              last_token_usage: {
                input_tokens: 120,
                cached_input_tokens: 100,
                output_tokens: 12,
                reasoning_output_tokens: 3,
                total_tokens: 132,
              },
              model_context_window: 258400,
            },
            rate_limits: {
              primary: { used_percent: 35, window_minutes: 300, resets_at: 1779902529 },
              secondary: { used_percent: 61, window_minutes: 10080, resets_at: 1780178417 },
            },
          },
        }),
      ].join("\n"),
    );

    process.env.HOME = home;
    process.env.CODEX_HOME = codexHome;

    const usage = await buildUsageInfo(tempDir);

    expect(usage.codex).toMatchObject({
      timestamp: "2026-05-27T12:00:00.000Z",
      inputTokens: 1000,
      cachedInputTokens: 800,
      outputTokens: 90,
      reasoningOutputTokens: 20,
      totalTokens: 1090,
      lastInputTokens: 120,
      lastCachedInputTokens: 100,
      lastOutputTokens: 12,
      lastReasoningOutputTokens: 3,
      lastTotalTokens: 132,
      contextWindow: 258400,
      primary: { usedPercent: 35, windowMinutes: 300, resetsAtUnix: 1779902529 },
      secondary: { usedPercent: 61, windowMinutes: 10080, resetsAtUnix: 1780178417 },
    });
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
