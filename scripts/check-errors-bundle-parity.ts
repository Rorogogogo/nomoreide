/**
 * Phase 6 parity gate for the repro bundle and the error→fix loop:
 *
 *   GET  /api/errors/:id/bundle
 *   POST /api/errors/:id/fix
 *
 * Both need a real incident, so the gate makes one: a service that writes a
 * fatal line to stderr is started, given time to be classified, and stopped
 * again before anything is asked. Stopping it first is what makes the answer
 * comparable — a running service puts a pid and an uptime into the bundle that
 * two runtimes never share.
 *
 * **The bundle is a document, and it is compared as one.** It is markdown a
 * person pastes into an agent, so every heading, every quoted log line and
 * every masked value is content. That includes the masking: the service's
 * `.env` is planted with one obvious secret and one ordinary setting, and a
 * bundle that leaked the first would be a bundle that pastes a credential into
 * a chat window.
 *
 * `?save=1` writes the document to disk as well, so a `file` step reads it back
 * out of both homes and compares the bytes — the saved copy and the returned
 * copy have to be the same document.
 *
 * Usage:
 *   node --import tsx scripts/check-errors-bundle-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
    "Usage: node --import tsx scripts/check-errors-bundle-parity.ts [--dump] <candidate> [args...]",
  );
}

/** Writes one fatal line and then stays up until it is stopped. */
const ERRORER =
  "node -e \"console.error('fatal error: the widget exploded'); setInterval(()=>{},1000)\"";

/** One obvious secret and one ordinary setting. */
const ENV_FILE = "API_KEY=supersecret-value\nPORT=3000\nDATABASE_URL=postgres://u:p@h/db\n";

interface RequestStep {
  readonly kind?: "request";
  readonly name: string;
  readonly method: string;
  readonly path: string;
}

/** The saved bundle, read out of the repro directory. */
interface FileStep {
  readonly kind: "file";
  readonly name: string;
}

type Step = RequestStep | FileStep;

const steps: Step[] = [
  { name: "bundle/the-incident", method: "GET", path: "/api/errors/1/bundle" },
  { name: "bundle/saved-to-disk", method: "GET", path: "/api/errors/1/bundle?save=1" },
  { kind: "file", name: "file/the-saved-bundle" },
  // Anything but exactly "1" does not save.
  { name: "bundle/save-is-zero", method: "GET", path: "/api/errors/1/bundle?save=0" },
  { name: "bundle/save-is-true", method: "GET", path: "/api/errors/1/bundle?save=true" },

  // --- refusals ---------------------------------------------------------------
  { name: "bundle/an-unknown-incident", method: "GET", path: "/api/errors/99/bundle" },
  { name: "bundle/rejects-post", method: "POST", path: "/api/errors/1/bundle" },
  // Not digits, so the pattern does not match at all.
  { name: "bundle/a-non-numeric-id", method: "GET", path: "/api/errors/abc/bundle" },

  // --- the fix loop -----------------------------------------------------------
  { name: "fix/the-incident", method: "POST", path: "/api/errors/1/fix" },
  { name: "fix/an-unknown-incident", method: "POST", path: "/api/errors/99/fix" },
  { name: "fix/rejects-get", method: "GET", path: "/api/errors/1/fix" },
];

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
}

const credentials = new Map<Runtime, string>();

async function send(runtime: Runtime, method: string, path: string): Promise<Answer> {
  const credential = credentials.get(runtime) ?? "";
  const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    method,
    headers: credential ? { authorization: `Bearer ${credential}` } : {},
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

/** Whatever the repro directory holds, by name and by content. */
async function readSaved(runtime: Runtime): Promise<unknown> {
  const dir = join(runtime.workspace, ".nomoreide", "repros");
  try {
    const names = (await readdir(dir)).sort();
    const files = await Promise.all(
      names.map(async (name) => ({
        // The name carries a timestamp; only its shape is comparable.
        name: name.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z/, "<stamp>"),
        contents: await readFile(join(dir, name), "utf8"),
      })),
    );
    return { files };
  } catch (error) {
    return { missing: (error as NodeJS.ErrnoException).code ?? String(error) };
  }
}

/**
 * Erase each runtime's own paths, the pids and the instants. The markdown
 * itself survives, which is the point — a heading that moved or a line that
 * stopped being quoted still fails.
 */
function normalize(value: unknown, runtime: Runtime): unknown {
  const text = JSON.stringify(value ?? null)
    .split(`/private${runtime.home}`)
    .join("<home>")
    .split(runtime.home)
    .join("<home>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<at>")
    // The saved file is stamped with an ISO instant, dashes for colons.
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/g, "<stamp>")
    .replace(/"pid":\s*\d+/g, '"pid":<pid>')
    .replace(/- pid: \d+/g, "- pid: <pid>")
    // The bundle is markdown, so the pid appears as prose too.
    .replace(/\*\*PID:\*\* \d+/g, "**PID:** <pid>")
    .replace(/\*\*Uptime:\*\*[^\\n]*/g, "**Uptime:** <uptime>")
    .replace(/\bsnap_[0-9a-z]+/g, "<snapshot>")
    .replace(/\bses_[0-9a-z]+/g, "<session>")
    // Agent session ids are minted from a clock and a random suffix.
    .replace(/\bs-[0-9a-z]+-[0-9a-z]+/g, "<session>");
  return JSON.parse(text);
}

const root = await mkdtemp(join(tmpdir(), "nmi-errors-bundle-parity-"));
const harness = new RuntimeHarness(root);
let failures = 0;

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      spec,
      ({ workspace }) => ({
        version: 1,
        services: [{ name: "errorer", command: ERRORER, cwd: workspace }],
        bundles: [],
        databases: [],
        gitRepositories: [],
      }),
      () => [{ path: ".env", contents: ENV_FILE }],
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

  // Make the incident, then take the service away again so nothing in the
  // bundle depends on a live process.
  for (const runtime of runtimes) {
    await send(runtime, "POST", "/api/services/errorer/start");
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  for (const runtime of runtimes) {
    await send(runtime, "POST", "/api/services/errorer/stop");
  }
  await new Promise((resolve) => setTimeout(resolve, 500));

  for (const step of steps) {
    const answers =
      step.kind === "file"
        ? { reference: await readSaved(reference), candidate: await readSaved(candidate) }
        : {
            reference: await send(reference, step.method, step.path),
            candidate: await send(candidate, step.method, step.path),
          };
    if (dump) {
      console.log(`--- ${step.name} ---`);
      console.log(`  reference: ${inspect(answers.reference, { depth: null })}`);
      console.log(`  candidate: ${inspect(answers.candidate, { depth: null })}`);
    }
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
  console.log(`\nerrors-bundle parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\nerrors-bundle parity: ${steps.length} cases match`);
