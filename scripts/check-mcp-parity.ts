import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  captureMcpContract,
  type McpCommand,
  normalizeMcpContract,
} from "../test/support/mcp-contract.js";

const separator = process.argv.indexOf("--");
const rawCandidateArgs =
  separator === -1 ? process.argv.slice(2) : process.argv.slice(separator + 1);
const surfaceOnly = rawCandidateArgs.includes("--surface-only");
const candidateArgs = rawCandidateArgs.filter((argument) => argument !== "--surface-only");
if (candidateArgs.length === 0) {
  throw new Error(
    "Usage: npm run mcp:parity -- [--surface-only] <candidate-command> [candidate-args...]",
  );
}

const root = resolve(import.meta.dirname, "..");
const referenceHome = await mkdtemp(join(tmpdir(), "nomoreide-mcp-reference-"));
const candidateHome = await mkdtemp(join(tmpdir(), "nomoreide-mcp-candidate-"));
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

function command(commandName: string, args: string[], home: string): McpCommand {
  return {
    command: commandName,
    args,
    cwd: root,
    env: {
      ...inheritedEnv,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      NOMOREIDE_AUTO_UI: "0",
    },
  };
}

try {
  const reference = await captureMcpContract(
    command(process.execPath, ["--import", "tsx", "src/index.ts", "mcp"], referenceHome),
  );
  const candidate = await captureMcpContract(
    command(candidateArgs[0], candidateArgs.slice(1), candidateHome),
  );
  const candidateContract = normalizeMcpContract(candidate, {
    temporaryPaths: [candidateHome],
  });
  const referenceContract = normalizeMcpContract(reference, {
    temporaryPaths: [referenceHome],
  });
  if (surfaceOnly) {
    const surface = ({ initialize, tools }: typeof candidate) => ({ initialize, tools });
    assert.deepStrictEqual(
      surface(candidateContract as typeof candidate),
      surface(referenceContract as typeof reference),
    );
  } else {
    assert.deepStrictEqual(candidateContract, referenceContract);
  }
  process.stdout.write(
    `MCP ${surfaceOnly ? "Phase 1 surface " : ""}parity passed for ${candidateArgs.join(" ")}\n`,
  );
} finally {
  await Promise.all([
    rm(referenceHome, { recursive: true, force: true }),
    rm(candidateHome, { recursive: true, force: true }),
  ]);
}
