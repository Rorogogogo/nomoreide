/**
 * Phase 6 parity gate for repository registration: register, remove, clone,
 * adopt, create, select, and the board's pinned order.
 *
 * These write *config*, so the gate compares the config each runtime ends up
 * with as well as the responses — three of these routes answer with the whole
 * public config, and one that saved something different while echoing the same
 * body would pass an HTTP-only compare.
 *
 * Cloning is hermetic: each runtime clones from a bare repository on its own
 * disk, so nothing reaches a network.
 *
 * Usage:
 *   node --import tsx scripts/check-git-repositories-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const git = (cwd: string, ...args: string[]) => run("git", args, { cwd });

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly form?: string;
  readonly json?: unknown;
  /** Built per runtime, for bodies naming a path only that runtime knows. */
  readonly formFor?: (runtime: Runtime) => string;
}

const encode = (value: string) => encodeURIComponent(value);

const steps: readonly Step[] = [
  // --- register ---
  { name: "register/no-name", method: "POST", path: "/api/git/repositories", form: "path=/tmp" },
  {
    name: "register/no-path",
    method: "POST",
    path: "/api/git/repositories",
    form: "name=whatever",
  },
  {
    name: "register/relative-path",
    method: "POST",
    path: "/api/git/repositories",
    form: "name=rel&path=relative/dir",
  },
  {
    name: "register/not-a-repository",
    method: "POST",
    path: "/api/git/repositories",
    formFor: (runtime) => `name=plain&path=${encode(join(runtime.home, "plain-dir"))}`,
  },
  {
    name: "register/second-repository",
    method: "POST",
    path: "/api/git/repositories",
    formFor: (runtime) => `name=second&path=${encode(join(runtime.home, "second-repo"))}`,
  },
  // The same name twice: whatever the store does about it, both must agree.
  {
    name: "register/duplicate-name",
    method: "POST",
    path: "/api/git/repositories",
    formFor: (runtime) => `name=second&path=${encode(join(runtime.home, "third-repo"))}`,
  },

  // --- select ---
  { name: "select/no-name", method: "POST", path: "/api/git/select" },
  { name: "select/unknown", method: "POST", path: "/api/git/select", form: "name=nope" },
  { name: "select/second", method: "POST", path: "/api/git/select", form: "name=second" },

  // --- board ---
  { name: "board/no-body", method: "PUT", path: "/api/git/board" },
  { name: "board/names-not-an-array", method: "PUT", path: "/api/git/board", json: { names: "repo" } },
  {
    name: "board/mixed-entries",
    method: "PUT",
    path: "/api/git/board",
    json: { names: ["repo", 7, null, "second"] },
  },
  // The store caps the board; more names than columns must be cut identically.
  {
    name: "board/over-the-cap",
    method: "PUT",
    path: "/api/git/board",
    json: { names: ["a", "b", "c", "d", "e", "f", "g"] },
  },
  // A repeated name must appear once, in its first position.
  {
    name: "board/duplicates",
    method: "PUT",
    path: "/api/git/board",
    json: { names: ["repo", "repo", "second", "repo"] },
  },
  // Five stale names ahead of two real ones. Filtering before capping keeps
  // the real ones; capping first would throw them away and leave the board
  // empty — which is the difference this case exists to see.
  {
    name: "board/stale-names-ahead-of-real-ones",
    method: "PUT",
    path: "/api/git/board",
    json: { names: ["a", "b", "c", "d", "e", "repo", "second"] },
  },
  { name: "board/emptied", method: "PUT", path: "/api/git/board", json: { names: [] } },

  // --- adopt ---
  { name: "adopt/no-path", method: "POST", path: "/api/git/adopt" },
  {
    name: "adopt/not-in-a-repository",
    method: "POST",
    path: "/api/git/adopt",
    formFor: (runtime) => `path=${encode(join(runtime.home, "plain-dir"))}`,
  },
  // From a *subdirectory*, which must register the root rather than the subdir.
  {
    name: "adopt/from-a-subdirectory",
    method: "POST",
    path: "/api/git/adopt",
    formFor: (runtime) => `path=${encode(join(runtime.home, "second-repo", "src"))}`,
  },

  // --- create ---
  { name: "create/no-name", method: "POST", path: "/api/git/create" },
  { name: "create/name-with-nothing-left", method: "POST", path: "/api/git/create", form: "name=..." },
  {
    name: "create/new-project",
    method: "POST",
    path: "/api/git/create",
    formFor: (runtime) =>
      `name=${encode("My New App")}&parentPath=${encode(join(runtime.home, "projects"))}`,
  },
  // Again, into a directory that now has contents.
  {
    name: "create/destination-taken",
    method: "POST",
    path: "/api/git/create",
    formFor: (runtime) =>
      `name=${encode("My New App")}&parentPath=${encode(join(runtime.home, "projects"))}`,
  },

  // --- clone ---
  { name: "clone/no-url", method: "POST", path: "/api/git/clone" },
  { name: "clone/unusable-url", method: "POST", path: "/api/git/clone", form: "url=not-a-url" },
  {
    name: "clone/from-a-local-bare-repo",
    method: "POST",
    path: "/api/git/clone",
    formFor: (runtime) => `url=${encode(join(runtime.home, "origin-fixture.git"))}`,
  },
  {
    name: "clone/again-into-the-same-place",
    method: "POST",
    path: "/api/git/clone",
    formFor: (runtime) => `url=${encode(join(runtime.home, "origin-fixture.git"))}`,
  },

  // --- remove ---
  { name: "remove/unknown", method: "DELETE", path: "/api/git/repositories/never-registered" },
  { name: "remove/second", method: "DELETE", path: "/api/git/repositories/second" },
  // The selected one: removing it must clear the selection, not dangle it.
  { name: "select/repo-again", method: "POST", path: "/api/git/select", form: "name=repo" },
  { name: "remove/the-selected-one", method: "DELETE", path: "/api/git/repositories/repo" },
  { name: "remove/percent-encoded-name", method: "DELETE", path: "/api/git/repositories/My%20New%20App" },
];

const dump = process.argv.includes("--dump");
const argv = process.argv.slice(2).filter((value) => value !== "--dump");
if (argv.length === 0) {
  console.error("Usage: check-git-repositories-parity.ts <candidate> [args...]");
  process.exit(2);
}

const root = await mkdtemp(join(tmpdir(), "nmi-git-repos-parity-"));
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
        gitRepositories: [{ name: "repo", path: partial.workspace }],
        selectedGitRepository: "repo",
      }),
      () => [],
    );
    await seedFixtures(runtime);
    // Clones and new projects land in the managed repos dir, which is derived
    // from the environment — pointed at each runtime's own home so the two
    // never share one.
    await harness.startDaemon(runtime, {
      NOMOREIDE_REPOS_DIR: join(runtime.home, "managed-repos"),
    });
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
      const normalize = (answer: Answer, runtime: Runtime) =>
        stripContentType(normalizePaths(answer, runtime));
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

  // What each runtime actually saved, and what it left on disk.
  for (const [name, read] of finalReads()) {
    const both = {
      reference: await read(reference),
      candidate: await read(candidate),
    };
    try {
      assert.deepStrictEqual(both.candidate, both.reference);
      console.log(`ok   ${name}`);
    } catch (error) {
      failures += 1;
      console.log(`FAIL ${name}`);
      console.log(`  reference: ${inspect(both.reference, { depth: null })}`);
      console.log(`  candidate: ${inspect(both.candidate, { depth: null })}`);
      console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true });
}

const total = steps.length + finalReads().length;
console.log(
  failures === 0
    ? `\ngit-repositories parity: ${total} cases match`
    : `\ngit-repositories parity: ${failures} case(s) diverged`,
);
process.exit(failures === 0 ? 0 : 1);

function finalReads(): Array<[string, (runtime: Runtime) => Promise<unknown>]> {
  return [
    [
      "config/repositories",
      async (runtime) => {
        const raw = await readFile(join(runtime.home, ".config", "nomoreide", "config.json"), "utf8");
        const config = JSON.parse(raw);
        return {
          repositories: (config.gitRepositories ?? []).map(
            (repository: { name: string; path: string }) => ({
              name: repository.name,
              path: erase(repository.path, runtime),
            }),
          ),
          selected: config.selectedGitRepository ?? "<none>",
          board: config.gitBoardRepositories ?? "<unset>",
        };
      },
    ],
    [
      "disk/managed-repos",
      async (runtime) => {
        const { stdout } = await run("ls", [join(runtime.home, "managed-repos")]).catch(() => ({
          stdout: "<absent>",
        }));
        return stdout;
      },
    ],
    [
      "disk/created-project",
      async (runtime) => {
        const { stdout } = await run("ls", [join(runtime.home, "projects")]).catch(() => ({
          stdout: "<absent>",
        }));
        return stdout;
      },
    ],
  ];
}

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
  if (step.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(step.json);
  } else if (step.formFor || step.form !== undefined) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = step.formFor ? step.formFor(runtime) : step.form;
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

function stripContentType(answer: Answer): Omit<Answer, "contentType"> {
  const { contentType: _contentType, ...rest } = answer;
  return rest;
}

function erase(value: string, runtime: Runtime): string {
  return value
    .split(`/private${runtime.home}`)
    .join("<home>")
    .split(runtime.home)
    .join("<home>");
}

function normalizePaths(answer: Answer, runtime: Runtime): Answer {
  return { ...answer, body: JSON.parse(erase(JSON.stringify(answer.body), runtime)) };
}

/** A repository to adopt from, a plain directory, and a bare repo to clone. */
async function seedFixtures(runtime: Runtime): Promise<void> {
  const workspace = runtime.workspace;
  await git(workspace, "init", "--quiet", "--initial-branch", "main");
  await git(workspace, "config", "user.email", "gate@example.com");
  await git(workspace, "config", "user.name", "Gate");
  await writeFile(join(workspace, "readme.txt"), "seed\n");
  await git(workspace, "add", "-A");
  await git(workspace, "commit", "--quiet", "-m", "first");

  // Not a repository at all — what `register` and `adopt` must refuse.
  await run("mkdir", ["-p", join(runtime.home, "plain-dir")]);

  // A second real repository, with a subdirectory to adopt *from*.
  const second = join(runtime.home, "second-repo");
  await run("mkdir", ["-p", join(second, "src")]);
  await git(second, "init", "--quiet", "--initial-branch", "main");
  await git(second, "config", "user.email", "gate@example.com");
  await git(second, "config", "user.name", "Gate");
  await writeFile(join(second, "src", "app.ts"), "export const app = 1;\n");
  await git(second, "add", "-A");
  await git(second, "commit", "--quiet", "-m", "second");

  // A third, so registering a duplicate name has a different path to offer.
  const third = join(runtime.home, "third-repo");
  await run("mkdir", ["-p", third]);
  await git(third, "init", "--quiet", "--initial-branch", "main");
  await git(third, "config", "user.email", "gate@example.com");
  await git(third, "config", "user.name", "Gate");
  await writeFile(join(third, "third.txt"), "third\n");
  await git(third, "add", "-A");
  await git(third, "commit", "--quiet", "-m", "third");

  // Something to clone from, on this machine.
  await run("git", ["clone", "--quiet", "--bare", second, join(runtime.home, "origin-fixture.git")]);
}
