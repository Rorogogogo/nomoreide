/**
 * Phase 4 error-inbox parity gate.
 *
 * `nomoreide_list_errors` and `nomoreide_error_prompt`, driven against a set of
 * throwaway services that each emit one fixed sequence of log lines. Both
 * runtimes get their own daemon, their own workspace, and the same sequence.
 *
 * Services are started **one at a time**, each given time to finish emitting
 * before the next begins. Incident ids are assigned in the order incidents are
 * first seen and the listing is ordered by when each was last seen, so two runs
 * are only comparable if the lines arrive in the same order — which starting
 * them concurrently would not guarantee.
 *
 * What it pins:
 *
 *  - Which lines are incidents. The word list is not the log store's severity
 *    list, and the error pattern has a trailing word boundary and no leading
 *    one, so `terror` is an error and `errors` is not.
 *  - The zero-count exemption, which applies to errors and not to warnings.
 *  - Deduplication by signature, and what a signature forgets: timestamps, hex
 *    literals, and whole numbers.
 *  - Where a stack frame attaches, the twelve-line context window, and the cap
 *    on frames appended to it.
 *  - The hundred-incident cap, checked last because reaching it evicts
 *    everything the earlier steps put there.
 *  - The prompt, with and without an affected file, and with a real diff.
 *
 * `firstSeen` and `lastSeen` are wall-clock and cannot repeat between two runs,
 * so they are dropped rather than compared. The *order* they impose is still
 * compared, because the listing is returned in it.
 *
 * Two emitters ask for more space between their lines than the rest, and the
 * reason is a race in the reference rather than in the fixture — see
 * {@link Emitter.spacing}. The flood is waited for by condition instead of by
 * clock, for the same kind of reason: a sleep long enough on an idle machine is
 * not long enough on a busy one, and a gate that has to be re-run is a gate
 * people stop believing.
 *
 * Nothing here reads either implementation.
 *
 * Usage:
 *   node --import tsx scripts/check-mcp-errors-parity.ts <candidate> [args...]
 *   ... --dump   print both payloads per step
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { promisify } from "node:util";
import {
  candidateSpec,
  delay,
  normalizeRuntimePayload,
  referenceSpec,
  RuntimeHarness,
  toolPayload,
  type Runtime,
  type WorkspaceFile,
} from "../test/support/runtime-parity.js";

const execFileAsync = promisify(execFile);

const argv = process.argv.slice(2);
const dump = argv.includes("--dump");
const candidateArgv = argv.filter((entry) => entry !== "--dump");
if (candidateArgv.length === 0) {
  throw new Error(
    "Usage: node --import tsx scripts/check-mcp-errors-parity.ts [--dump] <candidate-command> [args...]",
  );
}

/** Wall-clock fields that cannot repeat. The order they impose still is. */
/** How far apart an emitter's lines are, unless it asks for more room. */
const DEFAULT_SPACING = 40;

const VOLATILE = ["firstSeen", "lastSeen"];


interface Emitter {
  readonly name: string;
  readonly lines: string[];
  /** Milliseconds to wait after starting it, before the next one begins. */
  readonly settle: number;
  /**
   * Milliseconds between lines, for the two emitters that need more room than
   * the default.
   *
   * The reference occasionally delivers two adjacent stderr lines out of order
   * — the later one is seen first, so it takes the lower incident id *and* the
   * earlier timestamp, and the listing (newest activity first, ties by id
   * descending) then reports the pair the wrong way round. It is the reference
   * that varies run to run; the native runtime has never been observed to. The
   * two emitters it shows up on are the ones that make it likely: `long`, whose
   * lines are long enough to straddle a read, and `flood`, which has a hundred
   * and five chances to hit it.
   *
   * Widening the gap is a fixture fix, not a reconciliation. The order is still
   * compared, and a runtime that got it wrong still fails.
   */
  readonly spacing?: number;
}

/** `{{file}}` becomes the workspace's own `broken.js` in each runtime. */
const emitters: Emitter[] = [
  {
    name: "words",
    settle: 2_500,
    lines: [
      "Error: plain",
      "the terror of it all",
      "zzz errors zzz",
      "zzz error_code zzz",
      "zzz error-ish zzz",
      "zzz fatal zzz",
      "zzz panic zzz",
      "zzz panicked zzz",
      "zzz exception zzz",
      "zzz uncaught zzz",
      "zzz unhandled zzz",
      "zzz traceback zzz",
      "zzz segmentation fault zzz",
      "zzz segfault zzz",
      "zzz eaddrinuse zzz",
      "zzz econnrefused zzz",
      "zzz enoent zzz",
      "zzz warn zzz",
      "zzz warning zzz",
      "zzz warnings zzz",
      "zzz deprecated zzz",
      "zzz deprecation zzz",
      "warning: this is an error too",
      "Error:    spaced    out",
      "Error:\tseparated\tby\ttabs",
      "   Error: leading spaces",
      "    just indented, which is not a stack frame",
      "plain informational line",
    ],
  },
  {
    name: "counts",
    settle: 1_500,
    lines: [
      "0 errors",
      "0 error",
      "1 error",
      "no error",
      "00 error",
      "0 warn",
      "found 0 errors in 2 files",
      // The exemption is an error rule, so this is still a warning.
      "0 errors and a warn",
    ],
  },
  {
    name: "dedup",
    settle: 1_500,
    lines: [
      "Error: id 111 failed",
      "Error: id 222 failed",
      "Error: id 333 failed",
      "Error at 2026-08-22T12:00:00.000Z",
      "Error at 2026-08-22T13:00:00.000Z",
      "Error: took 12.5ms and 0x1f bytes",
      "Error: took 99.5ms and 0xff bytes",
    ],
  },
  {
    name: "frames",
    settle: 2_000,
    lines: [
      "Error: frame follows",
      "    at handler ({{file}}:3:11)",
      "    at second ({{file}}:4:11)",
      "noise between",
      "    at h ({{file}}:9:1)",
      "Error: python style",
      '  File "{{file}}", line 7, in handler',
      "Error: no column is not a frame",
      "    at h ({{file}}:8)",
      "\tat com.example.Main.run(Main.java:42)",
    ],
  },
  {
    name: "nocolumn",
    settle: 1_200,
    lines: ["Error: only a no-column frame", "    at h ({{file}}:8)"],
  },
  // 30: the same message from two services is two incidents, never one.
  { name: "twin-first", settle: 1_200, lines: ["Error: shared between services"] },
  { name: "twin-second", settle: 1_200, lines: ["Error: shared between services"] },
  {
    name: "window",
    settle: 2_000,
    lines: [
      ...Array.from({ length: 12 }, (_, index) => `pre ${index + 1}`),
      "Error: a full window",
      ...Array.from({ length: 16 }, (_, index) => `    at f${index} ({{file}}:${index + 1}:1)`),
    ],
  },
  {
    name: "long",
    settle: 1_200,
    spacing: 150,
    lines: [`Error: ${"y".repeat(400)}`, `Error: ${"num 1234567890 ".repeat(30)}`],
  },
  {
    name: "diffable",
    settle: 1_500,
    lines: ["Error: needs a diff", "    at handler ({{file}}:2:1)"],
  },
];

/**
 * Emitted last: 105 distinct signatures push the inbox past its cap.
 *
 * Its `settle` is unused — this one is waited for by condition rather than by
 * clock, because it is the only emitter whose output is large enough for a
 * fixed wait to be a coin flip on a loaded machine.
 */
const flood: Emitter = {
  name: "flood",
  settle: 0,
  spacing: 150,
  lines: Array.from({ length: 105 }, (_, index) => `Error: distinct ${label(index)}`),
};

/**
 * Waits for the flood to have filled the inbox, rather than for a fixed number
 * of seconds.
 *
 * A sleep long enough on an idle machine is not long enough on a busy one, and
 * a gate that has to be re-run is a gate people stop believing. The condition is
 * exact — the cap, reached, with nothing but flood incidents left — so waiting
 * on it cannot mask a runtime that produced the wrong answer: a candidate that
 * never reaches it fails on the deadline instead of on the diff, and one that
 * reaches a *different* answer still fails the comparison that follows.
 */
async function waitForTheFlood(runtime: Runtime): Promise<void> {
  const deadline = Date.now() + FLOOD_DEADLINE;
  while (Date.now() < deadline) {
    const { payload } = toolPayload(
      await harness.call(runtime, "nomoreide_list_errors", { limit: 200 }),
    ) as { payload?: unknown };
    const incidents = (Array.isArray(payload) ? payload : []) as Array<{
      service?: string;
      title?: string;
    }>;
    // Reaching the cap is not enough: the flood passes through "100 flood
    // incidents" while it is still emitting, so two runtimes read at that
    // moment are each holding a different hundred. The *last* line having
    // arrived is the terminal condition, and the listing is newest first.
    const settled =
      incidents.length === INBOX_CAP &&
      incidents.every((incident) => incident.service === flood.name) &&
      incidents[0]?.title === flood.lines.at(-1);
    if (settled) return;
    await delay(FLOOD_POLL);
  }
  throw new Error(
    `[${runtime.label}] the inbox never filled with ${INBOX_CAP} flood incidents within ${FLOOD_DEADLINE}ms.`,
  );
}

/** What the inbox keeps, which the flood is sized to exceed. */
const INBOX_CAP = 100;
const FLOOD_POLL = 250;
const FLOOD_DEADLINE = 60_000;

function label(index: number): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  return `${letters[index % 26]}${letters[Math.floor(index / 26)]}`;
}

const root = await mkdtemp(join(tmpdir(), "nomoreide-errors-parity-"));
const harness = new RuntimeHarness(root);
let compared = 0;

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(candidateArgv)]) {
    runtimes.push(await harness.provision(spec, (runtime) => config(runtime), (runtime) => files(runtime)));
  }
  // A repository, so the prompt for an incident in a tracked file has a diff to
  // show. Built after provisioning because it needs the files on disk.
  await Promise.all(runtimes.map((runtime) => makeRepository(runtime)));
  for (const runtime of runtimes) {
    await harness.startDaemon(runtime);
  }

  // One at a time: ids and ordering are assigned by arrival.
  for (const emitter of emitters) {
    await Promise.all(
      runtimes.map((runtime) => harness.call(runtime, "nomoreide_start_service", { name: emitter.name })),
    );
    await delay(emitter.settle);
  }

  await compare(runtimes, "errors/all", (runtime) => harness.call(runtime, "nomoreide_list_errors"));
  await compare(runtimes, "errors/limit-1", (runtime) =>
    harness.call(runtime, "nomoreide_list_errors", { limit: 1 }),
  );
  await compare(runtimes, "errors/limit-5", (runtime) =>
    harness.call(runtime, "nomoreide_list_errors", { limit: 5 }),
  );
  await compare(runtimes, "errors/limit-at-the-bound", (runtime) =>
    harness.call(runtime, "nomoreide_list_errors", { limit: 200 }),
  );
  for (const [name, args] of [
    ["errors/reject-zero-limit", { limit: 0 }],
    ["errors/reject-limit-past-the-bound", { limit: 201 }],
    ["errors/reject-fractional-limit", { limit: 1.5 }],
    ["errors/reject-limit-of-the-wrong-type", { limit: "5" }],
  ] as Array<[string, Record<string, unknown>]>) {
    await compare(runtimes, name, (runtime) => harness.call(runtime, "nomoreide_list_errors", args));
  }

  // Prompts, addressed by the signature each runtime assigned an id to, so a
  // divergence in ids fails `errors/all` rather than silently comparing two
  // different incidents here.
  for (const [name, signature] of [
    ["prompt/with-a-diff", "diffable error: needs a diff"],
    ["prompt/without-a-file", "counts no error"],
    ["prompt/with-a-full-window", "window error: a full window"],
  ] as Array<[string, string]>) {
    await compare(runtimes, name, async (runtime) => {
      const id = await idOf(runtime, signature);
      return harness.call(runtime, "nomoreide_error_prompt", { id });
    });
  }
  await compare(runtimes, "prompt/no-such-incident", (runtime) =>
    harness.call(runtime, "nomoreide_error_prompt", { id: 9_999 }),
  );
  for (const [name, args] of [
    ["prompt/reject-a-missing-id", {}],
    ["prompt/reject-a-zero-id", { id: 0 }],
    ["prompt/reject-a-fractional-id", { id: 2.5 }],
  ] as Array<[string, Record<string, unknown>]>) {
    await compare(runtimes, name, (runtime) => harness.call(runtime, "nomoreide_error_prompt", args));
  }

  // Last: this evicts most of what the steps above looked at.
  await Promise.all(
    runtimes.map((runtime) => harness.call(runtime, "nomoreide_start_service", { name: flood.name })),
  );
  await Promise.all(runtimes.map((runtime) => waitForTheFlood(runtime)));
  await compare(
    runtimes,
    "errors/after-the-cap-is-reached",
    (runtime) => harness.call(runtime, "nomoreide_list_errors", { limit: 200 }),
  );
  // Only here is the default visible: below the cap the inbox holds fewer
  // incidents than any plausible default would return.
  await compare(
    runtimes,
    "errors/the-default-limit",
    (runtime) => harness.call(runtime, "nomoreide_list_errors"),
  );

  console.log(`MCP error-inbox parity passed (${compared} steps).`);
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}

/** The id this runtime gave the incident with that signature. */
async function idOf(runtime: Runtime, signature: string): Promise<number> {
  const payload = toolPayload(
    await harness.call(runtime, "nomoreide_list_errors", { limit: 200 }),
  ) as { payload?: Array<{ id: number; signature: string }> };
  const found = payload.payload?.find((incident) => incident.signature === signature);
  if (!found) {
    throw new Error(`${runtime.label} never recorded an incident signed "${signature}"`);
  }
  return found.id;
}

async function compare(
  runtimes: readonly Runtime[],
  name: string,
  call: (runtime: Runtime) => Promise<unknown>,
  volatile: readonly string[] = VOLATILE,
): Promise<void> {
  const observed = await Promise.all(
    runtimes.map(async (runtime) =>
      normalizeRuntimePayload(toolPayload(await call(runtime)), runtimes, [...volatile]),
    ),
  );
  if (dump) {
    for (const [index, payload] of observed.entries()) {
      console.log(`\n--- ${name} [${runtimes[index].label}]`);
      console.log(inspect(payload, { depth: null, maxArrayLength: null }));
    }
  }
  try {
    assert.deepStrictEqual(observed[1], observed[0]);
  } catch (error) {
    console.error(`\nError-inbox parity failed at step "${name}".`);
    console.error(`reference: ${inspect(observed[0], { depth: null, maxArrayLength: null })}`);
    console.error(`candidate: ${inspect(observed[1], { depth: null, maxArrayLength: null })}`);
    throw error;
  }
  compared += 1;
}

/**
 * Each emitter as a registered service. Spelled with this runtime's own
 * absolute paths, and with the node binary running the gate rather than
 * whatever `node` a PATH lookup would find.
 */
function config(runtime: Omit<Runtime, "port">): unknown {
  return {
    version: 1,
    services: [...emitters, flood].map((emitter) => ({
      name: emitter.name,
      command: `${process.execPath} ${join(runtime.workspace, `${emitter.name}.js`)}`,
      cwd: runtime.workspace,
    })),
    bundles: [],
    gitRepositories: [],
  };
}

function files(runtime: Omit<Runtime, "port">): WorkspaceFile[] {
  const broken = join(runtime.workspace, "broken.js");
  return [
    // Tracked and then modified, so `git diff` has something to report.
    { path: "broken.js", contents: "committed 1\ncommitted 2\ncommitted 3\n" },
    ...[...emitters, flood].map((emitter) => ({
      path: `${emitter.name}.js`,
      contents: emitterScript(
        emitter.lines.map((line) => line.replaceAll("{{file}}", broken)),
        emitter.spacing,
      ),
    })),
  ];
}

/**
 * Fixed cadence rather than all at once: the inbox reads a line at a time, and
 * a burst delivered in one chunk would make the order the two runtimes observe
 * depend on how each drains its pipe.
 */
function emitterScript(lines: string[], spacing = DEFAULT_SPACING): string {
  return [
    `const lines = ${JSON.stringify(lines)};`,
    "let index = 0;",
    "const timer = setInterval(() => {",
    "  if (index >= lines.length) { clearInterval(timer); setInterval(() => {}, 1000); return; }",
    "  process.stderr.write(lines[index++] + '\\n');",
    `}, ${spacing});`,
  ].join("\n");
}

/** Commit the workspace, then dirty the one file an incident points at. */
async function makeRepository(runtime: Runtime): Promise<void> {
  const run = (args: string[]) =>
    execFileAsync("git", args, {
      cwd: runtime.workspace,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-01-02T03:04:05+00:00",
        GIT_COMMITTER_DATE: "2026-01-02T03:04:05+00:00",
      },
    });
  await run(["init", "--quiet", "--initial-branch=main"]);
  await run(["config", "user.email", "parity@nomoreide.test"]);
  await run(["config", "user.name", "NoMoreIDE Parity"]);
  await run(["config", "commit.gpgsign", "false"]);
  await run(["add", "broken.js"]);
  await run(["commit", "--quiet", "-m", "base"]);
  await writeFile(join(runtime.workspace, "broken.js"), "committed 1\nCHANGED 2\ncommitted 3\n");
}
