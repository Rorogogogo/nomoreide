/**
 * Probe: how the reference answers the two approval-broker endpoints.
 *
 * Reads nothing of the implementation — boots a daemon in a throwaway home and
 * asks it. Point it at the native binary with
 * `NMI_CANDIDATE=./target/debug/nomoreide` to diff the port by eye.
 *
 * Every case here is one the broker can answer *without* an agent session
 * existing, which is the whole default-deny surface: no channel, a malformed
 * body, a missing or mistyped request id. The blocking path — a hook that waits
 * because a channel really is open — is deliberately not probed, because
 * nothing would answer it.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { candidateSpec, referenceSpec, RuntimeHarness } from "../../test/support/runtime-parity.js";

const root = await mkdtemp(join(tmpdir(), "nmi-approval-probe-"));
const harness = new RuntimeHarness(root);

const spec = process.env.NMI_CANDIDATE
  ? candidateSpec([process.env.NMI_CANDIDATE])
  : referenceSpec();
const runtime = await harness.provision(
  spec,
  () => ({ version: 1, services: [], bundles: [], gitRepositories: [] }),
  () => [],
);
await harness.startDaemon(runtime);

const credential = await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
  .then((value) => value.trim())
  .catch(() => "");

/** Send one raw body and report status, content type, and what came back. */
async function post(path: string, raw: string, method = "POST") {
  const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
    },
    ...(method === "POST" ? { body: raw } : {}),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* a non-JSON body is reported as the text it was */
  }
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    body: parsed,
  };
}

const cases: Array<[string, string, string, string?]> = [
  // --- POST /api/agent/chat/approval : the hook side ---
  ["approval/no-session", "/api/agent/chat/approval", JSON.stringify({ requestId: "r1", toolName: "Bash", toolInput: { command: "ls" } })],
  ["approval/unknown-session", "/api/agent/chat/approval", JSON.stringify({ sessionId: "nope", requestId: "r2", toolName: "Bash", toolInput: {} })],
  ["approval/missing-request-id", "/api/agent/chat/approval", JSON.stringify({ sessionId: "s", toolName: "Bash" })],
  ["approval/request-id-number", "/api/agent/chat/approval", JSON.stringify({ sessionId: "s", requestId: 7 })],
  ["approval/request-id-null", "/api/agent/chat/approval", JSON.stringify({ sessionId: "s", requestId: null })],
  ["approval/malformed", "/api/agent/chat/approval", "{not json"],
  ["approval/empty-body", "/api/agent/chat/approval", ""],
  ["approval/whitespace-body", "/api/agent/chat/approval", "   \n  "],
  ["approval/json-null", "/api/agent/chat/approval", "null"],
  ["approval/json-array", "/api/agent/chat/approval", "[1,2,3]"],
  ["approval/json-string", "/api/agent/chat/approval", '"hello"'],
  ["approval/no-tool-name", "/api/agent/chat/approval", JSON.stringify({ requestId: "r3" })],
  ["approval/extra-keys", "/api/agent/chat/approval", JSON.stringify({ requestId: "r4", nope: 1, sessionId: "" })],
  ["approval/empty-session-id", "/api/agent/chat/approval", JSON.stringify({ sessionId: "", requestId: "r5" })],
  ["approval/get", "/api/agent/chat/approval", "", "GET"],

  // --- POST /api/agent/chat/approve : the decision side ---
  ["approve/unknown", "/api/agent/chat/approve", JSON.stringify({ sessionId: "s", requestId: "r", decision: "allow" })],
  ["approve/missing-session", "/api/agent/chat/approve", JSON.stringify({ requestId: "r", decision: "allow" })],
  ["approve/missing-request", "/api/agent/chat/approve", JSON.stringify({ sessionId: "s", decision: "allow" })],
  ["approve/both-missing", "/api/agent/chat/approve", JSON.stringify({ decision: "allow" })],
  ["approve/session-number", "/api/agent/chat/approve", JSON.stringify({ sessionId: 1, requestId: "r" })],
  ["approve/decision-garbage", "/api/agent/chat/approve", JSON.stringify({ sessionId: "s", requestId: "r", decision: "maybe" })],
  ["approve/decision-missing", "/api/agent/chat/approve", JSON.stringify({ sessionId: "s", requestId: "r" })],
  ["approve/with-reason", "/api/agent/chat/approve", JSON.stringify({ sessionId: "s", requestId: "r", decision: "deny", reason: "no" })],
  ["approve/malformed", "/api/agent/chat/approve", "{not json"],
  ["approve/empty-body", "/api/agent/chat/approve", ""],
  ["approve/json-null", "/api/agent/chat/approve", "null"],
  ["approve/get", "/api/agent/chat/approve", "", "GET"],
];

console.log(`# runtime: ${spec.label}\n`);
for (const [name, path, raw, method] of cases) {
  const answered = await post(path, raw, method);
  console.log(`--- ${name} ---`);
  console.log(`  sent: ${method ?? "POST"} ${path} ${raw === "" ? "(no body)" : raw}`);
  console.log(`  got:  ${answered.status} ${answered.type ?? "(no content-type)"}`);
  console.log(`        ${inspect(answered.body, { depth: null, breakLength: 200 })}`);
}

await harness.shutdown();
await rm(root, { recursive: true, force: true });
