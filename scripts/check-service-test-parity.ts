/**
 * Phase 6 parity gate for the per-service test runner:
 *
 *   POST /api/services/:name/test
 *   GET  /api/services/:name/test/stream
 *
 * A run is **asynchronous**: the POST answers the moment the child is spawned,
 * with a run that is still `running`. Everything that matters afterwards — the
 * output, the exit, the failing count, the synthetic error line — only ever
 * appears on the stream. So most cases here open the stream, start a run
 * inside it, and compare the whole sequence of frames.
 *
 * The stream's `event:` name **varies per frame** (`status`, then `output`,
 * then `status` again), unlike every other stream in the daemon, where it is
 * fixed. That is the thing most likely to be flattened by a port.
 *
 * A failed run also appends a synthetic `ERROR:` line to the service's
 * `<name>:test` log channel, which the error inbox turns into an incident — so
 * one case reads `/api/errors` and checks the run surfaced there too.
 *
 * Usage:
 *   node --import tsx scripts/check-service-test-parity.ts <candidate> [args...]
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
  throw new Error("Usage: node --import tsx scripts/check-service-test-parity.ts [--dump] <candidate> [args...]");
}

const credentials = new Map<Runtime, string>();
const auth = (runtime: Runtime): Record<string, string> => {
  const credential = credentials.get(runtime) ?? "";
  return credential ? { authorization: `Bearer ${credential}` } : {};
};

interface Answer {
  status: number;
  contentType: string | null;
  body: unknown;
}

async function send(
  runtime: Runtime,
  method: string,
  path: string,
  form?: Record<string, string>,
): Promise<Answer> {
  const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    method,
    headers: form
      ? { ...auth(runtime), "content-type": "application/x-www-form-urlencoded" }
      : auth(runtime),
    body: form ? new URLSearchParams(form).toString() : undefined,
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

/** A run's id and clocks are per-runtime; its status, command and counts are not. */
const VOLATILE = new Set(["id", "startedAt", "endedAt"]);

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

function normalize(value: unknown, runtime: Runtime): unknown {
  const erased = JSON.stringify(value ?? null)
    .split(`/private${runtime.home}`)
    .join("<home>")
    .split(runtime.home)
    .join("<home>");
  return scrub(JSON.parse(erased));
}

/** Only the JSON after `data: ` is normalized; the framing bytes are compared as sent. */
function normalizeStream(body: string, runtime: Runtime): string {
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

const HEADERS = ["content-type", "cache-control", "connection"] as const;
const testPath = (name: string) => `/api/services/${name}/test`;

const root = await mkdtemp(join(tmpdir(), "nmi-service-test-parity-"));
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
      ({ workspace }) => ({
        version: 1,
        services: [
          { name: "passer", command: "true", cwd: workspace, test: "node -e \"console.log('one line')\"" },
          {
            name: "failer",
            command: "true",
            cwd: workspace,
            test: "node -e \"console.log('FAIL a.test.js'); console.log('1 failed'); process.exit(1)\"",
          },
          { name: "slow", command: "true", cwd: workspace, test: "node -e \"setTimeout(()=>{},4000)\"" },
          // No `test` of its own, so the runner falls back to its default.
          { name: "bare", command: "true", cwd: workspace },
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
  const [reference, candidate] = runtimes;

  const streamView = (
    answer: { status: number; headers: Record<string, string>; body: string },
    runtime: Runtime,
  ) => ({
    status: answer.status,
    headers: Object.fromEntries(HEADERS.map((key) => [key, answer.headers[key] ?? null])),
    body: normalizeStream(answer.body, runtime),
  });

  /** Open the stream, start a run inside it, and read the whole sequence. */
  async function runInStream(name: string, service: string, form?: Record<string, string>) {
    const answers = await Promise.all(
      runtimes.map((runtime) =>
        harness.readStream(runtime, `${testPath(service)}/stream`, {
          headers: auth(runtime),
          idleMs: 2_500,
          totalMs: 15_000,
          whileOpen: async () => {
            await send(runtime, "POST", testPath(service), form);
          },
        }),
      ),
    );
    compare(name, streamView(answers[0], reference), streamView(answers[1], candidate));
  }

  // The POST's own answer: a run that has only just started.
  compare(
    "test/the-answer-to-starting-a-run",
    normalize(await send(reference, "POST", testPath("passer")), reference),
    normalize(await send(candidate, "POST", testPath("passer")), candidate),
  );
  await new Promise((resolve) => setTimeout(resolve, 1_500));

  // Opening the stream after a finished run replays its last status.
  {
    const answers = await Promise.all(
      runtimes.map((runtime) =>
        harness.readStream(runtime, `${testPath("passer")}/stream`, { headers: auth(runtime) }),
      ),
    );
    compare(
      "stream/replays-the-last-run",
      streamView(answers[0], reference),
      streamView(answers[1], candidate),
    );
  }
  // A service nobody has run has nothing to replay.
  {
    const answers = await Promise.all(
      runtimes.map((runtime) =>
        harness.readStream(runtime, `${testPath("bare")}/stream`, { headers: auth(runtime) }),
      ),
    );
    compare(
      "stream/nothing-to-replay",
      streamView(answers[0], reference),
      streamView(answers[1], candidate),
    );
  }

  await runInStream("stream/a-failing-run", "failer");
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await runInStream("stream/a-run-with-a-pattern", "passer", { pattern: "a.test.js" });
  await new Promise((resolve) => setTimeout(resolve, 1_000));

  // A failed run appends a synthetic ERROR line, which the inbox picks up.
  compare(
    "errors/the-failed-run-surfaced",
    normalize(await send(reference, "GET", "/api/errors"), reference),
    normalize(await send(candidate, "GET", "/api/errors"), candidate),
  );

  // A second run while one is active is refused.
  for (const runtime of runtimes) await send(runtime, "POST", testPath("slow"));
  await new Promise((resolve) => setTimeout(resolve, 500));
  compare(
    "test/a-second-run-while-one-is-active",
    normalize(await send(reference, "POST", testPath("slow")), reference),
    normalize(await send(candidate, "POST", testPath("slow")), candidate),
  );

  for (const [name, method, path] of [
    ["test/an-unregistered-service", "POST", testPath("ghost")],
    ["test/rejects-get", "GET", testPath("passer")],
    ["stream/rejects-post", "POST", `${testPath("passer")}/stream`],
  ] as const) {
    compare(
      name,
      normalize(await send(reference, method, path), reference),
      normalize(await send(candidate, method, path), candidate),
    );
  }
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\nservice-test parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log("\nservice-test parity: all cases match");
