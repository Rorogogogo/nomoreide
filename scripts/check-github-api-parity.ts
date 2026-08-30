/**
 * Phase 6 parity gate for the GitHub API routes: pull requests, issues, CI,
 * and Actions runs.
 *
 * Each runtime is pointed at its own loopback stand-in for api.github.com, and
 * every step compares two things — what the route answered, and every request
 * it made to get there. The second half is what makes this gate worth having:
 * these routes are mostly a pass-through, so a runtime that built the query
 * differently, sent the body in a different shape, or asked for a different
 * media type would answer identically right up until it reached real GitHub.
 *
 * Nothing here reads either implementation. The canned responses are rewritten
 * between steps so one repository can be walked through a whole session.
 *
 * Usage:
 *   node --import tsx scripts/check-github-api-parity.ts <candidate> [args...]
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
import { type ApiStub, type RecordedRequest, type StubRoute, startApiStub } from "./support/http-api-stub.js";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", args, { cwd });

const REMOTE = "https://github.com/acme/widgets.git";
const REPO = "/repos/acme/widgets";

const PR = {
  number: 7,
  title: "Add the thing",
  state: "open",
  body: "Because the thing was missing.",
  html_url: "https://github.com/acme/widgets/pull/7",
  head: { ref: "feature", sha: "abc123def456" },
  base: { ref: "main", sha: "0000111122223333" },
  user: { login: "octocat" },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  merged_at: null,
  draft: false,
  mergeable: true,
};

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly json?: unknown;
  /** Rewrite the canned responses before either runtime is asked. */
  readonly arrange?: () => void;
  /** Rewrite one runtime's config on disk before it is asked. */
  readonly plant?: (config: Record<string, unknown>) => void;
  /**
   * Compare the outbound requests as a set rather than a sequence.
   *
   * Two routes fan out concurrently, and which of their calls reaches the stub
   * first is a race in both runtimes, not a behaviour. That the same calls were
   * made, with the same queries and bodies, still has to hold.
   */
  readonly concurrent?: boolean;
}

const api: StubRoute[] = [];

function serve(route: StubRoute): void {
  const index = api.findIndex(
    (candidate) => candidate.method === route.method && candidate.path === route.path,
  );
  if (index === -1) api.push(route);
  else api[index] = route;
}

const get = (path: string, status: number, body: unknown, contentType?: string) =>
  serve({ method: "GET", path: `${REPO}${path}`, status, body, contentType });
const post = (path: string, status: number, body: unknown) =>
  serve({ method: "POST", path: `${REPO}${path}`, status, body });
const put = (path: string, status: number, body: unknown) =>
  serve({ method: "PUT", path: `${REPO}${path}`, status, body });

/** The diff endpoint is told apart from the JSON one by its Accept header. */
const diff = (number: number, status: number, body: string) =>
  serve({
    method: "GET",
    path: `${REPO}/pulls/${number}`,
    accept: "application/vnd.github.diff",
    status,
    body,
    contentType: "text/plain",
  });

const steps: readonly Step[] = [
  // --- Branches -------------------------------------------------------------
  {
    name: "branches/connected",
    method: "GET",
    path: "/api/github/branches",
    concurrent: true,
    arrange: () => {
      get("", 200, { full_name: "acme/widgets", default_branch: "main" });
      get("/branches?per_page=100", 200, [
        { name: "main", protected: true, commit: { sha: "aaa", url: "ignored" } },
        { name: "feature", protected: false, commit: { sha: "bbb" } },
      ]);
    },
  },
  // A repository with no default branch reports null rather than dropping the
  // key — the panel binds to it either way.
  {
    name: "branches/no-default-branch",
    method: "GET",
    path: "/api/github/branches",
    concurrent: true,
    arrange: () => get("", 200, { full_name: "acme/widgets" }),
  },
  {
    name: "branches/null-default-branch",
    method: "GET",
    path: "/api/github/branches",
    concurrent: true,
    arrange: () => get("", 200, { full_name: "acme/widgets", default_branch: null }),
  },
  // A branch whose commit carries no sha: the reshape keeps the shape, and the
  // missing field simply is not there.
  {
    name: "branches/commit-without-a-sha",
    method: "GET",
    path: "/api/github/branches",
    concurrent: true,
    arrange: () => get("/branches?per_page=100", 200, [{ name: "odd", protected: false, commit: {} }]),
  },
  {
    name: "branches/github-fails",
    method: "GET",
    path: "/api/github/branches",
    concurrent: true,
    arrange: () => get("/branches?per_page=100", 500, { message: "Server Error" }),
  },

  // --- Listing pull requests ------------------------------------------------
  {
    name: "prs/default-query",
    method: "GET",
    path: "/api/github/prs",
    arrange: () => {
      get("", 200, { full_name: "acme/widgets", default_branch: "main" });
      get("/branches?per_page=100", 200, []);
      get("/pulls?state=open&per_page=30&page=1", 200, [PR]);
    },
  },
  {
    name: "prs/state-and-page",
    method: "GET",
    path: "/api/github/prs?state=closed&page=2",
    arrange: () => get("/pulls?state=closed&per_page=30&page=2", 200, []),
  },
  // Neither value is validated here — GitHub is the one that objects, and the
  // request it is asked to object to has to be the same one.
  { name: "prs/unknown-state", method: "GET", path: "/api/github/prs?state=banana" },
  { name: "prs/blank-state", method: "GET", path: "/api/github/prs?state=" },
  { name: "prs/page-not-a-number", method: "GET", path: "/api/github/prs?page=abc" },
  { name: "prs/page-zero", method: "GET", path: "/api/github/prs?page=0" },
  { name: "prs/page-fractional", method: "GET", path: "/api/github/prs?page=2.7" },
  { name: "prs/page-negative", method: "GET", path: "/api/github/prs?page=-3" },
  { name: "prs/page-hex", method: "GET", path: "/api/github/prs?page=0x10" },
  { name: "prs/page-exponent", method: "GET", path: "/api/github/prs?page=1e2" },
  { name: "prs/page-padded", method: "GET", path: "/api/github/prs?page=%20%204%20" },
  { name: "prs/page-empty", method: "GET", path: "/api/github/prs?page=" },
  // The two spellings Rust's own float parser takes and JavaScript's does not.
  { name: "prs/page-rust-infinity", method: "GET", path: "/api/github/prs?page=inf" },
  { name: "prs/page-word-infinity", method: "GET", path: "/api/github/prs?page=Infinity" },
  {
    name: "prs/github-refuses",
    method: "GET",
    path: "/api/github/prs?state=closed&page=2",
    arrange: () => get("/pulls?state=closed&per_page=30&page=2", 422, { message: "Invalid page" }),
  },

  // --- Creating a pull request ----------------------------------------------
  { name: "prs/create-no-body", method: "POST", path: "/api/github/prs" },
  { name: "prs/create-only-a-title", method: "POST", path: "/api/github/prs", json: { title: "x" } },
  {
    name: "prs/create-blank-after-trimming",
    method: "POST",
    path: "/api/github/prs",
    json: { title: "  ", head: "feature", base: "main" },
  },
  {
    name: "prs/create-non-string-fields",
    method: "POST",
    path: "/api/github/prs",
    json: { title: 7, head: "feature", base: "main" },
  },
  {
    name: "prs/create",
    method: "POST",
    path: "/api/github/prs",
    json: { title: "  Add the thing  ", head: " feature ", base: "main", body: "Why." },
    arrange: () => post("/pulls", 201, PR),
  },
  // A body that is not a string is left out of the payload entirely, rather
  // than sent as null — GitHub reads a null body as "clear it".
  {
    name: "prs/create-without-a-body",
    method: "POST",
    path: "/api/github/prs",
    json: { title: "No body", head: "feature", base: "main", body: 42 },
  },
  {
    name: "prs/create-draft",
    method: "POST",
    path: "/api/github/prs",
    json: { title: "Draft", head: "feature", base: "main", draft: true },
  },
  // Only a real `true` is a draft: the reference tests `=== true`.
  {
    name: "prs/create-draft-is-a-string",
    method: "POST",
    path: "/api/github/prs",
    json: { title: "Draft", head: "feature", base: "main", draft: "true" },
  },
  {
    name: "prs/create-refused",
    method: "POST",
    path: "/api/github/prs",
    json: { title: "Dupe", head: "feature", base: "main" },
    arrange: () => post("/pulls", 422, { message: "A pull request already exists." }),
  },

  // --- One pull request -----------------------------------------------------
  {
    name: "prs/get",
    method: "GET",
    path: "/api/github/prs/7",
    arrange: () => get("/pulls/7", 200, PR),
  },
  // The reference matches this route by `\d+`, so a name never reaches a
  // handler at all — it falls all the way to the dispatcher's own 404.
  { name: "prs/get-not-a-number", method: "GET", path: "/api/github/prs/abc" },
  { name: "prs/get-mixed", method: "GET", path: "/api/github/prs/7a" },
  {
    name: "prs/get-unknown",
    method: "GET",
    path: "/api/github/prs/404",
    arrange: () => get("/pulls/404", 404, { message: "Not Found" }),
  },

  // --- Merging --------------------------------------------------------------
  {
    name: "prs/merge-no-body",
    method: "POST",
    path: "/api/github/prs/7/merge",
    arrange: () => put("/pulls/7/merge", 200, { merged: true, sha: "deadbeef", message: "Pull Request successfully merged" }),
  },
  { name: "prs/merge-rebase", method: "POST", path: "/api/github/prs/7/merge", json: { method: "rebase" } },
  // Anything else is a squash, not a refusal.
  { name: "prs/merge-unknown-method", method: "POST", path: "/api/github/prs/7/merge", json: { method: "fast-forward" } },
  { name: "prs/merge-numeric-method", method: "POST", path: "/api/github/prs/7/merge", json: { method: 3 } },
  {
    name: "prs/merge-with-a-commit-title",
    method: "POST",
    path: "/api/github/prs/7/merge",
    json: { method: "merge", commitTitle: "Merge it", commitMessage: "Because." },
  },
  // An empty title is no title: the reference spreads it in only when truthy.
  {
    name: "prs/merge-with-an-empty-commit-title",
    method: "POST",
    path: "/api/github/prs/7/merge",
    json: { method: "merge", commitTitle: "", commitMessage: "" },
  },
  {
    name: "prs/merge-refused",
    method: "POST",
    path: "/api/github/prs/7/merge",
    json: {},
    arrange: () => put("/pulls/7/merge", 405, { message: "Pull Request is not mergeable" }),
  },
  { name: "prs/merge-not-a-number", method: "POST", path: "/api/github/prs/x/merge" },

  // --- The review screen ----------------------------------------------------
  {
    name: "prs/review",
    method: "GET",
    path: "/api/github/prs/7/review",
    concurrent: true,
    arrange: () => {
      get("/pulls/7", 200, PR);
      get("/pulls/7/files?per_page=100", 200, [
        {
          filename: "src/app.ts",
          status: "modified",
          additions: 3,
          deletions: 1,
          changes: 4,
          patch: "@@ -1 +1 @@",
          blob_url: "https://github.com/acme/widgets/blob/abc/src/app.ts",
        },
        // A file too big for GitHub to send a patch for: the key is absent, and
        // it has to stay absent rather than become null.
        { filename: "huge.bin", status: "added", additions: 0, deletions: 0, changes: 0 },
      ]);
      get("/pulls/7/reviews?per_page=100", 200, [{ id: 1, state: "APPROVED", user: { login: "octocat" } }]);
      get("/issues/7/comments?per_page=100", 200, [{ id: 9, body: "Looks good" }]);
      get("/commits/abc123def456/check-runs?per_page=100", 200, {
        total_count: 2,
        check_runs: [
          { id: 1, name: "build", status: "completed", conclusion: "success" },
          { id: 2, name: "test", status: "completed", conclusion: "failure" },
        ],
      });
    },
  },
  // A commit with no checks at all: GitHub answers 404, and that is reported as
  // "unknown" rather than as a failure.
  {
    name: "prs/review-with-no-checks",
    method: "GET",
    path: "/api/github/prs/7/review",
    concurrent: true,
    arrange: () => get("/commits/abc123def456/check-runs?per_page=100", 404, { message: "Not Found" }),
  },
  // A pull request whose head carries no sha still asks — for the empty string,
  // which is what the reference asks for too.
  {
    name: "prs/review-head-without-a-sha",
    method: "GET",
    path: "/api/github/prs/7/review",
    concurrent: true,
    arrange: () => get("/pulls/7", 200, { ...PR, head: { ref: "feature" } }),
  },
  {
    name: "prs/review-files-fail",
    method: "GET",
    path: "/api/github/prs/7/review",
    concurrent: true,
    arrange: () => {
      get("/pulls/7", 200, PR);
      get("/pulls/7/files?per_page=100", 500, { message: "Server Error" });
    },
  },

  // --- The diff -------------------------------------------------------------
  {
    name: "prs/diff",
    method: "GET",
    path: "/api/github/prs/7/diff",
    arrange: () => diff(7, 200, "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n"),
  },
  // A failed diff is reported as whatever the server wrote, because a diff
  // response was never JSON to begin with.
  {
    name: "prs/diff-refused",
    method: "GET",
    path: "/api/github/prs/7/diff",
    arrange: () => diff(7, 406, "too large"),
  },
  { name: "prs/diff-not-a-number", method: "GET", path: "/api/github/prs/nan/diff" },

  // --- Issues ---------------------------------------------------------------
  {
    name: "issues/default",
    method: "GET",
    path: "/api/github/issues",
    arrange: () =>
      get("/issues?state=open&per_page=30&page=1", 200, [
        { number: 1, title: "A real issue" },
        // GitHub returns pull requests from the issues endpoint. They are
        // filtered out — a "pull_request" key at all is what marks one.
        { number: 7, title: "Add the thing", pull_request: { url: "..." } },
        { number: 8, title: "Null marker", pull_request: null },
      ]),
  },
  {
    name: "issues/state-and-page",
    method: "GET",
    path: "/api/github/issues?state=all&page=3",
    arrange: () => get("/issues?state=all&per_page=30&page=3", 200, []),
  },
  { name: "issues/create-no-body", method: "POST", path: "/api/github/issues" },
  { name: "issues/create-blank-title", method: "POST", path: "/api/github/issues", json: { title: "   " } },
  {
    name: "issues/create",
    method: "POST",
    path: "/api/github/issues",
    json: { title: "  Something broke  ", body: "Here is how." },
    arrange: () => post("/issues", 201, { number: 12, title: "Something broke" }),
  },
  {
    name: "issues/create-without-a-body",
    method: "POST",
    path: "/api/github/issues",
    json: { title: "Terse", body: null },
  },
  {
    name: "issues/get",
    method: "GET",
    path: "/api/github/issues/1",
    arrange: () => get("/issues/1", 200, { number: 1, title: "A real issue" }),
  },
  { name: "issues/get-not-a-number", method: "GET", path: "/api/github/issues/one" },
  {
    name: "issues/comments-list",
    method: "GET",
    path: "/api/github/issues/1/comments",
    arrange: () => get("/issues/1/comments?per_page=100", 200, [{ id: 3, body: "Any update?" }]),
  },
  { name: "issues/comments-blank", method: "POST", path: "/api/github/issues/1/comments", json: { body: "  " } },
  { name: "issues/comments-non-string", method: "POST", path: "/api/github/issues/1/comments", json: { body: 5 } },
  {
    name: "issues/comments-add",
    method: "POST",
    path: "/api/github/issues/1/comments",
    json: { body: "  On it.  " },
    arrange: () => post("/issues/1/comments", 201, { id: 4, body: "On it." }),
  },
  { name: "issues/comments-wrong-method", method: "PUT", path: "/api/github/issues/1/comments" },

  // --- CI -------------------------------------------------------------------
  {
    name: "ci/known-sha",
    method: "GET",
    path: "/api/github/ci/abc123def456",
    arrange: () =>
      get("/commits/abc123def456/check-runs?per_page=100", 200, {
        total_count: 1,
        check_runs: [{ id: 1, name: "build", status: "completed", conclusion: "success" }],
      }),
  },
  {
    name: "ci/no-checks",
    method: "GET",
    path: "/api/github/ci/abc123def456",
    arrange: () => get("/commits/abc123def456/check-runs?per_page=100", 404, { message: "Not Found" }),
  },
  {
    name: "ci/github-fails",
    method: "GET",
    path: "/api/github/ci/abc123def456",
    arrange: () => get("/commits/abc123def456/check-runs?per_page=100", 500, { message: "Server Error" }),
  },
  // The path pattern will not send just anything down a URL it signs a token
  // onto: too short, and not hexadecimal, are both simply not this route.
  { name: "ci/too-short", method: "GET", path: "/api/github/ci/abc" },
  { name: "ci/not-hex", method: "GET", path: "/api/github/ci/zzzzzz" },
  { name: "ci/uppercase", method: "GET", path: "/api/github/ci/ABC123" },
  { name: "ci/too-long", method: "GET", path: `/api/github/ci/${"a".repeat(65)}` },

  // --- Actions --------------------------------------------------------------
  {
    name: "runs/default",
    method: "GET",
    path: "/api/github/runs",
    arrange: () =>
      get("/actions/runs?per_page=30&page=1", 200, {
        total_count: 1,
        workflow_runs: [{ id: 100, name: "ci", head_sha: "abc", status: "completed", conclusion: "success" }],
      }),
  },
  {
    name: "runs/for-a-branch",
    method: "GET",
    path: "/api/github/runs?branch=feature&page=2",
    arrange: () => get("/actions/runs?per_page=30&page=2&branch=feature", 200, { workflow_runs: [] }),
  },
  // An empty branch is no branch: it must not become `&branch=`.
  { name: "runs/empty-branch", method: "GET", path: "/api/github/runs?branch=" },
  {
    name: "runs/jobs",
    method: "GET",
    path: "/api/github/runs/100/jobs",
    arrange: () =>
      get("/actions/runs/100/jobs?per_page=100", 200, {
        total_count: 1,
        jobs: [{ id: 5, name: "build", conclusion: "success" }],
      }),
  },
  {
    name: "runs/jobs-without-a-jobs-key",
    method: "GET",
    path: "/api/github/runs/100/jobs",
    arrange: () => get("/actions/runs/100/jobs?per_page=100", 200, { total_count: 0 }),
  },
  { name: "runs/jobs-not-a-number", method: "GET", path: "/api/github/runs/latest/jobs" },

  // --- With nothing connected ------------------------------------------------
  // The CI route is the one that answers 200 with an empty result instead of a
  // refusal: a commit list renders a badge per row, and "not connected" is not
  // an error to show forty times over.
  {
    name: "ci/no-account-connected",
    method: "GET",
    path: "/api/github/ci/abc123def456",
    plant: (config) => {
      config.githubTokens = [];
    },
  },
  { name: "prs/no-account-connected", method: "GET", path: "/api/github/prs" },
  { name: "branches/no-account-connected", method: "GET", path: "/api/github/branches" },
  {
    name: "prs/no-repository-selected",
    method: "GET",
    path: "/api/github/prs",
    plant: (config) => {
      config.gitRepositories = [];
      config.selectedGitRepository = undefined;
    },
  },
];

const dump = process.argv.includes("--dump");
const argv = process.argv.slice(2).filter((value) => value !== "--dump");
if (argv.length === 0) {
  console.error("Usage: check-github-api-parity.ts <candidate> [args...]");
  process.exit(2);
}

const root = await mkdtemp(join(tmpdir(), "nmi-github-api-parity-"));
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
    if (step.plant) {
      for (const runtime of runtimes) await plant(runtime, step.plant);
    }
    for (const stub of stubs) stub.take();

    // One unit per runtime: the answer and the requests it caused are the
    // comparison, and in replay the reference's side comes from the recording
    // rather than from a process that no longer exists.
    const observe = (runtime: Runtime, stub: (typeof stubs)[number]) =>
      harness.recorded(runtime, step.name, async () => ({
        answer: await send(runtime, step),
        requests: order(step, stub.take()),
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
    compare(
      step.name,
      { answer: normalizePaths(answers.candidate, candidate), requests: requests.candidate },
      { answer: normalizePaths(answers.reference, reference), requests: requests.reference },
    );
  }
} finally {
  await harness.shutdown();
  await Promise.all(stubs.map((stub) => stub.close()));
  await rm(root, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? `\ngithub-api parity: ${steps.length} cases match`
    : `\ngithub-api parity: ${failures} case(s) diverged`,
);
process.exit(failures === 0 ? 0 : 1);

/** Concurrent fan-out has no reliable arrival order; compare it as a set. */
function order(step: Step, requests: RecordedRequest[]): RecordedRequest[] {
  if (!step.concurrent) return requests;
  return [...requests].sort((left, right) => left.path.localeCompare(right.path));
}

function compare(name: string, candidate: unknown, reference: unknown): void {
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
  readonly contentType: string | null;
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

async function seedWorkspace(runtime: Runtime): Promise<void> {
  const workspace = runtime.workspace;
  await git(workspace, "init", "--quiet", "--initial-branch", "main");
  await git(workspace, "config", "user.email", "gate@example.com");
  await git(workspace, "config", "user.name", "Gate");
  await git(workspace, "remote", "add", "origin", REMOTE);
  await writeFile(join(workspace, "readme.txt"), "seed\n");
  await git(workspace, "add", "-A");
  await git(workspace, "commit", "--quiet", "-m", "first");
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
