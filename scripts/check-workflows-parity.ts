/**
 * Phase 6 parity gate for the workflow surface:
 *
 *   GET    /api/workflows
 *   POST   /api/workflows
 *   DELETE /api/workflows/:id
 *
 * A workflow is an ordered list of steps a client-side runner walks, so there
 * is no run endpoint — these three are the whole surface, and they are a read,
 * a save and a delete over config.
 *
 * **The list is a merge, not a table.** The shipped templates come first, and a
 * saved workflow whose id matches one of them *replaces* it in place — that is
 * what forking a template means — while anything else is appended. So saving
 * over `commit-push` must not lengthen the list or reorder it, and deleting
 * that fork must bring the template back.
 *
 * **`builtin` is forced false on save**, so a fork cannot claim to be a shipped
 * template.
 *
 * **Every failure is a 400**, because all three routes wrap everything in one
 * catch. The interesting failures are the schema's: the step list is a
 * discriminated union on `kind`, so an unknown kind is reported once as a bad
 * discriminator rather than as three parallel arm failures.
 *
 * Usage:
 *   node --import tsx scripts/check-workflows-parity.ts <candidate> [args...]
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
    "Usage: node --import tsx scripts/check-workflows-parity.ts [--dump] <candidate> [args...]",
  );
}

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly json?: unknown;
  readonly raw?: string;
}

const gate = { kind: "gate", id: "g", title: "Approve", message: "Go?" };
const action = { kind: "action", id: "a", title: "Push", op: "push" };
const agent = { kind: "agent", id: "s", title: "Draft", prompt: "do a thing" };

const steps: readonly Step[] = [
  { name: "list/the-templates", method: "GET", path: "/api/workflows" },
  { name: "list/wrong-method", method: "PUT", path: "/api/workflows" },

  // --- saving -----------------------------------------------------------------
  { name: "save/a-new-workflow", method: "POST", path: "/api/workflows", json: { id: "mine", name: "Mine", steps: [action] } },
  { name: "save/with-a-description", method: "POST", path: "/api/workflows", json: { id: "described", name: "Described", description: "why", steps: [gate] } },
  { name: "save/every-step-kind", method: "POST", path: "/api/workflows", json: { id: "all-kinds", name: "All kinds", steps: [action, agent, gate] } },
  { name: "save/an-agent-step-that-verifies", method: "POST", path: "/api/workflows", json: { id: "verified", name: "Verified", steps: [{ ...agent, verify: "committed" }] } },
  { name: "save/agent-capabilities", method: "POST", path: "/api/workflows", json: { id: "capable", name: "Capable", steps: [{ ...agent, capabilities: { skills: ["one"], mcpServers: ["two"] } }] } },
  // Replacing a template in place: the list must not grow or reorder.
  { name: "save/over-a-template", method: "POST", path: "/api/workflows", json: { id: "commit-push", name: "My fork", steps: [action] } },
  { name: "save/read-back-the-fork", method: "GET", path: "/api/workflows" },
  // Claiming to be shipped is overwritten rather than refused.
  { name: "save/claiming-to-be-builtin", method: "POST", path: "/api/workflows", json: { id: "liar", name: "Liar", builtin: true, steps: [action] } },
  { name: "save/replacing-itself", method: "POST", path: "/api/workflows", json: { id: "mine", name: "Mine again", steps: [gate] } },

  // --- saving, the refusals ----------------------------------------------------
  { name: "save/no-id", method: "POST", path: "/api/workflows", json: { name: "Nameless", steps: [action] } },
  { name: "save/a-blank-id", method: "POST", path: "/api/workflows", json: { id: "", name: "Blank", steps: [action] } },
  { name: "save/no-name", method: "POST", path: "/api/workflows", json: { id: "x", steps: [action] } },
  { name: "save/no-steps", method: "POST", path: "/api/workflows", json: { id: "x", name: "X" } },
  { name: "save/no-steps-at-all", method: "POST", path: "/api/workflows", json: { id: "x", name: "X", steps: [] } },
  { name: "save/a-step-kind-nobody-knows", method: "POST", path: "/api/workflows", json: { id: "x", name: "X", steps: [{ kind: "wander", id: "w", title: "W" }] } },
  { name: "save/a-step-with-no-kind", method: "POST", path: "/api/workflows", json: { id: "x", name: "X", steps: [{ id: "w", title: "W" }] } },
  { name: "save/an-action-with-no-op", method: "POST", path: "/api/workflows", json: { id: "x", name: "X", steps: [{ kind: "action", id: "a", title: "A" }] } },
  { name: "save/an-op-nobody-knows", method: "POST", path: "/api/workflows", json: { id: "x", name: "X", steps: [{ kind: "action", id: "a", title: "A", op: "deploy" }] } },
  { name: "save/an-agent-with-no-prompt", method: "POST", path: "/api/workflows", json: { id: "x", name: "X", steps: [{ kind: "agent", id: "s", title: "S" }] } },
  { name: "save/a-verify-nobody-knows", method: "POST", path: "/api/workflows", json: { id: "x", name: "X", steps: [{ ...agent, verify: "deployed" }] } },
  { name: "save/a-gate-with-no-message", method: "POST", path: "/api/workflows", json: { id: "x", name: "X", steps: [{ kind: "gate", id: "g", title: "G" }] } },
  { name: "save/a-body-that-is-not-json", method: "POST", path: "/api/workflows", raw: "not json" },
  { name: "save/a-body-that-is-an-array", method: "POST", path: "/api/workflows", json: [1] },

  // --- deleting ----------------------------------------------------------------
  { name: "delete/a-saved-workflow", method: "DELETE", path: "/api/workflows/mine" },
  { name: "delete/the-same-one-again", method: "DELETE", path: "/api/workflows/mine" },
  // Deleting a fork brings the template back.
  { name: "delete/a-fork-of-a-template", method: "DELETE", path: "/api/workflows/commit-push" },
  { name: "delete/read-back", method: "GET", path: "/api/workflows" },
  // A built-in that was never forked cannot be deleted away.
  { name: "delete/an-unforked-template", method: "DELETE", path: "/api/workflows/ship-it" },
  { name: "delete/an-id-with-spaces", method: "DELETE", path: `/api/workflows/${encodeURIComponent("  described  ")}` },
  { name: "delete/an-id-nobody-has", method: "DELETE", path: "/api/workflows/ghost" },
  { name: "delete/wrong-method", method: "PATCH", path: "/api/workflows/mine" },
];

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
}

async function send(runtime: Runtime, step: Step): Promise<Answer> {
  const credential = await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
    .then((value) => value.trim())
    .catch(() => "");
  const headers: Record<string, string> = credential
    ? { authorization: `Bearer ${credential}` }
    : {};
  let body: string | undefined;
  if (step.raw !== undefined) {
    headers["content-type"] = "application/json";
    body = step.raw;
  } else if (step.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(step.json);
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

function erase(value: string, runtime: Runtime): string {
  return value.split(`/private${runtime.home}`).join("<home>").split(runtime.home).join("<home>");
}

function normalize(answer: Answer, runtime: Runtime): Answer {
  return { ...answer, body: JSON.parse(erase(JSON.stringify(answer.body), runtime)) };
}

async function census(runtime: Runtime): Promise<unknown> {
  const raw = await readFile(join(runtime.home, ".config", "nomoreide", "config.json"), "utf8");
  return JSON.parse(erase(raw, runtime));
}

const root = await mkdtemp(join(tmpdir(), "nmi-workflows-parity-"));
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

  const both = { reference: await census(reference), candidate: await census(candidate) };
  try {
    assert.deepStrictEqual(both.candidate, both.reference);
    console.log("ok   workflows/on-disk");
  } catch (error) {
    failures += 1;
    console.log("FAIL workflows/on-disk");
    console.log(`  reference: ${inspect(both.reference, { depth: null })}`);
    console.log(`  candidate: ${inspect(both.candidate, { depth: null })}`);
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
  }
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}

const total = steps.length + 1;
if (failures > 0) {
  console.log(`workflows parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`workflows parity: ${total} cases match`);
