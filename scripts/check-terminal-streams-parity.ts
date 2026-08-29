/**
 * Phase 6 parity gate for the two remaining event streams whose feature is
 * already served natively:
 *
 *   GET /api/terminal/events
 *   GET /api/workflow-triggers/pending/stream
 *
 * **These two do not share a framing, and that is why both are here.** The
 * trigger queue uses the house style — `retry: 2000`, `: ping` — while the
 * terminal stream opens with `: connected`, keeps alive with `: keepalive`,
 * declares a charset, and adds `x-accel-buffering: no` so a reverse proxy does
 * not sit on its frames. A port that generalised one shape over both would
 * pass a gate that only knew the house style.
 *
 * The body is compared as bytes with only the JSON *inside* each `data:` line
 * normalized, so every byte of framing — the comment prologue, the field
 * names, the blank line that ends a frame — still has to match.
 *
 * Usage:
 *   node --import tsx scripts/check-terminal-streams-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    "Usage: node --import tsx scripts/check-terminal-streams-parity.ts [--dump] <candidate> [args...]",
  );
}

const SESSIONS = "/api/terminal/sessions";
const credentials = new Map<Runtime, string>();

function auth(runtime: Runtime): Record<string, string> {
  const credential = credentials.get(runtime) ?? "";
  return credential ? { authorization: `Bearer ${credential}` } : {};
}

async function send(
  runtime: Runtime,
  method: string,
  path: string,
  body?: string,
): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    method,
    headers: body
      ? { ...auth(runtime), "content-type": "application/json" }
      : auth(runtime),
    body,
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

/**
 * A session's id, pid and clocks are assigned per runtime and say nothing. Its
 * label, cwd, state and presentation are the whole content of the event.
 */
const VOLATILE = new Set(["pid", "createdAt", "updatedAt", "startedAt", "lastActiveAt", "id"]);

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) =>
        VOLATILE.has(key) ? [key, "<volatile>"] : [key, scrub(item)],
      ),
    );
  }
  return value;
}

/**
 * Normalize only what sits after `data: `. Every other byte — the comments,
 * the field names, the blank lines — is compared as it was sent.
 */
function normalizeBody(body: string, runtime: Runtime): string {
  return body
    .split(`/private${runtime.home}`)
    .join("<home>")
    .split(runtime.home)
    .join("<home>")
    .replace(/^data: (.*)$/gm, (line, payload: string) => {
      try {
        return `data: ${JSON.stringify(scrub(JSON.parse(payload)))}`;
      } catch {
        return line;
      }
    });
}

const HEADERS = ["content-type", "cache-control", "connection", "x-accel-buffering"] as const;

interface StreamStep {
  readonly name: string;
  readonly path: string;
  readonly idleMs?: number;
  readonly totalMs?: number;
  readonly trigger?: (runtime: Runtime) => Promise<void>;
}

const TERMINAL = "/api/terminal/events";
const TRIGGERS = "/api/workflow-triggers/pending/stream";

const streams: StreamStep[] = [
  { name: "terminal/the-replay", path: TERMINAL },
  {
    name: "terminal/a-session-opened-while-open",
    path: TERMINAL,
    idleMs: 3_000,
    trigger: async (runtime) => {
      await send(runtime, "POST", SESSIONS, '{"label":"late"}');
    },
  },
  // Closing a session emits **nothing**: the manager disposes it before any
  // state change reaches a listener. The case is here to pin that absence — a
  // port that helpfully emitted an `exited` frame would fail it.
  {
    name: "terminal/closing-emits-nothing",
    path: TERMINAL,
    idleMs: 3_000,
    trigger: async (runtime) => {
      const listed = (await send(runtime, "GET", SESSIONS)) as {
        body: { sessions?: Array<{ id: string }> };
      };
      const id = listed.body.sessions?.[0]?.id;
      if (id) await send(runtime, "DELETE", `${SESSIONS}/${encodeURIComponent(id)}`);
    },
  },
  // Long enough to sit through one keepalive. The terminal stream spells its
  // comment differently from every other stream, which is the point.
  { name: "terminal/the-keepalive", path: TERMINAL, idleMs: 16_000, totalMs: 19_000 },
  // Nothing fires a trigger in either runtime, so this is the empty replay —
  // still a contract, and a differently-spelled one.
  { name: "triggers/the-empty-replay", path: TRIGGERS },
  { name: "triggers/the-heartbeat", path: TRIGGERS, idleMs: 16_000, totalMs: 19_000 },
];

const requests = [
  { name: "terminal/rejects-post", method: "POST", path: TERMINAL },
  { name: "triggers/rejects-post", method: "POST", path: TRIGGERS },
];

/**
 * The two heartbeat cases cost nineteen seconds each. A seeded sweep skips
 * them for a mutation that cannot reach the heartbeat; a plain run never does,
 * so the committed gate is always the whole gate.
 */
const skipSlow = process.env.NMI_SKIP_SLOW === "1";
const SLOW = new Set(["terminal/the-keepalive", "triggers/the-heartbeat"]);

const root = await mkdtemp(join(tmpdir(), "nmi-terminal-streams-parity-"));
const harness = new RuntimeHarness(root);
let failures = 0;

function compare(name: string, reference: unknown, candidate: unknown): void {
  if (dump) {
    console.log(`--- ${name} ---`);
    console.log(`  reference: ${inspect(reference, { depth: null })}`);
    console.log(`  candidate: ${inspect(candidate, { depth: null })}`);
  }
  try {
    assert.deepStrictEqual(candidate, reference);
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}`);
    console.log(`  reference: ${inspect(reference, { depth: null })}`);
    console.log(`  candidate: ${inspect(candidate, { depth: null })}`);
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
  }
}

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      spec,
      () => ({
        version: 1,
        services: [],
        bundles: [],
        databases: [],
        gitRepositories: [],
      }),
      () => [],
    );
    await harness.startDaemon(runtime, {}, runtime.workspace);
    credentials.set(
      runtime,
      await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
        .then((value) => value.trim())
        .catch(() => ""),
    );
    runtimes.push(runtime);
  }

  // One session before any stream opens, so the replay has something in it.
  // Given time to settle, because a shell reaches `running` a moment after the
  // request that asked for it returns.
  for (const runtime of runtimes) await send(runtime, "POST", SESSIONS, '{"label":"first"}');
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  for (const step of streams) {
    if (skipSlow && SLOW.has(step.name)) continue;
    const answers = await Promise.all(
      runtimes.map((runtime) =>
        harness.readStream(runtime, step.path, {
          headers: auth(runtime),
          idleMs: step.idleMs,
          totalMs: step.totalMs,
          whileOpen: step.trigger ? () => step.trigger!(runtime) : undefined,
        }),
      ),
    );
    const view = (
      answer: { status: number; headers: Record<string, string>; body: string },
      runtime: Runtime,
    ) => ({
      status: answer.status,
      headers: Object.fromEntries(HEADERS.map((key) => [key, answer.headers[key] ?? null])),
      body: normalizeBody(answer.body, runtime),
    });
    compare(step.name, view(answers[0], runtimes[0]), view(answers[1], runtimes[1]));
  }

  for (const step of requests) {
    compare(
      step.name,
      await send(runtimes[0], step.method, step.path),
      await send(runtimes[1], step.method, step.path),
    );
  }
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\nterminal-streams parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\nterminal-streams parity: ${streams.length + requests.length} cases match`);
