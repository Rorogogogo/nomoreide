/**
 * Phase 6 parity gate for agent change-sets:
 *
 *   GET  /api/agent/change-sets
 *   GET  /api/agent/change-sets/:id
 *   POST /api/agent/change-sets/:id/restore
 *   GET  /api/agent/change-sets/:id/diff
 *
 * A change-set is a session the MCP recording wrapper wrote to
 * `~/.nomoreide/agent-sessions.json`, pinned to the snapshot taken before its
 * first tool call. The store is a plain JSON file re-read on every request and
 * never written by these routes, so the gate plants it directly — which is also
 * the only way to give a session a snapshot that exists, since the sha has to
 * come from a snapshot each runtime took for itself.
 *
 * **The id is not decoded.** Every other `:id` in this codebase goes through
 * `decodeURIComponent`; these three do not — the raw path segment is compared
 * against the stored id. So a session whose id contains a `%2F` is reachable
 * only by sending `%2F` *encoded again*, and a session whose id contains a real
 * `/` is not reachable at all. The fixture stores both.
 *
 * **A missing snapshot and an unknown session are the same 404**, with the same
 * wording, on restore and diff: both read `session?.snapshotSha` and cannot
 * tell the two apart. `GET /:id` is the only one that distinguishes them, and
 * it answers a session with no snapshot as a *success* carrying an empty file
 * list.
 *
 * Usage:
 *   node --import tsx scripts/check-change-sets-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect, promisify } from "node:util";
import {
  candidateSpec,
  referenceSpec,
  RuntimeHarness,
  type Runtime,
} from "../test/support/runtime-parity.js";

const run = promisify(execFile);

const argv = process.argv.slice(2).filter((a) => a !== "--dump");
const dump = process.argv.slice(2).includes("--dump");
if (argv.length === 0) {
  throw new Error(
    "Usage: node --import tsx scripts/check-change-sets-parity.ts [--dump] <candidate> [args...]",
  );
}

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly body?: string;
  /** Runs against this runtime before the request. */
  readonly mutate?: (runtime: Runtime) => Promise<void>;
}

const SETS = "/api/agent/change-sets";
const STORE = ".nomoreide/agent-sessions.json";

/** Where the daemon keeps its change-sets: beside its logs, under `$HOME`. */
const storePath = (runtime: Runtime) => join(runtime.home, STORE);

/**
 * Plant the store.
 *
 * `snapshotSha` is filled in from a snapshot this runtime took a moment ago,
 * because a sha from the other runtime would name nothing here.
 */
async function plantStore(runtime: Runtime, sha: string): Promise<void> {
  const sessions = [
    {
      id: "with-snapshot",
      repoPath: runtime.workspace,
      snapshotSha: sha,
      snapshotRef: "refs/nomoreide/snapshots/1-agent",
      startedAt: "2026-08-01T00:00:00.000Z",
      lastToolAt: "2026-08-01T00:05:00.000Z",
      toolCount: 3,
    },
    // Recorded before any snapshot could be taken.
    {
      id: "no-snapshot",
      repoPath: runtime.workspace,
      startedAt: "2026-08-02T00:00:00.000Z",
      lastToolAt: "2026-08-02T00:01:00.000Z",
      toolCount: 1,
    },
    // A sha in the right shape that names nothing.
    {
      id: "stale-snapshot",
      repoPath: runtime.workspace,
      snapshotSha: "0".repeat(40),
      startedAt: "2026-08-03T00:00:00.000Z",
      lastToolAt: "2026-08-03T00:01:00.000Z",
      toolCount: 2,
    },
    // The repository it was recorded in is gone.
    {
      id: "missing-repo",
      repoPath: join(runtime.home, "deleted-repo"),
      snapshotSha: sha,
      startedAt: "2026-08-04T00:00:00.000Z",
      lastToolAt: "2026-08-04T00:01:00.000Z",
      toolCount: 1,
    },
    // Two ids that only differ in whether they are encoded. Reaching either one
    // says which of the two the route compares against.
    {
      id: "a%2Fb",
      repoPath: runtime.workspace,
      snapshotSha: sha,
      startedAt: "2026-08-05T00:00:00.000Z",
      lastToolAt: "2026-08-05T00:01:00.000Z",
      toolCount: 1,
    },
    {
      id: "spaced id",
      repoPath: runtime.workspace,
      snapshotSha: sha,
      startedAt: "2026-08-06T00:00:00.000Z",
      lastToolAt: "2026-08-06T00:01:00.000Z",
      toolCount: 1,
    },
  ];
  await writeFile(storePath(runtime), `${JSON.stringify(sessions, null, 2)}\n`, "utf8");
}

/** Take a snapshot through the API and answer with its sha. */
async function takeSnapshot(runtime: Runtime): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${runtime.port}/api/snapshots`, {
    method: "POST",
    headers: { ...(await credentialFor(runtime)), "content-type": "application/json" },
    body: '{"label":"agent session"}',
  });
  const payload = (await response.json()) as { snapshot?: { sha: string } };
  return payload.snapshot?.sha ?? "0".repeat(40);
}

const steps: readonly Step[] = [
  // --- before there is a store ------------------------------------------------
  { name: "list/no-store-at-all", method: "GET", path: SETS },
  {
    name: "list/a-store-that-is-not-an-array",
    method: "GET",
    path: SETS,
    mutate: async (runtime) => writeFile(storePath(runtime), '{"sessions":[]}\n'),
  },
  {
    name: "list/a-store-that-is-not-json",
    method: "GET",
    path: SETS,
    mutate: async (runtime) => writeFile(storePath(runtime), "not json at all\n"),
  },
  {
    name: "list/a-store-that-is-empty",
    method: "GET",
    path: SETS,
    mutate: async (runtime) => writeFile(storePath(runtime), ""),
  },

  // --- a planted store -------------------------------------------------------
  {
    name: "list/the-planted-sessions",
    method: "GET",
    path: SETS,
    mutate: async (runtime) => {
      // The tree has to have moved for the snapshot to be worth diffing.
      await writeFile(join(runtime.workspace, "app.txt"), "changed by the agent\n");
      await plantStore(runtime, await takeSnapshot(runtime));
    },
  },
  { name: "list/wrong-method", method: "POST", path: SETS },

  // --- reading one -----------------------------------------------------------
  { name: "read/a-session-with-a-snapshot", method: "GET", path: `${SETS}/with-snapshot` },
  // A success, not a refusal: no snapshot means nothing changed to report.
  { name: "read/a-session-with-no-snapshot", method: "GET", path: `${SETS}/no-snapshot` },
  { name: "read/a-session-whose-snapshot-is-gone", method: "GET", path: `${SETS}/stale-snapshot` },
  { name: "read/a-session-whose-repository-is-gone", method: "GET", path: `${SETS}/missing-repo` },
  { name: "read/an-unknown-session", method: "GET", path: `${SETS}/nothing-here` },
  // The id is compared raw, so this reaches the session stored as `a%2Fb`.
  { name: "read/an-id-that-is-stored-encoded", method: "GET", path: `${SETS}/a%252Fb` },
  // ...and this one decodes to `a/b`, which is not a session and cannot be one.
  { name: "read/an-id-that-decodes-to-a-slash", method: "GET", path: `${SETS}/a%2Fb` },
  { name: "read/an-id-with-an-encoded-space", method: "GET", path: `${SETS}/spaced%20id` },
  { name: "read/an-id-with-a-literal-space", method: "GET", path: `${SETS}/spaced id` },
  { name: "read/an-empty-id", method: "GET", path: `${SETS}/` },
  { name: "read/wrong-method", method: "DELETE", path: `${SETS}/with-snapshot` },

  // --- the diff --------------------------------------------------------------
  { name: "diff/everything", method: "GET", path: `${SETS}/with-snapshot/diff` },
  { name: "diff/one-path", method: "GET", path: `${SETS}/with-snapshot/diff?path=app.txt` },
  { name: "diff/a-blank-path", method: "GET", path: `${SETS}/with-snapshot/diff?path=` },
  { name: "diff/a-padded-path", method: "GET", path: `${SETS}/with-snapshot/diff?path=%20app.txt%20` },
  { name: "diff/a-path-that-does-not-exist", method: "GET", path: `${SETS}/with-snapshot/diff?path=nope.txt` },
  // Both of these are the same 404 with the same wording.
  { name: "diff/a-session-with-no-snapshot", method: "GET", path: `${SETS}/no-snapshot/diff` },
  { name: "diff/an-unknown-session", method: "GET", path: `${SETS}/nothing-here/diff` },
  { name: "diff/a-session-whose-snapshot-is-gone", method: "GET", path: `${SETS}/stale-snapshot/diff` },
  { name: "diff/wrong-method", method: "POST", path: `${SETS}/with-snapshot/diff` },
  { name: "diff/an-empty-id", method: "GET", path: `${SETS}//diff` },

  // --- restoring -------------------------------------------------------------
  { name: "restore/a-session-with-no-snapshot", method: "POST", path: `${SETS}/no-snapshot/restore` },
  { name: "restore/an-unknown-session", method: "POST", path: `${SETS}/nothing-here/restore` },
  { name: "restore/a-session-whose-snapshot-is-gone", method: "POST", path: `${SETS}/stale-snapshot/restore` },
  { name: "restore/wrong-method", method: "GET", path: `${SETS}/with-snapshot/restore` },
  // Last, because it puts the working tree back and every diff above depends on
  // it having moved.
  { name: "restore/a-session", method: "POST", path: `${SETS}/with-snapshot/restore` },
  { name: "restore/the-diff-afterwards", method: "GET", path: `${SETS}/with-snapshot/diff` },
  { name: "restore/the-same-session-again", method: "POST", path: `${SETS}/with-snapshot/restore` },
];

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
}

async function credentialFor(runtime: Runtime): Promise<Record<string, string>> {
  const credential = await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
    .then((value) => value.trim())
    .catch(() => "");
  return credential ? { authorization: `Bearer ${credential}` } : {};
}

async function send(runtime: Runtime, step: Step): Promise<Answer> {
  if (step.mutate) await step.mutate(runtime);
  const response = await fetch(`http://127.0.0.1:${runtime.port}${step.path}`, {
    method: step.method,
    headers: { ...(await credentialFor(runtime)), "content-type": "application/json" },
    body: step.body,
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* a diff is text, and is compared as the text it was */
  }
  return { status: response.status, contentType: response.headers.get("content-type"), body: parsed };
}

/** Shas and the epoch in a ref name; a change-set's own fields are all fixed. */
const VOLATILE = new Set(["sha", "snapshotSha", "preRestore"]);

function scrub(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/refs\/nomoreide\/snapshots\/\d+-/g, "refs/nomoreide/snapshots/<epoch>-")
      .replace(/\b[0-9a-f]{40}\b/g, "<sha>")
      .replace(/\b[0-9a-f]{7,12}\b/g, "<short-sha>");
  }
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

function normalize(answer: Answer, runtime: Runtime): Answer {
  const erased = JSON.stringify(answer.body)
    .split(`/private${runtime.home}`)
    .join("<home>")
    .split(runtime.home)
    .join("<home>");
  return { ...answer, body: scrub(JSON.parse(erased)) };
}

const root = await mkdtemp(join(tmpdir(), "nmi-change-sets-parity-"));
const harness = new RuntimeHarness(root);
let failures = 0;

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      spec,
      (partial) => ({
        version: 1,
        services: [],
        bundles: [],
        databases: [],
        gitRepositories: [{ name: "demo", path: partial.workspace }],
        selectedGitRepository: "demo",
      }),
      () => [
        { path: "app.txt", contents: "the original\n" },
        { path: "README.md", contents: "# demo\n" },
      ],
    );
    // A snapshot needs a repository with a commit in it.
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["config", "user.email", "gate@example.com"],
      ["config", "user.name", "Gate"],
      ["add", "-A"],
      ["commit", "-q", "-m", "first"],
    ]) {
      await run("git", args, { cwd: runtime.workspace });
    }
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
  console.log(`\nchange-sets parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\nchange-sets parity: ${steps.length} cases match`);
