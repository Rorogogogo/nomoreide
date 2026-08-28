/**
 * Phase 6 parity gate for host activity and the process-termination guard:
 *
 *   GET  /api/metrics
 *   GET  /api/services/:name/metrics
 *   POST /api/processes/terminate
 *
 * **The numbers cannot be compared and are not.** CPU, RSS and the host's
 * process table are sampled at whatever instant each daemon got round to, so
 * two runtimes never see the same values and often not even the same number of
 * rows. What is compared is the *shape*: which keys the answer carries, and —
 * for `includeProcesses` — whether one particular key is there at all. That is
 * the whole of the decision this endpoint makes, so erasing the values costs
 * the gate nothing it could have had.
 *
 * **The termination guard is compared exactly.** It is the one write here, it
 * kills a process by pid, and every refusal it makes is deterministic: a pid
 * that is not a safe integer, a pid at or below init, a pid nothing is running,
 * and a pid whose command is not the one the caller expected. Two of those
 * refusals are reachable with real pids that both runtimes can see — a pid far
 * above any that exists, and this gate's own process with a deliberately wrong
 * expected command, which stops at the mismatch and never signals anything.
 *
 * Nothing here terminates a process, and no case supplies a matching command.
 *
 * Usage:
 *   node --import tsx scripts/check-metrics-parity.ts <candidate> [args...]
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
    "Usage: node --import tsx scripts/check-metrics-parity.ts [--dump] <candidate> [args...]",
  );
}

/** Far above any pid a machine hands out, so nothing is running as it. */
const ABSENT_PID = 4_194_303;

interface Step {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  readonly raw?: string;
  /** Compare the key shape rather than the values, for live samples. */
  readonly shapeOnly?: boolean;
}

const METRICS = "/api/metrics";
const TERMINATE = "/api/processes/terminate";

const steps: Step[] = [
  // --- host activity ----------------------------------------------------------
  { name: "metrics/without-processes", method: "GET", path: METRICS, shapeOnly: true },
  { name: "metrics/with-processes", method: "GET", path: `${METRICS}?includeProcesses=1`, shapeOnly: true },
  // Only the exact string "1" includes them.
  { name: "metrics/include-is-zero", method: "GET", path: `${METRICS}?includeProcesses=0`, shapeOnly: true },
  { name: "metrics/include-is-true", method: "GET", path: `${METRICS}?includeProcesses=true`, shapeOnly: true },
  { name: "metrics/include-is-blank", method: "GET", path: `${METRICS}?includeProcesses=`, shapeOnly: true },
  { name: "metrics/include-repeated", method: "GET", path: `${METRICS}?includeProcesses=1&includeProcesses=0`, shapeOnly: true },
  { name: "metrics/an-unrelated-parameter", method: "GET", path: `${METRICS}?other=1`, shapeOnly: true },

  // --- one service's series ---------------------------------------------------
  { name: "service-metrics/a-registered-service", method: "GET", path: "/api/services/api/metrics" },
  { name: "service-metrics/an-unknown-service", method: "GET", path: "/api/services/nope/metrics" },
  { name: "service-metrics/a-name-that-needs-decoding", method: "GET", path: "/api/services/a%2Fb/metrics" },
  { name: "service-metrics/rejects-post", method: "POST", path: "/api/services/api/metrics" },

  // --- the termination guard --------------------------------------------------
  { name: "terminate/an-empty-body", method: "POST", path: TERMINATE, body: {} },
  { name: "terminate/a-body-that-is-not-json", method: "POST", path: TERMINATE, raw: "{ not json" },
  { name: "terminate/no-body-at-all", method: "POST", path: TERMINATE },
  { name: "terminate/a-pid-that-is-not-a-number", method: "POST", path: TERMINATE, body: { pid: "abc", expectedCommand: "x" } },
  { name: "terminate/a-fractional-pid", method: "POST", path: TERMINATE, body: { pid: 1.5, expectedCommand: "x" } },
  { name: "terminate/no-expected-command", method: "POST", path: TERMINATE, body: { pid: ABSENT_PID } },
  { name: "terminate/a-blank-expected-command", method: "POST", path: TERMINATE, body: { pid: ABSENT_PID, expectedCommand: "" } },
  { name: "terminate/an-expected-command-that-is-not-a-string", method: "POST", path: TERMINATE, body: { pid: ABSENT_PID, expectedCommand: 7 } },
  // Past the route's own validation, into the guard itself.
  { name: "terminate/pid-zero", method: "POST", path: TERMINATE, body: { pid: 0, expectedCommand: "x" } },
  { name: "terminate/pid-one", method: "POST", path: TERMINATE, body: { pid: 1, expectedCommand: "x" } },
  { name: "terminate/a-negative-pid", method: "POST", path: TERMINATE, body: { pid: -5, expectedCommand: "x" } },
  { name: "terminate/a-pid-nothing-is-running", method: "POST", path: TERMINATE, body: { pid: ABSENT_PID, expectedCommand: "x" } },
  { name: "terminate/rejects-get", method: "GET", path: TERMINATE },
];

/** Filled once both daemons are up: this process, which both of them can see. */
let liveStep: Step;

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
}

const credentials = new Map<Runtime, string>();

async function send(runtime: Runtime, step: Step): Promise<Answer> {
  const credential = credentials.get(runtime) ?? "";
  const headers: Record<string, string> = credential
    ? { authorization: `Bearer ${credential}` }
    : {};
  let body: string | undefined;
  if (step.raw !== undefined) {
    body = step.raw;
    headers["content-type"] = "application/json";
  } else if (step.body !== undefined) {
    body = JSON.stringify(step.body);
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`http://127.0.0.1:${runtime.port}${step.path}`, {
    method: step.method,
    headers,
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
 * Every key path in a document, with the leaves dropped.
 *
 * A live sample's numbers are noise; the keys around them are the contract. An
 * array is collapsed to its first element's shape and a flag for whether it had
 * any, so two hosts with different numbers of processes still compare.
 */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : ["<non-empty>", shape(value[0])];
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, shape(child)]),
    );
  }
  return typeof value;
}

const root = await mkdtemp(join(tmpdir(), "nmi-metrics-parity-"));
const harness = new RuntimeHarness(root);
let failures = 0;

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      spec,
      ({ workspace }) => ({
        version: 1,
        services: [
          { name: "api", command: "node -e 'setInterval(()=>{},1000)'", cwd: workspace, port: 45331 },
        ],
        bundles: [],
        databases: [],
        gitRepositories: [],
      }),
      () => [],
    );
    await harness.startDaemon(runtime);
    credentials.set(
      runtime,
      await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
        .then((value) => value.trim())
        .catch(() => ""),
    );
    runtimes.push(runtime);
  }
  const [reference, candidate] = runtimes;

  // This process is alive and both daemons can see it, so the guard gets past
  // "no longer running" and refuses on the command instead. The command it is
  // given is deliberately not this process's, so nothing is ever signalled.
  liveStep = {
    name: "terminate/a-live-pid-whose-command-does-not-match",
    method: "POST",
    path: TERMINATE,
    body: { pid: process.pid, expectedCommand: "this-is-not-the-command-of-that-process" },
  };

  for (const step of [...steps, liveStep]) {
    const answers = {
      reference: await send(reference, step),
      candidate: await send(candidate, step),
    };
    const pick = (answer: Answer) =>
      step.shapeOnly ? { status: answer.status, shape: shape(answer.body) } : answer;
    const pair = { reference: pick(answers.reference), candidate: pick(answers.candidate) };
    if (dump) {
      console.log(`--- ${step.name} ---`);
      console.log(`  reference: ${inspect(pair.reference, { depth: null })}`);
      console.log(`  candidate: ${inspect(pair.candidate, { depth: null })}`);
    }
    try {
      assert.deepStrictEqual(pair.candidate, pair.reference);
      console.log(`ok   ${step.name}`);
    } catch (error) {
      failures += 1;
      console.log(`FAIL ${step.name}`);
      console.log(`  reference: ${inspect(pair.reference, { depth: null })}`);
      console.log(`  candidate: ${inspect(pair.candidate, { depth: null })}`);
      console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\nmetrics parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\nmetrics parity: ${steps.length + 1} cases match`);
