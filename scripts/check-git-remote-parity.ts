/**
 * Phase 6 parity gate for the git writes that reach a remote or rewrite
 * history: `push`, `pull`, `merge`, `rebase`, and `default-branch/pull`.
 *
 * Every runtime gets its own *bare* repository to push to, planted beside its
 * workspace, so the whole gate is hermetic — nothing here touches a network.
 * That bare repo is also what makes the interesting answers observable: an
 * upstream that had to be set, a fast-forward that had something to fetch, a
 * default branch resolved from the remote's own HEAD.
 *
 * Sequenced like the local-writes gate: each case can change what the next one
 * sees, so both runtimes are driven through the same ordered mutations and the
 * two repositories are compared on disk at the end.
 *
 * Usage:
 *   node --import tsx scripts/check-git-remote-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { inspect } from "node:util";
import { gitVersion } from "../test/support/parity-recording.js";
import {
  candidateSpec,
  referenceSpec,
  RuntimeHarness,
  type Runtime,
} from "../test/support/runtime-parity.js";

const run = promisify(execFile);

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly form?: string;
}

/** A shell command run in both workspaces, for state no route can set up. */
interface Fixture {
  readonly fixture: string;
  readonly run: (workspace: string) => Promise<unknown>;
}

type Sequenced = Step | Fixture;

const isFixture = (step: Sequenced): step is Fixture => "fixture" in step;

const git = (cwd: string, ...args: string[]) => run("git", args, { cwd });

const sequence: readonly Sequenced[] = [
  // --- refusals that need no remote ---
  { name: "merge/no-branch", method: "POST", path: "/api/git/merge" },
  { name: "merge/blank-branch", method: "POST", path: "/api/git/merge", form: "branch=%20%20" },
  { name: "rebase/no-branch", method: "POST", path: "/api/git/rebase" },
  {
    name: "merge/unknown-repo",
    method: "POST",
    path: "/api/git/merge",
    form: "repo=nope&branch=feature",
  },
  { name: "push/unknown-repo", method: "POST", path: "/api/git/push", form: "repo=nope" },
  { name: "pull/unknown-repo", method: "POST", path: "/api/git/pull", form: "repo=nope" },
  { name: "merge/unknown-branch", method: "POST", path: "/api/git/merge", form: "branch=nowhere" },

  // --- a dirty tree blocks integration, and must still be dirty afterwards ---
  {
    fixture: "dirty the tree",
    run: (workspace) => writeFile(join(workspace, "src/main.rs"), "fn main() { dirty(); }\n"),
  },
  { name: "merge/dirty-tree", method: "POST", path: "/api/git/merge", form: "branch=feature" },
  { name: "rebase/dirty-tree", method: "POST", path: "/api/git/rebase", form: "branch=feature" },
  { name: "status/still-dirty", method: "GET", path: "/api/git/status" },
  {
    fixture: "clean the tree",
    run: (workspace) => git(workspace, "checkout", "--", "src/main.rs"),
  },

  // --- push: first one sets an upstream, the next one does not ---
  { name: "push/first-sets-upstream", method: "POST", path: "/api/git/push" },
  { name: "status/after-first-push", method: "GET", path: "/api/git/status" },
  {
    fixture: "commit something to push",
    run: async (workspace) => {
      await writeFile(join(workspace, "src/main.rs"), "fn main() { second(); }\n");
      await git(workspace, "add", "-A");
      await git(workspace, "commit", "--quiet", "-m", "second");
    },
  },
  { name: "push/second-keeps-upstream", method: "POST", path: "/api/git/push" },
  { name: "status/after-second-push", method: "GET", path: "/api/git/status" },
  // `remote=` only decides anything on a branch with no upstream yet: once one
  // is set, `git push` follows it and the field is inert. So this needs a fresh
  // branch, which is also the only way the second remote ever gets written to.
  {
    fixture: "start a branch with no upstream",
    run: (workspace) => git(workspace, "switch", "--quiet", "-c", "mirrored"),
  },
  { name: "push/named-remote", method: "POST", path: "/api/git/push", form: "remote=mirror" },
  {
    fixture: "back to the default branch",
    run: (workspace) => git(workspace, "switch", "--quiet", "master"),
  },

  // --- pull: fast-forward only, with something actually to fetch ---
  {
    fixture: "advance the remote from a third clone",
    run: async (workspace) => {
      const clone = join(workspace, "..", "clone");
      await run("git", ["clone", "--quiet", join(workspace, "..", "remote.git"), clone]);
      await git(clone, "config", "user.email", "other@example.com");
      await git(clone, "config", "user.name", "Other");
      await writeFile(join(clone, "remote-only.txt"), "from elsewhere\n");
      await git(clone, "add", "-A");
      await git(clone, "commit", "--quiet", "-m", "remote work");
      await git(clone, "push", "--quiet");
    },
  },
  { name: "pull/fast-forward", method: "POST", path: "/api/git/pull" },
  { name: "status/after-pull", method: "GET", path: "/api/git/status" },

  // --- back to the default branch, while local and remote still agree ---
  // Ordered before merge/rebase on purpose: those move master, and this route
  // can only fast-forward. Testing it after them would only ever reach git's
  // "diverging branches" refusal — which is worth having, and is the last pair
  // of cases below, but is no substitute for the success path.
  {
    fixture: "wander off the default branch",
    run: (workspace) => git(workspace, "switch", "--quiet", "feature"),
  },
  { name: "default-branch/pull", method: "POST", path: "/api/git/default-branch/pull" },
  { name: "status/after-default-pull", method: "GET", path: "/api/git/status" },
  // The reference reads no body here at all, so an unknown `repo` is ignored
  // rather than 404'd. Honouring it would be a divergence dressed as a fix.
  {
    name: "default-branch/pull-ignores-repo",
    method: "POST",
    path: "/api/git/default-branch/pull",
    form: "repo=nope",
  },

  // --- merge and rebase on a clean tree ---
  { name: "merge/clean", method: "POST", path: "/api/git/merge", form: "branch=feature" },
  { name: "status/after-merge", method: "GET", path: "/api/git/status" },
  { name: "rebase/onto-a-merged-branch", method: "POST", path: "/api/git/rebase", form: "branch=feature" },
  { name: "status/after-rebase", method: "GET", path: "/api/git/status" },

  // --- and the refusal, when local and remote have both moved on ---
  {
    // Master has already moved locally; this moves the remote too, so neither
    // side can fast-forward onto the other.
    fixture: "advance the remote so both sides have moved",
    run: async (workspace) => {
      const clone = join(workspace, "..", "clone");
      await git(clone, "pull", "--quiet", "--ff-only");
      await writeFile(join(clone, "elsewhere.txt"), "theirs\n");
      await git(clone, "add", "-A");
      await git(clone, "commit", "--quiet", "-m", "their work");
      await git(clone, "push", "--quiet");
      await git(workspace, "switch", "--quiet", "feature");
    },
  },
  { name: "default-branch/pull-diverged", method: "POST", path: "/api/git/default-branch/pull" },
  { name: "pull/diverged", method: "POST", path: "/api/git/pull" },

  // --- a merge that genuinely conflicts, and must abort itself ---
  {
    fixture: "return to the default branch, clean",
    run: (workspace) => git(workspace, "switch", "--quiet", "master"),
  },
  { name: "merge/conflicting", method: "POST", path: "/api/git/merge", form: "branch=conflicting" },
  // The abort is what this proves: a repository left mid-conflict reports a
  // different status, and that is the only visible difference.
  { name: "status/after-conflict", method: "GET", path: "/api/git/status" },
  { name: "rebase/conflicting", method: "POST", path: "/api/git/rebase", form: "branch=conflicting" },
  { name: "status/after-conflicting-rebase", method: "GET", path: "/api/git/status" },
];

const dump = process.argv.includes("--dump");
const argv = process.argv.slice(2).filter((value) => value !== "--dump");
if (argv.length === 0) {
  console.error("Usage: check-git-remote-parity.ts <candidate> [args...]");
  process.exit(2);
}

const root = await mkdtemp(join(tmpdir(), "nmi-git-remote-parity-"));
const harness = new RuntimeHarness(root);
let failures = 0;

try {
  // This gate compares git's own words, and those change between versions of
  // git. The comparison is worth keeping unnormalised — it is what says the
  // port surfaces git's message rather than inventing one that reads about
  // right — so the recording is stamped with the git that made it instead,
  // and a replay against a different one stops and says so.
  await harness.bind("git", await gitVersion());
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
    await seedRepository(runtime.workspace);
    await harness.startDaemon(runtime);
    runtimes.push(runtime);
  }
  const [reference, candidate] = runtimes;

  for (const step of sequence) {
    if (isFixture(step)) {
      for (const runtime of runtimes) await step.run(runtime.workspace);
      continue;
    }
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
      const normalize = (answer: Answer) => {
        const { contentType: _contentType, ...rest } = normalizePaths(answer, [
          reference.workspace,
          candidate.workspace,
          reference.home,
          candidate.home,
        ]);
        return { ...rest, body: normalizeHashes(rest.body) };
      };
      assert.deepStrictEqual(normalize(answers.candidate), normalize(answers.reference));
      console.log(`ok   ${step.name}`);
    } catch (error) {
      failures += 1;
      console.log(`FAIL ${step.name}`);
      console.log(`  reference: ${inspect(answers.reference, { depth: null })}`);
      console.log(`  candidate: ${inspect(answers.candidate, { depth: null })}`);
      console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const [name, read] of finalReads()) {
    const both = {
      reference: await read(reference.workspace),
      candidate: await read(candidate.workspace),
    };
    try {
      assert.deepStrictEqual(both.candidate, both.reference);
      console.log(`ok   ${name}`);
    } catch (error) {
      failures += 1;
      console.log(`FAIL ${name}`);
      console.log(`  reference: ${inspect(both.reference)}`);
      console.log(`  candidate: ${inspect(both.candidate)}`);
      console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}

const total = sequence.filter((step) => !isFixture(step)).length + finalReads().length;
console.log(
  failures === 0
    ? `\ngit-remote parity: ${total} cases match`
    : `\ngit-remote parity: ${failures} case(s) diverged`,
);
process.exit(failures === 0 ? 0 : 1);

/** What the two repositories — and the two remotes — must look like at the end. */
function finalReads(): Array<[string, (cwd: string) => Promise<unknown>]> {
  const show = (cwd: string, args: string[]) =>
    run("git", args, { cwd }).then(({ stdout }) => stdout);
  return [
    ["tree/branch", (cwd) => show(cwd, ["branch", "--show-current"])],
    ["tree/subjects", (cwd) => show(cwd, ["log", "--format=%s", "-6"])],
    ["tree/porcelain-status", (cwd) => show(cwd, ["status", "--porcelain"])],
    ["tree/upstream", (cwd) => show(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"])],
    // The remote is the only witness that a push left the process at all.
    [
      "remote/subjects",
      (cwd) => show(join(cwd, "..", "remote.git"), ["log", "--format=%s", "-6", "master"]),
    ],
    // Every ref the mirror holds: a push aimed at the wrong remote leaves it
    // empty, and one aimed at the wrong branch shows up here as the wrong name.
    [
      "mirror/refs",
      (cwd) => show(join(cwd, "..", "mirror.git"), ["for-each-ref", "--format=%(refname)"]),
    ],
    ["tree/merge-head-absent", (cwd) => readFile(join(cwd, ".git/MERGE_HEAD"), "utf8").catch(() => "<absent>")],
    ["tree/rebase-dir-absent", (cwd) => readFile(join(cwd, ".git/rebase-merge/head-name"), "utf8").catch(() => "<absent>")],
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
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: parsed,
  };
}

function normalizePaths(answer: Answer, paths: readonly string[]): Answer {
  let replaced = JSON.stringify(answer.body);
  const variants = paths
    .flatMap((path) => [path, path.startsWith("/var/") ? `/private${path}` : path])
    .sort((a, b) => b.length - a.length);
  for (const path of variants) replaced = replaced.split(path).join("<root>");
  return { ...answer, body: JSON.parse(replaced) };
}

/**
 * Hashes and object counts differ by construction — two independently seeded
 * repositories never agree on either. Hashes become positional tokens; git's
 * transfer chatter ("Enumerating objects: 5, done.") is elided, since the
 * numbers describe packing rather than the answer.
 */
function normalizeHashes(value: unknown): unknown {
  const seen = new Map<string, string>();
  const token = (hash: string) => {
    if (!seen.has(hash)) seen.set(hash, `<hash-${seen.size}>`);
    return seen.get(hash)!;
  };
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      return node
        .replace(/\b[0-9a-f]{7,40}\b/g, (hash) => token(hash))
        .replace(/^(Enumerating|Counting|Compressing|Writing|Total|Delta|remote:).*$/gm, "<transfer>")
        .replace(/\b\d+ (object|byte|KiB|MiB)s?\b/g, "<count>");
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node).map(([key, entry]) =>
          key === "timestamp" || key === "createdAt" ? [key, "<timestamp>"] : [key, walk(entry)],
        ),
      );
    }
    return node;
  };
  return walk(value);
}

/** A repository, a branch to integrate, and a bare remote to push to. */
async function seedRepository(workspace: string): Promise<void> {
  const local = (...args: string[]) => git(workspace, ...args);
  await run("mkdir", ["-p", join(workspace, "src")]);

  const remote = join(workspace, "..", "remote.git");
  await run("git", ["init", "--quiet", "--bare", "--initial-branch", "master", remote]);
  // A second remote, so `remote=` in the body has somewhere else to go. A
  // route that ignored the field would push to origin and this stays empty.
  const mirror = join(workspace, "..", "mirror.git");
  await run("git", ["init", "--quiet", "--bare", "--initial-branch", "master", mirror]);

  await local("init", "--quiet", "--initial-branch", "master");
  await local("config", "user.email", "gate@example.com");
  await local("config", "user.name", "Gate");
  await writeFile(join(workspace, "src/main.rs"), "fn main() {}\n");
  await local("add", "-A");
  await local("commit", "--quiet", "-m", "first");

  // A branch with a commit of its own, so merge and rebase have real work.
  await local("switch", "--quiet", "-c", "feature");
  await writeFile(join(workspace, "feature.txt"), "feature work\n");
  await local("add", "-A");
  await local("commit", "--quiet", "-m", "feature work");
  await local("switch", "--quiet", "master");

  // A branch that edits the same line master later does, so merging it is a
  // real conflict rather than a validation failure — the only way to reach the
  // abort path.
  await local("switch", "--quiet", "-c", "conflicting");
  await writeFile(join(workspace, "src/main.rs"), "fn main() { conflicting(); }\n");
  await local("add", "-A");
  await local("commit", "--quiet", "-m", "conflicting work");
  await local("switch", "--quiet", "master");

  await local("remote", "add", "origin", remote);
  await local("remote", "add", "mirror", mirror);
}
