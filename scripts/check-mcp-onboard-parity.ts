/**
 * Phase 3 snapshot + onboarding parity gate.
 *
 * The last two groups of Phase 3 are here together because they are the two
 * that build state on disk rather than only reading it: a snapshot writes a
 * ref, and onboarding writes a whole clone. Both are driven the way the git
 * gate drives its tools — run the reference and the candidate against their
 * own identical copies of one fixture tree, and diff what each reports.
 *
 * Onboarding clones over `file://`, from bare-ish source repositories in the
 * fixture's own tree. That is not a shortcut around the network: a fixture
 * that reached github.com would be testing github.com. What matters here is
 * everything downstream of the clone — the scan, the profile, and the
 * heuristic proposals — and those cannot tell where the tree came from.
 *
 * Nothing here reads either implementation.
 *
 * One wrinkle shapes the fixture. The MCP server takes a snapshot of its *own*
 * working directory when a session begins, so a step that exercises a tool's
 * "no cwd argument" fallback cannot point the process at a repository and then
 * list it: that ambient snapshot is labelled with a random session id and the
 * two runtimes would never agree on it. `create` is unaffected — it reports
 * only its own snapshot — so the fallback is covered by creating in a
 * repository and by listing in a directory that is not one.
 *
 * Usage:
 *   node --import tsx scripts/check-mcp-onboard-parity.ts <candidate> [args...]
 *   ... --dump          print both payloads per step
 *   ... --only <prefix> run only the steps whose id starts with <prefix>
 */
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { callMcpTool } from "../test/support/mcp-contract.js";
import {
  type FixtureTree,
  type Runtime,
  isRecent,
  mcpCommand,
  normalize,
  prepareRuntime,
  recordable,
  recorder,
  repositoryRoot,
  substitute,
} from "./support/mcp-parity-fixture.js";
import { referenceSpec } from "../test/support/runtime-parity.js";

/**
 * A snapshot ref is named for the instant it was taken, so the two runtimes can
 * never agree on that part of it. Only the digits are masked, and only when
 * they read as a millisecond stamp from about now: the slug the label was
 * turned into is the interesting half and is compared as written.
 */
const SNAPSHOT_REF = /^(refs\/nomoreide\/snapshots\/)(\d{13})(?=-|$)/;

const argv = process.argv.slice(2);
const dump = argv.includes("--dump");
const onlyIndex = argv.indexOf("--only");
const only = onlyIndex >= 0 ? argv[onlyIndex + 1] : undefined;
const candidateArgv = argv.filter(
  (argument, index) =>
    argument !== "--dump" && (onlyIndex < 0 || (index !== onlyIndex && index !== onlyIndex + 1)),
);
if (candidateArgv.length === 0) {
  throw new Error(
    "Usage: node --import tsx scripts/check-mcp-onboard-parity.ts [--dump] [--only <prefix>] <candidate-command> [candidate-args...]",
  );
}

interface Fixture extends FixtureTree {
  fixtureVersion: 1;
  plan: Array<{
    id: string;
    tool: string;
    arguments: Record<string, unknown>;
    /** Run the MCP process from here, to exercise a tool's own cwd fallback. */
    processCwd?: string;
  }>;
}

const fixture = JSON.parse(
  await readFile(join(repositoryRoot, "test/fixtures/mcp-onboard-parity-v1.json"), "utf8"),
) as Fixture;
if (fixture.fixtureVersion !== 1) {
  throw new Error(`Unsupported onboard parity fixture version ${fixture.fixtureVersion}`);
}

// Both commands are spelled absolutely: a step may run the MCP process from a
// fixture directory rather than from the checkout, and a relative path would
// then resolve against the wrong place.
const specs = [
  // Absolute either way, and in replay a path that cannot exist — which is
  // what makes "the reference is never started" enforced rather than asserted.
  referenceSpec(),
  { label: "candidate", command: resolve(candidateArgv[0]), args: candidateArgv.slice(1) },
];

const roots: string[] = [];
try {
  const runtimes: Runtime[] = [];
  for (const spec of specs) {
    runtimes.push(await prepareRuntime(spec, fixture, roots));
  }

  let compared = 0;
  for (const step of fixture.plan) {
    if (only !== undefined && !step.id.startsWith(only)) {
      continue;
    }
    const observed = await Promise.all(runtimes.map((runtime) => call(runtime, step)));
    if (dump) {
      for (const [index, entry] of observed.entries()) {
        console.log(`\n--- ${step.id} [${runtimes[index].label}]`);
        console.log(JSON.stringify(entry, null, 2));
      }
    }
    try {
      assert.deepStrictEqual(observed[1], observed[0]);
    } catch (error) {
      console.error(`\nOnboard parity failed at step "${step.id}" (${step.tool}).`);
      console.error(`reference: ${JSON.stringify(observed[0], null, 2)}`);
      console.error(`candidate: ${JSON.stringify(observed[1], null, 2)}`);
      throw error;
    }
    compared += 1;
  }

  console.log(`MCP snapshot/onboard parity passed (${compared} steps).`);
} finally {
  await recorder.finish();
  await Promise.all(
    roots.map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch(() => {}),
    ),
  );
}

/**
 * One step's answer, from a process or from the recording.
 *
 * The normalized payload is the recorded unit rather than the raw response:
 * it has already had this runtime's own throwaway paths rewritten to fixture
 * tokens, so it is the same value in whatever directory the gate next runs in.
 */
async function call(runtime: Runtime, step: Fixture["plan"][number]): Promise<unknown> {
  return recorder.recorded(recordable(runtime), step.id, async () => {
    const args = Object.fromEntries(
      Object.entries(step.arguments).map(([key, value]) => [key, substitute(value, runtime)]),
    );
    const where: Runtime =
      step.processCwd === undefined
        ? runtime
        : { ...runtime, cwd: substitute(step.processCwd, runtime) as string };
    return maskSnapshotRefs(
      normalize(await callMcpTool(mcpCommand(where), step.tool, args), runtime),
    );
  });
}

function maskSnapshotRefs(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(SNAPSHOT_REF, (whole, prefix: string, stamp: string) =>
      isRecent(Number(stamp)) ? `${prefix}<ms>` : whole,
    );
  }
  if (Array.isArray(value)) {
    return value.map(maskSnapshotRefs);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, maskSnapshotRefs(entry)]),
  );
}
