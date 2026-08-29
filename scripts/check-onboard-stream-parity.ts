/**
 * Phase 6 parity gate for the onboarding installer:
 *
 *   POST /api/onboard/install/stream
 *
 * One endpoint, and the only one left in the wizard that streams. It runs a
 * shell command in a cloned repo and reports each line as it arrives, so the
 * three things worth gating are the containment check in front of it, the
 * framing of the stream, and what a command's *output* turns into.
 *
 * **`clonePath` must be inside the repos directory.** That is the guard: the
 * body names a directory and the daemon runs a shell command in it, so a path
 * outside the clone root is refused before anything is spawned. The gate walks
 * it with `..`, with a sibling whose name merely starts the same way, and with
 * the root itself — which is refused too, because a relative path of `""` is
 * not "inside".
 *
 * **Blank lines are dropped and a partial last line is flushed.** The runner
 * emits on `trim()`, so whitespace-only output produces no event at all, and a
 * command whose output has no trailing newline still reports its last line
 * when the child exits.
 *
 * `NOMOREIDE_REPOS_DIR` points both runtimes at their own clone root, so the
 * gate never touches `~/.nomoreide/repos`.
 *
 * Usage:
 *   node --import tsx scripts/check-onboard-stream-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    "Usage: node --import tsx scripts/check-onboard-stream-parity.ts [--dump] <candidate> [args...]",
  );
}

const STREAM = "/api/onboard/install/stream";

interface Step {
  readonly name: string;
  /** Built per runtime, because every path in it is that runtime's own. */
  readonly body: (runtime: Runtime) => string;
  readonly method?: "GET" | "POST";
}

/** `<home>/repos` — where this gate pretends clones live. */
const reposDir = (runtime: Runtime) => join(runtime.home, "repos");
/** The one clone inside it. */
const clone = (runtime: Runtime) => join(reposDir(runtime), "project");

const steps: Step[] = [
  /* ---- the containment guard ---- */
  { name: "guard/no-body", body: () => "{}" },
  { name: "guard/a-path-that-is-blank", body: () => JSON.stringify({ clonePath: "", command: "echo hi" }) },
  { name: "guard/a-path-that-is-a-number", body: () => JSON.stringify({ clonePath: 7, command: "echo hi" }) },
  { name: "guard/outside-the-repos-dir", body: () => JSON.stringify({ clonePath: "/tmp", command: "echo hi" }) },
  { name: "guard/the-repos-dir-itself", body: (r) => JSON.stringify({ clonePath: reposDir(r), command: "echo hi" }) },
  { name: "guard/climbing-out-with-dot-dot", body: (r) => JSON.stringify({ clonePath: join(clone(r), "..", "..", "elsewhere"), command: "echo hi" }) },
  // A sibling directory whose name merely *starts* with the root's — the
  // classic prefix-match hole, which `relative()` closes and a `startsWith`
  // would not.
  { name: "guard/a-sibling-with-the-same-prefix", body: (r) => JSON.stringify({ clonePath: `${reposDir(r)}-elsewhere/project`, command: "echo hi" }) },
  { name: "guard/no-command", body: (r) => JSON.stringify({ clonePath: clone(r) }) },
  { name: "guard/a-command-that-is-only-spaces", body: (r) => JSON.stringify({ clonePath: clone(r), command: "   " }) },
  { name: "guard/a-command-that-is-a-number", body: (r) => JSON.stringify({ clonePath: clone(r), command: 7 }) },
  // Both are wrong; which sentence comes back says which check runs first.
  { name: "guard/a-bad-path-and-no-command", body: () => JSON.stringify({ clonePath: "/tmp" }) },

  /* ---- running something ---- */
  { name: "run/a-line-on-stdout", body: (r) => JSON.stringify({ clonePath: clone(r), command: "echo hello" }) },
  { name: "run/lines-on-both-streams", body: (r) => JSON.stringify({ clonePath: clone(r), command: "echo out; echo err 1>&2" }) },
  { name: "run/several-lines", body: (r) => JSON.stringify({ clonePath: clone(r), command: "printf 'a\\nb\\nc\\n'" }) },
  { name: "run/a-last-line-with-no-newline", body: (r) => JSON.stringify({ clonePath: clone(r), command: "printf 'no-newline'" }) },
  { name: "run/output-that-is-only-blank-lines", body: (r) => JSON.stringify({ clonePath: clone(r), command: "printf '\\n\\n   \\n'" }) },
  { name: "run/no-output-at-all", body: (r) => JSON.stringify({ clonePath: clone(r), command: "true" }) },
  { name: "run/a-non-zero-exit", body: (r) => JSON.stringify({ clonePath: clone(r), command: "echo before; exit 7" }) },
  { name: "run/a-command-the-shell-cannot-find", body: (r) => JSON.stringify({ clonePath: clone(r), command: "definitely-not-a-command" }) },
  // The command runs *in* the clone, which is the point of `cwd`.
  { name: "run/it-runs-in-the-clone", body: (r) => JSON.stringify({ clonePath: clone(r), command: "cat marker.txt" }) },
  { name: "run/a-command-with-a-trailing-newline-in-it", body: (r) => JSON.stringify({ clonePath: clone(r), command: "  echo padded  " }) },
  // The path is a real directory that does not exist — the guard passes, the
  // spawn is what fails.
  { name: "run/a-clone-that-is-not-there", body: (r) => JSON.stringify({ clonePath: join(reposDir(r), "absent"), command: "echo hi" }) },

  { name: "stream/wrong-method", method: "GET", body: () => "" },
];

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
}

const credentials = new Map<string, string>();

async function send(runtime: Runtime, step: Step): Promise<Answer> {
  const credential = credentials.get(runtime.label) ?? "";
  const method = step.method ?? "POST";
  const response = await fetch(`http://127.0.0.1:${runtime.port}${STREAM}`, {
    method,
    headers: {
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      "content-type": "application/json",
    },
    body: method === "GET" ? undefined : step.body(runtime),
  });
  // The stream closes when the child exits, so reading to the end is the whole
  // answer.
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* SSE and the SPA shell are compared as the text they were */
  }
  return { status: response.status, contentType: response.headers.get("content-type"), body };
}

function normalize(value: unknown, runtime: Runtime): unknown {
  const text = JSON.stringify(value ?? null)
    .split(`/private${runtime.home}`)
    .join("<home>")
    .split(runtime.home)
    .join("<home>")
    .split(`127.0.0.1:${runtime.port}`)
    .join("<daemon>");
  return JSON.parse(text);
}

const root = await mkdtemp(join(tmpdir(), "nmi-onboard-stream-parity-"));
const harness = new RuntimeHarness(root);
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

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      spec,
      () => ({ version: 1, services: [], bundles: [], databases: [], gitRepositories: [] }),
      () => [],
    );
    // One clone to run things in, and a sibling that shares the root's name as
    // a prefix so the containment check has something to get wrong.
    await mkdir(clone(runtime), { recursive: true });
    await writeFile(join(clone(runtime), "marker.txt"), "in the clone\n", "utf8");
    await mkdir(join(`${reposDir(runtime)}-elsewhere`, "project"), { recursive: true });
    await harness.startDaemon(
      runtime,
      { NOMOREIDE_REPOS_DIR: reposDir(runtime) },
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
      normalize(await send(reference, step), reference),
      normalize(await send(candidate, step), candidate),
    );
  }
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\nonboard-stream parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log("\nonboard-stream parity: all cases match");
