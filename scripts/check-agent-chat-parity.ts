/**
 * Phase 6 parity gate for the in-dock agent chat:
 *
 *   GET  /api/agent/chat/status
 *   POST /api/agent/chat/model
 *   POST /api/agent/chat/provider
 *   POST /api/agent/chat            (Server-Sent Events)
 *
 * **The agent CLI is a fake this gate writes.** A real `claude` would need a
 * login, a network, and a model that answers differently every time — none of
 * which a diff can be run against. `NOMOREIDE_CLAUDE_BIN` and
 * `NOMOREIDE_CODEX_BIN` name the binary, so both runtimes are pointed at a
 * script that prints a fixed transcript in the CLI's own NDJSON dialect. What
 * is being gated is the daemon's *reading* of that dialect, which is the whole
 * of what it does with the child.
 *
 * The fake branches on the message it is handed, so one script covers a turn
 * that succeeds, one whose CLI exits non-zero, and one that prints a line
 * nothing can parse. Codex is deliberately left *uninstalled* — a path that
 * does not exist — because "not installed" is a first-class answer here: it is
 * what `configured: false` reports and what the 503 on a turn means.
 *
 * Two details are easy to lose in a port:
 *
 * - **`chat/status` probes every provider, not just the selected one**, so the
 *   dashboard can offer a switch to one that is installed.
 * - **A model is cleared by absence, by null, and by whitespace alike**, and
 *   pinned only by a non-blank string of at most 64 characters.
 *
 * Usage:
 *   node --import tsx scripts/check-agent-chat-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
    "Usage: node --import tsx scripts/check-agent-chat-parity.ts [--dump] <candidate> [args...]",
  );
}

const CHAT = "/api/agent/chat";

/**
 * Claude Code's `--output-format stream-json`, as much of it as the daemon
 * reads: an init line carrying the session, token deltas, a tool call and its
 * result, and a terminal `result`.
 *
 * The message is the last argument, and the script answers to three of them so
 * the failure paths are reachable without a second binary.
 */
const FAKE_CLAUDE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "0.0.0-fake"; exit 0; fi
eval "message=\\\${$#}"
case "$message" in
  "please fail")
    echo "the fake CLI was asked to fail" >&2
    exit 3
    ;;
  "please emit junk")
    echo "this line is not json"
    echo '{"type":"system","subtype":"init","session_id":"sess-fixed"}'
    echo '{"type":"result","subtype":"end_turn"}'
    exit 0
    ;;
esac
echo '{"type":"system","subtype":"init","session_id":"sess-fixed"}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo."}}}'
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}'
echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"a.txt","is_error":false}]}}'
echo '{"type":"result","subtype":"end_turn"}'
exit 0
`;

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: string;
  /** Sent raw, so a body that is not JSON can be one of the cases. */
  readonly raw?: boolean;
  /**
   * Replace `error` with a token before comparing.
   *
   * Used for exactly one thing: a body that is not JSON. The reference reports
   * its JSON engine's own message — `Expected property name or '}' in JSON at
   * position 1 (line 1 column 2)` — which names a byte offset and a token in
   * V8's wording. No other parser reproduces that sentence, and pretending
   * otherwise would mean hard-coding V8's grammar into a Rust daemon.
   *
   * What is still asserted here is everything that matters: the status is 400,
   * the shape is the `{ok:false,error}` envelope, and an error string is
   * *present*. Only the prose is dropped, and only on the two steps that ask
   * for it — a route that answered a parse failure with the wrong status, the
   * wrong shape, or no message still fails.
   */
  readonly maskError?: boolean;
}

const steps: Step[] = [
  { name: "status/before-anything", method: "GET", path: `${CHAT}/status` },

  /* ---- choosing a provider ---- */
  { name: "provider/no-body", method: "POST", path: `${CHAT}/provider`, body: "{}" },
  { name: "provider/a-body-that-is-not-json", method: "POST", path: `${CHAT}/provider`, body: "{oops", raw: true, maskError: true },
  { name: "provider/one-that-does-not-exist", method: "POST", path: `${CHAT}/provider`, body: '{"provider":"nope"}' },
  { name: "provider/one-that-is-a-number", method: "POST", path: `${CHAT}/provider`, body: '{"provider":7}' },
  { name: "provider/codex", method: "POST", path: `${CHAT}/provider`, body: '{"provider":"codex"}' },
  { name: "status/after-choosing-codex", method: "GET", path: `${CHAT}/status` },
  { name: "provider/back-to-claude", method: "POST", path: `${CHAT}/provider`, body: '{"provider":"claude"}' },

  /* ---- pinning a model ---- */
  { name: "model/no-body", method: "POST", path: `${CHAT}/model`, body: "{}" },
  { name: "model/an-unknown-provider", method: "POST", path: `${CHAT}/model`, body: '{"provider":"nope","model":"m"}' },
  { name: "model/a-model-that-is-a-number", method: "POST", path: `${CHAT}/model`, body: '{"provider":"claude","model":7}' },
  { name: "model/one-character-too-long", method: "POST", path: `${CHAT}/model`, body: `{"provider":"claude","model":"${"m".repeat(65)}"}` },
  { name: "model/exactly-at-the-limit", method: "POST", path: `${CHAT}/model`, body: `{"provider":"claude","model":"${"m".repeat(64)}"}` },
  { name: "model/a-real-one", method: "POST", path: `${CHAT}/model`, body: '{"provider":"claude","model":"opus"}' },
  { name: "model/one-for-the-other-provider", method: "POST", path: `${CHAT}/model`, body: '{"provider":"codex","model":"gpt-5"}' },
  { name: "status/with-both-models-pinned", method: "GET", path: `${CHAT}/status` },
  { name: "model/padding-is-trimmed", method: "POST", path: `${CHAT}/model`, body: '{"provider":"claude","model":"  opus  "}' },
  { name: "model/whitespace-clears-it", method: "POST", path: `${CHAT}/model`, body: '{"provider":"claude","model":"   "}' },
  { name: "model/null-clears-it", method: "POST", path: `${CHAT}/model`, body: '{"provider":"codex","model":null}' },
  { name: "model/an-absent-model-clears-it", method: "POST", path: `${CHAT}/model`, body: '{"provider":"claude"}' },
  { name: "status/after-clearing", method: "GET", path: `${CHAT}/status` },

  /* ---- a turn ---- */
  { name: "chat/no-message", method: "POST", path: CHAT, body: "{}" },
  { name: "chat/a-message-that-is-blank", method: "POST", path: CHAT, body: '{"message":"   "}' },
  { name: "chat/a-message-that-is-a-number", method: "POST", path: CHAT, body: '{"message":7}' },
  { name: "chat/a-body-that-is-not-json", method: "POST", path: CHAT, body: "{oops", raw: true, maskError: true },
  { name: "chat/a-provider-that-is-not-installed", method: "POST", path: CHAT, body: '{"message":"hi","provider":"codex"}' },
  { name: "chat/a-turn", method: "POST", path: CHAT, body: '{"message":"hi"}' },
  { name: "chat/a-turn-that-resumes", method: "POST", path: CHAT, body: '{"message":"hi","resumeSessionId":"sess-fixed"}' },
  { name: "chat/a-turn-that-auto-approves", method: "POST", path: CHAT, body: '{"message":"hi","autoApprove":true}' },
  { name: "chat/a-cli-that-exits-non-zero", method: "POST", path: CHAT, body: '{"message":"please fail"}' },
  { name: "chat/a-line-nothing-can-parse", method: "POST", path: CHAT, body: '{"message":"please emit junk"}' },
  { name: "chat/an-unknown-provider-on-the-turn", method: "POST", path: CHAT, body: '{"message":"hi","provider":"nope"}' },

  /* ---- wrong methods ---- */
  { name: "status/wrong-method", method: "POST", path: `${CHAT}/status`, body: "{}" },
  { name: "model/wrong-method", method: "GET", path: `${CHAT}/model` },
  { name: "provider/wrong-method", method: "GET", path: `${CHAT}/provider` },
  { name: "chat/wrong-method", method: "GET", path: CHAT },
];

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
}

const credentials = new Map<string, string>();

async function send(runtime: Runtime, step: Step): Promise<Answer> {
  const credential = credentials.get(runtime.label) ?? "";
  const response = await fetch(`http://127.0.0.1:${runtime.port}${step.path}`, {
    method: step.method,
    headers: {
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      "content-type": "application/json",
    },
    body: step.body,
  });
  // A chat turn is an event stream that ends when the child exits, so reading
  // it to the end is the whole answer — no idle timer needed.
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* SSE and the SPA shell are compared as the text they were */
  }
  if (step.maskError && typeof body === "object" && body !== null) {
    const envelope = body as { error?: unknown };
    if (typeof envelope.error === "string" && envelope.error.length > 0) {
      envelope.error = "<parser's own words>";
    }
  }
  return { status: response.status, contentType: response.headers.get("content-type"), body };
}

function normalize(value: unknown, runtime: Runtime, bin: string): unknown {
  const text = JSON.stringify(value ?? null)
    .split(`/private${runtime.home}`)
    .join("<home>")
    .split(runtime.home)
    .join("<home>")
    .split(`/private${bin}`)
    .join("<bin>")
    .split(bin)
    .join("<bin>")
    .split(`127.0.0.1:${runtime.port}`)
    .join("<daemon>");
  return JSON.parse(text);
}

const root = await mkdtemp(join(tmpdir(), "nmi-agent-chat-parity-"));
const bin = join(root, "bin");
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

const harness = new RuntimeHarness(root);

try {
  await mkdir(bin, { recursive: true });
  const claude = join(bin, "fake-claude");
  await writeFile(claude, FAKE_CLAUDE, "utf8");
  await chmod(claude, 0o755);
  // Deliberately absent: "not installed" is one of the answers being gated.
  const codex = join(bin, "no-codex-here");

  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      spec,
      () => ({ version: 1, services: [], bundles: [], databases: [], gitRepositories: [] }),
      () => [],
    );
    await harness.startDaemon(
      runtime,
      {
        NOMOREIDE_CLAUDE_BIN: claude,
        NOMOREIDE_CODEX_BIN: codex,
        // Pinned, because it decides whether approvals gate a turn and the
        // developer's own shell may have set it.
        NOMOREIDE_AGENT_PERMISSION_MODE: "default",
      },
      runtime.workspace,
    );
    credentials.set(
      runtime.label,
      await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
        .then((value) => value.trim())
        .catch(() => ""),
    );
    runtimes.push(runtime);
  }
  const [reference, candidate] = runtimes;

  for (const step of steps) {
    compare(
      step.name,
      normalize(await send(reference, step), reference, bin),
      normalize(await send(candidate, step), candidate, bin),
    );
  }
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\nagent-chat parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log("\nagent-chat parity: all cases match");
