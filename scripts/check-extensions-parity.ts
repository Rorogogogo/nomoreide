/**
 * Phase 6 parity gate for the two provider-registry reads:
 *
 *   GET /api/extensions
 *   GET /api/providers
 *
 * Both answer from static in-tree data — the deploy and host provider
 * manifests — so there are no fixtures beyond an empty config, and no way for
 * the answers to drift between two runs of the same build. That is what makes
 * them worth gating early: they are the inventory every other provider surface
 * is described by, and a manifest that disagrees between the runtimes is a
 * disagreement about what the product can reach on the network.
 *
 * `/api/extensions` flattens both registries into one neutral row per plugin
 * and `/api/providers` returns the deploy manifests as they are, so the two
 * cases together pin every manifest field twice, from two different shapes.
 *
 * Usage:
 *   node --import tsx scripts/check-extensions-parity.ts <candidate> [args...]
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
    "Usage: node --import tsx scripts/check-extensions-parity.ts [--dump] <candidate> [args...]",
  );
}

interface Step {
  readonly name: string;
  readonly method: string;
  readonly path: string;
}

const steps: Step[] = [
  { name: "extensions/installed", method: "GET", path: "/api/extensions" },
  { name: "providers/manifests", method: "GET", path: "/api/providers" },

  // Key order is content here: a manifest is a document a reader compares
  // field by field, and `deepStrictEqual` would not notice it being rebuilt in
  // a different order.
  { name: "extensions/key-order", method: "GET", path: "/api/extensions" },
  { name: "providers/key-order", method: "GET", path: "/api/providers" },

  // --- paths that match nothing ----------------------------------------------
  { name: "shape/extensions-rejects-post", method: "POST", path: "/api/extensions" },
  { name: "shape/providers-rejects-post", method: "POST", path: "/api/providers" },
  { name: "shape/extensions-with-a-trailing-slash", method: "GET", path: "/api/extensions/" },
  { name: "shape/providers-with-a-trailing-slash", method: "GET", path: "/api/providers/" },
  { name: "shape/a-deeper-extensions-path", method: "GET", path: "/api/extensions/vercel" },
];

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
}

const credentials = new Map<Runtime, string>();

async function send(runtime: Runtime, step: Step): Promise<Answer> {
  const credential = credentials.get(runtime) ?? "";
  const response = await fetch(`http://127.0.0.1:${runtime.port}${step.path}`, {
    method: step.method,
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

/** Every key path in the document, in the order the document lists them. */
function keyOrder(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => keyOrder(item, `${prefix}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => [
      `${prefix}.${key}`,
      ...keyOrder(child, `${prefix}.${key}`),
    ]);
  }
  return [];
}

const root = await mkdtemp(join(tmpdir(), "nmi-extensions-parity-"));
const harness = new RuntimeHarness(root);
let failures = 0;

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      spec,
      () => ({ version: 1, services: [], bundles: [], databases: [], gitRepositories: [] }),
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

  for (const step of steps) {
    const answers = {
      reference: await send(reference, step),
      candidate: await send(candidate, step),
    };
    const pick = (answer: Answer) =>
      step.name.endsWith("key-order") ? keyOrder(answer.body) : answer;
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
  console.log(`\nextensions parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\nextensions parity: ${steps.length} cases match`);
