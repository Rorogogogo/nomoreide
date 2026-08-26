/**
 * Phase 6 parity gate for the two branch mutations: `branches/switch` and
 * `branches/delete`.
 *
 * They are the last two endpoints of the git domain and they are deliberately
 * *not* symmetrical, which is most of what this gate is for:
 *
 *  - `delete` takes a `repo`, so it can act on a repository other than the
 *    selected one, and an unknown `repo` is a **404**. `switch` takes none and
 *    always acts on the selected repository, so a `repo` field sent to it is
 *    ignored rather than honoured.
 *  - `delete` wraps everything in a try, so every refusal is a **400**.
 *    `switch` wraps nothing, so a refusal escapes to the dispatcher as a
 *    **500**. A missing `name` therefore reports differently on the two.
 *
 * Both are writes, so the response body is only half the check: the branches on
 * disk and the branch each repository ends up on are compared afterwards. A
 * route that reported a refusal and switched anyway looks correct until then.
 *
 * `switch` also has a branch of its own worth pinning: a name that matches a
 * *remote* branch is checked out with `--track`, which creates a local branch,
 * while any other name is a plain switch. The fixture has a remote for that.
 *
 * Usage:
 *   node --import tsx scripts/check-git-branch-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { inspect } from "node:util";
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
    "Usage: node --import tsx scripts/check-git-branch-parity.ts [--dump] <candidate> [args...]",
  );
}

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly form?: string;
}

const encode = (value: string) => encodeURIComponent(value);

const steps: readonly Step[] = [
  // === switch ==============================================================
  { name: "switch/to-a-local-branch", method: "POST", path: "/api/git/branches/switch", form: "name=merged" },
  { name: "switch/to-the-branch-already-checked-out", method: "POST", path: "/api/git/branches/switch", form: "name=merged" },
  { name: "switch/back-to-main", method: "POST", path: "/api/git/branches/switch", form: "name=main" },
  { name: "switch/to-a-slashed-name", method: "POST", path: "/api/git/branches/switch", form: `name=${encode("feature/slashed")}` },
  // A name that exists only on the remote is checked out with `--track`, which
  // creates the local branch as a side effect.
  { name: "switch/to-a-remote-only-branch", method: "POST", path: "/api/git/branches/switch", form: "name=remote-only" },
  // The --track path only fires for a name that is listed as a remote branch,
  // and they are listed with their remote prefix: a bare "remote-only" takes
  // the plain-switch path and reaches --track only as "origin/remote-only".
  { name: "switch/to-a-remote-tracking-ref", method: "POST", path: "/api/git/branches/switch", form: `name=${encode("origin/remote-only")}` },
  { name: "switch/back-to-main-again", method: "POST", path: "/api/git/branches/switch", form: "name=main" },
  { name: "switch/to-a-branch-that-does-not-exist", method: "POST", path: "/api/git/branches/switch", form: "name=ghost" },
  { name: "switch/missing-name", method: "POST", path: "/api/git/branches/switch", form: "" },
  { name: "switch/blank-name", method: "POST", path: "/api/git/branches/switch", form: "name=%20%20" },
  // A name a shell would read as a flag, and one with a space in it.
  { name: "switch/name-that-looks-like-a-flag", method: "POST", path: "/api/git/branches/switch", form: `name=${encode("--orphan")}` },
  { name: "switch/name-with-a-space", method: "POST", path: "/api/git/branches/switch", form: `name=${encode("has space")}` },
  { name: "switch/name-with-a-semicolon", method: "POST", path: "/api/git/branches/switch", form: `name=${encode("main; touch pwned")}` },
  // `switch` takes no repo, so naming one must change nothing.
  { name: "switch/repo-field-is-ignored", method: "POST", path: "/api/git/branches/switch", form: "name=merged&repo=other" },
  { name: "switch/back-to-main-once-more", method: "POST", path: "/api/git/branches/switch", form: "name=main" },
  { name: "switch/wrong-method", method: "GET", path: "/api/git/branches/switch" },

  // === delete ==============================================================
  // --- create ----------------------------------------------------------------
  // Like switch, create takes no repo and catches nothing, so every refusal is
  // a 500. A blank startPoint means "from here" rather than an empty ref.
  { name: "create/a-new-branch", method: "POST", path: "/api/git/branches", form: "name=fresh" },
  { name: "create/the-same-branch-again", method: "POST", path: "/api/git/branches", form: "name=fresh" },
  { name: "create/from-a-start-point", method: "POST", path: "/api/git/branches", form: "name=from-main&startPoint=main" },
  { name: "create/from-a-blank-start-point", method: "POST", path: "/api/git/branches", form: "name=blank-start&startPoint=%20%20" },
  { name: "create/from-a-start-point-that-does-not-exist", method: "POST", path: "/api/git/branches", form: "name=nowhere&startPoint=ghost" },
  { name: "create/a-slashed-name", method: "POST", path: "/api/git/branches", form: `name=${encode("feature/new")}` },
  { name: "create/missing-name", method: "POST", path: "/api/git/branches", form: "" },
  { name: "create/blank-name", method: "POST", path: "/api/git/branches", form: "name=%20%20" },
  { name: "create/a-name-that-looks-like-a-flag", method: "POST", path: "/api/git/branches", form: `name=${encode("--all")}` },
  { name: "create/a-name-with-a-semicolon", method: "POST", path: "/api/git/branches", form: `name=${encode("x; touch pwned")}` },
  { name: "create/a-start-point-that-looks-like-a-flag", method: "POST", path: "/api/git/branches", form: `name=flagged&startPoint=${encode("--all")}` },
  // The repo field is ignored here, as it is on switch.
  { name: "create/the-repo-field-is-ignored", method: "POST", path: "/api/git/branches", form: "name=elsewhere&repo=other" },
  { name: "create/wrong-method", method: "PUT", path: "/api/git/branches" },

  { name: "delete/a-merged-branch", method: "POST", path: "/api/git/branches/delete", form: "name=merged" },
  { name: "delete/the-same-branch-again", method: "POST", path: "/api/git/branches/delete", form: "name=merged" },
  // `branch -d` refuses to drop work that is not reachable from anywhere else.
  { name: "delete/an-unmerged-branch", method: "POST", path: "/api/git/branches/delete", form: "name=unmerged" },
  { name: "delete/the-branch-that-is-checked-out", method: "POST", path: "/api/git/branches/delete", form: "name=main" },
  { name: "delete/a-branch-that-does-not-exist", method: "POST", path: "/api/git/branches/delete", form: "name=ghost" },
  { name: "delete/missing-name", method: "POST", path: "/api/git/branches/delete", form: "" },
  { name: "delete/blank-name", method: "POST", path: "/api/git/branches/delete", form: "name=%20%20" },
  { name: "delete/name-that-looks-like-a-flag", method: "POST", path: "/api/git/branches/delete", form: `name=${encode("--all")}` },
  { name: "delete/name-with-a-semicolon", method: "POST", path: "/api/git/branches/delete", form: `name=${encode("x; touch pwned")}` },
  { name: "delete/a-remote-tracking-ref", method: "POST", path: "/api/git/branches/delete", form: `name=${encode("origin/remote-only")}` },
  // The repo field: a registered name, an unknown one, and a blank one.
  { name: "delete/in-a-named-repo", method: "POST", path: "/api/git/branches/delete", form: "name=spare&repo=other" },
  { name: "delete/in-an-unknown-repo", method: "POST", path: "/api/git/branches/delete", form: "name=spare&repo=nope" },
  // The repository is resolved before the name is read, so an unknown repo with
  // no name at all reports the repository, not the missing field.
  { name: "delete/an-unknown-repo-and-no-name", method: "POST", path: "/api/git/branches/delete", form: "repo=nope" },
  { name: "delete/with-a-blank-repo", method: "POST", path: "/api/git/branches/delete", form: `name=${encode("feature/slashed")}&repo=` },
  { name: "delete/with-a-whitespace-repo", method: "POST", path: "/api/git/branches/delete", form: "name=leftover&repo=%20%20" },
  { name: "delete/wrong-method", method: "GET", path: "/api/git/branches/delete" },
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
  if (step.form !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
  const response = await fetch(`http://127.0.0.1:${runtime.port}${step.path}`, {
    method: step.method,
    headers,
    body: step.form,
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

/**
 * Where each repository ended up.
 *
 * The branches that exist, the one that is checked out, and whether anything
 * ran a shell — a `;` in a branch name that reached one would leave the file
 * behind.
 */
async function census(runtime: Runtime): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [label, cwd] of [
    ["selected", runtime.workspace],
    ["other", join(runtime.home, "other")],
  ] as const) {
    const git = (args: string[]) =>
      run("git", args, { cwd }).then(({ stdout }) => stdout.trim()).catch((error) => `<${error.code}>`);
    out[`${label}/branches`] = await git(["branch", "--all", "--format=%(refname)"]);
    out[`${label}/head`] = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    out[`${label}/status`] = await git(["status", "--porcelain"]);
    out[`${label}/pwned`] = await readFile(join(cwd, "pwned"), "utf8").then(() => "PRESENT").catch(() => "<absent>");
  }
  return out;
}

/** The repositories both runtimes get an identical copy of. */
async function seed(runtime: Runtime): Promise<void> {
  const workspace = runtime.workspace;
  const other = join(runtime.home, "other");
  const origin = join(runtime.home, "origin.git");
  await mkdir(other, { recursive: true });

  // A fixed identity *and* fixed timestamps, so both runtimes build
  // byte-identical commits and the SHAs git prints in its output compare
  // directly. Without this every "Deleted branch x (was <sha>)" differs and the
  // gate has to blur exactly the part that says which commit went.
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00+0000",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00+0000",
    GIT_AUTHOR_NAME: "Gate",
    GIT_AUTHOR_EMAIL: "gate@example.com",
    GIT_COMMITTER_NAME: "Gate",
    GIT_COMMITTER_EMAIL: "gate@example.com",
  };
  const git = (cwd: string) => (...args: string[]) => run("git", args, { cwd, env });
  const setup = async (cwd: string) => {
    const g = git(cwd);
    await g("init", "--quiet", "--initial-branch=main");
    await g("config", "user.email", "gate@example.com");
    await g("config", "user.name", "Gate");
    await writeFile(join(cwd, "file.txt"), "one\n");
    await g("add", "-A");
    await g("commit", "--quiet", "-m", "first");
  };

  await setup(workspace);
  const g = git(workspace);
  // A branch merged into main: pointing at main is enough for `-d` to allow it.
  await g("branch", "merged");
  await g("branch", "feature/slashed");
  await g("branch", "leftover");
  // A branch with work of its own, which `-d` must refuse.
  await g("switch", "--quiet", "-c", "unmerged");
  await writeFile(join(workspace, "file.txt"), "two\n");
  await g("commit", "--quiet", "-am", "second");
  await g("switch", "--quiet", "main");

  // A bare remote holding a branch that exists nowhere locally.
  await run("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin], { env });
  await g("remote", "add", "origin", origin);
  await g("push", "--quiet", "origin", "main");
  await g("switch", "--quiet", "-c", "remote-only");
  await g("push", "--quiet", "origin", "remote-only");
  await g("switch", "--quiet", "main");
  await g("branch", "--quiet", "-D", "remote-only");
  await g("fetch", "--quiet", "origin");

  await setup(other);
  await git(other)("branch", "spare");
}

const root = await mkdtemp(join(tmpdir(), "nmi-git-branch-parity-"));
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
        gitRepositories: [
          { name: "repo", path: partial.workspace },
          { name: "other", path: join(partial.home, "other") },
        ],
      }),
      () => [],
    );
    await seed(runtime);
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
    console.log("ok   repository/on-disk");
  } catch (error) {
    failures += 1;
    console.log("FAIL repository/on-disk");
    console.log(`  reference: ${inspect(both.reference, { depth: null })}`);
    console.log(`  candidate: ${inspect(both.candidate, { depth: null })}`);
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
  }
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true });
}

const total = steps.length + 1;
if (failures > 0) {
  console.log(`\ngit-branch parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\ngit-branch parity: ${total} cases match`);
