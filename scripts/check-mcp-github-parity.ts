/**
 * Phase 3 GitHub parity gate.
 *
 * The twelve GitHub API tools are the first that reach outward, so unlike the
 * git gate this one cannot simply run both runtimes and watch. Each runtime is
 * pointed at its own loopback stand-in for api.github.com (see
 * `support/http-api-stub.ts`), and the gate compares two things per step:
 * what the tool reported, and every request it made to get there — method,
 * path and query, headers, and body.
 *
 * Nothing here reads either implementation. `test/fixtures/mcp-github-parity-v1.json`
 * holds the canned responses and the ordered plan; both runtimes see the same
 * ones.
 *
 * Usage:
 *   node --import tsx scripts/check-mcp-github-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
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
import { type ApiStub, type StubRoute, startApiStub } from "./support/http-api-stub.js";

const argv = process.argv.slice(2);
const dump = argv.includes("--dump");
const candidateArgv = argv.filter((argument) => argument !== "--dump");
if (candidateArgv.length === 0) {
  throw new Error(
    "Usage: node --import tsx scripts/check-mcp-github-parity.ts [--dump] <candidate-command> [candidate-args...]",
  );
}

interface Fixture extends FixtureTree {
  fixtureVersion: 1;
  api: StubRoute[];
  plan: Array<{ id: string; tool: string; arguments: Record<string, unknown> }>;
}

const fixture = JSON.parse(
  await readFile(join(repositoryRoot, "test/fixtures/mcp-github-parity-v1.json"), "utf8"),
) as Fixture;
if (fixture.fixtureVersion !== 1) {
  throw new Error(`Unsupported GitHub parity fixture version ${fixture.fixtureVersion}`);
}

const specs = [
  { label: "reference", command: process.execPath, args: ["--import", "tsx", "src/index.ts"] },
  { label: "candidate", command: candidateArgv[0], args: candidateArgv.slice(1) },
];

const roots: string[] = [];
const stubs: ApiStub[] = [];
try {
  const runtimes: Runtime[] = [];
  for (const spec of specs) {
    const runtime = await prepareRuntime(spec, fixture, roots);
    const stub = await startApiStub(fixture.api);
    stubs.push(stub);
    runtime.env.NOMOREIDE_GITHUB_API_BASE = stub.base;
    runtimes.push(runtime);
  }

  let compared = 0;
  for (const step of fixture.plan) {
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
      console.error(`\nGitHub parity failed at step "${step.id}" (${step.tool}).`);
      console.error(`reference: ${JSON.stringify(observed[0], null, 2)}`);
      console.error(`candidate: ${JSON.stringify(observed[1], null, 2)}`);
      throw error;
    }
    compared += 1;
  }

  console.log(`MCP GitHub parity passed (${compared} steps).`);
} finally {
  await Promise.all(stubs.map((stub) => stub.close().catch(() => {})));
  await Promise.all(
    roots.map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch(() => {}),
    ),
  );
}

async function call(
  runtime: Runtime,
  stub: ApiStub,
  step: Fixture["plan"][number],
): Promise<unknown> {
  const args = Object.fromEntries(
    Object.entries(step.arguments).map(([key, value]) => [key, substitute(value, runtime)]),
  );
  stub.take();
  const response = await callMcpTool(mcpCommand(runtime), step.tool, args);
  return { reported: normalize(response, runtime), requests: stub.take() };
}
