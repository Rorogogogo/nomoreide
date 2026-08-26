/**
 * Phase 6 parity gate for workflow triggers:
 *
 *   GET    /api/workflow-triggers
 *   POST   /api/workflow-triggers
 *   DELETE /api/workflow-triggers/:id
 *   GET    /api/workflow-triggers/pending
 *   POST   /api/workflow-triggers/pending/:id/ack
 *
 * (The fifth endpoint, `/pending/stream`, is Server-Sent Events and is not
 * served natively yet.)
 *
 * **Almost all of this is one schema.** Six fields, two with defaults, one an
 * enum — and the route hands back the validator's own report rather than a
 * sentence, so the cases are mostly about what a `ZodError`'s message *is*: the
 * issue array as pretty JSON, in shape order, with a key order that differs by
 * issue code. An enum gets three different shapes depending on whether it was
 * missing, the wrong type, or simply not one of the options.
 *
 * **What is stored is not what was sent.** The schema is not strict, so an
 * unknown key validates and is then dropped; a missing `enabled` or `autoRun`
 * is filled in with its default; an absent `filter` stays absent rather than
 * becoming empty. The listing after each write is what makes that visible.
 *
 * **`pending` is a static path under a parameterised one.** A `GET` reaches the
 * queue; a `DELETE` falls through to the `:id` pattern and deletes a trigger
 * called `pending`. Both are cases here.
 *
 * The queue itself is empty on both sides: nothing in a gate fires a trigger.
 * That is what the routes answer, not a stub — but it does mean these cases
 * prove the shape of an empty queue and nothing about a full one.
 *
 * Usage:
 *   node --import tsx scripts/check-workflow-triggers-parity.ts <candidate> [args...]
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
    "Usage: node --import tsx scripts/check-workflow-triggers-parity.ts [--dump] <candidate> [args...]",
  );
}

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly body?: string;
  /** Read the config file on disk rather than sending a request. */
  readonly config?: true;
}

const TRIGGERS = "/api/workflow-triggers";
const ok = (id: string, extra = "") =>
  `{"id":"${id}","workflowId":"deploy","event":"ci-failure"${extra}}`;

const steps: readonly Step[] = [
  { name: "list/empty", method: "GET", path: TRIGGERS },

  // --- the schema: what is missing -------------------------------------------
  { name: "save/an-empty-body", method: "POST", path: TRIGGERS, body: "{}" },
  { name: "save/no-body-at-all", method: "POST", path: TRIGGERS },
  // Not an object, so no field is reached and the report is one issue at the root.
  { name: "save/a-body-that-is-an-array", method: "POST", path: TRIGGERS, body: "[]" },
  // `readJson` turns a non-object into `{}`, so these two report every field.
  { name: "save/a-body-that-is-a-string", method: "POST", path: TRIGGERS, body: '"nope"' },
  { name: "save/a-body-that-is-null", method: "POST", path: TRIGGERS, body: "null" },
  { name: "save/a-body-that-is-not-json", method: "POST", path: TRIGGERS, body: "{oops" },
  { name: "save/only-an-id", method: "POST", path: TRIGGERS, body: '{"id":"a"}' },

  // --- the schema: what is wrong ---------------------------------------------
  { name: "save/a-blank-id", method: "POST", path: TRIGGERS, body: ok("") },
  { name: "save/a-blank-workflow-id", method: "POST", path: TRIGGERS, body: '{"id":"a","workflowId":"","event":"ci-failure"}' },
  { name: "save/an-id-that-is-a-number", method: "POST", path: TRIGGERS, body: '{"id":7,"workflowId":"deploy","event":"ci-failure"}' },
  { name: "save/an-id-that-is-null", method: "POST", path: TRIGGERS, body: '{"id":null,"workflowId":"deploy","event":"ci-failure"}' },
  // Three shapes for one field: not an option, not a string, not there.
  { name: "save/an-event-that-is-not-an-option", method: "POST", path: TRIGGERS, body: '{"id":"a","workflowId":"deploy","event":"deploy-failed"}' },
  { name: "save/an-event-that-is-a-number", method: "POST", path: TRIGGERS, body: '{"id":"a","workflowId":"deploy","event":7}' },
  { name: "save/an-event-that-is-blank", method: "POST", path: TRIGGERS, body: '{"id":"a","workflowId":"deploy","event":""}' },
  { name: "save/an-enabled-that-is-a-string", method: "POST", path: TRIGGERS, body: ok("a", ',"enabled":"yes"') },
  { name: "save/an-enabled-that-is-null", method: "POST", path: TRIGGERS, body: ok("a", ',"enabled":null') },
  { name: "save/a-filter-that-is-a-number", method: "POST", path: TRIGGERS, body: ok("a", ',"filter":3') },
  // `null` is not `undefined`: an optional field that was sent as null is a
  // value of the wrong type, not an absent one.
  { name: "save/a-filter-that-is-null", method: "POST", path: TRIGGERS, body: ok("a", ',"filter":null') },
  { name: "save/an-auto-run-that-is-an-object", method: "POST", path: TRIGGERS, body: ok("a", ',"autoRun":{}') },
  // Everything wrong at once, so the report's *order* is what is being read.
  { name: "save/every-field-wrong", method: "POST", path: TRIGGERS, body: '{"id":1,"workflowId":2,"event":3,"enabled":4,"filter":5,"autoRun":6}' },

  // --- the schema: what works ------------------------------------------------
  { name: "save/the-minimum", method: "POST", path: TRIGGERS, body: ok("one") },
  { name: "save/every-field", method: "POST", path: TRIGGERS, body: '{"id":"two","workflowId":"tidy","event":"service-crash","enabled":false,"filter":"api","autoRun":true}' },
  // Not strict, so the unknown key validates — and is then dropped.
  { name: "save/an-unknown-key", method: "POST", path: TRIGGERS, body: ok("three", ',"colour":"red","id2":"x"') },
  { name: "save/a-blank-filter", method: "POST", path: TRIGGERS, body: ok("four", ',"filter":""') },
  { name: "save/each-event", method: "POST", path: TRIGGERS, body: ok("five", "").replace("ci-failure", "error-incident") },
  { name: "save/the-config-so-far", method: "GET", path: "", config: true },

  // --- replacing -------------------------------------------------------------
  // Same id, so it replaces — and moves to the end of the list.
  { name: "save/the-same-id-again", method: "POST", path: TRIGGERS, body: '{"id":"one","workflowId":"other","event":"service-crash","enabled":false}' },
  { name: "save/an-id-that-differs-only-by-space", method: "POST", path: TRIGGERS, body: '{"id":" one ","workflowId":"spaced","event":"ci-failure"}' },

  // --- deleting --------------------------------------------------------------
  { name: "delete/a-trigger", method: "DELETE", path: `${TRIGGERS}/two` },
  { name: "delete/an-id-that-is-not-there", method: "DELETE", path: `${TRIGGERS}/nope` },
  // Trimmed before it is matched, so this removes the trigger stored as " one ".
  { name: "delete/an-encoded-id-with-spaces", method: "DELETE", path: `${TRIGGERS}/%20one%20` },
  { name: "delete/an-encoded-id", method: "DELETE", path: `${TRIGGERS}/thr%65e` },
  { name: "delete/the-config-afterwards", method: "GET", path: "", config: true },

  // --- the pending queue -----------------------------------------------------
  { name: "pending/the-queue", method: "GET", path: `${TRIGGERS}/pending` },
  { name: "pending/acknowledging-nothing", method: "POST", path: `${TRIGGERS}/pending/anything/ack` },
  { name: "pending/an-encoded-ack-id", method: "POST", path: `${TRIGGERS}/pending/a%2Fb/ack` },
  { name: "pending/a-wrong-method-on-ack", method: "GET", path: `${TRIGGERS}/pending/anything/ack` },
  // Falls through to the `:id` pattern, so this deletes a trigger called
  // `pending` — which does not exist, and is therefore a success.
  { name: "pending/deleting-the-queue-path", method: "DELETE", path: `${TRIGGERS}/pending` },
  { name: "pending/a-post-to-the-queue-path", method: "POST", path: `${TRIGGERS}/pending`, body: "{}" },

  // --- methods ---------------------------------------------------------------
  // An exact route in the reference, so a wrong method reaches the shell.
  { name: "method/put-on-the-collection", method: "PUT", path: TRIGGERS },
  { name: "method/get-on-one-trigger", method: "GET", path: `${TRIGGERS}/one` },
  { name: "method/put-on-one-trigger", method: "PUT", path: `${TRIGGERS}/one` },
  { name: "list/at-the-end", method: "GET", path: TRIGGERS },
];

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
}

async function send(runtime: Runtime, step: Step): Promise<Answer> {
  if (step.config) {
    const raw = await readFile(
      join(runtime.home, ".config", "nomoreide", "config.json"),
      "utf8",
    ).catch(() => "");
    return { status: 0, contentType: null, body: raw ? JSON.parse(raw) : raw };
  }
  const credential = await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
    .then((value) => value.trim())
    .catch(() => "");
  const headers: Record<string, string> = {
    ...(credential ? { authorization: `Bearer ${credential}` } : {}),
    "content-type": "application/json",
  };
  const response = await fetch(`http://127.0.0.1:${runtime.port}${step.path}`, {
    method: step.method,
    headers,
    body: step.method === "GET" ? undefined : step.body,
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

function normalize(answer: Answer, runtime: Runtime): Answer {
  const erased = JSON.stringify(answer.body)
    .split(`/private${runtime.home}`)
    .join("<home>")
    .split(runtime.home)
    .join("<home>");
  return { ...answer, body: JSON.parse(erased) };
}

const root = await mkdtemp(join(tmpdir(), "nmi-workflow-triggers-parity-"));
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
    await harness.startDaemon(runtime, {});
    runtimes.push(runtime);
  }
  const [reference, candidate] = runtimes;

  for (const step of steps) {
    const answers = {
      reference: await send(reference, step),
      candidate: await send(candidate, step),
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
  console.log(`\nworkflow-triggers parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\nworkflow-triggers parity: ${steps.length} cases match`);
