import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NOMOREIDE_TOOL_DOMAINS } from "../src/mcp/tools/index.js";
import { captureMcpContract } from "../test/support/mcp-contract.js";

const root = resolve(import.meta.dirname, "..");
const fixtureDir = join(root, "test", "fixtures");
const tempHome = await mkdtemp(join(tmpdir(), "nomoreide-mcp-contract-"));

try {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const contract = await captureMcpContract({
    command: process.execPath,
    args: ["--import", "tsx", "src/index.ts", "mcp"],
    cwd: root,
    env: {
      ...env,
      HOME: tempHome,
      XDG_CONFIG_HOME: join(tempHome, ".config"),
      NOMOREIDE_AUTO_UI: "0",
    },
  });
  const manifest = {
    manifestVersion: 1,
    total: Object.values(NOMOREIDE_TOOL_DOMAINS).flat().length,
    domains: Object.entries(NOMOREIDE_TOOL_DOMAINS).map(([owner, tools]) => ({
      owner,
      count: tools.length,
      tools,
    })),
  };

  await mkdir(fixtureDir, { recursive: true });
  await Promise.all([
    writeFile(
      join(fixtureDir, "mcp-contract-v1.json"),
      `${JSON.stringify(contract, null, 2)}\n`,
    ),
    writeFile(
      join(fixtureDir, "mcp-tool-manifest-v1.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    ),
  ]);
} finally {
  await rm(tempHome, { recursive: true, force: true });
}
