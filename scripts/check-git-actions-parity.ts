/**
 * Parity gate for the write-capable git operations no MCP tool reaches.
 *
 * `pull` and `pull_default` are called by the dashboard and the desktop app,
 * never by an agent, so the MCP gates are blind to them. This runs the
 * TypeScript `GitActions` and the Rust one against their own identical copies
 * of a fixture repository and diffs what each returns — the same method as the
 * MCP gates, one layer lower down.
 *
 * The Rust side is reached through `examples/git-actions-probe.rs`, which
 * prints one operation's result as JSON.
 *
 * Nothing here reads either implementation.
 *
 * Usage:
 *   node --import tsx scripts/check-git-actions-parity.ts [--dump] [<probe-binary>]
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { GitActions } from "../src/core/git-actions.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const dump = argv.includes("--dump");
const probe =
  argv.find((argument) => argument !== "--dump") ??
  join(repositoryRoot, "target/debug/examples/git-actions-probe");

/** Fixed, so two runs of the same fixture produce the same commits. */
const COMMIT_TIME = "2026-01-02T03:04:05+00:00";
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_DATE: COMMIT_TIME,
  GIT_COMMITTER_DATE: COMMIT_TIME,
  // Nothing here may reach the network or wait on a prompt.
  GIT_TERMINAL_PROMPT: "0",
};

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, env: gitEnv });
}

/** One ordered step in building a fixture repository. */
type Setup =
  | { bareRemote: { name: string } }
  /** Push the current branch to a bare remote and track it. */
  | { publish: { remote: string } }
  | { remoteHead: { remote: string; branch: string } }
  | { symbolicHead: { remote: string; target: string } }
  | { branch: string }
  | { renameBranch: string }
  | { checkoutNew: { name: string; start?: string } }
  | { commit: { file: string; contents: string; message: string } }
  | { write: Record<string, string> }
  | { addRemote: { name: string; url: string } }
  /** Commit through a second clone, so the fixture is genuinely behind. */
  | {
      commitUpstream: {
        remote: string;
        branch: string;
        file: string;
        contents: string;
        message: string;
      };
    };

interface Case {
  id: string;
  setup: Setup[];
  operation: "pull-default" | "pull";
  arguments?: string[];
}

const cases: Case[] = [
  {
    id: "origin-head-set",
    setup: [
      { bareRemote: { name: "origin" } },
      { publish: { remote: "origin" } },
      { remoteHead: { remote: "origin", branch: "main" } },
      { checkoutNew: { name: "side" } },
    ],
    operation: "pull-default",
  },
  {
    // A remote added by hand never gets an `origin/HEAD`; the local `main` is
    // what stands in for it.
    id: "origin-head-unset-local-main",
    setup: [
      { bareRemote: { name: "origin" } },
      { publish: { remote: "origin" } },
      { checkoutNew: { name: "side" } },
    ],
    operation: "pull-default",
  },
  {
    id: "local-master-stands-in",
    setup: [{ renameBranch: "master" }, { checkoutNew: { name: "side" } }],
    operation: "pull-default",
  },
  {
    // Both exist: which one is preferred is a decision, not an accident.
    id: "local-main-preferred-over-master",
    setup: [{ renameBranch: "master" }, { branch: "main" }, { checkoutNew: { name: "side" } }],
    operation: "pull-default",
  },
  {
    id: "no-default-anywhere",
    setup: [{ renameBranch: "trunk" }, { checkoutNew: { name: "side" } }],
    operation: "pull-default",
  },
  {
    id: "no-default-named-remote",
    setup: [{ renameBranch: "trunk" }, { checkoutNew: { name: "side" } }],
    operation: "pull-default",
    arguments: ["upstream"],
  },
  {
    id: "named-remote",
    setup: [
      { bareRemote: { name: "upstream" } },
      { publish: { remote: "upstream" } },
      { remoteHead: { remote: "upstream", branch: "main" } },
      { checkoutNew: { name: "side" } },
    ],
    operation: "pull-default",
    arguments: ["upstream"],
  },
  {
    id: "already-on-the-default-branch",
    setup: [
      { bareRemote: { name: "origin" } },
      { publish: { remote: "origin" } },
      { remoteHead: { remote: "origin", branch: "main" } },
    ],
    operation: "pull-default",
  },
  {
    // Uncommitted work does not block a switch, and shows up in the output.
    id: "dirty-working-tree",
    setup: [
      { bareRemote: { name: "origin" } },
      { publish: { remote: "origin" } },
      { remoteHead: { remote: "origin", branch: "main" } },
      { checkoutNew: { name: "side" } },
      { write: { "f.txt": "dirty\n" } },
    ],
    operation: "pull-default",
  },
  {
    // The branch really moves, so this is a fast-forward rather than a no-op.
    id: "fast-forwards-behind-the-remote",
    setup: [
      { bareRemote: { name: "origin" } },
      { publish: { remote: "origin" } },
      { remoteHead: { remote: "origin", branch: "main" } },
      {
        commitUpstream: {
          remote: "origin",
          branch: "main",
          file: "g.txt",
          contents: "two\n",
          message: "two",
        },
      },
      { checkoutNew: { name: "side" } },
    ],
    operation: "pull-default",
  },
  {
    // git itself refuses the switch: an untracked file it would clobber.
    id: "switch-refused",
    setup: [
      { commit: { file: "x.txt", contents: "on main\n", message: "x" } },
      { bareRemote: { name: "origin" } },
      { publish: { remote: "origin" } },
      { remoteHead: { remote: "origin", branch: "main" } },
      { checkoutNew: { name: "side", start: "HEAD~1" } },
      { write: { "x.txt": "untracked and different\n" } },
    ],
    operation: "pull-default",
  },
  {
    // `origin/HEAD` names a branch that is not there any more.
    id: "default-branch-missing",
    setup: [
      { bareRemote: { name: "origin" } },
      { publish: { remote: "origin" } },
      { symbolicHead: { remote: "origin", target: "refs/remotes/origin/ghost" } },
      { checkoutNew: { name: "side" } },
    ],
    operation: "pull-default",
  },
  {
    id: "no-remote-at-all",
    setup: [{ checkoutNew: { name: "side" } }],
    operation: "pull-default",
  },
  {
    id: "remote-that-does-not-exist",
    setup: [{ addRemote: { name: "origin", url: "" } }, { checkoutNew: { name: "side" } }],
    operation: "pull-default",
  },
  {
    // Diverged: the remote moved and so did this branch, so a fast-forward is
    // not possible. A plain `pull` would merge here — refusing to is the point
    // of the flag.
    id: "diverged-cannot-fast-forward",
    setup: [
      { bareRemote: { name: "origin" } },
      { publish: { remote: "origin" } },
      { remoteHead: { remote: "origin", branch: "main" } },
      {
        commitUpstream: {
          remote: "origin",
          branch: "main",
          file: "g.txt",
          contents: "theirs\n",
          message: "theirs",
        },
      },
      { commit: { file: "h.txt", contents: "ours\n", message: "ours" } },
      { checkoutNew: { name: "side" } },
    ],
    operation: "pull-default",
  },
  {
    id: "plain-pull-with-an-upstream",
    setup: [{ bareRemote: { name: "origin" } }, { publish: { remote: "origin" } }],
    operation: "pull",
  },
  {
    id: "plain-pull-diverged",
    setup: [
      { bareRemote: { name: "origin" } },
      { publish: { remote: "origin" } },
      {
        commitUpstream: {
          remote: "origin",
          branch: "main",
          file: "g.txt",
          contents: "theirs\n",
          message: "theirs",
        },
      },
      { commit: { file: "h.txt", contents: "ours\n", message: "ours" } },
    ],
    operation: "pull",
  },
  {
    id: "plain-pull-without-one",
    setup: [],
    operation: "pull",
  },
];

const roots: string[] = [];
try {
  let compared = 0;
  for (const scenario of cases) {
    const observed = await Promise.all([
      reference(await build(scenario), scenario),
      candidate(await build(scenario), scenario),
    ]);
    if (dump) {
      console.log(`\n--- ${scenario.id}\nreference: ${JSON.stringify(observed[0], null, 2)}`);
      console.log(`candidate: ${JSON.stringify(observed[1], null, 2)}`);
    }
    try {
      assert.deepStrictEqual(observed[1], observed[0]);
    } catch (error) {
      console.error(`\nGitActions parity failed at case "${scenario.id}" (${scenario.operation}).`);
      console.error(`reference: ${JSON.stringify(observed[0], null, 2)}`);
      console.error(`candidate: ${JSON.stringify(observed[1], null, 2)}`);
      throw error;
    }
    compared += 1;
  }
  console.log(`GitActions parity passed (${compared} cases).`);
} finally {
  await Promise.all(
    roots.map((directory) => rm(directory, { recursive: true, force: true }).catch(() => {})),
  );
}

/** One runtime's own copy of a fixture. Each gets a fresh one, so neither can see the other's writes. */
async function build(scenario: Case): Promise<{ repo: string; base: string }> {
  const base = await mkdtemp(join(tmpdir(), `nomoreide-actions-${scenario.id}-`));
  roots.push(base);
  const repo = join(base, "repo");
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "--quiet", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "parity@nomoreide.test"]);
  await git(repo, ["config", "user.name", "NoMoreIDE Parity"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(repo, "f.txt"), "one\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "--quiet", "-m", "one"]);
  for (const step of scenario.setup) {
    await apply(base, repo, step);
  }
  return { repo, base };
}

async function apply(base: string, repo: string, step: Setup): Promise<void> {
  if ("bareRemote" in step) {
    const path = join(base, `${step.bareRemote.name}.git`);
    await mkdir(path, { recursive: true });
    await git(base, ["init", "--quiet", "--bare", path]);
    await git(repo, ["remote", "add", step.bareRemote.name, path]);
    return;
  }
  if ("publish" in step) {
    await git(repo, ["push", "--quiet", "--set-upstream", step.publish.remote, "HEAD"]);
    return;
  }
  if ("remoteHead" in step) {
    await git(repo, ["remote", "set-head", step.remoteHead.remote, step.remoteHead.branch]);
    return;
  }
  if ("symbolicHead" in step) {
    await git(repo, [
      "symbolic-ref",
      `refs/remotes/${step.symbolicHead.remote}/HEAD`,
      step.symbolicHead.target,
    ]);
    return;
  }
  if ("branch" in step) {
    await git(repo, ["branch", step.branch]);
    return;
  }
  if ("renameBranch" in step) {
    await git(repo, ["branch", "-m", step.renameBranch]);
    return;
  }
  if ("checkoutNew" in step) {
    const start = step.checkoutNew.start ? [step.checkoutNew.start] : [];
    await git(repo, ["checkout", "--quiet", "-b", step.checkoutNew.name, ...start]);
    return;
  }
  if ("commit" in step) {
    await writeFile(join(repo, step.commit.file), step.commit.contents);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "--quiet", "-m", step.commit.message]);
    return;
  }
  if ("write" in step) {
    for (const [file, contents] of Object.entries(step.write)) {
      await writeFile(join(repo, file), contents);
    }
    return;
  }
  if ("addRemote" in step) {
    // An empty URL names a remote that exists in config and resolves nowhere.
    await git(repo, ["remote", "add", step.addRemote.name, step.addRemote.url || join(base, "absent.git")]);
    return;
  }
  const other = join(base, "upstream-clone");
  await git(base, ["clone", "--quiet", join(base, `${step.commitUpstream.remote}.git`), other]);
  // A bare repository created by `git init --bare` still has HEAD pointing at
  // whatever this machine's `init.defaultBranch` is, so the clone lands on no
  // branch at all. Name the one to commit on rather than trusting the default.
  await git(other, ["checkout", "--quiet", step.commitUpstream.branch]);
  await git(other, ["config", "user.email", "parity@nomoreide.test"]);
  await git(other, ["config", "user.name", "NoMoreIDE Parity"]);
  await git(other, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(other, step.commitUpstream.file), step.commitUpstream.contents);
  await git(other, ["add", "-A"]);
  await git(other, ["commit", "--quiet", "-m", step.commitUpstream.message]);
  await git(other, ["push", "--quiet"]);
}

async function reference(
  fixture: { repo: string; base: string },
  scenario: Case,
): Promise<unknown> {
  const actions = new GitActions(fixture.repo);
  try {
    const value =
      scenario.operation === "pull"
        ? { output: await actions.pull() }
        : await actions.checkoutDefaultAndPull(
            scenario.arguments?.[0] ? { remote: scenario.arguments[0] } : {},
          );
    return { status: "ok", value: normalize(value, fixture) };
  } catch (error) {
    return { status: "error", message: normalize((error as Error).message, fixture) };
  }
}

async function candidate(
  fixture: { repo: string; base: string },
  scenario: Case,
): Promise<unknown> {
  const { stdout } = await execFileAsync(
    probe,
    [scenario.operation, fixture.repo, ...(scenario.arguments ?? [])],
    { env: gitEnv, maxBuffer: 8 * 1024 * 1024 },
  );
  return normalize(JSON.parse(stdout), fixture);
}

/**
 * Each runtime's fixture lives at its own throwaway path, and git quotes those
 * paths back. Rewrite them to one token so the two runs are comparable; nothing
 * else is touched.
 */
function normalize(value: unknown, fixture: { repo: string; base: string }): unknown {
  return JSON.parse(
    JSON.stringify(value).split(fixture.repo).join("<repo>").split(fixture.base).join("<base>"),
  );
}
