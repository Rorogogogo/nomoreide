/**
 * Phase 6 parity gate for `GET /api/github/pr-template`.
 *
 * One route, but the widest one in the domain: it reads the local repository,
 * asks GitHub about the repository and about a branch comparison, falls back to
 * two local comparisons when that fails, looks up the head commit's CI, and
 * writes a title and a body out of whatever it managed to collect — pushing a
 * sentence onto a `warnings` list at every step that did not work.
 *
 * So the cases here are mostly *degradations*: no upstream, no default branch,
 * a base that equals the head, GitHub refusing the comparison, both local
 * fallbacks failing, a repository with no commits at all. Each one has to
 * produce the same warnings, in the same order, on both runtimes — the order is
 * the record of which step failed first.
 *
 * Usage:
 *   node --import tsx scripts/check-github-template-parity.ts <candidate> [args...]
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
import { type ApiStub, type StubRoute, startApiStub } from "./support/http-api-stub.js";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", args, { cwd });

const REMOTE = "https://github.com/acme/widgets.git";
const REPO = "/repos/acme/widgets";
const PATH = "/api/github/pr-template";

interface Step {
  readonly name: string;
  /** Rewrite the canned GitHub responses before either runtime is asked. */
  readonly arrange?: () => void;
  /** Change one runtime's checkout before it is asked. */
  readonly stage?: (runtime: Runtime) => Promise<void>;
}

const api: StubRoute[] = [];

function serve(route: StubRoute): void {
  const index = api.findIndex(
    (candidate) => candidate.method === route.method && candidate.path === route.path,
  );
  if (index === -1) api.push(route);
  else api[index] = route;
}

const get = (path: string, status: number, body: unknown) =>
  serve({ method: "GET", path: `${REPO}${path}`, status, body });

const compare = (base: string, head: string, status: number, body: unknown) =>
  get(`/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, status, body);

const CHECKS = {
  total_count: 1,
  check_runs: [{ id: 1, name: "build", status: "completed", conclusion: "success" }],
};

const steps: readonly Step[] = [
  // --- The happy path -------------------------------------------------------
  // GitHub knows both branches, so the comparison comes from GitHub and the CI
  // lookup is keyed on the last commit it reported.
  {
    name: "template/compared-by-github",
    arrange: () => {
      get("", 200, { full_name: "acme/widgets", default_branch: "main" });
      compare("main", "feature", 200, {
        status: "ahead",
        ahead_by: 2,
        commits: [
          { sha: "c1", commit: { message: "First change\n\nWith a body." } },
          { sha: "c2", commit: { message: "  Second change  " } },
        ],
        files: [
          { filename: "src/app.ts", status: "modified", additions: 3, deletions: 1, changes: 4 },
          { filename: "src/new.ts", status: "added", additions: 9, deletions: 0, changes: 9 },
        ],
      });
      get("/commits/c2/check-runs?per_page=100", 200, CHECKS);
    },
  },
  // The title comes from the *last* commit, and a multi-line message is cut to
  // its first line. Two commits, because one cannot tell "first" from "last".
  {
    name: "template/title-from-the-last-commit",
    arrange: () =>
      compare("main", "feature", 200, {
        status: "ahead",
        ahead_by: 2,
        commits: [
          { sha: "c8", commit: { message: "The older one" } },
          { sha: "c9", commit: { message: "The newest one\nand its body" } },
        ],
        files: [],
      }),
  },
  // No commits at all: the title falls back to the branch name, turned into a
  // sentence.
  {
    name: "template/title-from-the-branch-name",
    arrange: () =>
      compare("main", "feature", 200, { status: "identical", ahead_by: 0, commits: [], files: [] }),
  },
  // A compare with no `files` key at all — the reference defaults it to empty.
  {
    name: "template/compare-without-a-files-key",
    arrange: () =>
      compare("main", "feature", 200, {
        status: "ahead",
        ahead_by: 1,
        commits: [{ sha: "c3", commit: { message: "No files reported" } }],
      }),
  },
  // More than the body lists: ten commits and twenty files are the cutoffs, and
  // the overflow line names how many were left out.
  {
    name: "template/more-than-the-body-lists",
    arrange: () =>
      compare("main", "feature", 200, {
        status: "ahead",
        ahead_by: 12,
        commits: Array.from({ length: 12 }, (_, index) => ({
          sha: `s${index}`,
          commit: { message: `Commit number ${index}` },
        })),
        files: Array.from({ length: 23 }, (_, index) => ({
          filename: `src/file-${index}.ts`,
          status: "modified",
          additions: 1,
          deletions: 0,
          changes: 1,
        })),
      }),
  },

  // A compare with no `ahead_by` at all: the key is *dropped*, not sent as
  // null — the reference copies the field straight off GitHub's payload.
  {
    name: "template/compare-without-an-ahead-count",
    arrange: () =>
      compare("main", "feature", 200, {
        status: "ahead",
        commits: [{ sha: "c4", commit: { message: "No count reported" } }],
        files: [],
      }),
  },

  // --- Falling back to the local repository ---------------------------------
  // GitHub cannot compare, so the local comparison against `main` answers, and
  // the failure is recorded as a warning rather than as an error.
  {
    name: "template/github-cannot-compare",
    arrange: () => compare("main", "feature", 404, { message: "Not Found" }),
  },
  // Neither the local base nor `origin/base` exists: both fallbacks fail, and
  // only the second failure is reported.
  {
    name: "template/nothing-can-compare",
    stage: async (runtime) => {
      await git(runtime.workspace, "branch", "-m", "main", "trunk");
    },
    arrange: () => get("", 200, { full_name: "acme/widgets", default_branch: "main" }),
  },

  // --- Where the base comes from --------------------------------------------
  // No default branch from GitHub: the upstream names the base instead.
  {
    name: "template/base-from-the-upstream",
    stage: async (runtime) => {
      await git(runtime.workspace, "branch", "-m", "trunk", "main");
      await git(runtime.workspace, "checkout", "--quiet", "feature");
      // A real remote-tracking ref, so the upstream is `origin/main` rather
      // than a bare `main` — otherwise stripping the prefix is a no-op and the
      // case cannot see whether it happened.
      await git(runtime.workspace, "update-ref", "refs/remotes/origin/main", "main");
      await git(runtime.workspace, "branch", "--set-upstream-to", "origin/main", "feature").catch(
        () => {},
      );
    },
    arrange: () => get("", 200, { full_name: "acme/widgets" }),
  },
  // Nothing at all names a base: it defaults to `main`.
  {
    name: "template/base-defaults-to-main",
    stage: async (runtime) => {
      await git(runtime.workspace, "branch", "--unset-upstream", "feature").catch(() => {});
    },
    arrange: () => get("", 500, { message: "Server Error" }),
  },
  // The head *is* the base: no comparison is attempted, and the reason is a
  // warning rather than an empty screen.
  {
    name: "template/head-is-the-base",
    stage: async (runtime) => {
      await git(runtime.workspace, "checkout", "--quiet", "main");
    },
    arrange: () => get("", 200, { full_name: "acme/widgets", default_branch: "main" }),
  },

  // An empty `default_branch` is a *value*, so it is kept rather than falling
  // through to the upstream. Nothing can be compared against it, and nothing
  // warns about that either — the reference's guard tests it for truthiness.
  {
    name: "template/empty-default-branch",
    arrange: () => get("", 200, { full_name: "acme/widgets", default_branch: "" }),
  },
  // A rename between the two branches, compared locally: `--name-status -z`
  // reports three tokens for one file, and the *new* path is the one to show.
  {
    name: "template/local-compare-with-a-rename",
    stage: async (runtime) => {
      await git(runtime.workspace, "checkout", "--quiet", "feature");
      await git(runtime.workspace, "mv", "readme.txt", "README.md").catch(() => {});
      await writeFile(join(runtime.workspace, "extra.ts"), "export const extra = 2;\n");
      await git(runtime.workspace, "add", "-A");
      await git(runtime.workspace, "commit", "--quiet", "-m", "Rename and add");
    },
    arrange: () => {
      get("", 200, { full_name: "acme/widgets", default_branch: "main" });
      compare("main", "feature", 404, { message: "Not Found" });
    },
  },

  // --- CI on the head -------------------------------------------------------
  {
    name: "template/head-ci-unavailable",
    stage: async (runtime) => {
      await git(runtime.workspace, "checkout", "--quiet", "feature");
    },
    arrange: () => {
      compare("main", "feature", 200, {
        status: "ahead",
        ahead_by: 1,
        commits: [{ sha: "c2", commit: { message: "Second change" } }],
        files: [],
      });
      get("/commits/c2/check-runs?per_page=100", 500, { message: "Server Error" });
    },
  },
  // A comparison that reports no commits has no head sha, so no CI is asked
  // for at all.
  {
    name: "template/no-head-sha-means-no-ci-call",
    arrange: () =>
      compare("main", "feature", 200, { status: "identical", ahead_by: 0, commits: [], files: [] }),
  },

  // --- Branch names that have to be turned into a title ---------------------
  {
    name: "template/branch-name-with-separators",
    stage: async (runtime) => {
      await git(runtime.workspace, "checkout", "--quiet", "-b", "feat/add_the-thing");
    },
    // A comparison that succeeds but found nothing: with no commit to take a
    // title from, the branch name is read as one.
    arrange: () =>
      compare("main", "feat/add_the-thing", 200, { status: "identical", ahead_by: 0, commits: [], files: [] }),
  },
  {
    name: "template/branch-name-starting-with-a-digit",
    stage: async (runtime) => {
      await git(runtime.workspace, "checkout", "--quiet", "-b", "123-fix");
    },
    // A comparison that succeeds but found nothing: with no commit to take a
    // title from, the branch name is read as one.
    arrange: () =>
      compare("main", "123-fix", 200, { status: "identical", ahead_by: 0, commits: [], files: [] }),
  },
  // A leading character `\w` does not match is left alone by the reference's
  // capitalisation.
  {
    name: "template/branch-name-starting-with-punctuation",
    stage: async (runtime) => {
      await git(runtime.workspace, "checkout", "--quiet", "-b", "+odd-name");
    },
    // A comparison that succeeds but found nothing: with no commit to take a
    // title from, the branch name is read as one.
    arrange: () =>
      compare("main", "+odd-name", 200, { status: "identical", ahead_by: 0, commits: [], files: [] }),
  },
  // The same rule, one step subtler: `\w` is ASCII, so a branch whose first
  // letter is outside it is *not* capitalised either. This is the case that
  // separates the reference's rule from a Unicode-aware one, which would
  // happily turn the accented letter into its capital.
  {
    name: "template/branch-name-starting-outside-ascii",
    stage: async (runtime) => {
      await git(runtime.workspace, "checkout", "--quiet", "-b", "\u00e9meraude-work");
    },
    arrange: () =>
      compare("main", "\u00e9meraude-work", 200, {
        status: "identical",
        ahead_by: 0,
        commits: [],
        files: [],
      }),
  },

  // --- Nothing works --------------------------------------------------------
  {
    name: "template/github-repository-unreadable",
    stage: async (runtime) => {
      await git(runtime.workspace, "checkout", "--quiet", "feature");
    },
    arrange: () => {
      get("", 401, { message: "Bad credentials" });
      compare("main", "feature", 401, { message: "Bad credentials" });
    },
  },
  // A repository with no commits: `git status` reports a branch that does not
  // exist yet, and every comparison fails.
  {
    name: "template/repository-with-no-commits",
    stage: async (runtime) => {
      await run("rm", ["-rf", join(runtime.home, "empty-repo")]);
      await run("mkdir", ["-p", join(runtime.home, "empty-repo")]);
      const empty = join(runtime.home, "empty-repo");
      await git(empty, "init", "--quiet", "--initial-branch", "main");
      await git(empty, "config", "user.email", "gate@example.com");
      await git(empty, "config", "user.name", "Gate");
      await git(empty, "remote", "add", "origin", REMOTE);
      await plant(runtime, (config) => {
        config.gitRepositories = [{ name: "widgets", path: empty }];
      });
    },
    arrange: () => get("", 200, { full_name: "acme/widgets", default_branch: "main" }),
  },
];

const dump = process.argv.includes("--dump");
const argv = process.argv.slice(2).filter((value) => value !== "--dump");
if (argv.length === 0) {
  console.error("Usage: check-github-template-parity.ts <candidate> [args...]");
  process.exit(2);
}

const root = await mkdtemp(join(tmpdir(), "nmi-github-template-parity-"));
const harness = new RuntimeHarness(root);
const stubs: ApiStub[] = [];
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
        gitRepositories: [{ name: "widgets", path: partial.workspace }],
        selectedGitRepository: "widgets",
        githubTokens: [{ host: "github.com", token: "tok-fixture" }],
      }),
      () => [],
    );
    await seedWorkspace(runtime);
    const stub = await startApiStub(api);
    stubs.push(stub);
    await harness.startDaemon(runtime, { NOMOREIDE_GITHUB_API_BASE: stub.base });
    runtimes.push(runtime);
  }
  const [reference, candidate] = runtimes;

  for (const step of steps) {
    step.arrange?.();
    if (step.stage) {
      for (const runtime of runtimes) await step.stage(runtime);
    }
    for (const stub of stubs) stub.take();

    // One unit per runtime: the answer and the requests it caused are the
    // comparison, and in replay the reference's side comes from the recording
    // rather than from a process that no longer exists.
    const observe = (runtime: Runtime, stub: (typeof stubs)[number]) =>
      harness.recorded(runtime, step.name, async () => ({
        answer: await send(runtime),
        requests: stub.take(),
      }));
    const reference_ = await observe(reference, stubs[0]);
    const candidate_ = await observe(candidate, stubs[1]);
    const answers = { reference: reference_.answer, candidate: candidate_.answer };
    const requests = { reference: reference_.requests, candidate: candidate_.requests };
    if (dump) {
      console.log(`--- ${step.name} ---`);
      console.log(`  reference: ${inspect({ ...answers.reference, requests: requests.reference }, { depth: null })}`);
      console.log(`  candidate: ${inspect({ ...answers.candidate, requests: requests.candidate }, { depth: null })}`);
    }
    compareAnswers(
      step.name,
      normalize({ answer: answers.candidate, requests: requests.candidate }, candidate),
      normalize({ answer: answers.reference, requests: requests.reference }, reference),
    );
  }
} finally {
  await harness.shutdown();
  await Promise.all(stubs.map((stub) => stub.close()));
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}

console.log(
  failures === 0
    ? `\ngithub-template parity: ${steps.length} cases match`
    : `\ngithub-template parity: ${failures} case(s) diverged`,
);
process.exit(failures === 0 ? 0 : 1);

function compareAnswers(name: string, candidate: unknown, reference: unknown): void {
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

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

async function plant(
  runtime: Runtime,
  edit: (config: Record<string, unknown>) => void,
): Promise<void> {
  const path = join(runtime.home, ".config", "nomoreide", "config.json");
  const config = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  edit(config);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
}

/** `main` with one commit, plus a `feature` branch one commit ahead. */
async function seedWorkspace(runtime: Runtime): Promise<void> {
  const workspace = runtime.workspace;
  await git(workspace, "init", "--quiet", "--initial-branch", "main");
  await git(workspace, "config", "user.email", "gate@example.com");
  await git(workspace, "config", "user.name", "Gate");
  await git(workspace, "remote", "add", "origin", REMOTE);
  await writeFile(join(workspace, "readme.txt"), "seed\n");
  await git(workspace, "add", "-A");
  await git(workspace, "commit", "--quiet", "-m", "First change");
  await git(workspace, "checkout", "--quiet", "-b", "feature");
  await writeFile(join(workspace, "app.ts"), "export const app = 1;\n");
  await git(workspace, "add", "-A");
  await git(workspace, "commit", "--quiet", "-m", "Second change");
}

async function send(runtime: Runtime): Promise<Answer> {
  const credential = await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
    .then((value) => value.trim())
    .catch(() => "");
  const response = await fetch(`http://127.0.0.1:${runtime.port}${PATH}`, {
    headers: credential ? { authorization: `Bearer ${credential}` } : {},
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* compared as the text it was */
  }
  return { status: response.status, body: parsed };
}

function erase(value: string, runtime: Runtime): string {
  return value
    .split(`/private${runtime.home}`)
    .join("<home>")
    .split(runtime.home)
    .join("<home>");
}

/**
 * Erase what cannot repeat between two equivalent runs.
 *
 * Commit hashes are the interesting one: git embeds a commit time at one-second
 * resolution, so two independently-seeded repositories with byte-identical
 * content agree only when both were seeded inside the same second. That made
 * this gate pass most of the time and fail the rest — worse than failing
 * always, because an intermittent pass reads as a flake rather than a hole.
 *
 * Applied to the **request log as well as the answer**: a sha reaches the
 * outbound URL of the CI lookup, which is exactly where it was being missed.
 */
function normalize<T>(value: T, runtime: Runtime): T {
  const erased = erase(JSON.stringify(value), runtime).replace(/\b[0-9a-f]{7,40}\b/g, "<sha>");
  return JSON.parse(erased) as T;
}
