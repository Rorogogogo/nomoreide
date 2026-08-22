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
import { readFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
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

const argv = process.argv.slice(2);
const dump = argv.includes("--dump");
const candidateArgv = argv.filter((argument) => argument !== "--dump");
if (candidateArgv.length === 0) {
  throw new Error(
    "Usage: node --import tsx scripts/check-mcp-git-parity.ts [--dump] <candidate-command> [candidate-args...]",
  );
}

interface Fixture extends FixtureTree {
  fixtureVersion: 2;
  plan: Array<{ id: string; tool: string; arguments: Record<string, unknown> }>;
}

const fixture = JSON.parse(
  await readFile(join(repositoryRoot, "test/fixtures/mcp-git-parity-v2.json"), "utf8"),
) as Fixture;
if (fixture.fixtureVersion !== 2) {
  throw new Error(`Unsupported git parity fixture version ${fixture.fixtureVersion}`);
}

const specs = [
  { label: "reference", command: process.execPath, args: ["--import", "tsx", "src/index.ts"] },
  { label: "candidate", command: candidateArgv[0], args: candidateArgv.slice(1) },
];

const roots: string[] = [];
try {
  const runtimes: Runtime[] = [];
  for (const spec of specs) {
    runtimes.push(await prepareRuntime(spec, fixture, roots));
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

async function call(runtime: Runtime, step: Fixture["plan"][number]): Promise<unknown> {
  const args = Object.fromEntries(
    Object.entries(step.arguments).map(([key, value]) => [key, substitute(value, runtime)]),
  );
  const response = await callMcpTool(mcpCommand(runtime), step.tool, args);
  return normalize(response, runtime);
}
