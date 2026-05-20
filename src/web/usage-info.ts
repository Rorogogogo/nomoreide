import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
}

export interface ClaudeRateLimitWindow {
  usedPercent: number;
  resetsAtUnix: number;
}

export interface ClaudeUsage {
  cwd: string;
  sessionId?: string;
  costUSD: number;
  durationMs: number;
  apiDurationMs: number;
  linesAdded: number;
  linesRemoved: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  webSearchRequests: number;
  models: ClaudeModelUsage[];
  fiveHour?: ClaudeRateLimitWindow;
  weekly?: ClaudeRateLimitWindow;
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  resetsAtUnix: number;
  windowMinutes?: number;
}

export interface CodexUsage {
  timestamp?: string;
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow;
}

export interface UsageInfo {
  claude?: ClaudeUsage;
  codex?: CodexUsage;
}

export async function buildUsageInfo(cwd: string): Promise<UsageInfo> {
  const home = homedir();
  const [claude, codex] = await Promise.all([
    readClaudeUsage(home, cwd),
    readCodexUsage(home),
  ]);
  const result: UsageInfo = {};
  if (claude) result.claude = claude;
  if (codex) result.codex = codex;
  return result;
}

async function readClaudeStateUsage(home: string): Promise<{
  fiveHour?: ClaudeRateLimitWindow;
  weekly?: ClaudeRateLimitWindow;
}> {
  try {
    const raw = await readFile(join(home, ".claude", "state", "usage"), "utf8");
    const parts = raw.trim().split("\t");
    const blockPct = toNumber(parts[0]);
    const blockReset = toNumber(parts[1]);
    const weeklyPct = toNumber(parts[2]);
    const weeklyReset = toNumber(parts[3]);
    const result: { fiveHour?: ClaudeRateLimitWindow; weekly?: ClaudeRateLimitWindow } = {};
    if (Number.isFinite(blockPct) && Number.isFinite(blockReset) && blockReset > 0) {
      result.fiveHour = { usedPercent: blockPct, resetsAtUnix: blockReset };
    }
    if (Number.isFinite(weeklyPct) && Number.isFinite(weeklyReset) && weeklyReset > 0) {
      result.weekly = { usedPercent: weeklyPct, resetsAtUnix: weeklyReset };
    }
    return result;
  } catch {
    return {};
  }
}

async function readClaudeUsage(home: string, cwd: string): Promise<ClaudeUsage | undefined> {
  try {
    const raw = await readFile(join(home, ".claude.json"), "utf8");
    const json = JSON.parse(raw) as {
      projects?: Record<string, Record<string, unknown>>;
    };
    const project = json.projects?.[cwd];
    const stateUsage = await readClaudeStateUsage(home);
    if (!project) {
      if (!stateUsage.fiveHour && !stateUsage.weekly) return undefined;
      return {
        cwd,
        costUSD: 0,
        durationMs: 0,
        apiDurationMs: 0,
        linesAdded: 0,
        linesRemoved: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        webSearchRequests: 0,
        models: [],
        fiveHour: stateUsage.fiveHour,
        weekly: stateUsage.weekly,
      };
    }

    const num = (key: string) => toNumber(project[key]);
    const models: ClaudeModelUsage[] = [];
    const modelUsage = project.lastModelUsage as Record<string, Record<string, unknown>> | undefined;
    if (modelUsage && typeof modelUsage === "object") {
      for (const [model, entry] of Object.entries(modelUsage)) {
        models.push({
          model,
          inputTokens: toNumber(entry.inputTokens),
          outputTokens: toNumber(entry.outputTokens),
          cacheReadInputTokens: toNumber(entry.cacheReadInputTokens),
          cacheCreationInputTokens: toNumber(entry.cacheCreationInputTokens),
          webSearchRequests: toNumber(entry.webSearchRequests),
          costUSD: toNumber(entry.costUSD),
        });
      }
      models.sort((a, b) => b.costUSD - a.costUSD);
    }

    return {
      cwd,
      sessionId: typeof project.lastSessionId === "string" ? project.lastSessionId : undefined,
      costUSD: num("lastCost"),
      durationMs: num("lastDuration"),
      apiDurationMs: num("lastAPIDuration"),
      linesAdded: num("lastLinesAdded"),
      linesRemoved: num("lastLinesRemoved"),
      inputTokens: num("lastTotalInputTokens"),
      outputTokens: num("lastTotalOutputTokens"),
      cacheCreationInputTokens: num("lastTotalCacheCreationInputTokens"),
      cacheReadInputTokens: num("lastTotalCacheReadInputTokens"),
      webSearchRequests: num("lastTotalWebSearchRequests"),
      models,
      fiveHour: stateUsage.fiveHour,
      weekly: stateUsage.weekly,
    };
  } catch {
    return undefined;
  }
}

async function readCodexUsage(home: string): Promise<CodexUsage | undefined> {
  const sessionsDir = join(home, ".codex", "sessions");
  let files: { mtime: number; path: string }[] = [];
  try {
    files = await collectJsonlFiles(sessionsDir);
  } catch {
    return undefined;
  }
  if (!files.length) return undefined;

  files.sort((a, b) => b.mtime - a.mtime);

  let best: { timestamp: string; usage: CodexUsage } | undefined;

  for (const { path } of files.slice(0, 20)) {
    const lines = await tailLines(path, 2_000_000);
    for (const line of lines) {
      if (!line.includes("rate_limits")) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const payload = (event.payload as Record<string, unknown> | undefined) ?? {};
      if (payload.type !== "token_count") continue;
      const rateLimits =
        (event.rate_limits as Record<string, unknown> | undefined) ??
        (payload.rate_limits as Record<string, unknown> | undefined);
      if (!rateLimits) continue;
      const primary = readWindow(rateLimits.primary);
      const secondary = readWindow(rateLimits.secondary);
      if (!primary && !secondary) continue;
      const timestamp = typeof event.timestamp === "string" ? event.timestamp : "";
      if (!best || timestamp > best.timestamp) {
        best = {
          timestamp,
          usage: { timestamp: timestamp || undefined, primary, secondary },
        };
      }
    }
    if (best) break;
  }

  return best?.usage;
}

async function collectJsonlFiles(dir: string): Promise<{ mtime: number; path: string }[]> {
  const out: { mtime: number; path: string }[] = [];
  await walkLimited(dir, out, 0);
  return out;
}

async function walkLimited(
  dir: string,
  out: { mtime: number; path: string }[],
  depth: number,
): Promise<void> {
  if (depth > 4) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkLimited(full, out, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const s = await stat(full);
          out.push({ mtime: s.mtimeMs, path: full });
        } catch {
          // ignore
        }
      }
    }),
  );
}

async function tailLines(path: string, maxBytes: number): Promise<string[]> {
  try {
    const handle = await (await import("node:fs/promises")).open(path, "r");
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - maxBytes);
      const length = Number(size) - start;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      return buffer.toString("utf8").split("\n");
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

function readWindow(value: unknown): CodexRateLimitWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  const usedPercent = toNumber(entry.used_percent);
  const resetsAtUnix = toNumber(entry.resets_at);
  if (!Number.isFinite(usedPercent) || !Number.isFinite(resetsAtUnix)) return undefined;
  const result: CodexRateLimitWindow = { usedPercent, resetsAtUnix };
  const windowMinutes = toNumber(entry.window_minutes);
  if (Number.isFinite(windowMinutes) && windowMinutes > 0) {
    result.windowMinutes = windowMinutes;
  }
  return result;
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}
