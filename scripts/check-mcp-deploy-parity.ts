/**
 * Phase 4 deploy-provider parity gate.
 *
 * The four deploy tools reach a vendor over HTTPS, so — like the GitHub gate
 * and unlike the git one — they cannot be diffed by running both runtimes and
 * watching. Each runtime is pointed at its own loopback stand-in (see
 * `providers/api-base.ts`, and `support/http-api-stub.ts` for the stub), and
 * two things are compared per step: what the tool reported, and every request
 * it made to get there — method, path and query, headers, and body. A runtime
 * that built a query differently would otherwise only be visible as a 404.
 *
 * The plan runs twice against two configs. The main pass is *connected*, which
 * is the only way to compare anything a provider actually answers; the second
 * plants no connection at all, because "not connected" is the state most users
 * are in and its message is the one they read.
 *
 * Nothing here reads either implementation.
 * `test/fixtures/mcp-deploy-parity-v1.json` holds the canned responses and the
 * ordered plan; both runtimes see the same ones.
 *
 * Usage:
 *   node --import tsx scripts/check-mcp-deploy-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { callMcpTool } from "../test/support/mcp-contract.js";
import { type ApiStub, type StubRoute, startApiStub } from "./support/http-api-stub.js";
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
const candidateArgv = argv.filter((argument) => argument !== "--dump");
if (candidateArgv.length === 0) {
  throw new Error(
    "Usage: node --import tsx scripts/check-mcp-deploy-parity.ts [--dump] <candidate-command> [candidate-args...]",
  );
}

interface Step {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
}

interface Fixture extends FixtureTree {
  fixtureVersion: 1;
  config: Record<string, unknown>;
  api: StubRoute[];
  plan: Step[];
  /** A second pass with no provider connection planted at all. */
  disconnected: { config: Record<string, unknown>; plan: Step[] };
}

const fixture = JSON.parse(
  await readFile(join(repositoryRoot, "test/fixtures/mcp-deploy-parity-v1.json"), "utf8"),
) as Fixture;
if (fixture.fixtureVersion !== 1) {
  throw new Error(`Unsupported deploy parity fixture version ${fixture.fixtureVersion}`);
}

const specs = [
  { label: "reference", command: process.execPath, args: ["--import", "tsx", "src/index.ts"] },
  { label: "candidate", command: candidateArgv[0], args: candidateArgv.slice(1) },
];

const roots: string[] = [];
const stubs: ApiStub[] = [];
try {
  let compared = 0;
  compared += await pass("connected", fixture.config, fixture.plan);
  compared += await pass("disconnected", fixture.disconnected.config, fixture.disconnected.plan);
  console.log(`MCP deploy-provider parity passed (${compared} steps).`);
} finally {
  await Promise.all(stubs.map((stub) => stub.close().catch(() => {})));
  await Promise.all(
    roots.map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch(() => {}),
    ),
  );
}

/**
 * One walk of a plan against one config, with a fresh tree and a fresh stub per
 * runtime.
 *
 * Fresh matters more here than in the other gates: the first call adopts the
 * account's sole team and **writes it to config**, so a pass that reused a tree
 * would skip the team lookup its first step is there to compare.
 */
async function pass(
  label: string,
  config: Record<string, unknown>,
  plan: Step[],
): Promise<number> {
  const runtimes: Runtime[] = [];
  for (const spec of specs) {
    const runtime = await prepareRuntime(
      { ...spec, label: `${spec.label}-${label}` },
      { ...fixture, config },
      roots,
    );
    const stub = await startApiStub(fixture.api);
    stubs.push(stub);
    runtime.env.NOMOREIDE_VERCEL_API_BASE = stub.base;
    runtime.env.NOMOREIDE_CLOUDFLARE_API_BASE = stub.base;
    runtimes.push(runtime);
  }

  for (const step of plan) {
    const observed = await Promise.all(
      runtimes.map((runtime, index) => call(runtime, stubs[index], step)),
    );
    if (dump) {
      for (const [index, entry] of observed.entries()) {
        console.log(`\n--- ${step.id} [${runtimes[index].label}]`);
        console.log(JSON.stringify(entry, null, 2));
      }
    }
    try {
      assert.deepStrictEqual(observed[1], observed[0]);
    } catch (error) {
      console.error(`\nDeploy-provider parity failed at step "${step.id}" (${step.tool}).`);
      console.error(`reference: ${JSON.stringify(observed[0], null, 2)}`);
      console.error(`candidate: ${JSON.stringify(observed[1], null, 2)}`);
      throw error;
    }
  }
  return plan.length;
}

async function call(runtime: Runtime, stub: ApiStub, step: Step): Promise<unknown> {
  const args = Object.fromEntries(
    Object.entries(step.arguments).map(([key, value]) => [key, substitute(value, runtime)]),
  );
  stub.take();
  const response = await callMcpTool(mcpCommand(runtime), step.tool, args);
  return { reported: normalize(response, runtime), requests: stub.take() };
}
