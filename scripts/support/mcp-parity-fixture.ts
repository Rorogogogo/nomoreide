/**
 * The throwaway repository tree the Phase 3 parity gates drive both runtimes
 * against, and the normalization that makes two runs of it comparable.
 *
 * Shared by the git gate and the GitHub gate: both need a runtime with a home,
 * a set of fixture repositories, and paths rewritten to tokens — they differ
 * only in what they then ask the tools.
 *
 * Nothing here reads either implementation.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type { McpCommand } from "../../test/support/mcp-contract.js";

const execFileAsync = promisify(execFile);

export const repositoryRoot = resolve(import.meta.dirname, "..", "..");

/**
 * Every commit is stamped with the same fixed timestamp. Author, committer,
 * message, and tree are already fixed by a fixture, so this is the last thing
 * that would differ — and with it fixed, both runtimes see byte-identical
 * commit hashes and a log can be compared as reported.
 */
export const COMMIT_TIME = "2026-01-02T03:04:05+00:00";

export const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

/**
 * One ordered step in building a fixture repository. Declarative rather than a
 * list of git commands, so a fixture says what state it wants and this file
 * stays the only place that knows how to reach it.
 */
export type Setup =
  | { commit: { file: string; contents: string; message: string } }
  /**
   * Write several files — nested paths included — and commit them together.
   * A repository that exists to be *scanned* is a source tree, not a sequence
   * of one-file commits, and spelling it that way keeps a fixture readable.
   */
  | { commitFiles: { files: Record<string, string>; message: string } }
  /** Create a bare origin, push the current branch, and track it. */
  | { remote: true }
  /** Point `origin` at a URL nothing has to answer — a remote only read, never reached. */
  | { originUrl: string }
  /** Point `origin/HEAD` at a branch, the way a clone would. */
  | { remoteHead: string }
  /** Move the branch back, leaving it behind whatever origin already has. */
  | { resetTo: string }
  /** Create a branch without switching to it. */
  | { branch: string }
  /**
   * Fabricate snapshot refs directly, without going through the tool. Pruning
   * only starts mattering past fifty of them, and fifty tool calls per runtime
   * would be a slow way to say so.
   */
  | { snapshotRefs: number }
  /** Leave HEAD on no branch at all. */
  | { detach: true }
  /** Write files and leave them uncommitted. */
  | { write: Record<string, string> }
  | { remove: string[] }
  | { stage: string[] };

export interface FixtureTree {
  repositories: Array<{ id: string; initialBranch: string; setup: Setup[] }>;
  /**
   * SQLite files to seed, each reachable from a step as `{{db:<id>}}`.
   *
   * SQLite is the only engine a fixture can stand up: Postgres and MySQL would
   * need a server, and a gate that depends on one is a gate that tests the
   * server. Everything these tools do that is engine-independent — the
   * catalog shapes, the row cap, the refusal — is visible through SQLite, and
   * what is not is recorded in the gate rather than pretended at.
   */
  databases?: Array<{ id: string; statements: string[] }>;
  /**
   * Extra bare repositories under `remotes/`, named however the fixture likes.
   * A clone derives its project name from the URL, so a name that has to be
   * sanitised is the only way to compare that derivation.
   */
  bareOrigins?: string[];
  plainDirectories?: string[];
}

export interface RuntimeSpec {
  label: string;
  command: string;
  args: string[];
}

export interface Runtime extends RuntimeSpec {
  home: string;
  worktrees: string;
  clones: string;
  /** Fixture id -> absolute path in this runtime's own tree. */
  paths: Map<string, string>;
  /** Extra environment this gate wants the runtime's MCP process to carry. */
  env: Record<string, string>;
  /**
   * Where the MCP process itself runs. Defaults to the checkout, which is what
   * the reference's own `src/index.ts` needs when it is spawned by path; a gate
   * that wants to exercise a tool's "no cwd argument" fallback overrides it.
   */
  cwd?: string;
}

/** Build one runtime's own copy of the fixture tree. `roots` collects it for cleanup. */
export async function prepareRuntime(
  spec: RuntimeSpec,
  fixture: FixtureTree,
  roots: string[],
): Promise<Runtime> {
  const base = await mkdtemp(join(tmpdir(), `nomoreide-parity-${spec.label}-`));
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
  for (const database of fixture.databases ?? []) {
    const path = join(base, "databases", `${database.id}.db`);
    await mkdir(dirname(path), { recursive: true });
    const handle = new DatabaseSync(path);
    try {
      for (const statement of database.statements) {
        handle.exec(statement);
      }
    } finally {
      handle.close();
    }
    paths.set(`db:${database.id}`, path);
  }
  for (const directory of fixture.plainDirectories ?? []) {
    const path = join(base, "plain", directory);
    await mkdir(path, { recursive: true });
    paths.set(`dir:${directory}`, path);
  }
  // Managed worktrees land here rather than in the real ~/.nomoreide.
  const worktrees = join(base, "worktrees");
  await mkdir(worktrees, { recursive: true });
  paths.set("worktrees", worktrees);
  paths.set("home", home);
  // The bare origins the `remote` setup step creates. A clone step names one
  // as its source, so a fixture needs a way to spell where they are.
  const remotes = join(base, "remotes");
  await mkdir(remotes, { recursive: true });
  paths.set("remotes", remotes);
  for (const name of fixture.bareOrigins ?? []) {
    await git(remotes, ["init", "--quiet", "--bare", join(remotes, `${name}.git`)]);
  }
  // And clones land here rather than in the real ~/.nomoreide/repos.
  const clones = join(base, "clones");
  paths.set("clones", clones);

  // git reports the resolved path of a worktree, so on a machine where the
  // temporary root is itself a symlink (macOS /var -> /private/var) the path it
  // prints is never the one built above. Register both spellings.
  for (const [key, path] of [...paths]) {
    const resolved = await realpath(path).catch(() => path);
    if (resolved !== path) {
      paths.set(`${key}#real`, resolved);
    }
  }

  return { ...spec, home, worktrees, clones, paths, env: {} };
}

export async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    env: { ...inheritedEnv, GIT_AUTHOR_DATE: COMMIT_TIME, GIT_COMMITTER_DATE: COMMIT_TIME },
  });
}

async function apply(base: string, id: string, path: string, step: Setup): Promise<void> {
  if ("commit" in step) {
    await write(path, step.commit.file, step.commit.contents);
    await git(path, ["add", "--", step.commit.file]);
    await git(path, ["commit", "--quiet", "-m", step.commit.message]);
    return;
  }
  if ("commitFiles" in step) {
    for (const [file, contents] of Object.entries(step.commitFiles.files)) {
      await write(path, file, contents);
    }
    await git(path, ["add", "--", ...Object.keys(step.commitFiles.files)]);
    await git(path, ["commit", "--quiet", "-m", step.commitFiles.message]);
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
  if ("originUrl" in step) {
    await git(path, ["remote", "add", "origin", step.originUrl]);
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
  if ("snapshotRefs" in step) {
    for (let index = 0; index < step.snapshotRefs; index += 1) {
      // A fixed base stamp rather than a real clock: these have to sort the
      // same way in both runtimes, and they must not read as "about now".
      const stamp = 1700000000000 + index;
      const name = `refs/nomoreide/snapshots/${stamp}-seeded-${String(index).padStart(3, "0")}`;
      await git(path, ["update-ref", name, "HEAD"]);
    }
    return;
  }
  if ("detach" in step) {
    await git(path, ["checkout", "--quiet", "--detach", "HEAD"]);
    return;
  }
  if ("write" in step) {
    for (const [file, contents] of Object.entries(step.write)) {
      await write(path, file, contents);
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

/** Write one fixture file, creating whatever directories its path names. */
async function write(root: string, file: string, contents: string): Promise<void> {
  const target = join(root, file);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

export function mcpCommand(runtime: Runtime): McpCommand {
  return {
    command: runtime.command,
    args: [...runtime.args, "mcp"],
    cwd: runtime.cwd ?? repositoryRoot,
    env: {
      ...inheritedEnv,
      HOME: runtime.home,
      XDG_CONFIG_HOME: join(runtime.home, ".config"),
      NOMOREIDE_AUTO_UI: "0",
      NOMOREIDE_WORKTREES_DIR: runtime.worktrees,
      NOMOREIDE_REPOS_DIR: runtime.clones,
      // Nothing here may reach the network or wait on a prompt: the fixture's
      // only remotes are bare directories in its own tree.
      GIT_TERMINAL_PROMPT: "0",
      // A commit the *tool* makes is stamped from this environment. Without
      // it the two runtimes commit at different instants and every hash they
      // report differs, which would make a commit tool uncomparable.
      GIT_AUTHOR_DATE: COMMIT_TIME,
      GIT_COMMITTER_DATE: COMMIT_TIME,
      ...runtime.env,
    },
  };
}

/** `{{repo:demo}}`, `{{dir:not-a-repo}}`, and `{{home}}` become this runtime's own paths. */
export function substitute(value: unknown, runtime: Runtime): unknown {
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

/** Roughly now — the window a timestamp a tool just produced has to fall in. */
export function isRecent(epochMs: number): boolean {
  const day = 24 * 60 * 60 * 1000;
  return Number.isFinite(epochMs) && Math.abs(Date.now() - epochMs) < day;
}

/**
 * Replace a plausible `createdAt` with a token, and leave anything else in that
 * key alone. A runtime that omitted it, or reported a nonsense time, still
 * differs — only a real one is forgiven, and the two spellings get different
 * tokens so a runtime that swapped them differs too.
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
      if (key !== "createdAt") {
        return [key, maskCreatedAt(entry)];
      }
      if (typeof entry === "number" && entry > 0 && isRecent(entry)) {
        return [key, "<epoch-ms>"];
      }
      // An ISO instant in UTC to the millisecond, which is what `toISOString`
      // produces. A time in another format, or in the wrong year, is left as
      // it is and so still fails the comparison.
      if (
        typeof entry === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry) &&
        isRecent(Date.parse(entry))
      ) {
        return [key, "<iso-instant>"];
      }
      return [key, maskCreatedAt(entry)];
    }),
  );
}

/** Rewrite this runtime's own throwaway paths to stable tokens. */
export function rewritePaths(runtime: Runtime): (text: string) => string {
  const tokens: Array<[string, string]> = [...runtime.paths]
    // Both spellings of a path collapse onto the same token, so a resolved and
    // an unresolved report of the same directory compare equal.
    .map(([key, path]) => [path, `<${key.replace(/#real$/, "")}>`] as [string, string])
    // Longest first, so a nested path is not partly rewritten by its parent.
    .sort((left, right) => right[0].length - left[0].length);
  return (text: string) => tokens.reduce((current, [path, token]) => current.split(path).join(token), text);
}

/**
 * Replace what cannot repeat between two equivalent runs — each runtime's own
 * throwaway paths, and `createdAt`, which is the wall-clock birth time of a
 * directory each runtime creates for itself and so can never match — and parse
 * the tool's JSON payload so that key *order*, which `serde_json` sorts and the
 * reference does not, is not compared. Message text, error codes, and every
 * other field are compared verbatim.
 */
export function normalize(response: unknown, runtime: Runtime): unknown {
  const rewrite = rewritePaths(runtime);
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
