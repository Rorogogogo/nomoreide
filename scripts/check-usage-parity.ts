/**
 * Phase 6 parity gate for the token-usage endpoints:
 *
 *   GET /api/agent/usage
 *   GET /api/agent/usage/history
 *
 * Everything both endpoints report is read off disk — `~/.claude.json`,
 * `~/.claude/state/usage`, the Codex session rollouts, and the append-only
 * `~/.nomoreide/usage-history.jsonl` — so the gate owns those files outright
 * and rewrites them between cases. A `write` step is setup, not an assertion:
 * it is applied to both homes and logged, and it is deliberately *not* counted
 * as a case, so the case total stays a count of things actually compared.
 *
 * **The daemon writes this file too, and that is fought rather than tolerated.**
 * `createWebServer` runs an always-on usage sampler: five seconds after boot,
 * and every thirty after that, it takes the current reading and appends a row
 * per source whose totals changed. A row's `at` is wall-clock, so a single tick
 * landing inside the run would diverge the two runtimes for no reason at all.
 * The gate therefore seeds `usage-history.jsonl` and then chmods it to `0444`;
 * the sampler's `appendFile` fails with EACCES, the reference swallows it, and
 * the read path becomes a pure function of bytes this gate wrote. Every history
 * `write` step unfreezes, rewrites, and refreezes.
 *
 * The cost is that the sampler's *append* path is unobservable here — it is the
 * writer, and this gate only reaches readers. That is recorded rather than
 * faked: nothing below claims to gate it.
 *
 * **Codex usage is a ladder, because only one file is ever read.** `readCodexUsage`
 * walks the sessions tree, sorts by mtime descending, takes the newest twenty,
 * and stops at the *first* file that yields a reading — so the newest productive
 * file wins even when an older one holds a later `timestamp`. Every case below
 * therefore removes the current winner to expose the next, which is what makes
 * the depth limit assertable: `toodeep.jsonl` is given the newest mtime of all
 * and must never surface, at any rung.
 *
 * Usage:
 *   node --import tsx scripts/check-usage-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspect } from "node:util";
import {
  candidateSpec,
  referenceSpec,
  RuntimeHarness,
  type Runtime,
} from "../test/support/runtime-parity.js";

const argv = process.argv.slice(2).filter((a) => a !== "--dump");
const dump = process.argv.slice(2).includes("--dump");
if (argv.length === 0) {
  throw new Error(
    "Usage: node --import tsx scripts/check-usage-parity.ts [--dump] <candidate> [args...]",
  );
}

/** Fixed, so both runtimes' mtimes are identical rather than merely close. */
const EPOCH = 1_700_000_000;

const HISTORY = ".nomoreide/usage-history.jsonl";

function jsonl(...lines: unknown[]): string {
  return `${lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`;
}

// --- Codex session rollouts ---------------------------------------------------

/**
 * The rich file. Line 2 wins: it carries the latest `timestamp` among the lines
 * that parse to a reading, and it holds rate limits at *both* the event and the
 * payload level, so which one a port reads is visible in the answer rather than
 * a coin flip. Line 4 has the file's latest timestamp of all and must lose
 * anyway — its totals are zero and it has no rate limits, so there is nothing
 * to report and the line is skipped.
 */
const NEWEST = jsonl(
  {
    timestamp: "2026-08-25T10:00:00.000Z",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 40,
          output_tokens: 50,
          reasoning_output_tokens: 5,
          total_tokens: 195,
        },
        last_token_usage: {
          input_tokens: 10,
          cached_input_tokens: 4,
          output_tokens: 5,
          reasoning_output_tokens: 1,
          total_tokens: 20,
        },
        model_context_window: 200000,
      },
      rate_limits: {
        primary: { used_percent: 33.5, resets_at: 1893456000, window_minutes: 300 },
        secondary: { used_percent: 12, resets_at: 1894060800, window_minutes: 0 },
      },
    },
  },
  {
    timestamp: "2026-08-25T12:00:00.000Z",
    rate_limits: { primary: { used_percent: "40", resets_at: 1893456999 } },
    payload: {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 200, output_tokens: 60, total_tokens: 260 } },
      rate_limits: { primary: { used_percent: 1, resets_at: 1 } },
    },
  },
  "{ not json at all, but it does say token_count",
  {
    timestamp: "2026-08-25T23:00:00.000Z",
    payload: {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 0, total_tokens: 0 }, last_token_usage: {} },
    },
  },
  { timestamp: "2026-08-25T09:00:00.000Z", payload: { type: "other" } },
);

/** Four directories below `sessions/`, which is the deepest rung still walked. */
const DEEP = jsonl({
  timestamp: "2026-01-02T03:04:05.000Z",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
      model_context_window: -1,
    },
  },
});

/** One rung deeper, and given the newest mtime in the tree so its absence is a result. */
const TOODEEP = jsonl({
  timestamp: "2099-01-01T00:00:00.000Z",
  payload: {
    type: "token_count",
    info: { total_token_usage: { input_tokens: 777, output_tokens: 777, total_tokens: 777 } },
    rate_limits: { primary: { used_percent: 99, resets_at: 99 } },
  },
});

/** A later `timestamp` than every other file, and an older mtime — so it loses. */
const OLDER = jsonl({
  timestamp: "2030-06-06T06:06:06.000Z",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: { input_tokens: 1, cached_input_tokens: 2, output_tokens: 3, total_tokens: 6 },
      last_token_usage: { input_tokens: 4, total_tokens: 4 },
      model_context_window: "128000",
    },
    rate_limits: { secondary: { used_percent: 5, resets_at: 5, window_minutes: 10080 } },
  },
});

/**
 * A rollout larger than the two megabytes that get read.
 *
 * The first line holds the latest `timestamp` in the whole fixture and would
 * win outright if it were read — but it sits before the window, so it must not
 * be. The last line is the only reading inside the window, and it is the one
 * the answer has to carry. Nothing in the padding says `token_count`, so the
 * window holds exactly one candidate.
 */
function bigRollout(): string {
  const head = JSON.stringify({
    timestamp: "2099-01-01T00:00:00.000Z",
    payload: {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 111, total_tokens: 111 } },
    },
  });
  const padding = JSON.stringify({ payload: { type: "turn_context" }, pad: "p".repeat(980) });
  const tail = JSON.stringify({
    timestamp: "2020-01-01T00:00:00.000Z",
    payload: {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 222, output_tokens: 222, total_tokens: 444 } },
    },
  });
  return `${[head, ...Array.from({ length: 2_200 }, () => padding), tail].join("\n")}\n`;
}

/** No `token_count` anywhere, so it occupies a slot in the newest-twenty without filling it. */
const FILLER = jsonl({ timestamp: "2026-08-01T00:00:00.000Z", payload: { type: "turn_context" } });

// --- ~/.claude.json ----------------------------------------------------------

/**
 * The daemon keys `projects` by its own `process.cwd()`, which on macOS is the
 * *resolved* path — `/private/var/...`, not the `/var/...` symlink the harness
 * hands out. Keying by the unresolved path silently lands every case on the
 * no-project branch, so the realpath is resolved once per runtime and used.
 */
const realWorkspace = new Map<Runtime, string>();

function workspaceKey(runtime: Runtime): string {
  return realWorkspace.get(runtime) ?? runtime.workspace;
}

function claudeJson(project: Record<string, unknown> | null, workspace: string): string {
  const projects: Record<string, unknown> = { "/somewhere/else": { lastCost: 99 } };
  if (project) projects[workspace] = project;
  return `${JSON.stringify({ projects }, null, 2)}\n`;
}

const RICH_PROJECT = {
  lastCost: 1.25,
  lastDuration: 45000,
  lastAPIDuration: 30000,
  lastLinesAdded: 120,
  // A string that parses, so the coercion is visible rather than assumed.
  lastLinesRemoved: " 37 ",
  lastTotalInputTokens: 1000,
  lastTotalOutputTokens: 250,
  lastTotalCacheCreationInputTokens: 10,
  lastTotalCacheReadInputTokens: 20,
  lastTotalWebSearchRequests: 3,
  lastSessionId: "sess-alpha",
  lastModelUsage: {
    "claude-haiku-4-5": {
      inputTokens: 5,
      outputTokens: 6,
      cacheReadInputTokens: 7,
      cacheCreationInputTokens: 8,
      webSearchRequests: 1,
      costUSD: 0.5,
    },
    // Only two of six keys, so the rest have to default rather than vanish.
    "claude-opus-5": { inputTokens: 10, costUSD: 2.5 },
    // Equal costs, so the sort has to be stable and keep insertion order.
    "tied-a": { costUSD: 1 },
    "tied-b": { costUSD: 1 },
    // Unreadable values: null, a boolean, an object, and a string that is not a number.
    "junk-values": { inputTokens: null, outputTokens: true, costUSD: {}, webSearchRequests: "abc" },
  },
};

// --- ~/.nomoreide/usage-history.jsonl ----------------------------------------

/**
 * Two Claude sessions and two Codex readings, plus the three shapes a
 * hand-damaged file actually takes: a blank line, a line that is not JSON, and
 * a line that is valid JSON but not an object. Nothing validates a row on the
 * way in, so the last one reaches the summary as a bare number.
 */
const SEEDED_HISTORY = jsonl(
  { at: "2026-08-20T09:00:00.000Z", source: "claude", sessionId: "s1", inputTokens: 10, outputTokens: 5, totalTokens: 15, costUSD: 0.5, models: ["opus"] },
  // Same session, higher cost — this is the one the summary must keep.
  { at: "2026-08-20T17:30:00.000Z", source: "claude", sessionId: "s1", inputTokens: 40, outputTokens: 20, totalTokens: 60, costUSD: 2, models: ["opus", "haiku"] },
  // Same session again at the same cost: `>=` means the later row still wins.
  { at: "2026-08-20T18:00:00.000Z", source: "claude", sessionId: "s1", inputTokens: 41, outputTokens: 21, totalTokens: 62, costUSD: 2 },
  "",
  { at: "2026-08-21T11:00:00.000Z", source: "claude", sessionId: "s2", inputTokens: 7, outputTokens: 3, totalTokens: 10, costUSD: 0.25 },
  // No sessionId at all, so the summary keys this run by its `at`.
  { at: "2026-08-21T12:00:00.000Z", source: "claude", inputTokens: 1, outputTokens: 1, totalTokens: 2, costUSD: 0.1 },
  { at: "2026-08-21T13:00:00.000Z", source: "codex", sessionId: "2026-08-21T13:00:00.000Z", inputTokens: 5, outputTokens: 6, totalTokens: 900, costUSD: 0 },
  { at: "2026-08-22T13:00:00.000Z", source: "codex", sessionId: "2026-08-22T13:00:00.000Z", inputTokens: 5, outputTokens: 6, totalTokens: 400, costUSD: 0 },
  "   ",
  "{ not json",
  // An unknown source, and extra keys nothing reads — both must survive `list` verbatim.
  { at: "2026-08-23T08:00:00.000Z", source: "gemini", inputTokens: 3, outputTokens: 4, totalTokens: 7, costUSD: 9, extra: { kept: true } },
  17,
);

/** Rows missing the fields the summary adds up: the arithmetic goes to NaN. */
const DAMAGED_HISTORY = jsonl(
  { at: "2026-08-24T08:00:00.000Z", source: "claude", sessionId: "d1" },
  { at: "2026-08-24T09:00:00.000Z", source: "codex" },
);

// --- steps -------------------------------------------------------------------

interface RequestStep {
  readonly kind?: "request";
  readonly name: string;
  readonly method: string;
  readonly path: string;
}

/**
 * Setup, applied to both homes. Paths are relative to the runtime's home, and
 * contents may be a function of the runtime: `.claude.json` keys its `projects`
 * map by the daemon's working directory, which is per-runtime by construction.
 */
interface WriteStep {
  readonly kind: "write";
  readonly name: string;
  readonly files?: Record<string, string | null | ((runtime: Runtime) => string)>;
  readonly times?: Record<string, number>;
  readonly freeze?: readonly string[];
}

/** A file read out of both homes, for state no response exposes. */
interface FileStep {
  readonly kind: "file";
  readonly name: string;
  readonly path: string;
}

/**
 * Sit still long enough for the daemon's usage sampler to have fired. Its first
 * tick is five seconds after boot, so a pause past that turns "the frozen file
 * is untouched" from a race into a result.
 */
interface WaitStep {
  readonly kind: "wait";
  readonly name: string;
  readonly ms: number;
}

type Step = RequestStep | WriteStep | FileStep | WaitStep;

const USAGE = "/api/agent/usage";
const HISTORY_PATH = "/api/agent/usage/history";

const steps: Step[] = [
  // --- the seeded reading -----------------------------------------------------
  { name: "usage/rich-claude-and-codex", method: "GET", path: USAGE },
  { name: "history/everything-seeded", method: "GET", path: HISTORY_PATH },

  // --- the `since` filter -----------------------------------------------------
  { name: "history/since-is-inclusive-of-its-own-row", method: "GET", path: `${HISTORY_PATH}?since=2026-08-21T11:00:00.000Z` },
  { name: "history/since-between-rows", method: "GET", path: `${HISTORY_PATH}?since=2026-08-21T11:00:00.001Z` },
  { name: "history/since-is-a-string-compare-not-a-date", method: "GET", path: `${HISTORY_PATH}?since=2026-08-2` },
  { name: "history/since-after-every-row", method: "GET", path: `${HISTORY_PATH}?since=2099` },
  // Present but empty: not the same as absent, and every row sorts at or above "".
  { name: "history/since-is-blank", method: "GET", path: `${HISTORY_PATH}?since=` },
  { name: "history/since-repeated", method: "GET", path: `${HISTORY_PATH}?since=2099&since=2020` },
  { name: "history/since-needs-decoding", method: "GET", path: `${HISTORY_PATH}?since=2026-08-21T13%3A00%3A00.000Z` },
  { name: "history/an-unrelated-parameter", method: "GET", path: `${HISTORY_PATH}?limit=1` },

  // --- Codex: peel the ladder one rung at a time ------------------------------
  {
    kind: "write",
    name: "drop the newest rollout",
    files: { ".codex/sessions/2026/08/newest.jsonl": null },
  },
  { name: "usage/codex-falls-through-to-the-deepest-walked-file", method: "GET", path: USAGE },
  {
    kind: "write",
    name: "drop the deep rollout",
    files: { ".codex/sessions/a/b/c/d/deep.jsonl": null },
  },
  // `older.jsonl` holds the latest timestamp in the tree and only surfaces now,
  // which is the whole point: mtime picks the file, timestamp picks the line.
  { name: "usage/codex-mtime-outranks-timestamp", method: "GET", path: USAGE },
  {
    kind: "write",
    name: "drop the older rollout, leaving only the over-deep one",
    files: { ".codex/sessions/older.jsonl": null },
  },
  { name: "usage/codex-never-walks-past-four-levels", method: "GET", path: USAGE },

  // --- Codex: the newest-twenty cap -------------------------------------------
  {
    kind: "write",
    name: "twenty barren rollouts newer than one productive rollout",
    files: Object.fromEntries([
      ...Array.from({ length: 20 }, (_, i) => [`.codex/sessions/cap/filler-${i}.jsonl`, FILLER]),
      [".codex/sessions/cap/productive.jsonl", OLDER],
      // Not a rollout at all: the walk only collects `.jsonl`.
      [".codex/sessions/cap/productive.json", OLDER],
      [".codex/sessions/cap/productive.jsonl.bak", OLDER],
    ]),
    times: Object.fromEntries([
      ...Array.from({ length: 20 }, (_, i) => [`.codex/sessions/cap/filler-${i}.jsonl`, EPOCH + 900 + i]),
      [".codex/sessions/cap/productive.jsonl", EPOCH + 50],
    ]),
  },
  { name: "usage/codex-reads-only-the-newest-twenty", method: "GET", path: USAGE },
  {
    kind: "write",
    name: "drop one filler so the productive rollout makes the cut",
    files: { ".codex/sessions/cap/filler-0.jsonl": null },
  },
  { name: "usage/codex-twenty-first-becomes-twentieth", method: "GET", path: USAGE },

  // --- Codex: only the last two megabytes of a rollout are read ---------------
  {
    kind: "write",
    name: "one rollout larger than the read window",
    files: { ".codex/sessions/cap": null, ".codex/sessions/big.jsonl": bigRollout() },
    times: { ".codex/sessions/big.jsonl": EPOCH + 800 },
  },
  { name: "usage/codex-reads-only-the-tail-of-a-rollout", method: "GET", path: USAGE },
  {
    kind: "write",
    name: "remove the sessions tree entirely",
    files: { ".codex/sessions": null },
  },
  { name: "usage/codex-with-no-sessions-directory", method: "GET", path: USAGE },

  // --- Claude: the rate-limit window file -------------------------------------
  {
    kind: "write",
    name: "a usage file whose resets are zero and negative",
    files: { ".claude/state/usage": "50\t0\t60\t-1\n" },
  },
  { name: "usage/claude-windows-need-a-positive-reset", method: "GET", path: USAGE },
  {
    kind: "write",
    name: "a usage file with two fields and no trailing newline",
    files: { ".claude/state/usage": "  7.5\t1893456000  " },
  },
  { name: "usage/claude-windows-from-a-short-usage-file", method: "GET", path: USAGE },
  {
    kind: "write",
    name: "a usage file of unparseable text",
    files: { ".claude/state/usage": "not\ta\tnumber\tanywhere" },
  },
  { name: "usage/claude-windows-from-unreadable-text", method: "GET", path: USAGE },

  // --- Claude: the project entry ----------------------------------------------
  {
    kind: "write",
    name: "restore the windows, and give the model map awkward shapes",
    files: { ".claude/state/usage": "12.5\t1893456000\t44\t1894060800\n" },
  },
  { name: "usage/claude-windows-restored", method: "GET", path: USAGE },
  {
    kind: "write",
    name: "a model map that is an array, and a session id that is a number",
    files: {
      ".claude.json": (runtime) =>
        claudeJson(
        {
          lastCost: "2.5e-1",
          lastSessionId: 42,
          lastTotalInputTokens: "1_000",
          lastModelUsage: [{ model: "ignored", costUSD: 1 }, { costUSD: 3 }],
        },
          workspaceKey(runtime),
        ),
    },
  },
  { name: "usage/claude-model-map-as-an-array", method: "GET", path: USAGE },
  {
    kind: "write",
    name: "a model map that is not an object at all",
    files: {
      ".claude.json": (runtime) => claudeJson({ lastCost: 1, lastModelUsage: 7 }, workspaceKey(runtime)),
    },
  },
  { name: "usage/claude-model-map-that-is-a-number", method: "GET", path: USAGE },
  {
    kind: "write",
    name: "a model map that is null",
    files: {
      ".claude.json": (runtime) => claudeJson({ lastCost: 1, lastModelUsage: null }, workspaceKey(runtime)),
    },
  },
  { name: "usage/claude-model-map-that-is-null", method: "GET", path: USAGE },
  {
    kind: "write",
    name: "no entry for this working directory",
    files: { ".claude.json": (runtime) => claudeJson(null, workspaceKey(runtime)) },
  },
  // The windows alone are still a reading, reported against a zeroed project.
  { name: "usage/claude-with-windows-but-no-project", method: "GET", path: USAGE },
  {
    kind: "write",
    name: "no entry for this working directory and no windows either",
    files: { ".claude/state/usage": null },
  },
  { name: "usage/claude-with-neither-project-nor-windows", method: "GET", path: USAGE },
  {
    kind: "write",
    name: "a claude.json that is not JSON",
    files: { ".claude.json": "{ nope" },
  },
  { name: "usage/claude-json-that-does-not-parse", method: "GET", path: USAGE },
  {
    kind: "write",
    name: "a claude.json that is a JSON array",
    files: { ".claude.json": "[1,2,3]\n" },
  },
  { name: "usage/claude-json-that-is-an-array", method: "GET", path: USAGE },
  {
    kind: "write",
    name: "no claude.json at all",
    files: { ".claude.json": null },
  },
  { name: "usage/no-claude-json-and-no-codex", method: "GET", path: USAGE },

  // --- history: the shapes a damaged file takes -------------------------------
  {
    kind: "write",
    name: "rows whose totals are missing entirely",
    files: { [HISTORY]: DAMAGED_HISTORY },
    freeze: [HISTORY],
  },
  { name: "history/rows-with-nothing-to-add-up", method: "GET", path: HISTORY_PATH },
  {
    kind: "write",
    name: "a history file of only blank lines",
    files: { [HISTORY]: "\n  \n\t\n" },
    freeze: [HISTORY],
  },
  { name: "history/only-blank-lines", method: "GET", path: HISTORY_PATH },
  {
    kind: "write",
    name: "no history file at all",
    files: { [HISTORY]: null },
  },
  { name: "history/no-file", method: "GET", path: HISTORY_PATH },
  { name: "history/no-file-with-since", method: "GET", path: `${HISTORY_PATH}?since=2026` },

  // --- shape ------------------------------------------------------------------
  { name: "shape/usage-rejects-post", method: "POST", path: USAGE },
  { name: "shape/history-rejects-post", method: "POST", path: HISTORY_PATH },
  { name: "shape/usage-with-a-trailing-slash", method: "GET", path: `${USAGE}/` },
  { name: "shape/history-with-a-trailing-slash", method: "GET", path: `${HISTORY_PATH}/` },
  { name: "shape/a-deeper-usage-path", method: "GET", path: `${USAGE}/history/extra` },

  // --- the file the daemon must not have grown --------------------------------
  //
  // The sampler has had its first tick by now, and would have appended a row
  // for every source with a reading. The file is read-only, so both runtimes
  // must have swallowed the failure and left the bytes alone.
  {
    kind: "write",
    name: "restore the seeded history, still frozen",
    files: { [HISTORY]: SEEDED_HISTORY },
    freeze: [HISTORY],
  },
  {
    kind: "write",
    name: "restore a reading for the sampler to want to record",
    files: {
      ".claude.json": (runtime) => claudeJson(RICH_PROJECT, workspaceKey(runtime)),
      ".claude/state/usage": "12.5\t1893456000\t44\t1894060800\n",
    },
  },
  { kind: "wait", name: "let the sampler tick", ms: 6_000 },
  { name: "usage/reading-restored-for-the-sampler", method: "GET", path: USAGE },
  { kind: "file", name: "file/history-is-exactly-what-was-seeded", path: HISTORY },
  { name: "history/unchanged-after-a-sampler-tick", method: "GET", path: HISTORY_PATH },
];

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
}

const credentials = new Map<Runtime, string>();

async function send(runtime: Runtime, step: RequestStep): Promise<Answer> {
  const credential = credentials.get(runtime) ?? "";
  const headers: Record<string, string> = credential
    ? { authorization: `Bearer ${credential}` }
    : {};
  const response = await fetch(`http://127.0.0.1:${runtime.port}${step.path}`, {
    method: step.method,
    headers,
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* compared as the text it was */
  }
  return { status: response.status, contentType: response.headers.get("content-type"), body: parsed };
}

async function readFileStep(runtime: Runtime, step: FileStep): Promise<unknown> {
  try {
    return { file: await readFile(join(runtime.home, step.path), "utf8") };
  } catch (error) {
    return { missing: (error as NodeJS.ErrnoException).code ?? String(error) };
  }
}

/** Setup. The history file is unfrozen to be rewritten and frozen again after. */
async function applyWrite(runtime: Runtime, step: WriteStep): Promise<void> {
  for (const [relative, contents] of Object.entries(step.files ?? {})) {
    const target = join(runtime.home, relative);
    if (contents === null) {
      await rm(target, { recursive: true, force: true });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await chmod(target, 0o644).catch(() => {});
    await writeFile(target, typeof contents === "function" ? contents(runtime) : contents);
  }
  for (const [relative, mtime] of Object.entries(step.times ?? {})) {
    await utimes(join(runtime.home, relative), mtime, mtime);
  }
  for (const relative of step.freeze ?? []) {
    await chmod(join(runtime.home, relative), 0o444);
  }
}

function erase(value: string, runtime: Runtime): string {
  return value
    .split(`/private${runtime.home}`)
    .join("<home>")
    .split(runtime.home)
    .join("<home>");
}

function normalize(value: unknown, runtime: Runtime): unknown {
  return JSON.parse(erase(JSON.stringify(value), runtime));
}

const root = await mkdtemp(join(tmpdir(), "nmi-usage-parity-"));
const harness = new RuntimeHarness(root);
let failures = 0;
let compared = 0;

async function seed(runtime: Runtime): Promise<void> {
  const write = async (relative: string, contents: string, mtime?: number) => {
    const target = join(runtime.home, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
    if (mtime !== undefined) await utimes(target, mtime, mtime);
  };

  await write(".claude.json", claudeJson(RICH_PROJECT, workspaceKey(runtime)));
  await write(".claude/state/usage", "12.5\t1893456000\t44\t1894060800\n");

  await write(".codex/sessions/2026/08/newest.jsonl", NEWEST, EPOCH + 300);
  await write(".codex/sessions/a/b/c/d/deep.jsonl", DEEP, EPOCH + 200);
  await write(".codex/sessions/a/b/c/d/e/toodeep.jsonl", TOODEEP, EPOCH + 400);
  await write(".codex/sessions/older.jsonl", OLDER, EPOCH + 100);

  // Seeded, then made unwritable so the daemon's own sampler cannot append.
  await write(HISTORY, SEEDED_HISTORY);
  await chmod(join(runtime.home, HISTORY), 0o444);
}

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      spec,
      () => ({ version: 1, services: [], bundles: [], databases: [], gitRepositories: [] }),
      () => [],
    );
    realWorkspace.set(runtime, await realpath(runtime.workspace));
    await seed(runtime);
    // The daemon's own working directory is the key into `.claude.json`'s
    // `projects` map, so it has to be a directory this gate owns.
    await harness.startDaemon(runtime, {}, runtime.workspace);
    const credential = await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
      .then((value) => value.trim())
      .catch(() => "");
    credentials.set(runtime, credential);
    runtimes.push(runtime);
  }
  const [reference, candidate] = runtimes;

  for (const step of steps) {
    if (step.kind === "write") {
      await applyWrite(reference, step);
      await applyWrite(candidate, step);
      console.log(`--   ${step.name}`);
      continue;
    }
    if (step.kind === "wait") {
      await new Promise((resolve) => setTimeout(resolve, step.ms));
      console.log(`--   ${step.name}`);
      continue;
    }
    const answers =
      step.kind === "file"
        ? {
            reference: await readFileStep(reference, step),
            candidate: await readFileStep(candidate, step),
          }
        : {
            reference: await send(reference, step),
            candidate: await send(candidate, step),
          };
    if (dump) {
      console.log(`--- ${step.name} ---`);
      console.log(`  reference: ${inspect(answers.reference, { depth: null })}`);
      console.log(`  candidate: ${inspect(answers.candidate, { depth: null })}`);
    }
    compared += 1;
    try {
      assert.deepStrictEqual(
        normalize(answers.candidate, candidate),
        normalize(answers.reference, reference),
      );
      console.log(`ok   ${step.name}`);
    } catch (error) {
      failures += 1;
      console.log(`FAIL ${step.name}`);
      console.log(`  reference: ${inspect(answers.reference, { depth: null })}`);
      console.log(`  candidate: ${inspect(answers.candidate, { depth: null })}`);
      console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\nusage parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\nusage parity: ${compared} cases match`);
