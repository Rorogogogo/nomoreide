/**
 * Phase 4 database parity gate.
 *
 * The nine database tools, driven against a throwaway SQLite file that both
 * runtimes get their own identical copy of. SQLite is the only engine a fixture
 * can stand up honestly — a gate that needed a Postgres server would be testing
 * the server — and it is enough to pin down everything the tools do that is not
 * dialect: the catalog shapes, the opaque object key, how a row becomes JSON,
 * where the row cap lands, and the difference between a statement this
 * connection refused and one the engine merely could not parse.
 *
 * Two things it deliberately cannot reach, recorded here rather than skipped
 * quietly:
 *
 *  - Postgres and MySQL. Their catalog SQL, their `qualifiedName` (which is
 *    `schema.name` there and a bare name here), and the text their drivers put
 *    on a connection failure are all unexercised. The reference reports an
 *    *empty* message when it cannot reach a Postgres server; the native
 *    runtime reports what sqlx says. Neither is diffable without a server, and
 *    matching an empty message would be the wrong thing to match anyway.
 *
 *  - A statement that closes the wrapper's own parenthesis and then comments
 *    out the rest of the line. The row cap is bound, so it disappears with the
 *    comment; SQLite then runs the shortened statement and sqlx lets the now
 *    homeless parameter go, while the reference's driver raises "column index
 *    out of range". Both stay read-only, so the difference is how loudly an
 *    escape of one's own row cap fails. `query-closes-the-wrapper` covers the
 *    same attempt in the form both runtimes answer identically.
 *
 *  - Integers past 2^53. The reference cannot report one at all — node:sqlite
 *    throws rather than lose precision, so `nomoreide_db_sample` on a table
 *    holding one fails. The native runtime returns the number. That is a fix,
 *    not a divergence to reproduce, so the fixture holds no such value and the
 *    difference is documented instead of gated.
 *
 * Nothing here reads either implementation.
 *
 * Usage:
 *   node --import tsx scripts/check-mcp-database-parity.ts <candidate> [args...]
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
  mcpCommand,
  normalize,
  prepareRuntime,
  recordable,
  recorder,
  repositoryRoot,
  substitute,
} from "./support/mcp-parity-fixture.js";
import { referenceSpec } from "../test/support/runtime-parity.js";

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
    "Usage: node --import tsx scripts/check-mcp-database-parity.ts [--dump] [--only <prefix>] <candidate-command> [candidate-args...]",
  );
}

interface Fixture extends FixtureTree {
  fixtureVersion: 1;
  plan: Array<{ id: string; tool: string; arguments: Record<string, unknown> }>;
}

const fixture = JSON.parse(
  await readFile(join(repositoryRoot, "test/fixtures/mcp-database-parity-v1.json"), "utf8"),
) as Fixture;
if (fixture.fixtureVersion !== 1) {
  throw new Error(`Unsupported database parity fixture version ${fixture.fixtureVersion}`);
}

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
  // Registration writes config, so the plan is ordered and has to stay that
  // way: a step that lists connections is only comparable if both runtimes
  // registered the same ones first. Steps therefore run in sequence, not in
  // parallel across the plan — only the two runtimes run side by side.
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
      console.error(`\nDatabase parity failed at step "${step.id}" (${step.tool}).`);
      console.error(`reference: ${JSON.stringify(observed[0], null, 2)}`);
      console.error(`candidate: ${JSON.stringify(observed[1], null, 2)}`);
      throw error;
    }
    compared += 1;
  }

  console.log(`MCP database parity passed (${compared} steps).`);
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
    return normalize(await callMcpTool(mcpCommand(runtime), step.tool, args), runtime);
  });
}
