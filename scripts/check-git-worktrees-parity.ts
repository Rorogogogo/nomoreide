/**
 * Phase 6 parity gate for the worktree writes: create, select, remove, prune.
 *
 * Worktrees land under a *managed root* the daemon picks from the environment,
 * not under the workspace, so each runtime's private HOME is what keeps the two
 * apart. That also makes the created paths differ between runtimes by
 * construction, which is why paths are normalized before comparing.
 *
 * Removal is the interesting one: it refuses a worktree that is currently
 * active, one with a terminal open inside it, and one with a running service
 * inside it. Each of those needs real state, so the gate opens a real terminal
 * and starts a real service rather than asserting the branch exists.
 *
 * Usage:
 *   node --import tsx scripts/check-git-worktrees-parity.ts <candidate> [args...]
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
  readonly json?: unknown;
  /** Built per runtime, for bodies naming a path only that runtime knows. */
  readonly jsonFor?: (runtime: Runtime, created: Map<string, string>) => unknown;
}

const steps: readonly Step[] = [
  // --- refusals that need no worktree ---
  { name: "create/no-branch", method: "POST", path: "/api/git/worktrees" },
  { name: "create/blank-branch", method: "POST", path: "/api/git/worktrees", json: { branch: "  " } },
  {
    name: "create/dashed-branch",
    method: "POST",
    path: "/api/git/worktrees",
    json: { branch: "--force" },
  },
  {
    name: "create/unknown-base",
    method: "POST",
    path: "/api/git/worktrees",
    json: { branch: "from-nowhere", createBranch: true, baseRef: "no-such-ref" },
  },
  {
    name: "create/existing-branch-not-created",
    method: "POST",
    path: "/api/git/worktrees",
    json: { branch: "never-made" },
  },

  // --- the real thing ---
  {
    name: "create/new-branch",
    method: "POST",
    path: "/api/git/worktrees",
    json: { branch: "wt-one", createBranch: true },
  },
  { name: "worktrees/after-create", method: "GET", path: "/api/git/worktrees" },
  // Creating selects it, so the second create moves the selection again.
  {
    name: "create/second",
    method: "POST",
    path: "/api/git/worktrees",
    json: { branch: "wt-two", createBranch: true },
  },
  { name: "worktrees/after-second", method: "GET", path: "/api/git/worktrees" },
  // A branch already checked out in another worktree cannot be checked out again.
  {
    name: "create/branch-already-checked-out",
    method: "POST",
    path: "/api/git/worktrees",
    json: { branch: "wt-one" },
  },
  // `createBranch` is strictly boolean true — the string is not it.
  {
    name: "create/create-branch-as-string",
    method: "POST",
    path: "/api/git/worktrees",
    json: { branch: "wt-three", createBranch: "true" },
  },

  // --- selecting ---
  { name: "select/no-path", method: "PUT", path: "/api/git/worktrees/active" },
  {
    name: "select/relative-path",
    method: "PUT",
    path: "/api/git/worktrees/active",
    json: { path: "relative/path" },
  },
  {
    name: "select/not-a-worktree",
    method: "PUT",
    path: "/api/git/worktrees/active",
    json: { path: "/tmp/definitely-not-a-worktree" },
  },
  {
    name: "select/back-to-root",
    method: "PUT",
    path: "/api/git/worktrees/active",
    jsonFor: (runtime) => ({ path: runtime.workspace }),
  },
  { name: "worktrees/after-select-root", method: "GET", path: "/api/git/worktrees" },

  // --- removal refusals ---
  {
    name: "remove/no-path",
    method: "DELETE",
    path: "/api/git/worktrees",
  },
  {
    name: "remove/unknown-path",
    method: "DELETE",
    path: "/api/git/worktrees",
    json: { path: "/tmp/never-a-worktree" },
  },
  // The active one is the repository root right now, and removing that is the
  // "switch first" refusal rather than "the primary cannot be removed".
  {
    name: "remove/the-active-one",
    method: "DELETE",
    path: "/api/git/worktrees",
    jsonFor: (runtime) => ({ path: runtime.workspace }),
  },
  {
    name: "remove/with-a-terminal-inside",
    method: "DELETE",
    path: "/api/git/worktrees",
    jsonFor: (_runtime, created) => ({ path: created.get("wt-one") }),
  },
  {
    name: "remove/with-a-running-service-inside",
    method: "DELETE",
    path: "/api/git/worktrees",
    jsonFor: (_runtime, created) => ({ path: created.get("wt-two") }),
  },
  // Removing the active worktree when it is *not* the primary one. This is
  // the only case where the "switch first" guard is distinguishable: against
  // the repository root, git's own "the primary cannot be removed" answers
  // first on macOS, because the stored active path is the resolved `/private`
  // spelling and the request carries the unresolved one, so the guard's
  // lexical compare never matches.
  {
    name: "remove/the-active-non-primary",
    method: "DELETE",
    path: "/api/git/worktrees",
    jsonFor: (_runtime, created) => ({ path: created.get("wt-three") }),
  },
  // A worktree with uncommitted work is refused by git itself, one layer down.
  {
    name: "remove/dirty",
    method: "DELETE",
    path: "/api/git/worktrees",
    jsonFor: (_runtime, created) => ({ path: created.get("wt-three") }),
  },

  // --- and finally one that goes through ---
  {
    name: "remove/clean",
    method: "DELETE",
    path: "/api/git/worktrees",
    jsonFor: (_runtime, created) => ({ path: created.get("wt-four") }),
  },
  { name: "worktrees/after-remove", method: "GET", path: "/api/git/worktrees" },
  { name: "prune", method: "POST", path: "/api/git/worktrees/prune" },
  { name: "worktrees/after-prune", method: "GET", path: "/api/git/worktrees" },
  // Last, because reaching prune's failure branch means pointing the
  // repository at a directory that is not there — which breaks every route
  // after it. Neither runtime catches this one, so both answer 500.
  { name: "prune/unreachable-repository", method: "POST", path: "/api/git/worktrees/prune" },
];

const dump = process.argv.includes("--dump");
const argv = process.argv.slice(2).filter((value) => value !== "--dump");
if (argv.length === 0) {
  console.error("Usage: check-git-worktrees-parity.ts <candidate> [args...]");
  process.exit(2);
}

const root = await mkdtemp(join(tmpdir(), "nmi-git-worktrees-parity-"));
const harness = new RuntimeHarness(root);
let failures = 0;
/** Branch name → created path, per runtime. */
const createdByPort = new Map<number, Map<string, string>>();

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      spec,
      (partial) => ({
        version: 1,
        // A service whose cwd is inside a worktree, so "stop it first" is
        // reachable. `sleep` outlives the check without producing output.
        // Three services, each reaching a different corner of the removal
        // guard. Their `cwd` values are repointed to the paths git actually
        // reports before they matter — see `repointService`.
        services: [
          // Running, inside the worktree being removed: the guard must fire.
          { name: "sleeper", command: "sleep 600", cwd: join(partial.home, "placeholder-two") },
          // Registered but never started, inside a worktree that *is* removed:
          // a guard that ignored runtime state would block this one.
          { name: "idle", command: "sleep 600", cwd: join(partial.home, "placeholder-four") },
          // Running, in a *sibling* whose path merely starts with the removed
          // one's: a containment check comparing strings would block this.
          { name: "neighbour", command: "sleep 600", cwd: join(partial.home, "placeholder-extra") },
        ],
        bundles: [],
        gitRepositories: [{ name: "repo", path: partial.workspace }],
        selectedGitRepository: "repo",
      }),
      () => [],
    );
    await seedRepository(runtime.workspace);
    await harness.startDaemon(runtime);
    createdByPort.set(runtime.port, new Map());
    runtimes.push(runtime);
  }
  const [reference, candidate] = runtimes;

  for (const step of steps) {
    // The two blockers need real state, set up immediately before the case
    // that must trip over them.
    if (step.name === "remove/with-a-terminal-inside") {
      for (const runtime of runtimes) {
        // A new terminal opens in whichever worktree is *selected* — the create
        // route ignores a `cwd` in its body — so the only way to put one inside
        // wt-one is to go there, open it, and come back.
        const path = createdByPort.get(runtime.port)!.get("wt-one")!;
        await selectWorktree(runtime, path);
        await openTerminal(runtime);
        await selectWorktree(runtime, runtime.workspace);
      }
    }
    if (step.name === "remove/with-a-running-service-inside") {
      for (const runtime of runtimes) {
        // The service's registered `cwd` has to be the path git actually
        // reports, not the one the config template guessed. On macOS those
        // differ by a `/private` prefix, and the containment check is lexical
        // on both sides — so a config written with the wrong spelling makes
        // the guard silently unreachable rather than failing loudly.
        await repointService(runtime, "sleeper", createdByPort.get(runtime.port)!.get("wt-two")!);
        await startService(runtime, "sleeper");
      }
    }
    if (step.name === "remove/dirty") {
      // Switch away, so what refuses this one is the uncommitted work rather
      // than it being the active worktree.
      for (const runtime of runtimes) await selectWorktree(runtime, runtime.workspace);
    }
    if (step.name === "remove/clean") {
      for (const runtime of runtimes) {
        // `idle` ran in wt-four and has stopped. A guard that only asked
        // "is this service registered here" rather than "is it running"
        // would refuse to remove the worktree it has finished with.
        await startService(runtime, "idle");
        await stopService(runtime, "idle");
      }
    }
    if (step.name === "prune/unreachable-repository") {
      for (const runtime of runtimes) await repointRepository(runtime, "/nonexistent/nomoreide-gate");
    }
    if (step.name === "remove/the-active-non-primary") {
      for (const runtime of runtimes) {
        const created = createdByPort.get(runtime.port)!;
        // A fourth worktree, one of which is dirtied and one left clean, so
        // the refusal and the success are told apart by state, not by name.
        for (const branch of ["wt-three", "wt-four"]) {
          const answer = await send(runtime, {
            name: `create/${branch}`,
            method: "POST",
            path: "/api/git/worktrees",
            json: { branch, createBranch: true },
          }, created);
          const path = (answer.body as { worktree?: { path?: string } })?.worktree?.path;
          if (path) created.set(branch, path);
        }
        // A worktree whose name extends wt-four's, so removing wt-four must
        // not be blocked by something standing in this one.
        const extra = await send(runtime, {
          name: "create/wt-four-extra",
          method: "POST",
          path: "/api/git/worktrees",
          json: { branch: "wt-four-extra", createBranch: true },
        }, created);
        const extraPath = (extra.body as { worktree?: { path?: string } })?.worktree?.path;
        if (extraPath) created.set("wt-four-extra", extraPath);

        await repointService(runtime, "idle", created.get("wt-four")!);
        await repointService(runtime, "neighbour", created.get("wt-four-extra")!);
        await startService(runtime, "neighbour");

        await writeFile(join(created.get("wt-three")!, "scratch.txt"), "uncommitted\n");
        // wt-three is left selected, so the next case removes the *active*
        // worktree; the case after it switches away and hits git's dirty check.
        await selectWorktree(runtime, created.get("wt-three")!);
      }
    }

    const answers = {
      reference: await send(reference, step, createdByPort.get(reference.port)!),
      candidate: await send(candidate, step, createdByPort.get(candidate.port)!),
    };
    // Remember where each create landed, so later steps can name it.
    if (step.name.startsWith("create/") && typeof step.json === "object" && step.json !== null) {
      const branch = (step.json as { branch?: string }).branch;
      for (const [runtime, answer] of [
        [reference, answers.reference] as const,
        [candidate, answers.candidate] as const,
      ]) {
        const path = (answer.body as { worktree?: { path?: string } })?.worktree?.path;
        if (branch && path) createdByPort.get(runtime.port)!.set(branch, path);
      }
    }

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
        return { ...rest, body: normalizeVolatile(rest.body) };
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

  // What the two managed roots hold at the end. A refused removal that removed
  // the directory anyway answers identically and leaves a different disk.
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
      console.log(`  reference: ${inspect(both.reference)}`);
      console.log(`  candidate: ${inspect(both.candidate)}`);
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
    ? `\ngit-worktrees parity: ${total} cases match`
    : `\ngit-worktrees parity: ${failures} case(s) diverged`,
);
process.exit(failures === 0 ? 0 : 1);

function finalReads(): Array<[string, (runtime: Runtime) => Promise<unknown>]> {
  return [
    [
      "disk/managed-root",
      async (runtime) => {
        const { stdout } = await run("ls", [
          join(runtime.home, ".nomoreide", "worktrees", "repo"),
        ]).catch(() => ({
          stdout: "<absent>",
        }));
        return stdout;
      },
    ],
    [
      // Read from the workspace directly rather than through config, which the
      // last case deliberately points at nothing.
      "git/worktree-list",
      async (runtime) => {
        const { stdout } = await git(runtime.workspace, "worktree", "list", "--porcelain");
        return stdout.split("\n").filter((line) => line.startsWith("branch ")).join("\n");
      },
    ],
    [
      "config/active-worktree",
      async (runtime) => {
        const raw = await readFile(
          join(runtime.home, ".config", "nomoreide", "config.json"),
          "utf8",
        );
        const path = JSON.parse(raw).gitRepositories?.[0]?.activeWorktreePath ?? "<unset>";
        return typeof path === "string"
          ? path
              .replace(`/private${runtime.home}`, "<resolved-home>")
              .replace(runtime.home, "<home>")
          : path;
      },
    ],
  ];
}

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
}

async function credentialFor(runtime: Runtime): Promise<string> {
  return readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
    .then((value) => value.trim())
    .catch(() => "");
}

async function send(
  runtime: Runtime,
  step: Step,
  created: Map<string, string>,
): Promise<Answer> {
  const credential = await credentialFor(runtime);
  const headers: Record<string, string> = credential
    ? { authorization: `Bearer ${credential}` }
    : {};
  const payload = step.jsonFor ? step.jsonFor(runtime, created) : step.json;
  let body: string | undefined;
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(payload);
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

/** Open a dock terminal, which lands in the currently selected worktree. */
async function openTerminal(runtime: Runtime): Promise<void> {
  const credential = await credentialFor(runtime);
  await fetch(`http://127.0.0.1:${runtime.port}/api/terminal/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
    },
    body: JSON.stringify({}),
  });
}

async function selectWorktree(runtime: Runtime, path: string): Promise<void> {
  const credential = await credentialFor(runtime);
  await fetch(`http://127.0.0.1:${runtime.port}/api/git/worktrees/active`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
    },
    body: JSON.stringify({ path }),
  });
}

/** Point the registered repository somewhere that does not exist. */
async function repointRepository(runtime: Runtime, path: string): Promise<void> {
  const file = join(runtime.home, ".config", "nomoreide", "config.json");
  const config = JSON.parse(await readFile(file, "utf8"));
  for (const repository of config.gitRepositories ?? []) {
    repository.path = path;
    delete repository.activeWorktreePath;
  }
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
}

/** Rewrite a registered service's cwd on disk. Config is read per request, so
 * the next call sees it without a restart. */
async function repointService(runtime: Runtime, name: string, cwd: string): Promise<void> {
  const path = join(runtime.home, ".config", "nomoreide", "config.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  for (const service of config.services ?? []) {
    if (service.name === name) service.cwd = cwd;
  }
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
}

async function stopService(runtime: Runtime, name: string): Promise<void> {
  const credential = await credentialFor(runtime);
  await fetch(`http://127.0.0.1:${runtime.port}/api/services/${name}/stop`, {
    method: "POST",
    headers: credential ? { authorization: `Bearer ${credential}` } : {},
  });
  await new Promise((resolve) => setTimeout(resolve, 700));
}

async function startService(runtime: Runtime, name: string): Promise<void> {
  const credential = await credentialFor(runtime);
  await fetch(`http://127.0.0.1:${runtime.port}/api/services/${name}/start`, {
    method: "POST",
    headers: credential ? { authorization: `Bearer ${credential}` } : {},
  });
  // The check reads runtime state, which is only true once the spawn lands.
  await new Promise((resolve) => setTimeout(resolve, 700));
}

/**
 * A worktree carries two things two runs can never agree on: the commit each
 * one independently created, and the wall-clock moment its directory was made.
 * Hashes become positional tokens so structure is still compared exactly;
 * `createdAt` is elided outright, since it is a float of milliseconds and no
 * two creates share one.
 */
function normalizeVolatile(value: unknown): unknown {
  const seen = new Map<string, string>();
  const token = (hash: string) => {
    if (!seen.has(hash)) seen.set(hash, `<hash-${seen.size}>`);
    return seen.get(hash)!;
  };
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return node.replace(/\b[0-9a-f]{7,40}\b/g, (h) => token(h));
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node).map(([key, entry]) =>
          key === "createdAt" || key === "timestamp" ? [key, "<timestamp>"] : [key, walk(entry)],
        ),
      );
    }
    return node;
  };
  return walk(value);
}

/**
 * Erase each runtime's own paths — but keep `/var` and `/private/var` apart.
 *
 * Collapsing both spellings to one token is what the other git gates do, and
 * here it would hide a real difference: a route that echoed the path git
 * resolved instead of the path the caller sent would look identical. So the
 * resolved spelling gets its own token, and a swap between them fails.
 */
function normalizePaths(answer: Answer, paths: readonly string[]): Answer {
  let replaced = JSON.stringify(answer.body);
  const variants = paths
    .flatMap((path) =>
      path.startsWith("/var/")
        ? ([[`/private${path}`, "<resolved-root>"], [path, "<root>"]] as const)
        : ([[path, "<root>"]] as const),
    )
    .sort((a, b) => b[0].length - a[0].length);
  for (const [path, token] of variants) replaced = replaced.split(path).join(token);
  return { ...answer, body: JSON.parse(replaced) };
}

async function seedRepository(workspace: string): Promise<void> {
  const local = (...args: string[]) => git(workspace, ...args);
  await local("init", "--quiet", "--initial-branch", "master");
  await local("config", "user.email", "gate@example.com");
  await local("config", "user.name", "Gate");
  await writeFile(join(workspace, "readme.txt"), "seed\n");
  await local("add", "-A");
  await local("commit", "--quiet", "-m", "first");
}
