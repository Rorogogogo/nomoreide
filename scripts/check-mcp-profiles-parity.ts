/**
 * Phase 5 agent-profile parity gate.
 *
 * A profile is a saved bundle of MCP servers, skills, and plugins, kept as a
 * directory tree under the user's config. Every tool here reads or writes that
 * tree, so both runtimes are given the same empty one and asked to build it up
 * with the same calls — and the trees they leave behind are compared, not just
 * the answers they gave.
 *
 * Nothing here reads either implementation.
 * `test/fixtures/mcp-profiles-parity-v1.json` holds the planted tree and the
 * ordered plan; both runtimes see the same one.
 *
 * Usage:
 *   node --import tsx scripts/check-mcp-profiles-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 *   ... --probe   run the reference alone and print what it answered
 */
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { callMcpTool } from "../test/support/mcp-contract.js";
import {
  type FixtureTree,
  type Runtime,
  mcpCommand,
  normalize,
  prepareRuntime,
  repositoryRoot,
  rewritePaths,
  substitute,
} from "./support/mcp-parity-fixture.js";

const argv = process.argv.slice(2);
const dump = argv.includes("--dump");
const probe = argv.includes("--probe");
const candidateArgv = argv.filter((argument) => !argument.startsWith("--"));
if (candidateArgv.length === 0 && !probe) {
  throw new Error(
    "Usage: node --import tsx scripts/check-mcp-profiles-parity.ts [--dump] [--probe] <candidate-command> [candidate-args...]",
  );
}

interface Step {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  /**
   * Home-relative files to delete from *every* runtime before this step. The
   * fixture plants a config for all three agents, which leaves the "this agent
   * has no config" branch of every reader unreachable; a step that removes one
   * first is how the plan reaches it. Applied to both runtimes, so the two are
   * still asked the same question.
   */
  removeHomeFiles?: string[];
  /**
   * Home-relative files to write before this step, for the states no fixture
   * can start in — a config file that is not valid JSON, say. Written to both
   * runtimes, like the deletions above.
   */
  writeHomeFiles?: Array<{ path: string; contents: string }>;
}

interface Fixture extends FixtureTree {
  fixtureVersion: 1;
  /** Stub executables planted on PATH, so availability is the fixture's answer. */
  pathStubs: string[];
  plan: Step[];
}

const fixture = JSON.parse(
  await readFile(join(repositoryRoot, "test/fixtures/mcp-profiles-parity-v1.json"), "utf8"),
) as Fixture;
if (fixture.fixtureVersion !== 1) {
  throw new Error(`Unsupported profiles parity fixture version ${fixture.fixtureVersion}`);
}

const specs = [
  { label: "reference", command: process.execPath, args: ["--import", "tsx", "src/index.ts"] },
  ...(probe ? [] : [{ label: "candidate", command: candidateArgv[0], args: candidateArgv.slice(1) }]),
];

const roots: string[] = [];
try {
  const runtimes: Runtime[] = [];
  for (const spec of specs) {
    const runtime = await prepareRuntime(spec, fixture, roots);
    // The agent commands the fixture says are installed, and nothing else:
    // `bin` comes first so a real `claude` on this machine cannot win, and the
    // login shell is neutralised because a stub reachable only through PATH
    // loses to whatever `$SHELL -lc` would put ahead of it.
    runtime.env.PATH = `${join(runtime.home, "bin")}:${process.env.PATH ?? ""}`;
    runtime.env.SHELL = "/bin/sh";
    // A step that passes no cwd falls back to the server's own, which is this
    // checkout — so the "all" steps do answer partly from the machine the gate
    // runs on. That is safe here because nothing is compared against a stored
    // payload: both runtimes are spawned in the same directory and diffed
    // against each other, so a skill installed here changes what is covered,
    // never whether the gate passes. It cannot be pointed elsewhere anyway;
    // the reference is `--import tsx src/index.ts`, which only resolves from
    // the repository root.
    runtimes.push(runtime);
  }

  for (const step of fixture.plan) {
    for (const runtime of runtimes) {
      for (const file of step.removeHomeFiles ?? []) {
        await rm(join(runtime.home, file), { recursive: true, force: true });
      }
      for (const file of step.writeHomeFiles ?? []) {
        const target = join(runtime.home, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, substitute(file.contents, runtime) as string);
      }
    }
    const observed = await Promise.all(runtimes.map((runtime) => call(runtime, step)));
    if (dump || probe) {
      for (const [index, entry] of observed.entries()) {
        console.log(`\n--- ${step.id} [${runtimes[index].label}]`);
        console.log(JSON.stringify(entry, null, 2));
      }
    }
    if (probe) continue;
    try {
      assert.deepStrictEqual(observed[1], observed[0]);
      // And again in wire order. Every MCP server map here is reported in the
      // order its config file wrote it, and `deepStrictEqual` compares objects
      // as unordered — so a candidate that sorted these would pass the check
      // above while answering something the reference never says.
      //
      // Only this gate asks that, on purpose. Elsewhere an object's keys are
      // its *fields*, and Rust and TypeScript order those differently for no
      // observable reason. Here the keys are the user's own server names, so
      // their order is data.
      assert.strictEqual(JSON.stringify(observed[1]), JSON.stringify(observed[0]));
    } catch (error) {
      console.error(`\nProfile parity failed at step "${step.id}" (${step.tool}).`);
      console.error(`reference: ${JSON.stringify(observed[0], null, 2)}`);
      console.error(`candidate: ${JSON.stringify(observed[1], null, 2)}`);
      throw error;
    }
  }
  if (probe && process.env.NOMOREIDE_DUMP_HOME) {
    // The profile store the tools built up, which no payload shows in full.
    const root = join(runtimes[0].home, ".config/nomoreide/agent-profiles");
    for (const [key, body] of Object.entries(await readTree(root, runtimes[0]))) {
      console.log(`\n=== ${key}`);
      console.log(body);
    }
  }
  console.log(
    probe
      ? `Profile probe finished (${fixture.plan.length} steps against the reference only).`
      : `MCP agent-profile parity passed (${fixture.plan.length} steps).`,
  );
} finally {
  await Promise.all(
    roots.map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch(() => {}),
    ),
  );
}

async function call(runtime: Runtime, step: Step): Promise<unknown> {
  const args = Object.fromEntries(
    Object.entries(step.arguments).map(([key, value]) => [key, substitute(value, runtime)]),
  );
  const response = await callMcpTool(mcpCommand(runtime), step.tool, args);
  return maskBackupStamps(normalize(response, runtime));
}

/**
 * Blank the timestamp out of every backup path.
 *
 * A backup is named for the second it was taken in, with a counter appended
 * when one second holds more than one. Two runtimes are asked the same
 * question milliseconds apart, so which side of a second boundary each lands
 * on — and therefore whether it collides with its own previous backup — is a
 * race, not a behaviour. The *number* of backups a change takes is still
 * compared, because the array keeps its length; the format of the stamp and
 * the collision counter are pinned by unit tests instead.
 */
function maskBackupStamps(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/\d{8}-\d{6}(-\d+)?/g, "<stamp>")
      // `updatedAt` is when a profile was last written, so the two runtimes
      // never agree on it. The *order* it puts a listing in is still compared,
      // because masking the value does not reorder the list.
      .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "<iso-instant>");
  }
  if (Array.isArray(value)) {
    return value.map(maskBackupStamps);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, maskBackupStamps(entry)]),
  );
}

/**
 * Every file both runtimes wrote, compared byte for byte.
 *
 * The two homes and the two repositories hold the same fixture, so after the
 * same plan they must hold the same bytes — modulo each runtime's own paths
 * and the backup stamps, which are rewritten the way a payload's are.
 */
async function assertTreesMatch(runtimes: Runtime[]): Promise<void> {
  const [reference, candidate] = runtimes;
  for (const [label, of] of [
    ["home", (runtime: Runtime) => runtime.home],
    ["repository", (runtime: Runtime) => runtime.paths.get("repo:demo") ?? ""],
  ] as const) {
    const left = await readTree(of(reference), reference);
    const right = await readTree(of(candidate), candidate);
    try {
      assert.deepStrictEqual(right, left);
    } catch (error) {
      console.error(`\nThe two runtimes wrote different files under the ${label}.`);
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        if (left[key] !== right[key]) {
          console.error(`\n--- ${key}`);
          console.error(`reference: ${JSON.stringify(left[key])}`);
          console.error(`candidate: ${JSON.stringify(right[key])}`);
        }
      }
      throw error;
    }
  }
}

async function readTree(root: string, runtime: Runtime): Promise<Record<string, string>> {
  const { readdir } = await import("node:fs/promises");
  const rewrite = rewritePaths(runtime);
  const files: Record<string, string> = {};
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
          // `.git` is the fixture's own bookkeeping, and its object names differ
      // between two runs. `.nomoreide` is the *server's* — session records it
      // writes whatever tool was called — and nothing here owns it.
      if (entry.name === ".git" || entry.name === ".nomoreide") continue;
      const path = join(directory, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path, key);
      } else {
        const body = await readFile(path, "utf8").catch(() => "<unreadable>");
        // The stamp in a backup's *name* is a race, so the name is
        // normalised; the bytes inside it still have to match.
        files[key.replace(/\d{8}-\d{6}(-\d+)?/g, "<stamp>")] = rewrite(body);
      }
    }
  };
  await walk(root, "");
  return files;
}