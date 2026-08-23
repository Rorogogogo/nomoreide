/**
 * Phase 5 agent-environment parity gate.
 *
 * These tools read what the *user has installed* — `~/.claude.json`,
 * `~/.codex/config.toml`, an agent's skills directory, whether the agent's
 * command is on PATH. None of that is written by any tool, so both runtimes are
 * given the same planted home and the same PATH of stub executables, and asked
 * the same questions.
 *
 * Hermetic on purpose: an agent that happens to be installed on the machine
 * running this must not change the answer, or the gate passes here and fails on
 * a laptop with one more editor installed.
 *
 * Nothing here reads either implementation.
 * `test/fixtures/mcp-agent-env-parity-v1.json` holds the planted tree and the
 * ordered plan; both runtimes see the same one.
 *
 * Usage:
 *   node --import tsx scripts/check-mcp-agent-env-parity.ts <candidate> [args...]
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
  substitute,
} from "./support/mcp-parity-fixture.js";

const argv = process.argv.slice(2);
const dump = argv.includes("--dump");
const probe = argv.includes("--probe");
const candidateArgv = argv.filter((argument) => !argument.startsWith("--"));
if (candidateArgv.length === 0 && !probe) {
  throw new Error(
    "Usage: node --import tsx scripts/check-mcp-agent-env-parity.ts [--dump] [--probe] <candidate-command> [candidate-args...]",
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
  await readFile(join(repositoryRoot, "test/fixtures/mcp-agent-env-parity-v1.json"), "utf8"),
) as Fixture;
if (fixture.fixtureVersion !== 1) {
  throw new Error(`Unsupported agent-env parity fixture version ${fixture.fixtureVersion}`);
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
      console.error(`\nAgent-environment parity failed at step "${step.id}" (${step.tool}).`);
      console.error(`reference: ${JSON.stringify(observed[0], null, 2)}`);
      console.error(`candidate: ${JSON.stringify(observed[1], null, 2)}`);
      throw error;
    }
  }
  if (probe && process.env.NOMOREIDE_DUMP_HOME) {
    // What the writers left on disk, which no tool reports back.
    const { readdir } = await import("node:fs/promises");
    for (const relative of [".claude.json", ".codex/config.toml", ".gemini/antigravity-cli/mcp_config.json"]) {
      const target = join(runtimes[0].home, relative);
      console.log(`\n=== FILE ${relative}`);
      console.log(await readFile(target, "utf8").catch(() => "<absent>"));
    }
    for (const relative of [".claude/skills", ".config/nomoreide/agent-env-backups"]) {
      const target = join(runtimes[0].home, relative);
      console.log(`\n=== DIR ${relative}`);
      console.log((await readdir(target).catch(() => [])).sort().join("\n"));
    }
  }
  console.log(
    probe
      ? `Agent-environment probe finished (${fixture.plan.length} steps against the reference only).`
      : `MCP agent-environment parity passed (${fixture.plan.length} steps).`,
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
    return value.replace(/\d{8}-\d{6}(-\d+)?/g, "<stamp>");
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
