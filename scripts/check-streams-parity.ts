/**
 * Phase 6 parity gate for the two server-sent event streams that stand alone:
 *
 *   GET /api/errors/stream
 *   GET /api/agent/tool-calls/stream
 *
 * **The stream is compared as bytes, not as a shape.** An event stream is a
 * wire format — `retry:`, `event:`, `data:` and the blank line that ends a
 * frame are all protocol, and a client that reconnects on its own depends on
 * every one of them. So each case sends the raw text through, with only the
 * instants and the temporary paths erased.
 *
 * Three things a JSON gate could not see are covered here:
 *
 * - the **replay**: a stream opened after the fact re-sends what it holds, so
 *   a dashboard that reloads does not start blank;
 * - **live delivery**: an incident raised while the stream is open arrives on
 *   it, which is the whole point of the endpoint;
 * - the **heartbeat**: a comment frame every 15 seconds, which is what keeps a
 *   proxy from dropping an idle connection. Nothing in a response body shows
 *   it, and a port that skipped it would look perfect until deployed.
 *
 * Usage:
 *   node --import tsx scripts/check-streams-parity.ts <candidate> [args...]
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
  throw new Error("Usage: node --import tsx scripts/check-streams-parity.ts [--dump] <candidate> [args...]");
}

/** Writes one fatal line and then stays up until it is stopped. */
const errorer = (message: string) =>
  `node -e "console.error('fatal error: ${message}'); setInterval(()=>{},1000)"`;

const credentials = new Map<Runtime, string>();

function auth(runtime: Runtime): Record<string, string> {
  const credential = credentials.get(runtime) ?? "";
  return credential ? { authorization: `Bearer ${credential}` } : {};
}

async function send(runtime: Runtime, method: string, path: string): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    method,
    headers: auth(runtime),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* compared as the text it was */
  }
  return { status: response.status, contentType: response.headers.get("content-type"), body };
}

/** The headers a stream is opened with, which are as much of the contract as its body. */
const STREAM_HEADERS = ["content-type", "cache-control", "connection"] as const;

interface StreamStep {
  readonly name: string;
  readonly path: string;
  readonly idleMs?: number;
  readonly totalMs?: number;
  /** Fired once the stream is open, to test live delivery. */
  readonly trigger?: (runtime: Runtime) => Promise<void>;
}

interface RequestStep {
  readonly name: string;
  readonly method: string;
  readonly path: string;
}

const streams: StreamStep[] = [
  { name: "errors/the-replay", path: "/api/errors/stream" },
  {
    name: "errors/an-incident-raised-while-open",
    path: "/api/errors/stream",
    idleMs: 2_500,
    trigger: async (runtime) => {
      await send(runtime, "POST", "/api/services/late/start");
    },
  },
  // Long enough to sit through one 15-second heartbeat and see the comment
  // frame it writes. Slow on purpose: nothing shorter can observe it.
  { name: "errors/the-heartbeat", path: "/api/errors/stream", idleMs: 16_000, totalMs: 19_000 },
  // Nothing writes to the tool-call store in either runtime — an in-process
  // MCP server is its only writer and both daemons' clients are separate
  // processes — so this is the empty replay, which is still a contract.
  { name: "tool-calls/the-empty-replay", path: "/api/agent/tool-calls/stream" },
];

const requests: RequestStep[] = [
  // Both are exact GET routes in the reference, and a wrong method on one of
  // those is not a 405 — it matches nothing and reaches the SPA shell.
  { name: "errors/rejects-post", method: "POST", path: "/api/errors/stream" },
  { name: "tool-calls/rejects-post", method: "POST", path: "/api/agent/tool-calls/stream" },
];

/**
 * Erase the instants, the ids and each runtime's own paths. Every byte of the
 * event framing survives, which is the point.
 */
function normalize(value: unknown, runtime: Runtime): unknown {
  const text = JSON.stringify(value ?? null)
    .split(`/private${runtime.home}`)
    .join("<home>")
    .split(runtime.home)
    .join("<home>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<at>");
  return JSON.parse(text);
}

const root = await mkdtemp(join(tmpdir(), "nmi-streams-parity-"));
const harness = new RuntimeHarness(root);
let failures = 0;

function compare(name: string, reference: unknown, candidate: unknown, runtimes: Runtime[]): void {
  if (dump) {
    console.log(`--- ${name} ---`);
    console.log(`  reference: ${inspect(reference, { depth: null })}`);
    console.log(`  candidate: ${inspect(candidate, { depth: null })}`);
  }
  try {
    assert.deepStrictEqual(
      normalize(candidate, runtimes[1]),
      normalize(reference, runtimes[0]),
    );
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
      ({ workspace }) => ({
        version: 1,
        services: [
          { name: "errorer", command: errorer("the widget exploded"), cwd: workspace },
          { name: "late", command: errorer("the gasket failed"), cwd: workspace },
        ],
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

  // One incident before any stream opens, so the replay has something in it.
  for (const runtime of runtimes) await send(runtime, "POST", "/api/services/errorer/start");
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  for (const runtime of runtimes) await send(runtime, "POST", "/api/services/errorer/stop");
  await new Promise((resolve) => setTimeout(resolve, 500));

  for (const step of streams) {
    // Both runtimes at once: these cases are almost all waiting, and the
    // heartbeat one waits nineteen seconds.
    const [reference, candidate] = await Promise.all(
      runtimes.map((runtime) =>
        harness.readStream(runtime, step.path, {
          headers: auth(runtime),
          idleMs: step.idleMs,
          totalMs: step.totalMs,
          whileOpen: step.trigger ? () => step.trigger!(runtime) : undefined,
        }),
      ),
    );
    const view = (answer: { status: number; headers: Record<string, string>; body: string }) => ({
      status: answer.status,
      headers: Object.fromEntries(STREAM_HEADERS.map((key) => [key, answer.headers[key] ?? null])),
      body: answer.body,
    });
    compare(step.name, view(reference), view(candidate), runtimes);
  }

  for (const step of requests) {
    compare(
      step.name,
      await send(runtimes[0], step.method, step.path),
      await send(runtimes[1], step.method, step.path),
      runtimes,
    );
  }
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}

if (failures > 0) {
  console.log(`\nstreams parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\nstreams parity: ${streams.length + requests.length} cases match`);
