import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  captureMcpContract,
  type McpCommand,
  normalizeMcpContract,
} from "../test/support/mcp-contract.js";
import { Recorder } from "../test/support/parity-recording.js";
import { referenceSpec } from "../test/support/runtime-parity.js";

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
const recorder = new Recorder();
const reference = referenceSpec();
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
  // The whole contract is the recorded unit. In replay the reference is a path
  // that cannot exist, so a run that still tried to capture it would die
  // naming itself rather than quietly passing because `src/` is still here.
  const referenceContractRaw = await recorder.recorded(
    {
      ...reference,
      home: referenceHome,
      workspace: referenceHome,
      port: 0,
    },
    "contract",
    () => captureMcpContract(command(reference.command, [...reference.args, "mcp"], referenceHome)),
  );
  const candidate = await captureMcpContract(
    command(candidateArgs[0], candidateArgs.slice(1), candidateHome),
  );
  const candidateContract = normalizeMcpContract(candidate, {
    temporaryPaths: [candidateHome],
  });
  const referenceContract = normalizeMcpContract(referenceContractRaw, {
    temporaryPaths: [referenceHome],
  });
  if (surfaceOnly) {
    const surface = ({ initialize, tools }: typeof candidate) => ({ initialize, tools });
    assert.deepStrictEqual(
      surface(candidateContract as typeof candidate),
      surface(referenceContract as typeof candidate),
    );
  } else {
    assert.deepStrictEqual(candidateContract, referenceContract);
  }
  process.stdout.write(
    `MCP ${surfaceOnly ? "Phase 1 surface " : ""}parity passed for ${candidateArgs.join(" ")}\n`,
  );
} finally {
  await recorder.finish();
  await Promise.all([
    rm(referenceHome, { recursive: true, force: true }),
    rm(candidateHome, { recursive: true, force: true }),
  ]);
}
