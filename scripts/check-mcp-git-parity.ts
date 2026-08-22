/**
 * Phase 3 git parity gate.
 *
 * Runs the TypeScript reference and a candidate binary against identical,
 * throwaway fixture repositories and compares what each reports through MCP.
 * Nothing here reads either implementation: the plan in
 * `test/fixtures/mcp-git-parity-v2.json` drives both runtimes with the same
 * ordered calls and the payloads are diffed.
 *
 * Unlike the Phase 2 runtime gate, no daemon is involved — the git config tools
 * write `config.json` directly in both runtimes, so each one only needs a home
 * of its own.
 *
 * Usage:
 *   node --import tsx scripts/check-mcp-git-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { callMcpTool, type McpCommand } from "../test/support/mcp-contract.js";

const execFileAsync = promisify(execFile);

const argv = process.argv.slice(2);
const dump = argv.includes("--dump");
const candidateArgv = argv.filter((argument) => argument !== "--dump");
if (candidateArgv.length === 0) {
  throw new Error(
    "Usage: node --import tsx scripts/check-mcp-git-parity.ts [--dump] <candidate-command> [candidate-args...]",
  );
}

const root = resolve(import.meta.dirname, "..");

/**
 * One ordered step in building a fixture repository. Declarative rather than a
 * list of git commands, so the fixture says what state it wants and this file
 * stays the only place that knows how to reach it.
 */
type Setup =
  | { commit: { file: string; contents: string; message: string } }
  /** Create a bare origin, push the current branch, and track it. */
  | { remote: true }
  /** Point `origin/HEAD` at a branch, the way a clone would. */
  | { remoteHead: string }
  /** Move the branch back, leaving it behind whatever origin already has. */
  | { resetTo: string }
  /** Create a branch without switching to it. */
  | { branch: string }
  /** Leave HEAD on no branch at all. */
  | { detach: true }
  /** Write files and leave them uncommitted. */
  | { write: Record<string, string> }
  | { remove: string[] }
  | { stage: string[] };

interface Fixture {
  fixtureVersion: 2;
  repositories: Array<{
    id: string;
    initialBranch: string;
    setup: Setup[];
  }>;
  plainDirectories: string[];
  plan: Array<{
    id: string;
    tool: string;
    arguments: Record<string, unknown>;
  }>;
}

const fixture = JSON.parse(
  await readFile(join(root, "test/fixtures/mcp-git-parity-v2.json"), "utf8"),
) as Fixture;
if (fixture.fixtureVersion !== 2) {
  throw new Error(`Unsupported git parity fixture version ${fixture.fixtureVersion}`);
}

/**
 * Every commit is stamped with the same fixed timestamp. Author, committer,
 * message, and tree are already fixed by the fixture, so this is the last thing
 * that would differ — and with it fixed, both runtimes see byte-identical
 * commit hashes and `nomoreide_git_log` can be compared as reported.
 */
const COMMIT_TIME = "2026-01-02T03:04:05+00:00";

const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

interface Runtime {
  label: string;
  command: string;
  args: string[];
  home: string;
  worktrees: string;
  /** Fixture id -> absolute path in this runtime's own tree. */
  paths: Map<string, string>;
}

const specs = [
  { label: "reference", command: process.execPath, args: ["--import", "tsx", "src/index.ts"] },
  { label: "candidate", command: candidateArgv[0], args: candidateArgv.slice(1) },
];

const roots: string[] = [];
try {
  const runtimes: Runtime[] = [];
  for (const spec of specs) {
    runtimes.push(await prepare(spec));
  }

  let compared = 0;
  for (const step of fixture.plan) {
    const payloads = await Promise.all(runtimes.map((runtime) => call(runtime, step)));
    if (dump) {
      for (const [index, payload] of payloads.entries()) {
        console.log(`\n--- ${step.id} [${runtimes[index].label}]`);
        console.log(JSON.stringify(payload, null, 2));
      }
    }
    try {
      assert.deepStrictEqual(payloads[1], payloads[0]);
    } catch (error) {
      console.error(`\nGit parity failed at step "${step.id}" (${step.tool}).`);
      console.error(`reference: ${JSON.stringify(payloads[0], null, 2)}`);
      console.error(`candidate: ${JSON.stringify(payloads[1], null, 2)}`);
      throw error;
    }
    compared += 1;
  }

  console.log(`MCP git parity passed (${compared} steps).`);
} finally {
  await Promise.all(
    roots.map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch(() => {}),
    ),
  );
}

async function prepare(spec: { label: string; command: string; args: string[] }): Promise<Runtime> {
  const base = await mkdtemp(join(tmpdir(), `nomoreide-git-parity-${spec.label}-`));
  roots.push(base);
  const home = join(base, "home");
  await mkdir(join(home, ".config", "nomoreide"), { recursive: true });

  const paths = new Map<string, string>();
  for (const repository of fixture.repositories) {
    const path = join(base, "repos", repository.id);
    await mkdir(path, { recursive: true });
    // --initial-branch keeps the fixture independent of the machine's
    // init.defaultBranch, which otherwise differs between developers and CI.
    await git(path, ["init", "--quiet", `--initial-branch=${repository.initialBranch}`]);
    await git(path, ["config", "user.email", "parity@nomoreide.test"]);
    await git(path, ["config", "user.name", "NoMoreIDE Parity"]);
    await git(path, ["config", "commit.gpgsign", "false"]);
    for (const step of repository.setup) {
      await apply(base, repository.id, path, step);
    }
    paths.set(`repo:${repository.id}`, path);
  }
  for (const directory of fixture.plainDirectories) {
    const path = join(base, "plain", directory);
    await mkdir(path, { recursive: true });
    paths.set(`dir:${directory}`, path);
  }
  // Managed worktrees land here rather than in the real ~/.nomoreide.
  const worktrees = join(base, "worktrees");
  await mkdir(worktrees, { recursive: true });
  paths.set("worktrees", worktrees);
  paths.set("home", home);

  // git reports the resolved path of a worktree, so on a machine where the
  // temporary root is itself a symlink (macOS /var -> /private/var) the path it
  // prints is never the one built above. Register both spellings.
  for (const [key, path] of [...paths]) {
    const resolved = await realpath(path).catch(() => path);
    if (resolved !== path) {
      paths.set(`${key}#real`, resolved);
    }
  }

  return { ...spec, home, worktrees, paths };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    env: { ...inheritedEnv, GIT_AUTHOR_DATE: COMMIT_TIME, GIT_COMMITTER_DATE: COMMIT_TIME },
  });
}

async function apply(base: string, id: string, path: string, step: Setup): Promise<void> {
  if ("commit" in step) {
    await writeFile(join(path, step.commit.file), step.commit.contents);
    await git(path, ["add", "--", step.commit.file]);
    await git(path, ["commit", "--quiet", "-m", step.commit.message]);
    return;
  }
  if ("remote" in step) {
    const origin = join(base, "remotes", `${id}.git`);
    await mkdir(origin, { recursive: true });
    await git(path, ["init", "--quiet", "--bare", origin]);
    await git(path, ["remote", "add", "origin", origin]);
    await git(path, ["push", "--quiet", "--set-upstream", "origin", "HEAD"]);
    return;
  }
  if ("remoteHead" in step) {
    await git(path, ["remote", "set-head", "origin", step.remoteHead]);
    return;
  }
  if ("resetTo" in step) {
    await git(path, ["reset", "--quiet", "--hard", step.resetTo]);
    return;
  }
  if ("branch" in step) {
    await git(path, ["branch", step.branch]);
    return;
  }
  if ("detach" in step) {
    await git(path, ["checkout", "--quiet", "--detach", "HEAD"]);
    return;
  }
  if ("write" in step) {
    for (const [file, contents] of Object.entries(step.write)) {
      await writeFile(join(path, file), contents);
    }
    return;
  }
  if ("remove" in step) {
    for (const file of step.remove) {
      await rm(join(path, file));
    }
    return;
  }
  await git(path, ["add", "--", ...step.stage]);
}

function command(runtime: Runtime): McpCommand {
  return {
    command: runtime.command,
    args: [...runtime.args, "mcp"],
    cwd: root,
    env: {
      ...inheritedEnv,
      HOME: runtime.home,
      XDG_CONFIG_HOME: join(runtime.home, ".config"),
      NOMOREIDE_AUTO_UI: "0",
      NOMOREIDE_WORKTREES_DIR: runtime.worktrees,
      // A commit the *tool* makes is stamped from this environment. Without
      // it the two runtimes commit at different instants and every hash they
      // report differs, which would make `nomoreide_git_commit` uncomparable.
      GIT_AUTHOR_DATE: COMMIT_TIME,
      GIT_COMMITTER_DATE: COMMIT_TIME,
    },
  };
}

/** `{{repo:demo}}`, `{{dir:not-a-repo}}`, and `{{home}}` become this runtime's own paths. */
function substitute(value: unknown, runtime: Runtime): unknown {
  if (typeof value !== "string") {
    return value;
  }
  return value.replace(/\{\{([^}]+)\}\}/g, (whole, key: string) => {
    // `#real` spellings exist only so output can be normalized; a step asks
    // for a path by its plain name.
    const path = key.endsWith("#real") ? undefined : runtime.paths.get(key);
    if (path === undefined) {
      throw new Error(`Unknown fixture placeholder ${whole}`);
    }
    return path;
  });
}

async function call(runtime: Runtime, step: Fixture["plan"][number]): Promise<unknown> {
  const args = Object.fromEntries(
    Object.entries(step.arguments).map(([key, value]) => [key, substitute(value, runtime)]),
  );
  const response = await callMcpTool(command(runtime), step.tool, args);
  return normalize(response, runtime);
}

/**
 * Replace what cannot repeat between two equivalent runs — each runtime's own
 * throwaway paths, and `createdAt`, which is the wall-clock birth time of a
 * directory each runtime creates for itself and so can never match — and parse
 * the tool's JSON payload so that key *order*, which `serde_json` sorts and the
 * reference does not, is not compared. Message text, error codes, and every
 * other field are compared verbatim.
 */
/**
 * Replace a plausible `createdAt` with a token, and leave anything else in that
 * key alone. A runtime that omitted it, reported it as a string, or reported a
 * nonsense time still differs — only the digits of a real one are forgiven.
 */
function maskCreatedAt(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(maskCreatedAt);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (key === "createdAt" && typeof entry === "number" && Number.isFinite(entry) && entry > 0) {
        return [key, "<epoch-ms>"];
      }
      return [key, maskCreatedAt(entry)];
    }),
  );
}

function normalize(response: unknown, runtime: Runtime): unknown {
  const tokens: Array<[string, string]> = [...runtime.paths]
    // Both spellings of a path collapse onto the same token, so a resolved and
    // an unresolved report of the same directory compare equal.
    .map(([key, path]) => [path, `<${key.replace(/#real$/, "")}>`] as [string, string])
    // Longest first, so a nested path is not partly rewritten by its parent.
    .sort((left, right) => right[0].length - left[0].length);

  const rewrite = (text: string): string =>
    tokens.reduce((current, [path, token]) => current.split(path).join(token), text);

  const result = (response as { result?: { content?: Array<{ text?: string }> } }).result;
  const text = result?.content?.[0]?.text;
  if (typeof text === "string") {
    const rewritten = rewrite(text);
    let payload: unknown = rewritten;
    try {
      payload = JSON.parse(rewritten);
    } catch {
      // A refusal is plain prose, not JSON; compare the sentence itself.
    }
    return {
      isError: (result as { isError?: boolean }).isError ?? false,
      payload: maskCreatedAt(payload),
    };
  }
  return JSON.parse(rewrite(JSON.stringify(response)));
}
