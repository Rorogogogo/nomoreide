/**
 * Phase 6 parity gate for the agent status endpoints:
 *
 *   GET  /api/agent/claude-settings
 *   POST /api/agent/claude-settings
 *   GET  /api/agent/mcp-status
 *   GET  /api/agent/tool-calls
 *
 * The three that read something all read it from outside this program — a
 * hand-editable settings file, and two agent CLIs — so the gate plants a stub
 * `claude` and a stub `codex` on PATH and writes the settings file itself.
 *
 * **`mcp-status` can be observed exactly twice.** `getMcpAuthStatuses` caches
 * per agent for fifteen seconds, and a gate runs in well under that, so the
 * *first* request for each agent is the only one that reaches a CLI. The stub
 * output is therefore built to carry every state mapping in one answer rather
 * than one per case: Claude's five spellings in five lines, and Codex's whole
 * `auth_status` vocabulary in one JSON array. Later requests are still worth
 * asking — they gate that the cache is a cache, and that every spelling of the
 * `agent` parameter that is not `codex` lands on Claude.
 *
 * **The settings file is compared on disk, not just through the API.** The
 * point of the write path is that it *preserves keys it does not own* — a user
 * who hand-edited `~/.claude/settings.json` must not lose data because someone
 * toggled a switch. No response shows that, so `file/` steps read the file out
 * of both homes and diff the bytes. A port that rewrote the file wholesale
 * would pass every request case and fail these.
 *
 * **`tool-calls` is expected to be empty, and that is the finding.** The store
 * is created by the web layer and only ever written by an in-process MCP
 * server; the daemon's MCP clients are separate processes, so nothing reaches
 * it. The cases assert the empty shape and record that the `limit` clamp is
 * unobservable here rather than pretending to gate it.
 *
 * Usage:
 *   node --import tsx scripts/check-agent-status-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    "Usage: node --import tsx scripts/check-agent-status-parity.ts [--dump] <candidate> [args...]",
  );
}

/**
 * `claude mcp list` prints one server per line as
 * `<name>: <url-or-command> - <status>`. Every state the parser can reach is
 * here, plus three lines that must be skipped rather than parsed into a server
 * with a blank name.
 */
const CLAUDE_STUB = String.raw`#!/usr/bin/env node
process.stdout.write(
  "Checking MCP server health...\n" +
    "\n" +
    "linear: https://mcp.linear.app/sse - ✗ Needs authentication\n" +
    "context7: npx -y @upstash/context7-mcp - ✓ Connected\n" +
    "broken: node ./broken.js - ✗ Failed to connect\n" +
    "angry: node ./angry.js - ✗ Error: spawn ENOENT\n" +
    "pending: node ./pending.js - awaiting approval\n" +
    // A colon after the separator: the name is everything before the *first*
    // ": ", so this is a server called "weird".
    "weird: http://x/a - b - ✓ Connected\n" +
    // No " - " at all, so not a server line.
    "just a sentence with a colon: nothing\n" +
    // A " - " before the ": ", which the guard refuses.
    "no name - here: value\n" +
    ": leading colon - ✓ Connected\n",
);
// The real CLI exits non-zero while still printing a usable table, and the
// reference reads the table anyway.
process.exit(1);
`;

/**
 * `codex mcp list --json`. One entry per `auth_status` the mapper knows, in the
 * order the mapper tests them — including `not_logged_in`, which contains
 * `logged_in` and must not be read as connected.
 */
const CODEX_STUB = String.raw`#!/usr/bin/env node
process.stdout.write(
  JSON.stringify([
    { name: "local-fs", auth_status: "unsupported" },
    { name: "no-auth-needed", auth_status: "not_required" },
    { name: "none-at-all", auth_status: "none" },
    { name: "blank", auth_status: "" },
    { name: "absent" },
    { name: "not-logged-in", auth_status: "not_logged_in" },
    { name: "logged-out", auth_status: "logged_out" },
    { name: "expired", auth_status: "expired" },
    { name: "needs-login", auth_status: "needs_login" },
    { name: "required", auth_status: "auth_required" },
    { name: "logged-in", auth_status: "logged_in" },
    { name: "authed", auth_status: "authenticated" },
    { name: "authorized", auth_status: "authorized" },
    { name: "ok", auth_status: "ok" },
    { name: "connected", auth_status: "connected" },
    { name: "who-knows", auth_status: "something-else" },
    { auth_status: "logged_in" },
    { name: 7, auth_status: "logged_in" },
  ]),
);
`;

/**
 * The settings file the gate starts from.
 *
 * The keys around `attribution` are the point: they are what a write has to
 * leave alone, and one of them is nested so a shallow copy is not enough.
 */
const SETTINGS = {
  model: "claude-sonnet-5",
  attribution: { commit: "", pr: "" },
  permissions: { allow: ["Bash(ls:*)"], deny: [] },
  env: { FOO: "bar" },
};

interface RequestStep {
  readonly kind?: "request";
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly body?: unknown;
  readonly raw?: string;
}

/** Reads a file out of each runtime's home and diffs the text. */
interface FileStep {
  readonly kind: "file";
  readonly name: string;
  /** Relative to the runtime's home. */
  readonly path: string;
}

type Step = RequestStep | FileStep;

const steps: readonly Step[] = [
  // --- reading the co-author setting -----------------------------------------
  // The fixture has `{ commit: "", pr: "" }`, which is the one shape that means
  // opted out.
  { name: "settings/opted-out", method: "GET", path: "/api/agent/claude-settings" },
  { name: "settings/wrong-method", method: "DELETE", path: "/api/agent/claude-settings" },

  // --- turning it on ---------------------------------------------------------
  {
    name: "settings/turn-on",
    method: "POST",
    path: "/api/agent/claude-settings",
    body: { coAuthorWithClaude: true },
  },
  { name: "settings/after-turning-on", method: "GET", path: "/api/agent/claude-settings" },
  // Everything else in the file has to still be there, unchanged and in order.
  { kind: "file", name: "file/after-turning-on", path: ".claude/settings.json" },

  // --- turning it off --------------------------------------------------------
  {
    name: "settings/turn-off",
    method: "POST",
    path: "/api/agent/claude-settings",
    body: { coAuthorWithClaude: false },
  },
  { name: "settings/after-turning-off", method: "GET", path: "/api/agent/claude-settings" },
  // `attribution` is back, and where it was re-added matters: key order is part
  // of a file a person edits by hand.
  { kind: "file", name: "file/after-turning-off", path: ".claude/settings.json" },

  // Setting it to what it already is must be a no-op, not a rewrite.
  {
    name: "settings/turn-off-again",
    method: "POST",
    path: "/api/agent/claude-settings",
    body: { coAuthorWithClaude: false },
  },
  { kind: "file", name: "file/after-turning-off-again", path: ".claude/settings.json" },

  // --- what the write path refuses -------------------------------------------
  // A boolean, strictly. None of these are one.
  {
    name: "settings/a-string",
    method: "POST",
    path: "/api/agent/claude-settings",
    body: { coAuthorWithClaude: "true" },
  },
  {
    name: "settings/a-number",
    method: "POST",
    path: "/api/agent/claude-settings",
    body: { coAuthorWithClaude: 1 },
  },
  {
    name: "settings/null",
    method: "POST",
    path: "/api/agent/claude-settings",
    body: { coAuthorWithClaude: null },
  },
  { name: "settings/no-field", method: "POST", path: "/api/agent/claude-settings", body: {} },
  { name: "settings/an-empty-body", method: "POST", path: "/api/agent/claude-settings", raw: "" },
  { name: "settings/a-body-that-is-not-json", method: "POST", path: "/api/agent/claude-settings", raw: "{" },
  // A refusal must not have touched the file.
  { kind: "file", name: "file/after-the-refusals", path: ".claude/settings.json" },

  // --- MCP auth state --------------------------------------------------------
  // First ask per agent is the only one that reaches a CLI, so these two carry
  // every state mapping between them.
  { name: "mcp/claude", method: "GET", path: "/api/agent/mcp-status" },
  { name: "mcp/codex", method: "GET", path: "/api/agent/mcp-status?agent=codex" },
  // Everything that is not exactly `codex` is Claude Code — including the
  // agent's own other spellings.
  { name: "mcp/claude-code", method: "GET", path: "/api/agent/mcp-status?agent=claude-code" },
  { name: "mcp/claude-spelled-out", method: "GET", path: "/api/agent/mcp-status?agent=claude" },
  { name: "mcp/an-unknown-agent", method: "GET", path: "/api/agent/mcp-status?agent=gemini" },
  { name: "mcp/a-blank-agent", method: "GET", path: "/api/agent/mcp-status?agent=" },
  { name: "mcp/codex-with-different-case", method: "GET", path: "/api/agent/mcp-status?agent=Codex" },
  // A repeated parameter: the first wins.
  { name: "mcp/two-agents", method: "GET", path: "/api/agent/mcp-status?agent=codex&agent=claude" },
  { name: "mcp/wrong-method", method: "POST", path: "/api/agent/mcp-status" },

  // --- the tool-call feed ----------------------------------------------------
  // Empty in a daemon, for every limit — see the header note.
  { name: "tool-calls/default", method: "GET", path: "/api/agent/tool-calls" },
  { name: "tool-calls/a-limit", method: "GET", path: "/api/agent/tool-calls?limit=5" },
  { name: "tool-calls/limit-is-zero", method: "GET", path: "/api/agent/tool-calls?limit=0" },
  { name: "tool-calls/limit-is-negative", method: "GET", path: "/api/agent/tool-calls?limit=-1" },
  { name: "tool-calls/limit-is-huge", method: "GET", path: "/api/agent/tool-calls?limit=99999" },
  { name: "tool-calls/limit-is-not-a-number", method: "GET", path: "/api/agent/tool-calls?limit=abc" },
  { name: "tool-calls/wrong-method", method: "POST", path: "/api/agent/tool-calls" },

  // --- paths that match nothing ----------------------------------------------
  { name: "shape/an-unknown-agent-path", method: "GET", path: "/api/agent/nope" },
  { name: "shape/a-trailing-slash", method: "GET", path: "/api/agent/tool-calls/" },
  { name: "shape/a-deeper-path", method: "GET", path: "/api/agent/mcp-status/extra" },
];

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
}

const credentials = new Map<Runtime, string>();

async function send(runtime: Runtime, step: RequestStep): Promise<Answer> {
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
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: parsed,
  };
}

/** A file read is its own kind of answer: the text, or why it could not be read. */
async function readFileStep(runtime: Runtime, step: FileStep): Promise<unknown> {
  try {
    return { file: await readFile(join(runtime.home, step.path), "utf8") };
  } catch (error) {
    return { missing: (error as NodeJS.ErrnoException).code ?? String(error) };
  }
}

function erase(value: string, runtime: Runtime): string {
  return value
    .split(`/private${runtime.home}`)
    .join("<home>")
    .split(runtime.home)
    .join("<home>");
}

function normalize(value: unknown, runtime: Runtime): unknown {
  return JSON.parse(erase(JSON.stringify(value), runtime));
}

const root = await mkdtemp(join(tmpdir(), "nmi-agent-status-parity-"));
const harness = new RuntimeHarness(root);
let failures = 0;

async function seed(runtime: Runtime): Promise<void> {
  await mkdir(join(runtime.home, ".claude"), { recursive: true });
  await writeFile(
    join(runtime.home, ".claude", "settings.json"),
    `${JSON.stringify(SETTINGS, null, 2)}\n`,
  );
  const bin = join(runtime.workspace, "bin");
  await mkdir(bin, { recursive: true });
  for (const [name, source] of [
    ["claude", CLAUDE_STUB],
    ["codex", CODEX_STUB],
  ] as const) {
    await writeFile(join(bin, name), source);
    await chmod(join(bin, name), 0o755);
  }
}

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      spec,
      () => ({
        version: 1,
        services: [],
        bundles: [],
        databases: [],
        gitRepositories: [],
      }),
      () => [],
    );
    await seed(runtime);
    await harness.startDaemon(runtime, {
      PATH: `${join(runtime.workspace, "bin")}:${process.env.PATH ?? ""}`,
    });
    const credential = await import("node:fs/promises")
      .then((fs) => fs.readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8"))
      .then((value) => value.trim())
      .catch(() => "");
    credentials.set(runtime, credential);
    runtimes.push(runtime);
  }
  const [reference, candidate] = runtimes;

  for (const step of steps) {
    const answers =
      step.kind === "file"
        ? {
            reference: await readFileStep(reference, step),
            candidate: await readFileStep(candidate, step),
          }
        : {
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
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}

if (failures > 0) {
  console.log(`\nagent-status parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\nagent-status parity: ${steps.length} cases match`);
