/**
 * Phase 6 parity gate for the read-safe `/api/git/*` routes served by the
 * native daemon: status, overview, files, file-sizes, file, commit,
 * commit/files, branches, identity, diff, graph, worktrees. (search/files and
 * search/content have their own coverage via the daemon's HTTP integration
 * test and are not repeated here.)
 *
 * Nothing here reads either implementation's route handler. Both runtimes get
 * an identical set of real git repositories — planted with the same shell
 * commands in each runtime's own throwaway home — registered the same way, and
 * the same ordered sequence of HTTP calls is diffed.
 *
 * Usage:
 *   node --import tsx scripts/check-git-reads-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { inspect } from "node:util";
import {
  candidateSpec,
  referenceSpec,
  RuntimeHarness,
  type Runtime,
  type WorkspaceFile,
} from "../test/support/runtime-parity.js";

const run = promisify(execFile);

interface Step {
  readonly name: string;
  readonly path: string;
  readonly text?: boolean;
}

const steps: readonly Step[] = [
  { name: "status", path: "/api/git/status" },
  { name: "overview/default-board", path: "/api/git/overview" },
  { name: "files", path: "/api/git/files" },
  { name: "file-sizes", path: "/api/git/file-sizes" },
  { name: "file/tracked", path: "/api/git/file?path=src/main.rs" },
  { name: "file/nested", path: "/api/git/file?path=src/nested/deep.txt" },
  { name: "file/untracked", path: "/api/git/file?path=untracked.txt" },
  { name: "file/climbing", path: "/api/git/file?path=" + encodeURIComponent("../escape.txt") },
  { name: "file/missing-path", path: "/api/git/file" },
  { name: "file/binary", path: "/api/git/file?path=image.bin" },
  { name: "commit/no-hash", path: "/api/git/commit" },
  { name: "commit/files-no-hash", path: "/api/git/commit/files" },
  { name: "commit/invalid-hash", path: "/api/git/commit?hash=not-hex" },
  { name: "commit/short-hash", path: "/api/git/commit?hash=abc" },
  { name: "branches", path: "/api/git/branches" },
  { name: "identity/no-account-selected", path: "/api/git/identity" },
  { name: "identity/named-repo", path: "/api/git/identity?repo=repo" },
  { name: "identity/unknown-repo", path: "/api/git/identity?repo=nope" },
  { name: "diff/untracked", path: "/api/git/diff?file=untracked.txt", text: true },
  { name: "diff/unstaged", path: "/api/git/diff?file=src/main.rs", text: true },
  { name: "diff/staged-only", path: "/api/git/diff?file=staged-only.txt", text: true },
  { name: "diff/both-staged-and-unstaged", path: "/api/git/diff?file=both.txt", text: true },
  { name: "diff/clean-file", path: "/api/git/diff?file=src/nested/deep.txt" },
  { name: "diff/missing-file-param", path: "/api/git/diff" },
  { name: "diff/unknown-repo", path: "/api/git/diff?file=a.txt&repo=nope" },
  { name: "diff/no-trailing-newline", path: "/api/git/diff?file=no-newline.txt", text: true },
  { name: "graph/default", path: "/api/git/graph" },
  { name: "graph/custom-limit", path: "/api/git/graph?limit=2" },
  { name: "graph/unparsable-limit", path: "/api/git/graph?limit=not-a-number" },
  { name: "graph/zero-limit", path: "/api/git/graph?limit=0" },
  { name: "graph/fractional-limit", path: "/api/git/graph?limit=2.9" },
  { name: "graph/over-ceiling", path: "/api/git/graph?limit=99999" },
  { name: "worktrees", path: "/api/git/worktrees" },
];

const dump = process.argv.includes("--dump");
const argv = process.argv.slice(2).filter((value) => value !== "--dump");
if (argv.length === 0) {
  console.error("Usage: check-git-reads-parity.ts <candidate> [args...]");
  process.exit(2);
}

const root = await mkdtemp(join(tmpdir(), "nmi-git-reads-parity-"));
const harness = new RuntimeHarness(root);
let failures = 0;
// Each runtime's own commit hash: git embeds a commit timestamp, so two
// independently-seeded repos with byte-identical content still diverge in
// hash — this is not a case where "the same input" means "the same output".
const commitHashByPort = new Map<number, string>();

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      spec,
      (partial) => ({
        version: 1,
        services: [],
        bundles: [],
        // `path` is the unresolved /var/... form a real config holds on macOS,
        // while `git worktree list` reports the /private/var/... target. The
        // active-worktree match has to see through that, so the fixture keeps
        // them in the two different forms rather than normalizing either.
        // Five repositories, because `overview` fans out over all of them and
        // its board defaults to the first four — a cap that is only
        // observable once a fifth exists to be left out.
        gitRepositories: [
          {
            name: "repo",
            path: partial.workspace,
            activeWorktreePath: join(partial.workspace, "..", "wt-feature"),
          },
          // A real second repository, on its own branch with its own dirty
          // files, so a column that merely echoed the selected repo's status
          // would show.
          { name: "second", path: join(partial.home, "second-repo") },
          // A directory that exists but is not a repository: git answers,
          // and it answers with a failure.
          { name: "broken", path: join(partial.home, "not-a-repo") },
          // A path that is not there at all — the spawn itself fails, which
          // is a different failure from git refusing.
          { name: "missing", path: join(partial.home, "no-such-directory") },
          // Fifth, so the default board has something to cut.
          { name: "beta", path: join(partial.home, "beta-repo") },
          // A live repository whose *active worktree* has been removed. The
          // read fails, and a failing column reports the registered path
          // rather than the worktree it could not reach — which is only
          // observable when the two differ, as they do only here.
          {
            name: "detached",
            path: join(partial.home, "beta-repo"),
            activeWorktreePath: join(partial.home, "gone-worktree"),
          },
        ],
        selectedGitRepository: "repo",
      }),
      () => workspaceFiles(),
    );
    // The repo must exist and have history before the daemon is asked about
    // it, so this runs between provisioning and starting the daemon rather
    // than as a step.
    const { commitHash } = await seedRepository(runtime.workspace);
    await seedOverviewRepositories(runtime.home);
    commitHashByPort.set(runtime.port, commitHash);
    await harness.startDaemon(runtime);
    runtimes.push(runtime);
  }
  const [reference, candidate] = runtimes;

  // A step naming a commit is resolved per runtime rather than shared, for
  // the reason above: one static path would silently ask the candidate about
  // a commit that only the reference's repo has.
  const commitSteps = (runtime: Runtime): Step[] => {
    const hash = commitHashByPort.get(runtime.port)!;
    return [
      { name: "commit/diff", path: `/api/git/commit?hash=${hash}`, text: true },
      { name: "commit/diff-one-file", path: `/api/git/commit?hash=${hash}&file=src/main.rs`, text: true },
      { name: "commit/files", path: `/api/git/commit/files?hash=${hash}` },
    ];
  };
  const allSteps: readonly [reference: Step, candidate: Step][] = [
    ...steps.map((step): [Step, Step] => [step, step]),
    ...commitSteps(reference).map((step, index): [Step, Step] => [step, commitSteps(candidate)[index]]),
  ];

  const compare = async (referenceStep: Step, candidateStep: Step) => {
    const answers = {
      reference: await send(reference, referenceStep),
      candidate: await send(candidate, candidateStep),
    };
    if (dump) {
      console.log(`--- ${referenceStep.name} ---`);
      console.log(`  reference: ${inspect(answers.reference, { depth: null })}`);
      console.log(`  candidate: ${inspect(answers.candidate, { depth: null })}`);
    }
    try {
      // Content-type charset is a systemic axum-vs-Node difference across the
      // whole daemon, not specific to these routes — not compared here, the
      // same way the terminal and approval gates don't compare it either.
      const normalize = (answer: Answer) => {
        // The runtime *home* is erased as well as the workspace: a worktree
        // added beside the workspace (`../wt-feature`) lives under the home,
        // so normalizing only the workspace would leave "reference" vs
        // "candidate" in the path and fail on the harness's own layout.
        // Longest-first so the workspace is replaced before its parent.
        const { contentType: _contentType, ...rest } = normalizePaths(answer, [
          reference.workspace,
          candidate.workspace,
          reference.home,
          candidate.home,
        ]);
        return { ...rest, body: normalizeHashes(rest.body) };
      };
      assert.deepStrictEqual(normalize(answers.candidate), normalize(answers.reference));
      console.log(`ok   ${referenceStep.name}`);
    } catch (error) {
      failures += 1;
      console.log(`FAIL ${referenceStep.name}`);
      console.log(`  reference: ${inspect(answers.reference, { depth: null })}`);
      console.log(`  candidate: ${inspect(answers.candidate, { depth: null })}`);
      console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  for (const [referenceStep, candidateStep] of allSteps) {
    await compare(referenceStep, candidateStep);
  }

  // The board's *pinned* branch cannot coexist with its default branch in one
  // config, and there is no read-safe route that sets it. Both configs are
  // rewritten on disk instead — every handler loads config per request, so the
  // next call sees the new board without a restart.
  for (const runtime of runtimes) {
    await pinBoard(runtime, ["beta", "gone", "repo"]);
  }
  const pinned: Step = { name: "overview/pinned-board", path: "/api/git/overview" };
  await compare(pinned, pinned);
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? `\ngit-reads parity: ${steps.length + 4} cases match`
    : `\ngit-reads parity: ${failures} case(s) diverged`,
);
process.exit(failures === 0 ? 0 : 1);

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
}

async function send(runtime: Runtime, step: Step): Promise<Answer> {
  const credential = await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
    .then((value) => value.trim())
    .catch(() => "");
  const response = await fetch(`http://127.0.0.1:${runtime.port}${step.path}`, {
    headers: credential ? { authorization: `Bearer ${credential}` } : {},
  });
  const text = await response.text();
  if (step.text) {
    return { status: response.status, contentType: response.headers.get("content-type"), body: text };
  }
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* compared as the text it was */
  }
  return { status: response.status, contentType: response.headers.get("content-type"), body };
}

/** Erase each runtime's own absolute workspace path from a body, so a real
 * path substring inside a diff/error message does not fail the compare. */
function normalizePaths(answer: Answer, paths: readonly string[]): Answer {
  let replaced = JSON.stringify(answer.body);
  // macOS reports /private/var where the harness holds /var, so each path is
  // erased in both forms. Longest first, so a workspace is replaced before the
  // home that contains it.
  const variants = paths
    .flatMap((path) => [path, path.startsWith("/var/") ? `/private${path}` : path])
    .sort((a, b) => b.length - a.length);
  for (const path of variants) replaced = replaced.split(path).join("<root>");
  return { ...answer, body: JSON.parse(replaced) };
}

/**
 * Each runtime seeds its own repo, so commit hashes and author timestamps
 * differ by construction. Replace each distinct hash with a positional token
 * (in first-seen order) so *structure* — lane, laneCount, edges, throughLanes,
 * refs, parent wiring — is still compared exactly, which is the whole point of
 * gating the graph.
 */
function normalizeHashes(value: unknown): unknown {
  const seen = new Map<string, string>();
  const token = (hash: string) => {
    if (!seen.has(hash)) seen.set(hash, `<hash-${seen.size}>`);
    return seen.get(hash)!;
  };
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return /^[0-9a-f]{40}$/.test(node) ? token(node) : node;
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node).map(([key, entry]) =>
          // A commit timestamp is wall-clock and cannot match across runs.
          key === "timestamp" || key === "createdAt"
            ? [key, "<timestamp>"]
            : [key, walk(entry)],
        ),
      );
    }
    return node;
  };
  return walk(value);
}

function workspaceFiles(): WorkspaceFile[] {
  return [];
}

/**
 * Rewrite one runtime's config with a pinned board. `gone` is deliberately not
 * a registered repository: the effective board has to drop it, and pinning
 * only names that exist would never show whether it does.
 */
async function pinBoard(runtime: Runtime, names: string[]): Promise<void> {
  const path = join(runtime.home, ".config", "nomoreide", "config.json");
  const fs = await import("node:fs/promises");
  const config = JSON.parse(await fs.readFile(path, "utf8"));
  config.gitBoardRepositories = names;
  await fs.writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Plant the other repositories `overview` fans out over, beside the runtime's
 * workspace. Only two of the four registered here are real: `not-a-repo` and
 * the absent `no-such-directory` are the failing columns, and they fail in two
 * different ways on purpose — git refusing versus the spawn never landing.
 */
async function seedOverviewRepositories(home: string): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.mkdir(join(home, "not-a-repo"), { recursive: true });
  await fs.writeFile(join(home, "not-a-repo", "readme.txt"), "not a repository\n");

  // `second` carries a branch name and a dirty working tree unlike the main
  // repo's, so a column showing the wrong repository is visible rather than
  // coincidentally identical.
  const second = join(home, "second-repo");
  await fs.mkdir(second, { recursive: true });
  const git = (cwd: string) => (...args: string[]) => run("git", args, { cwd });
  const inSecond = git(second);
  await inSecond("init", "--quiet", "--initial-branch", "trunk");
  await inSecond("config", "user.email", "gate@example.com");
  await inSecond("config", "user.name", "Gate");
  await fs.writeFile(join(second, "app.ts"), "export const app = 1;\n");
  await inSecond("add", "-A");
  await inSecond("commit", "--quiet", "-m", "second repo");
  await fs.writeFile(join(second, "app.ts"), "export const app = 2;\n");
  await fs.writeFile(join(second, "scratch.log"), "untracked\n");

  // `beta` is clean and exists only to be the fifth repository the default
  // board cuts.
  const beta = join(home, "beta-repo");
  await fs.mkdir(beta, { recursive: true });
  const inBeta = git(beta);
  await inBeta("init", "--quiet", "--initial-branch", "main");
  await inBeta("config", "user.email", "gate@example.com");
  await inBeta("config", "user.name", "Gate");
  await fs.writeFile(join(beta, "beta.txt"), "beta\n");
  await inBeta("add", "-A");
  await inBeta("commit", "--quiet", "-m", "beta repo");
}

/** Plant an identical repo (files, commits, a branch) in one runtime's
 * workspace and report the hashes later steps need. */
async function seedRepository(cwd: string): Promise<{ commitHash: string }> {
  const git = (...args: string[]) => run("git", args, { cwd });
  await run("mkdir", ["-p", join(cwd, "src/nested")]);
  const write = (path: string, contents: string | Buffer) =>
    import("node:fs/promises").then((fs) => fs.writeFile(join(cwd, path), contents));

  await git("init", "--quiet");
  await git("config", "user.email", "gate@example.com");
  await git("config", "user.name", "Gate");

  await write("src/main.rs", "fn main() {}\n");
  await write("src/nested/deep.txt", "nested content\n");
  await write("image.bin", Buffer.from([0x00, 0xff, 0x01, 0x00]));
  await git("add", "-A");
  await git("commit", "--quiet", "-m", "first");

  await write("src/main.rs", "fn main() { println!(\"hi\"); }\n");
  await write("staged-only.txt", "committed\n");
  await write("both.txt", "committed\n");
  await git("add", "-A");
  await git("commit", "--quiet", "-m", "second");

  await git("branch", "feature");
  // A real second worktree, so `activePath` has to *choose* rather than always
  // landing on the repo root — which is what makes the match logic observable.
  await git("worktree", "add", join(cwd, "..", "wt-feature"), "feature");

  // An unstaged edit: `git diff` shows it, `--cached` does not.
  await write("src/main.rs", "fn main() { println!(\"edited\"); }\n");
  // Staged only: `--cached` shows it, `git diff` does not.
  await write("staged-only.txt", "staged\n");
  await git("add", "staged-only.txt");
  // Both: the unstaged version must win.
  await write("both.txt", "staged\n");
  await git("add", "both.txt");
  await write("both.txt", "unstaged\n");

  await write("untracked.txt", "not tracked\n");
  await write("no-newline.txt", "no trailing newline");

  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd });
  return { commitHash: stdout.trim() };
}
