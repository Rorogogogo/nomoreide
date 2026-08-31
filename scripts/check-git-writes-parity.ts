/**
 * Phase 6 parity gate for the *write* half of `/api/git/*` that stays local:
 * `stage`, `unstage`, `commit`, `PUT /api/git/file`, and `fetch`.
 *
 * Unlike the read gate, every case here can change what the next case sees, so
 * the sequence is the fixture: the two runtimes start from byte-identical
 * repositories and are driven through the *same* ordered mutations. A read is
 * interleaved after each write, because a write that answers `{ok:true}`
 * without doing anything looks exactly like one that worked.
 *
 * Usage:
 *   node --import tsx scripts/check-git-writes-parity.ts <candidate> [args...]
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

/** A shell command run in *both* workspaces between steps, for state no
 * read-safe route can set up — a remote, in practice. */
interface Fixture {
  readonly fixture: string;
  readonly args: readonly string[];
}

type Sequenced = Step | Fixture;

function isFixture(step: Sequenced): step is Fixture {
  return "fixture" in step;
}

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT";
  readonly path: string;
  /** JSON body. */
  readonly json?: unknown;
  /** Form-encoded body, already serialized — `commit` is the one form route. */
  readonly form?: string;
  readonly text?: boolean;
}

const steps: readonly Step[] = [
  // --- staging refusals, none of which may change the tree ---
  { name: "stage/no-body", method: "POST", path: "/api/git/stage" },
  { name: "stage/empty-paths", method: "POST", path: "/api/git/stage", json: { paths: [] } },
  { name: "stage/blank-path", method: "POST", path: "/api/git/stage", json: { paths: ["   "] } },
  {
    name: "stage/non-string-paths",
    method: "POST",
    path: "/api/git/stage",
    json: { paths: [7, null] },
  },
  {
    name: "stage/unknown-repo",
    method: "POST",
    path: "/api/git/stage",
    json: { repo: "nope", paths: ["untracked.txt"] },
  },
  { name: "status/after-refusals", method: "GET", path: "/api/git/status" },

  // --- the editor's save ---
  { name: "file/write-no-body", method: "PUT", path: "/api/git/file" },
  { name: "file/write-blank-path", method: "PUT", path: "/api/git/file", json: { path: "  " } },
  {
    name: "file/write-no-content",
    method: "PUT",
    path: "/api/git/file",
    json: { path: "src/main.rs" },
  },
  {
    name: "file/write-non-string-content",
    method: "PUT",
    path: "/api/git/file",
    json: { path: "src/main.rs", content: 7 },
  },
  {
    name: "file/write-untracked",
    method: "PUT",
    path: "/api/git/file",
    json: { path: "untracked.txt", content: "rewritten" },
  },
  {
    name: "file/write-climbing",
    method: "PUT",
    path: "/api/git/file",
    json: { path: "../escape.txt", content: "rewritten" },
  },
  {
    name: "file/write-binary",
    method: "PUT",
    path: "/api/git/file",
    json: { path: "image.bin", content: "now text" },
  },
  {
    name: "file/write-tracked",
    method: "PUT",
    path: "/api/git/file",
    json: { path: "src/main.rs", content: "fn main() { saved(); }\n" },
  },
  { name: "file/read-back", method: "GET", path: "/api/git/file?path=src/main.rs" },

  // --- index round trip ---
  {
    name: "stage/one-file",
    method: "POST",
    path: "/api/git/stage",
    json: { paths: ["src/main.rs"] },
  },
  { name: "status/after-stage", method: "GET", path: "/api/git/status" },
  {
    name: "unstage/one-file",
    method: "POST",
    path: "/api/git/unstage",
    json: { paths: ["src/main.rs"] },
  },
  { name: "status/after-unstage", method: "GET", path: "/api/git/status" },

  // --- committing ---
  { name: "commit/no-body", method: "POST", path: "/api/git/commit" },
  { name: "commit/blank-message", method: "POST", path: "/api/git/commit", form: "message=%20%20" },
  {
    name: "commit/unknown-repo",
    method: "POST",
    path: "/api/git/commit",
    form: "repo=nope&message=anything",
  },
  // Nothing is staged yet, so git refuses — a real 400 with git's own wording.
  { name: "commit/nothing-staged", method: "POST", path: "/api/git/commit", form: "message=empty" },
  {
    name: "stage/for-commit",
    method: "POST",
    path: "/api/git/stage",
    json: { paths: ["src/main.rs"] },
  },
  // `+` is a space and `%2B` is a literal plus: the one place form decoding is
  // observable, since the message comes back out through the log.
  {
    name: "commit/staged",
    method: "POST",
    path: "/api/git/commit",
    form: "message=fix+a%2Bb+parsing",
  },
  { name: "graph/after-commit", method: "GET", path: "/api/git/graph?limit=2" },
  { name: "status/after-commit", method: "GET", path: "/api/git/status" },

  // --- fetching ---
  // With no remote configured at all, `git fetch --prune` is a successful
  // no-op. That is the success path; the failure path needs a remote that
  // cannot be reached, which no read-safe route can add.
  { name: "fetch/no-remote", method: "POST", path: "/api/git/fetch" },
];

/** The full ordered run: steps, with fixture commands spliced in. */
const sequence: readonly Sequenced[] = [
  ...steps,
  { fixture: "remote", args: ["remote", "add", "origin", "/nonexistent/nomoreide-gate.git"] },
  { name: "fetch/broken-remote", method: "POST", path: "/api/git/fetch" },
];

const dump = process.argv.includes("--dump");
const argv = process.argv.slice(2).filter((value) => value !== "--dump");
if (argv.length === 0) {
  console.error("Usage: check-git-writes-parity.ts <candidate> [args...]");
  process.exit(2);
}

const root = await mkdtemp(join(tmpdir(), "nmi-git-writes-parity-"));
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
        // A *cached* identity, so `resolveSelectedIdentity` answers from
        // config and never reaches GitHub. Without this the commit falls back
        // to the machine's git config, `author` is null on both sides, and a
        // route that ignored the selection entirely would still pass.
        githubIdentities: [
          {
            host: "github.com",
            login: "gate-bot",
            name: "Gate Bot",
            email: "gate-bot@users.noreply.github.com",
          },
        ],
        gitRepositories: [
          {
            name: "repo",
            path: partial.workspace,
            githubCredential: { source: "gh", host: "github.com", login: "gate-bot" },
          },
        ],
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
      for (const runtime of runtimes) await run("git", [...step.args], { cwd: runtime.workspace });
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

  // The daemons answered identically; the repositories they answered *about*
  // must have ended up identical too. A write that reports the right thing and
  // leaves a different tree behind is exactly what an HTTP-only compare misses.
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
    ? `\ngit-writes parity: ${total} cases match`
    : `\ngit-writes parity: ${failures} case(s) diverged`,
);
process.exit(failures === 0 ? 0 : 1);

/** Assertions about the repository on disk, run after every step. */
function finalReads(): Array<[string, (cwd: string) => Promise<unknown>]> {
  const git = (cwd: string, args: string[]) => run("git", args, { cwd }).then(({ stdout }) => stdout);
  return [
    ["tree/commit-subject", (cwd) => git(cwd, ["log", "-1", "--format=%s"])],
    // Who the commit was stamped as. The machine identity is the harness's own
    // git config, so a route that dropped the selected account would show it.
    ["tree/commit-author", (cwd) => git(cwd, ["log", "-1", "--format=%an <%ae>"])],
    ["tree/commit-committer", (cwd) => git(cwd, ["log", "-1", "--format=%cn <%ce>"])],
    ["tree/commit-count", (cwd) => git(cwd, ["rev-list", "--count", "HEAD"])],
    ["tree/porcelain-status", (cwd) => git(cwd, ["status", "--porcelain"])],
    ["tree/saved-file", (cwd) => readFile(join(cwd, "src/main.rs"), "utf8")],
    ["tree/binary-intact", (cwd) => readFile(join(cwd, "image.bin")).then((b) => b.toString("hex"))],
    ["tree/untracked-intact", (cwd) => readFile(join(cwd, "untracked.txt"), "utf8")],
    // The climbing write must not have landed above the repository either.
    [
      "tree/no-escaped-file",
      (cwd) => readFile(join(cwd, "..", "escape.txt"), "utf8").catch(() => "<absent>"),
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
  } else if (step.form !== undefined) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = step.form;
  }
  const response = await fetch(`http://127.0.0.1:${runtime.port}${step.path}`, {
    method: step.method,
    headers,
    body,
  });
  const text = await response.text();
  const contentType = response.headers.get("content-type");
  if (step.text) return { status: response.status, contentType, body: text };
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* compared as the text it was */
  }
  return { status: response.status, contentType, body: parsed };
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
 * Each runtime seeds and commits into its own repository, so hashes differ by
 * construction. Full hashes are tokenized positionally; short hashes are
 * tokenized too, because `git commit` reports one inside its summary line
 * (`[main 1a2b3c4] subject`) and that line is the only proof the commit
 * happened.
 */
function normalizeHashes(value: unknown): unknown {
  const seen = new Map<string, string>();
  const token = (hash: string) => {
    if (!seen.has(hash)) seen.set(hash, `<hash-${seen.size}>`);
    return seen.get(hash)!;
  };
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      if (/^[0-9a-f]{40}$/.test(node)) return token(node);
      // Inside a longer string (a commit summary), replace in place.
      return node.replace(/\b[0-9a-f]{7,40}\b/g, (hash) => token(hash));
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

/** Plant an identical repository in one runtime's workspace. */
async function seedRepository(cwd: string): Promise<void> {
  const git = (...args: string[]) => run("git", args, { cwd });
  await run("mkdir", ["-p", join(cwd, "src")]);
  const write = (path: string, contents: string | Buffer) =>
    writeFile(join(cwd, path), contents);

  await git("init", "--quiet");
  await git("config", "user.email", "gate@example.com");
  await git("config", "user.name", "Gate");

  await write("src/main.rs", "fn main() {}\n");
  await write("image.bin", Buffer.from([0x00, 0xff, 0x01, 0x00]));
  await git("add", "-A");
  await git("commit", "--quiet", "-m", "first");

  await write("untracked.txt", "not tracked\n");
}
