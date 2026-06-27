import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Minimal shape this store needs from a usage reading. The web layer's
 * `UsageInfo` is structurally assignable to it, so core never imports the web
 * layer (no dependency cycle).
 */
export interface UsageSnapshotInput {
  claude?: {
    sessionId?: string;
    costUSD: number;
    inputTokens: number;
    outputTokens: number;
    models?: Array<{ model: string }>;
  };
  codex?: {
    timestamp?: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export type UsageSource = "claude" | "codex";

export interface UsageHistoryEntry {
  at: string;
  source: UsageSource;
  /** Claude: the agent session id. Codex: the reading's source timestamp. */
  sessionId?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Real per-session cost for Claude; 0 for Codex (no honest price available). */
  costUSD: number;
  models?: string[];
}

export interface UsageDayBucket {
  date: string;
  costUSD: number;
  runs: number;
  totalTokens: number;
}

export interface UsageHistorySummary {
  /** Distinct Claude sessions recorded — i.e. agent runs. */
  runs: number;
  totalCostUSD: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  firstAt?: string;
  lastAt?: string;
  byDay: UsageDayBucket[];
  /** Latest cumulative Codex token total (Codex reports lifetime totals, not per-run). */
  codexTotalTokens: number;
}

/**
 * Append-only token/cost history at `.nomoreide/usage-history.jsonl`. A sampler
 * calls {@link record} with the latest usage reading; a row is appended only
 * when a source's totals actually change, so an idle agent doesn't grow the file
 * each tick. Claude's `costUSD` is a real per-session figure (it resets and the
 * session id changes on a new run), so the summary groups by session to answer
 * "this work cost ~$X over N runs".
 */
export class UsageHistory {
  private readonly filePath: string;
  private seeded = false;
  private readonly lastKey: Partial<Record<UsageSource, string>> = {};

  constructor(options: { filePath: string }) {
    this.filePath = options.filePath;
  }

  /** Append a row per source whose totals changed since the last recorded row. */
  async record(input: UsageSnapshotInput): Promise<UsageHistoryEntry[]> {
    if (!this.seeded) await this.seed();

    const at = new Date().toISOString();
    const candidates: UsageHistoryEntry[] = [];

    if (input.claude && hasClaudeData(input.claude)) {
      candidates.push({
        at,
        source: "claude",
        sessionId: input.claude.sessionId,
        inputTokens: input.claude.inputTokens,
        outputTokens: input.claude.outputTokens,
        totalTokens: input.claude.inputTokens + input.claude.outputTokens,
        costUSD: input.claude.costUSD,
        models: input.claude.models?.map((m) => m.model),
      });
    }
    if (input.codex && input.codex.totalTokens > 0) {
      candidates.push({
        at,
        source: "codex",
        sessionId: input.codex.timestamp,
        inputTokens: input.codex.inputTokens,
        outputTokens: input.codex.outputTokens,
        totalTokens: input.codex.totalTokens,
        costUSD: 0,
      });
    }

    const appended: UsageHistoryEntry[] = [];
    for (const entry of candidates) {
      const key = entryKey(entry);
      if (this.lastKey[entry.source] === key) continue;
      this.lastKey[entry.source] = key;
      appended.push(entry);
    }
    if (appended.length > 0) {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${appended.map((e) => JSON.stringify(e)).join("\n")}\n`);
    }
    return appended;
  }

  async list(options: { since?: string } = {}): Promise<UsageHistoryEntry[]> {
    const entries = await this.loadEntries();
    const since = options.since;
    return since ? entries.filter((entry) => entry.at >= since) : entries;
  }

  async summary(options: { since?: string } = {}): Promise<UsageHistorySummary> {
    const entries = await this.list(options);
    const codex = entries.filter((e) => e.source === "codex");

    // Each Claude session contributes its final (max-cost) snapshot once.
    const bySession = new Map<string, UsageHistoryEntry>();
    for (const entry of entries) {
      if (entry.source !== "claude") continue;
      const key = entry.sessionId ?? entry.at;
      const prev = bySession.get(key);
      if (!prev || entry.costUSD >= prev.costUSD) bySession.set(key, entry);
    }
    const sessions = [...bySession.values()];

    let totalCostUSD = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTokens = 0;
    const dayMap = new Map<string, UsageDayBucket>();
    for (const session of sessions) {
      totalCostUSD += session.costUSD;
      totalInputTokens += session.inputTokens;
      totalOutputTokens += session.outputTokens;
      totalTokens += session.totalTokens;
      const date = session.at.slice(0, 10);
      const bucket = dayMap.get(date) ?? { date, costUSD: 0, runs: 0, totalTokens: 0 };
      bucket.costUSD += session.costUSD;
      bucket.runs += 1;
      bucket.totalTokens += session.totalTokens;
      dayMap.set(date, bucket);
    }

    const ats = entries.map((e) => e.at).sort();
    return {
      runs: sessions.length,
      totalCostUSD,
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      firstAt: ats[0],
      lastAt: ats[ats.length - 1],
      byDay: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
      codexTotalTokens: codex.length > 0 ? Math.max(...codex.map((e) => e.totalTokens)) : 0,
    };
  }

  /** Prime dedup keys from the last recorded row per source so a restart doesn't re-append. */
  private async seed(): Promise<void> {
    this.seeded = true;
    for (const entry of await this.loadEntries()) {
      this.lastKey[entry.source] = entryKey(entry);
    }
  }

  private async loadEntries(): Promise<UsageHistoryEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return [];
    }
    const entries: UsageHistoryEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as UsageHistoryEntry);
      } catch {
        // skip a corrupt line
      }
    }
    return entries;
  }
}

function hasClaudeData(claude: NonNullable<UsageSnapshotInput["claude"]>): boolean {
  return claude.costUSD > 0 || claude.inputTokens > 0 || claude.outputTokens > 0;
}

function entryKey(entry: UsageHistoryEntry): string {
  if (entry.source === "codex") {
    return `codex:${entry.sessionId ?? ""}:${entry.totalTokens}`;
  }
  return `claude:${entry.sessionId ?? ""}:${entry.costUSD}:${entry.inputTokens}:${entry.outputTokens}`;
}
