/**
 * Phase 6 parity gate for the read-safe `/api/git/*` routes added to the
 * native daemon: status, files, file-sizes, file, commit, commit/files,
 * branches. (search/files and search/content already have their own
 * coverage via the daemon's HTTP integration test and are not repeated
 * here; graph and worktrees are not served natively yet — see routes/git.rs.)
 *
 * Nothing here reads either implementation's route handler. Both runtimes get
 * an identical real git repository — planted with the same shell commands in
 * each runtime's own throwaway workspace — registered as the selected
 * repository, and the same ordered sequence of HTTP calls is diffed.
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
];
// `/api/git/graph` and `/api/git/worktrees` are not served by the native
// daemon yet — see the note at the end of routes/git.rs for why — so they
// are not gated here either.

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
        gitRepositories: [{ name: "repo", path: partial.workspace }],
        selectedGitRepository: "repo",
      }),
      () => workspaceFiles(),
    );
    // The repo must exist and have history before the daemon is asked about
    // it, so this runs between provisioning and starting the daemon rather
    // than as a step.
    const { commitHash } = await seedRepository(runtime.workspace);
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

  for (const [referenceStep, candidateStep] of allSteps) {
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
        const { contentType: _contentType, ...rest } = normalizePaths(answer, [reference.workspace, candidate.workspace]);
        return rest;
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
  }
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? `\ngit-reads parity: ${steps.length + 3} cases match`
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
  const text = JSON.stringify(answer.body);
  let replaced = text;
  for (const path of paths) replaced = replaced.split(path).join("<workspace>");
  return { ...answer, body: JSON.parse(replaced) };
}

function workspaceFiles(): WorkspaceFile[] {
  return [];
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
  await git("add", "-A");
  await git("commit", "--quiet", "-m", "second");

  await git("branch", "feature");

  await write("untracked.txt", "not tracked\n");

  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd });
  return { commitHash: stdout.trim() };
}
