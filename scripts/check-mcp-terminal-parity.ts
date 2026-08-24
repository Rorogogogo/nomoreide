/**
 * Phase 5 terminal parity gate.
 *
 * The three tools that reach a live PTY. Nothing here reads either
 * implementation: both runtimes get a private home, an identical service
 * config, and the same ordered sequence of daemon calls, and what each one
 * reported is diffed.
 *
 * Two things make this gate different from the others.
 *
 * **No tool creates a session.** A terminal is a PTY with a process attached
 * and it lives only in the daemon's memory, so it cannot be planted on disk the
 * way a deploy connection was. The gate drives each runtime's own
 * `POST /api/terminal/sessions` to make one — which is the honest way to say
 * it: that endpoint is the only thing that creates a session, and the tools
 * only ever read or move what it left behind.
 *
 * **The interesting id needs encoding.** A service terminal takes a stable
 * `svc:<name>` id, so a service named `needs encoding#hash` produces a session
 * whose id has to survive being made into a URL path segment. Left unencoded
 * the `#` truncates the path at a fragment and the request reaches a different
 * endpoint entirely — which the answer alone would report as a plain "unknown
 * session". Every step naming that session is therefore a check on the
 * encoding as much as on the tool.
 *
 * What is deliberately not compared: opening a *running* agent session really
 * launches Terminal.app. The lease, the attach socket, and the
 * `terminalLaunching` presentation behind it cannot be exercised without taking
 * over the developer's desktop. Every refusal in front of that launch is
 * reachable and is compared, including the one that needs a real agent session
 * — a stub provider binary that has already exited.
 *
 * Usage:
 *   node --import tsx scripts/check-mcp-terminal-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  candidateSpec,
  delay,
  normalizeRuntimePayload,
  referenceSpec,
  RuntimeHarness,
  toolPayload,
  type Runtime,
  type RuntimeSpec,
  type WorkspaceFile,
} from "../test/support/runtime-parity.js";

/** A session the gate creates before the tools are asked about it. */
interface Create {
  /** What `POST /api/terminal/sessions` is given. */
  readonly body: Record<string, unknown>;
  /** Milliseconds to wait afterwards, for a session that is meant to end. */
  readonly settle?: number;
}

/**
 * A step that compares one MCP tool's answer, or one answer from the endpoint
 * the gate itself depends on.
 *
 * The create endpoint is compared because everything else here is built on it:
 * a runtime that refused a request the other accepted, or refused it in
 * different words, would change what every later step is looking at. No MCP
 * tool reaches it, so this gate is the only place it is held.
 */
type Step =
  | {
      readonly name: string;
      /** Sessions to create before this step's call, in order. */
      readonly create?: readonly Create[];
      readonly tool: string;
      readonly args?: Record<string, unknown>;
    }
  | {
      readonly name: string;
      /** A create whose status and body are compared rather than assumed. */
      readonly createAnswer: Record<string, unknown>;
    };

/** An id carrying a control character, which the schema refuses. */
const CONTROL_ID = "a\u0001b";

/**
 * One ordered walk. Sessions accumulate, so each list step is also a check that
 * the ones before it are still reported, still in the order they were made.
 */
const PLAN: Step[] = [
  { name: "list/none", tool: "nomoreide_list_terminal_sessions" },
  { name: "open/unknown", tool: "nomoreide_open_terminal", args: { id: "nope" } },
  { name: "reclaim/unknown", tool: "nomoreide_reclaim_terminal", args: { id: "nope" } },

  // A plain workspace shell: the `+` tab.
  {
    name: "list/one-shell",
    create: [{ body: {} }],
    tool: "nomoreide_list_terminal_sessions",
  },
  { name: "open/shell", tool: "nomoreide_open_terminal", args: { id: "term_1" } },
  // Reclaim checks neither kind nor state — it resets whatever it finds — so a
  // shell session reclaims successfully and reports itself unchanged.
  { name: "reclaim/shell", tool: "nomoreide_reclaim_terminal", args: { id: "term_1" } },
  { name: "list/after-reclaim", tool: "nomoreide_list_terminal_sessions" },

  // Service sessions, including the one whose id has to be encoded.
  {
    name: "list/services",
    create: [
      { body: { serviceName: "local-with-env" } },
      { body: { serviceName: "needs encoding#hash" } },
      // Neither stub exists on PATH, so both of these fail to spawn and are
      // reaped. That is deliberate — it is the only place a *service* session
      // is observed in its ended state — but the reaping is asynchronous on
      // both sides, so the list waits for it rather than racing it.
      { body: { serviceName: "remote" } },
      { body: { serviceName: "composed" }, settle: 2_000 },
    ],
    tool: "nomoreide_list_terminal_sessions",
  },
  {
    name: "open/encoded-id",
    tool: "nomoreide_open_terminal",
    args: { id: "svc:needs encoding#hash" },
  },
  {
    name: "reclaim/encoded-id",
    tool: "nomoreide_reclaim_terminal",
    args: { id: "svc:needs encoding#hash" },
  },
  // A near-miss id: the same session with the fragment lopped off. If a runtime
  // dropped the `#` rather than encoding it, this is the id its request
  // actually carried — so this step and the two above disagree unless the
  // encoding is real.
  {
    name: "open/truncated-id",
    tool: "nomoreide_open_terminal",
    args: { id: "svc:needs encoding" },
  },
  // Reopening a service tab reattaches rather than spawning a second shell, so
  // the list is unchanged.
  {
    name: "list/service-reopened",
    create: [{ body: { serviceName: "local-with-env" } }],
    tool: "nomoreide_list_terminal_sessions",
  },

  // An agent session whose provider binary exits immediately. This is the only
  // way to reach the "not running" refusal without launching a real terminal.
  {
    name: "list/agent-exited",
    create: [{ body: { agent: { provider: "codex", prompt: "review this" } }, settle: 1_500 }],
    tool: "nomoreide_list_terminal_sessions",
  },
  { name: "open/exited-agent", tool: "nomoreide_open_terminal", args: { id: "term_2" } },
  { name: "reclaim/exited-agent", tool: "nomoreide_reclaim_terminal", args: { id: "term_2" } },

  // The create endpoint the gate itself leans on, answering for itself.
  { name: "create/unknown-service", createAnswer: { serviceName: "not-registered" } },
  // Not a refusal: a name that is only whitespace is no name at all, and falls
  // through to the plain workspace shell.
  { name: "create/blank-service-is-a-shell", createAnswer: { serviceName: "   " } },
  {
    name: "create/bad-provider",
    createAnswer: { agent: { provider: "gemini", prompt: "" } },
  },
  {
    name: "create/bad-resume-id",
    createAnswer: { agent: { provider: "codex", prompt: "", resumeId: "zz" } },
  },
  {
    name: "create/bad-model",
    createAnswer: { agent: { provider: "codex", prompt: "", model: "--oops" } },
  },

  // Refusals decided before a tool runs.
  { name: "error/missing-id", tool: "nomoreide_open_terminal", args: {} },
  { name: "error/empty-id", tool: "nomoreide_open_terminal", args: { id: "" } },
  { name: "error/slash-id", tool: "nomoreide_open_terminal", args: { id: "a/b" } },
  { name: "error/backslash-id", tool: "nomoreide_reclaim_terminal", args: { id: "a\\b" } },
  { name: "error/control-id", tool: "nomoreide_open_terminal", args: { id: CONTROL_ID } },
  { name: "error/too-long-id", tool: "nomoreide_open_terminal", args: { id: "x".repeat(201) } },
  { name: "error/longest-allowed-id", tool: "nomoreide_open_terminal", args: { id: "x".repeat(200) } },
  { name: "error/numeric-id", tool: "nomoreide_open_terminal", args: { id: 7 } },
  // An undeclared key is stripped rather than refused.
  {
    name: "error/extra-key",
    tool: "nomoreide_list_terminal_sessions",
    args: { unexpected: true },
  },
];

const argv = process.argv.slice(2);
const dump = argv.includes("--dump");
const candidateArgv = argv.filter((entry) => entry !== "--dump");
if (candidateArgv.length === 0) {
  throw new Error(
    "Usage: node --import tsx scripts/check-mcp-terminal-parity.ts [--dump] <candidate-command> [args...]",
  );
}

const root = await mkdtemp(join(tmpdir(), "nomoreide-terminal-parity-"));
const harness = new RuntimeHarness(root);

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(candidateArgv)] satisfies RuntimeSpec[]) {
    runtimes.push(
      await harness.provision(
        spec,
        (runtime) => config(runtime.workspace),
        () => workspaceFiles(),
      ),
    );
  }

  // Serial rather than concurrent: these spawn real PTYs and reap real process
  // groups, and two runtimes doing that at once turns a slow machine into
  // failures that look like divergences.
  const transcripts = new Map<string, Map<string, unknown>>();
  for (const runtime of runtimes) {
    await harness.startDaemon(runtime, agentEnv(runtime));
    transcripts.set(runtime.label, await walk(runtime));
  }

  const [reference, candidate] = runtimes;
  const referenceRun = transcripts.get(reference.label)!;
  const candidateRun = transcripts.get(candidate.label)!;

  if (dump) {
    for (const step of PLAN) {
      process.stdout.write(`\n=== ${step.name} ===\n`);
      process.stdout.write(`--- reference\n${format(referenceRun.get(step.name))}\n`);
      process.stdout.write(`--- candidate\n${format(candidateRun.get(step.name))}\n`);
    }
  }

  const divergences: string[] = [];
  for (const step of PLAN) {
    const expected = normalizeRuntimePayload(referenceRun.get(step.name), runtimes);
    const actual = normalizeRuntimePayload(candidateRun.get(step.name), runtimes);
    try {
      assert.deepStrictEqual(actual, expected);
      // `deepStrictEqual` treats an object as unordered, and these payloads are
      // rendered to JSON for an agent to read — so the key order is part of the
      // answer and is held separately.
      assert.equal(JSON.stringify(actual), JSON.stringify(expected));
    } catch {
      divergences.push(
        `\n### ${step.name}${"tool" in step ? ` (${step.tool})` : ""}` +
          `\n--- reference\n${format(expected)}\n--- candidate\n${format(actual)}` +
          `\n--- reference JSON\n${JSON.stringify(expected)}` +
          `\n--- candidate JSON\n${JSON.stringify(actual)}`,
      );
    }
  }

  if (divergences.length > 0) {
    throw new Error(
      `${divergences.length} of ${PLAN.length} terminal parity steps diverged:${divergences.join("\n")}`,
    );
  }

  process.stdout.write(`MCP terminal parity passed (${PLAN.length} steps).\n`);
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}

async function walk(runtime: Runtime): Promise<Map<string, unknown>> {
  const transcript = new Map<string, unknown>();
  for (const step of PLAN) {
    if ("createAnswer" in step) {
      transcript.set(step.name, await postSession(runtime, step.createAnswer));
      continue;
    }
    for (const created of step.create ?? []) {
      await createSession(runtime, created.body);
      if (created.settle) await delay(created.settle);
    }
    const response = await harness.call(runtime, step.tool, step.args ?? {}, agentEnv(runtime));
    transcript.set(step.name, toolPayload(response));
  }
  return transcript;
}

/**
 * Ask one runtime's daemon to create a session.
 *
 * The native daemon authenticates every endpoint and the reference does not, so
 * the credential is sent when the runtime has written one. The response is
 * asserted rather than ignored: a step whose session was never created would
 * otherwise be compared as two identical "unknown session" answers and pass.
 */
async function createSession(runtime: Runtime, body: Record<string, unknown>): Promise<void> {
  const { status, body: answered } = await postSession(runtime, body);
  if (status !== 201) {
    throw new Error(
      `${runtime.label}: creating a terminal session returned ${status}: ` +
        `${JSON.stringify(answered)}`,
    );
  }
}

/** POST the create endpoint and hand back what it answered, refusals included. */
async function postSession(
  runtime: Runtime,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const credential = await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
    .then((value) => value.trim())
    .catch(() => "");
  const response = await fetch(`http://127.0.0.1:${runtime.port}/api/terminal/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* a non-JSON body is compared as the text it was */
  }
  return { status: response.status, body: parsed };
}

/**
 * A provider stub that exits immediately, so an agent session can be observed
 * in its ended state without a real CLI or a real terminal window.
 */
function agentEnv(runtime: Runtime): Record<string, string> {
  return { NOMOREIDE_CODEX_BIN: join(runtime.workspace, "stubs", "codex") };
}

function config(workspace: string): unknown {
  return {
    version: 1,
    services: [
      // Its `env` is deliberately written in a non-alphabetical order: the
      // assignments a local service contributes reach its shell, and two
      // runtimes reading them out of differently-ordered maps would build
      // different argv.
      {
        name: "local-with-env",
        kind: "local",
        command: "true",
        cwd: workspace,
        env: { Z_LAST: "z value", A_FIRST: "a value" },
      },
      { name: "needs encoding#hash", kind: "local", command: "true", cwd: workspace },
      { name: "remote", kind: "ssh", command: "true", cwd: "/srv/app", host: "parity-host" },
      {
        name: "composed",
        kind: "docker-compose",
        command: "true",
        cwd: workspace,
        composeService: "web",
      },
    ],
    bundles: [],
    gitRepositories: [],
  };
}

function workspaceFiles(): WorkspaceFile[] {
  return [
    {
      path: "stubs/codex",
      executable: true,
      contents: "#!/bin/sh\nexit 7\n",
    },
  ];
}

function format(value: unknown): string {
  return inspect(value, { depth: null, colors: false, breakLength: 100, sorted: true });
}
