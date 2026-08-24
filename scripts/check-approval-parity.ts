/**
 * Phase 5 approval-broker parity gate.
 *
 * The two endpoints either side of a tool-permission decision. No MCP tool
 * reaches them — the caller is an agent CLI's hook, which blocks on the answer
 * — so this gate drives the daemon's HTTP surface directly, the way the
 * terminal gate drives `POST /api/terminal/sessions`.
 *
 * **What is reachable, and why that is the interesting part.** A decision needs
 * a run, a run needs a spawned agent CLI, and neither runtime can be made to
 * spawn one inside a gate. Everything this gate can reach is therefore a
 * *refusal*: no session, an unopened session, a body that is empty, malformed,
 * or the wrong shape. That is exactly the surface worth holding. The refusals
 * are what a hook hits when something has already gone wrong, they are the only
 * thing standing between a stray POST and an approved tool call, and they must
 * fail closed identically in both runtimes. The path where a human really
 * decides is held by the core crate's own tests instead.
 *
 * Two divergences are declared rather than compared, and both are asserted so
 * that closing one fails this gate instead of passing silently:
 *
 * - **A malformed body's prose.** The reference surfaces its JSON engine's
 *   parse error, which names a byte offset. A different parser cannot reproduce
 *   the wording. Status and shape are compared; the message is not.
 * - **A wrong method on an exact route.** The reference's `route()` declines to
 *   match on a method mismatch and falls through to the SPA shell's catch-all,
 *   answering `404 text/html`. The native daemon does not serve that shell yet,
 *   so axum answers `405 application/json`. This closes in Phase 6, when the
 *   Rust daemon serves the compiled assets.
 *
 * Usage:
 *   node --import tsx scripts/check-approval-parity.ts <candidate> [args...]
 *   ... --dump    print both answers per case
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

/** One request, sent identically to both runtimes. */
interface Case {
  readonly name: string;
  readonly path: string;
  /** The raw body, byte for byte — malformed bodies are the point. */
  readonly body: string;
  readonly method?: string;
  /**
   * The reference leaks its JSON engine's parse message here. Compare the
   * status and `ok`, drop the prose.
   */
  readonly engineMessage?: boolean;
  /** Declared divergence: assert each side separately instead of diffing. */
  readonly divergent?: { readonly reference: Answer; readonly candidate: Answer };
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

const APPROVAL = "/api/agent/chat/approval";
const APPROVE = "/api/agent/chat/approve";

/**
 * A wrong method on an exact route. Both sides refuse; they disagree on how,
 * for a structural reason that Phase 6 closes.
 */
const methodDivergence = {
  reference: { status: 404, body: "Not found" },
  candidate: { status: 405, body: { ok: false, error: "Method not allowed" } },
} as const;

const cases: readonly Case[] = [
  // --- the hook side: every answer is a deny carried by a 200, because the
  // caller is an agent waiting for a verdict and a non-2xx reads as a broken
  // hook rather than as "not allowed".
  {
    name: "approval/no-session",
    path: APPROVAL,
    body: JSON.stringify({ requestId: "r1", toolName: "Bash", toolInput: { command: "ls" } }),
  },
  {
    name: "approval/unknown-session",
    path: APPROVAL,
    body: JSON.stringify({ sessionId: "nobody-opened-this", requestId: "r2", toolName: "Bash" }),
  },
  // An empty session id is not a key. A hook that fires before the CLI has
  // reported its session sends one, and a runtime that looked it up would match
  // a channel only by accident.
  {
    name: "approval/empty-session-id",
    path: APPROVAL,
    body: JSON.stringify({ sessionId: "", requestId: "r3" }),
  },
  {
    name: "approval/missing-request-id",
    path: APPROVAL,
    body: JSON.stringify({ sessionId: "s", toolName: "Bash" }),
  },
  // A non-string id is absent, not present-and-wrong: the reference tests
  // `typeof`, so these must not be read as ids.
  {
    name: "approval/request-id-number",
    path: APPROVAL,
    body: JSON.stringify({ sessionId: "s", requestId: 7 }),
  },
  {
    name: "approval/request-id-null",
    path: APPROVAL,
    body: JSON.stringify({ sessionId: "s", requestId: null }),
  },
  { name: "approval/malformed", path: APPROVAL, body: "{not json" },
  // Empty and whitespace bodies become `{}` — a *missing field*, not a
  // malformed one. The two answer differently and a port can easily merge them.
  { name: "approval/empty-body", path: APPROVAL, body: "" },
  { name: "approval/whitespace-body", path: APPROVAL, body: "  \n  " },
  // Reading a field off an array or a string finds nothing, which is again
  // missing rather than malformed. A typed extractor would refuse these.
  { name: "approval/json-array", path: APPROVAL, body: "[1,2,3]" },
  { name: "approval/json-string", path: APPROVAL, body: '"hello"' },
  // Literal null throws in the reference and answers 500. Mirrored on purpose;
  // see the note in the Rust route module.
  { name: "approval/json-null", path: APPROVAL, body: "null" },
  { name: "approval/no-tool-name", path: APPROVAL, body: JSON.stringify({ requestId: "r4" }) },
  {
    name: "approval/extra-keys",
    path: APPROVAL,
    body: JSON.stringify({ requestId: "r5", unexpected: 1, toolInput: { nested: [1, { a: 2 }] } }),
  },
  {
    name: "approval/get",
    path: APPROVAL,
    body: "",
    method: "GET",
    divergent: methodDivergence,
  },

  // --- the decision side: a stale request is `ok: false` at 200; a request
  // that was never well-formed is a 400.
  {
    name: "approve/unknown",
    path: APPROVE,
    body: JSON.stringify({ sessionId: "s", requestId: "r", decision: "allow" }),
  },
  {
    name: "approve/missing-session",
    path: APPROVE,
    body: JSON.stringify({ requestId: "r", decision: "allow" }),
  },
  {
    name: "approve/missing-request",
    path: APPROVE,
    body: JSON.stringify({ sessionId: "s", decision: "allow" }),
  },
  { name: "approve/both-missing", path: APPROVE, body: JSON.stringify({ decision: "allow" }) },
  {
    name: "approve/session-number",
    path: APPROVE,
    body: JSON.stringify({ sessionId: 1, requestId: "r" }),
  },
  // Anything that is not exactly "allow" denies, so a garbled decision fails
  // closed rather than granting the call.
  {
    name: "approve/decision-garbage",
    path: APPROVE,
    body: JSON.stringify({ sessionId: "s", requestId: "r", decision: "maybe" }),
  },
  {
    name: "approve/decision-missing",
    path: APPROVE,
    body: JSON.stringify({ sessionId: "s", requestId: "r" }),
  },
  {
    name: "approve/decision-allow-uppercase",
    path: APPROVE,
    body: JSON.stringify({ sessionId: "s", requestId: "r", decision: "Allow" }),
  },
  {
    name: "approve/with-reason",
    path: APPROVE,
    body: JSON.stringify({ sessionId: "s", requestId: "r", decision: "deny", reason: "no" }),
  },
  { name: "approve/malformed", path: APPROVE, body: "{not json", engineMessage: true },
  { name: "approve/empty-body", path: APPROVE, body: "" },
  { name: "approve/json-array", path: APPROVE, body: "[1,2,3]" },
  { name: "approve/json-null", path: APPROVE, body: "null" },
  { name: "approve/get", path: APPROVE, body: "", method: "GET", divergent: methodDivergence },
];

const dump = process.argv.includes("--dump");
const argv = process.argv.slice(2).filter((value) => value !== "--dump");
if (argv.length === 0) {
  console.error("Usage: check-approval-parity.ts <candidate> [args...]");
  process.exit(2);
}

const root = await mkdtemp(join(tmpdir(), "nmi-approval-parity-"));
const harness = new RuntimeHarness(root);
let failures = 0;

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      spec,
      () => ({ version: 1, services: [], bundles: [], gitRepositories: [] }),
      () => [],
    );
    await harness.startDaemon(runtime);
    runtimes.push(runtime);
  }
  const [reference, candidate] = runtimes;

  for (const testCase of cases) {
    const answers = {
      reference: await send(reference, testCase),
      candidate: await send(candidate, testCase),
    };
    if (dump) {
      console.log(`--- ${testCase.name} ---`);
      console.log(`  reference: ${inspect(answers.reference, { depth: null })}`);
      console.log(`  candidate: ${inspect(answers.candidate, { depth: null })}`);
    }

    try {
      if (testCase.divergent) {
        // Asserted rather than skipped, so that closing the divergence fails
        // here and says so, instead of passing unnoticed.
        assert.deepStrictEqual(
          answers.reference,
          testCase.divergent.reference,
          "the reference side of a declared divergence changed",
        );
        assert.deepStrictEqual(
          answers.candidate,
          testCase.divergent.candidate,
          "the candidate side of a declared divergence changed",
        );
      } else {
        const [left, right] = [answers.reference, answers.candidate].map((answer) =>
          testCase.engineMessage ? withoutEngineMessage(answer) : answer,
        );
        assert.deepStrictEqual(right, left);
        // Key order is part of the payload: the hook reads these as JSON text.
        assert.strictEqual(
          JSON.stringify(right),
          JSON.stringify(left),
          "same fields, different order",
        );
      }
      console.log(`ok   ${testCase.name}`);
    } catch (error) {
      failures += 1;
      console.log(`FAIL ${testCase.name}`);
      console.log(`  reference: ${inspect(answers.reference, { depth: null })}`);
      console.log(`  candidate: ${inspect(answers.candidate, { depth: null })}`);
      console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? `\napproval parity: ${cases.length} cases match`
    : `\napproval parity: ${failures} of ${cases.length} cases diverged`,
);
process.exit(failures === 0 ? 0 : 1);

/** Send one case to one runtime and report exactly what came back. */
async function send(runtime: Runtime, testCase: Case): Promise<Answer> {
  // The native daemon authenticates every endpoint and the reference does not,
  // so the credential is sent only when the runtime has written one.
  const credential = await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
    .then((value) => value.trim())
    .catch(() => "");
  const method = testCase.method ?? "POST";
  const response = await fetch(`http://127.0.0.1:${runtime.port}${testCase.path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
    },
    ...(method === "POST" ? { body: testCase.body } : {}),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* a non-JSON body is compared as the text it was */
  }
  return { status: response.status, body };
}

/** Replace an engine-specific parse message, keeping the shape around it. */
function withoutEngineMessage(answer: Answer): Answer {
  if (typeof answer.body !== "object" || answer.body === null) return answer;
  const body = answer.body as Record<string, unknown>;
  if (typeof body.error !== "string") return answer;
  return { status: answer.status, body: { ...body, error: "<engine parse message>" } };
}
